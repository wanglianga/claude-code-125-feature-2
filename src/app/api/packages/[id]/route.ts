import { NextRequest } from 'next/server';
import { one, query, tx } from '@/lib/db';
import { api, ok, fail, logActivity } from '@/lib/api';
import { openMispackEvent } from '@/lib/mispack';

// 包装码详情：内含明细、扫码历史、关联错包事件
export const GET = api(async (_req: NextRequest, _b: any, user, ctx) => {
  const id = ctx.params.id;
  const pk = await one<any>(
    `SELECT pk.*, c.name intended_class_name, cp.name intended_campus_name,
            sh.shipment_no, pb.batch_no, p.name plan_name, s.name supplier_name
       FROM packages pk
       LEFT JOIN classes c ON c.id=pk.intended_class_id
       LEFT JOIN campuses cp ON cp.id=pk.intended_campus_id
       LEFT JOIN shipments sh ON sh.id=pk.shipment_id
       LEFT JOIN production_batches pb ON pb.id=pk.batch_id
       JOIN plans p ON p.id=pk.plan_id
       JOIN suppliers s ON s.id=pk.supplier_id
      WHERE pk.id=?`, [id]);
  if (!pk) return fail('包装码不存在', 404);
  const [items, scans, events] = await Promise.all([
    query(
      `SELECT pi.*, oi.name item_name, oi.size, oi.garment_type,
              s.name student_name, s.student_no, cl.name class_name, o.id order_id, o.student_id
         FROM package_items pi
         JOIN order_items oi ON oi.id=pi.order_item_id
         JOIN orders o ON o.id=oi.order_id
         JOIN students s ON s.id=o.student_id
         JOIN classes cl ON cl.id=o.class_id
        WHERE pi.package_id=? ORDER BY cl.id, s.student_no`, [id]),
    query(
      `SELECT ps.*, u.real_name scanner_user_name, d.name distribution_name
         FROM package_scans ps
         LEFT JOIN users u ON u.id=ps.scanned_by
         LEFT JOIN distributions d ON d.id=ps.distribution_id
        WHERE ps.package_id=? ORDER BY ps.id DESC`, [id]),
    query(
      `SELECT me.id, me.event_no, me.status, me.title FROM mispack_items mi
         JOIN mispack_events me ON me.id=mi.event_id
        WHERE mi.package_id=? GROUP BY me.id ORDER BY me.id DESC`, [id]),
  ]);
  return ok({ package: pk, items, scans, events });
});

// 扫码登记。同一包装码重复扫描（第二次及以后）即触发错包预警，自动定位范围并冻结相关发放批次
export const POST = api(async (_req: NextRequest, body: any, user) => {
  const pk = await one<any>('SELECT * FROM packages WHERE id=?', [body.id]);
  if (!pk) return fail('包装码不存在', 404);
  const scene = body.scene === 'distribution' ? 'distribution' : 'arrival';
  if (scene === 'distribution' && body.distribution_id) {
    const d = await one('SELECT id FROM distributions WHERE id=?', [body.distribution_id]);
    if (!d) return fail('发放场次不存在', 404);
  }

  const result = await tx(async (conn) => {
    const [[cntRow]]: any = await conn.query('SELECT COUNT(*) cnt FROM package_scans WHERE package_id=?', [pk.id]);
    const seq = Number(cntRow.cnt) + 1;
    await conn.query(
      `INSERT INTO package_scans (package_id,scene,distribution_id,scanned_by,scanner_name,note)
       VALUES (?,?,?,?,?,?)`,
      [pk.id, scene, body.distribution_id || null, user.id, body.scanner_name || user.real_name,
       body.note || (seq > 1 ? `第${seq}次重复扫描` : null)]);
    return { seq };
  });
  await logActivity({ actor: user, action: '扫描包装码', detail: `${pk.package_code} 第${result.seq}次（${scene === 'arrival' ? '到校' : '发放现场'}）` });

  // 重复扫描：自动触发错包定位与批次冻结
  let mispack: any = null;
  if (result.seq > 1) {
    const scope = await openMispackEvent({
      actor: user,
      triggerType: 'duplicate_scan',
      packageIds: [pk.id],
      distributionId: body.distribution_id || null,
      title: `包装码 ${pk.package_code} 被重复扫描（第${result.seq}次），疑似两班尺码包混装`,
      description: body.note || '到校/发放现场同一包装码重复扫描，平台自动定位受影响学生与发放批次',
    });
    mispack = scope;
  }
  return ok({ seq: result.seq, duplicate: result.seq > 1, mispack });
}, ['general_affairs', 'head_teacher', 'admin', 'supplier', 'factory']);
