import { query, one } from './db';
import { genNo } from './api';
import type { SessionUser } from './auth';

// 错包状态流转：to_check（待核对）→ to_repack（待重新分拣）→ resending（补发中）→ closed（已闭环）
export const WP_STATUS = ['to_check', 'to_repack', 'resending', 'closed'] as const;

type Actor = Pick<SessionUser, 'role' | 'real_name'>;
const SYSTEM_ACTOR: Actor = { role: 'system', real_name: '系统超时巡检' };

// 替代调拨建议：从其他班级/其他发货单中同品类同尺码的到校未发余量调拨
export async function buildTransferSuggestion(
  planId: number,
  planItemId: number | null,
  size: string | null,
  excludeClassIds: number[],
): Promise<string> {
  if (!planItemId) return '';
  const where = ['o.plan_id=?', 'oi.plan_item_id=?'];
  const args: any[] = [planId, planItemId];
  if (size) { where.push('oi.size=?'); args.push(size); }
  if (excludeClassIds.length) { where.push('o.class_id NOT IN (?)'); args.push(excludeClassIds); }
  const rows = await query<any>(
    `SELECT * FROM (
       SELECT c.name class_name, oi.name item_name, oi.size,
              SUM(sl.arrived_qty) arrived,
              COALESCE((SELECT SUM(rc.qty) FROM receipts rc WHERE rc.order_item_id=oi.id), 0) issued
         FROM shipment_lines sl
         JOIN shipments sh ON sh.id=sl.shipment_id
         JOIN order_items oi ON oi.id=sl.order_item_id
         JOIN orders o ON o.id=oi.order_id
         JOIN classes c ON c.id=o.class_id
        WHERE sh.status='arrived' AND ${where.join(' AND ')}
        GROUP BY c.id, oi.id
     ) t
      WHERE t.arrived - t.issued > 0
      ORDER BY t.arrived - t.issued DESC LIMIT 5`,
    args,
  );
  if (!rows.length) return '';
  const parts = rows.slice(0, 3).map((r) =>
    `${r.class_name}可调拨 ${r.item_name}(${r.size}) 到校余量 ${Number(r.arrived) - Number(r.issued)} 件`);
  return `建议替代调拨：${parts.join('；')}`;
}

export async function logWrongPack(conn: any, caseId: number, actor: Actor, action: string, detail?: string) {
  await conn.query(
    'INSERT INTO wrong_pack_logs (case_id,actor_role,actor_name,action,detail) VALUES (?,?,?,?,?)',
    [caseId, actor.role, actor.real_name, action, detail || null]);
}

// 补发再次超时：自动生成向供应商追责单 + 替代调拨建议（幂等）
export async function runOverdueChecks(actor: Actor = SYSTEM_ACTOR): Promise<any[]> {
  const due = await query<any>(
    `SELECT wpc.* FROM wrong_pack_cases wpc
      WHERE wpc.status IN ('to_repack','resending')
        AND wpc.resend_overdue=0
        AND wpc.resend_shipped_at IS NOT NULL
        AND wpc.resend_expected_arrival IS NOT NULL
        AND wpc.resend_expected_arrival < CURDATE()`,
  );
  const result: any[] = [];
  for (const wpc of due) {
    const exist = await one('SELECT id FROM supplier_liabilities WHERE case_id=? AND type=?', [wpc.id, 'wrong_pack_overdue']);
    if (exist) {
      await query('UPDATE wrong_pack_cases SET resend_overdue=1 WHERE id=?', [wpc.id]);
      continue;
    }
    // 受影响班级与未闭环明细
    const items = await query<any>(
      `SELECT wpi.*, oi.plan_item_id, oi.size, oi.name item_name
         FROM wrong_pack_items wpi JOIN order_items oi ON oi.id=wpi.order_item_id
        WHERE wpi.case_id=? AND wpi.item_status IN ('affected','resending')`, [wpc.id]);
    const classIds = [...new Set(items.map((i) => i.class_id))];
    // 替代调拨建议（按出现最多的品类尺码查询，并汇总其他建议）
    let suggestion = '';
    const seen = new Set<string>();
    for (const it of items) {
      const key = `${it.plan_item_id}:${it.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = await buildTransferSuggestion(wpc.plan_id, it.plan_item_id, it.size, classIds);
      if (s) { suggestion = suggestion ? `${suggestion}；${s.replace('建议替代调拨：', '')}` : s; }
      if (seen.size >= 3) break;
    }
    if (!suggestion) suggestion = '校内暂无同品类同尺码到校余量，建议立即跨校区调拨或启动应急生产';
    const amount = Math.round(items.length * 50 * 100) / 100;
    const liabilityNo = genNo('LB');
    await query(
      `INSERT INTO supplier_liabilities
         (liability_no,case_id,supplier_id,plan_id,type,status,amount,note,transfer_suggestion,created_by)
       VALUES (?,?,?,?, 'wrong_pack_overdue','open',?,?,?,NULL)`,
      [liabilityNo, wpc.id, wpc.supplier_id, wpc.plan_id, amount,
       `错包工单 ${wpc.case_no} 补发预计 ${wpc.resend_expected_arrival} 到校，已超时未闭环，涉及 ${items.length} 件，建议每件扣罚50元`,
       suggestion]);
    await query(
      `UPDATE wrong_pack_cases
          SET resend_overdue=1, accountability_no=COALESCE(accountability_no,?),
              accountability_note=COALESCE(accountability_note,?),
              transfer_suggestion=COALESCE(transfer_suggestion,?)
        WHERE id=?`,
      [liabilityNo, `补发再次超时，已自动生成追责单 ${liabilityNo}（建议扣罚 ¥${amount}）`, suggestion, wpc.id]);
    await query(
      'INSERT INTO wrong_pack_logs (case_id,actor_role,actor_name,action,detail) VALUES (?,?,?,?,?)',
      [wpc.id, actor.role, actor.real_name, '补发超时自动追责',
       `${liabilityNo}；${suggestion}`]);
    for (const it of items) {
      await query(
        'INSERT INTO activity_log (student_id,actor_role,actor_name,action,detail) VALUES (?,?,?,?,?)',
        [it.student_id, actor.role, actor.real_name, '错包补发超时', `${wpc.case_no} 已生成追责单 ${liabilityNo}`]);
    }
    result.push({ case_id: wpc.id, liability_no: liabilityNo, amount, suggestion });
  }
  return result;
}
