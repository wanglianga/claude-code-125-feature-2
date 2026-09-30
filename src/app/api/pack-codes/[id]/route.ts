import { NextRequest } from 'next/server';
import { one, query, tx } from '@/lib/db';
import { api, ok, fail, logActivity } from '@/lib/api';

export const GET = api(async (_req: NextRequest, _b: any, user, ctx) => {
  const id = ctx.params.id;
  const pack = await one<any>(
    `SELECT pc.*, sh.shipment_no, pb.batch_no, c.name class_name
       FROM pack_codes pc
       LEFT JOIN shipments sh ON sh.id=pc.shipment_id
       LEFT JOIN production_batches pb ON pb.id=pc.batch_id
       LEFT JOIN classes c ON c.id=pc.class_id
      WHERE pc.id=?`, [id]);
  if (!pack) return fail('包装码不存在', 404);
  const [items, scans] = await Promise.all([
    query(
      `SELECT pi.*, oi.name item_name, oi.size, oi.garment_type, s.name student_name, s.student_no,
              ce.name expected_class_name, ca.name actual_class_name
         FROM pack_items pi
         JOIN order_items oi ON oi.id=pi.order_item_id
         JOIN orders o ON o.id=oi.order_id
         JOIN students s ON s.id=o.student_id
         LEFT JOIN classes ce ON ce.id=pi.expected_class_id
         LEFT JOIN classes ca ON ca.id=pi.actual_class_id
        WHERE pi.pack_code_id=? ORDER BY pi.mismatch DESC, s.student_no`, [id]),
    query(
      `SELECT ps.*, u.real_name scanner_real, d.name distribution_name
         FROM pack_scans ps
         LEFT JOIN users u ON u.id=ps.scanner_user_id
         LEFT JOIN distributions d ON d.id=ps.distribution_id
        WHERE ps.pack_code_id=? ORDER BY ps.id`, [id]),
  ]);
  return ok({ pack, items, scans });
});

// 到校/发放现场扫码：同一包装码再次扫描即为重复扫描（需触发错包核对与冻结）
export const POST = api(async (_req: NextRequest, body: any, user) => {
  const pack = await one<any>('SELECT * FROM pack_codes WHERE id=?', [body.id]);
  if (!pack) return fail('包装码不存在', 404);
  const prev = await one<any>('SELECT COUNT(*) n FROM pack_scans WHERE pack_code_id=?', [pack.id]);
  const duplicate = Number(prev.n) > 0;

  await tx(async (conn) => {
    await conn.query(
      `INSERT INTO pack_scans (pack_code_id,distribution_id,scanner_user_id,scanner_name,duplicate,note)
       VALUES (?,?,?,?,?,?)`,
      [pack.id, body.distribution_id || null, user.id, user.real_name, duplicate ? 1 : 0, body.note || null]);
    if (duplicate) {
      await conn.query("UPDATE pack_codes SET status='mixed' WHERE id=? AND status NOT IN ('frozen','closed')", [pack.id]);
    } else {
      await conn.query("UPDATE pack_codes SET status='scanned' WHERE id=? AND status IN ('shipped','arrived')", [pack.id]);
    }
  });
  await logActivity({ actor: user, action: duplicate ? '包装码重复扫描' : '扫描包装码',
    detail: `${pack.pack_code}${body.distribution_id ? ` 发放场#${body.distribution_id}` : ''}${duplicate ? '（重复扫描，需冻结相关发放批次核对）' : ''}` });
  return ok({ duplicate });
}, ['general_affairs', 'head_teacher', 'supplier', 'factory', 'admin']);
