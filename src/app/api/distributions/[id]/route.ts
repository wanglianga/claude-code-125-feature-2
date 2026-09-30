import { NextRequest } from 'next/server';
import { one, query, tx } from '@/lib/db';
import { api, ok, fail, logActivity, genNo } from '@/lib/api';

// 发放场次详情：本班已到校、可发放的订单明细与签收情况
export const GET = api(async (_req: NextRequest, _b: any, user, ctx) => {
  const id = ctx.params.id;
  const dist = await one<any>(
    `SELECT d.*, c.name class_name FROM distributions d JOIN classes c ON c.id=d.class_id WHERE d.id=?`, [id]);
  if (!dist) return fail('发放场次不存在', 404);
  const receipts = await query(
    `SELECT r.*, s.name student_name, s.student_no, oi.name item_name, oi.size, oi.garment_type,
            cs.name claimant_name
     FROM receipts r
     JOIN students s ON s.id=r.student_id
     JOIN order_items oi ON oi.id=r.order_item_id
     LEFT JOIN students cs ON cs.id=r.claimant_student_id
     WHERE r.distribution_id=? ORDER BY s.student_no, oi.id`, [id]);

  // 候选：本班、已缴费、已到校（arrived_qty>0）且尚未在本场发放的明细
  const candidates = await query(
    `SELECT sl.id shipment_line_id, oi.id order_item_id, s.id student_id, s.student_no, s.name student_name,
            oi.name item_name, oi.size, oi.garment_type,
            sl.arrived_qty,
            COALESCE((SELECT SUM(r2.qty) FROM receipts r2 WHERE r2.order_item_id=oi.id),0) already_issued
     FROM shipment_lines sl
     JOIN shipments sh ON sh.id=sl.shipment_id
     JOIN order_items oi ON oi.id=sl.order_item_id
     JOIN orders o ON o.id=oi.order_id
     JOIN students s ON s.id=o.student_id
     WHERE sh.status='arrived' AND o.class_id=? AND o.status='paid'
     HAVING arrived_qty - already_issued > 0
     ORDER BY s.student_no, oi.id`, [dist.class_id]);

  return ok({ distribution: dist, receipts, candidates });
});

// 发放/签收动作
export const POST = api(async (_req: NextRequest, body: any, user) => {
  const dist = await one<any>('SELECT * FROM distributions WHERE id=?', [body.distribution_id]);
  if (!dist) return fail('发放场次不存在', 404);

  // 错包冻结：只冻结相关发放批次，冻结期间不能发放/签收/确认整批结束（无关班级场次不受影响）
  if (dist.frozen && ['issue', 'sign', 'set_status'].includes(body.action)) {
    const fz = await one<any>(
      `SELECT wpc.case_no FROM wrong_pack_freezes wpf
       JOIN wrong_pack_cases wpc ON wpc.id=wpf.case_id
      WHERE wpf.distribution_id=? AND wpf.unfrozen=0 LIMIT 1`, [dist.id]);
    return fail(`本班发放批次因子包 ${fz?.case_no || ''} 已冻结，缺失包补齐并闭环后自动解冻`, 409);
  }

  // 发放一件（可登记为正常/错领/漏发未到）
  if (body.action === 'issue') {
    const oi = await one<any>(
      `SELECT oi.*, o.student_id, o.class_id, o.id order_id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.id=?`,
      [body.order_item_id]);
    if (!oi || oi.class_id !== dist.class_id) return fail('该明细不属于本场次班级');
    const dup = await one('SELECT id FROM receipts WHERE distribution_id=? AND order_item_id=?', [dist.id, oi.id]);
    if (dup) return fail('该明细已在本场次登记');
    const status = ['issued', 'wrong_claim', 'missing'].includes(body.status) ? body.status : 'issued';
    await tx(async (conn) => {
      await conn.query(
        `INSERT INTO receipts (distribution_id,order_item_id,student_id,qty,status,claimant_student_id,reason)
         VALUES (?,?,?,?,?,?,?)`,
        [dist.id, oi.id, body.actual_student_id || oi.student_id, body.qty || 1, status,
         body.claimant_student_id || null, body.reason || null]);
      if (status === 'issued') {
        await conn.query('UPDATE order_items SET signed_qty=signed_qty+? WHERE id=?', [body.qty || 1, oi.id]);
      }
      if (status === 'missing') {
        await conn.query(
          `INSERT INTO activity_log (student_id,order_id,actor_role,actor_name,action,detail)
           VALUES (?,?,?,?,?,?)`,
          [oi.student_id, oi.order_id, user.role, user.real_name, '发放登记-缺件',
            `${oi.name}(${oi.size}) 未到货，已列入补领`]);
      }
      if (status === 'wrong_claim') {
        await conn.query(
          `INSERT INTO activity_log (student_id,order_id,actor_role,actor_name,action,detail)
           VALUES (?,?,?,?,?,?)`,
          [oi.student_id, oi.order_id, user.role, user.real_name, '班级错领',
            `校服被 ${body.claimant_student_id ? '学生#' + body.claimant_student_id : '他人'} 错领，待找回/补发`]);
      }
    });
    await logActivity({ student_id: oi.student_id, order_id: oi.order_id, actor: user,
      action: status === 'issued' ? '发放校服' : `发放登记:${status}`, detail: `${oi.name} ${oi.size}` });
    return ok();
  }

  // 家长签收（正常发放后由家长/学生确认，可在补领场签收）
  if (body.action === 'sign') {
    const r = await one<any>('SELECT * FROM receipts WHERE id=? AND distribution_id=?', [body.receipt_id, dist.id]);
    if (!r) return fail('签收记录不存在', 404);
    await query("UPDATE receipts SET status='signed', signed_by=?, signed_at=NOW(), handled=CASE WHEN status IN ('wrong_claim','missing') THEN handled ELSE 1 END WHERE id=?",
      [body.signed_by || user.real_name, r.id]);
    if (r.status === 'issued') {
      // issued 已在发放时计入 signed_qty，保持不变
    }
    await logActivity({ student_id: r.student_id, actor: user, action: '家长签收', detail: `签收记录#${r.id}` });
    return ok();
  }

  // 标记异常已处理（错领找回 / 缺件已补）
  if (body.action === 'resolve') {
    await query('UPDATE receipts SET handled=1 WHERE id=?', [body.receipt_id]);
    const r = await one<any>('SELECT * FROM receipts WHERE id=?', [body.receipt_id]);
    await logActivity({ student_id: r.student_id, actor: user, action: '发放异常闭环', detail: body.note || `签收记录#${r.id}` });
    return ok();
  }

  // 场次状态
  if (body.action === 'set_status') {
    if (!['planned', 'in_progress', 'done'].includes(body.status)) return fail('状态非法');
    // 相关班级在缺失包未补齐前不能确认整批发放（无关班级可继续确认）
    if (body.status === 'done') {
      const open = await one<any>(
        `SELECT wpc.case_no FROM wrong_pack_items wpi
           JOIN wrong_pack_cases wpc ON wpc.id=wpi.case_id
          WHERE wpi.class_id=? AND wpi.item_status<>'excluded' AND wpc.status<>'closed'
          LIMIT 1`, [dist.class_id]);
      if (open) return fail(`本班缺失包尚未补齐（错包 ${open.case_no} 未闭环），不能确认整批发放`, 409);
    }
    await query('UPDATE distributions SET status=? WHERE id=?', [body.status, dist.id]);
    return ok();
  }

  return fail('未知操作');
}, ['general_affairs', 'head_teacher', 'admin']);
