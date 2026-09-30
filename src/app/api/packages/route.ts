import { NextRequest } from 'next/server';
import { query, one, tx } from '@/lib/db';
import { api, ok, fail, logActivity } from '@/lib/api';

// 包装码列表（供应商装箱追溯；总务/班主任按班级核对）
export const GET = api(async (req: NextRequest, _b: any, user) => {
  const sp = req.nextUrl.searchParams;
  const where: string[] = [];
  const params: any[] = [];
  if (user.role === 'supplier' || user.role === 'factory') { where.push('pk.supplier_id=?'); params.push(user.supplier_id); }
  for (const k of ['plan_id', 'shipment_id', 'batch_id', 'intended_class_id']) {
    const v = sp.get(k);
    if (v) { where.push(`pk.${k}=?`); params.push(v); }
  }
  if (sp.get('code')) { where.push('pk.package_code LIKE ?'); params.push(`%${sp.get('code')}%`); }
  const rows = await query(
    `SELECT pk.*, c.name intended_class_name, cp.name intended_campus_name,
            sh.shipment_no, pb.batch_no, p.name plan_name, s.name supplier_name,
            u.real_name packer_name,
            (SELECT COUNT(*) FROM package_items pi WHERE pi.package_id=pk.id) item_kinds,
            (SELECT COALESCE(SUM(pi.qty),0) FROM package_items pi WHERE pi.package_id=pk.id) item_qty,
            (SELECT COUNT(*) FROM package_scans ps WHERE ps.package_id=pk.id) scan_cnt,
            (SELECT COUNT(*) FROM mispack_items mi
               JOIN mispack_events me ON me.id=mi.event_id
              WHERE mi.package_id=pk.id AND me.status<>'closed') open_mispack
       FROM packages pk
       LEFT JOIN classes c ON c.id=pk.intended_class_id
       LEFT JOIN campuses cp ON cp.id=pk.intended_campus_id
       LEFT JOIN shipments sh ON sh.id=pk.shipment_id
       LEFT JOIN production_batches pb ON pb.id=pk.batch_id
       JOIN plans p ON p.id=pk.plan_id
       JOIN suppliers s ON s.id=pk.supplier_id
       LEFT JOIN users u ON u.id=pk.packed_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY pk.id DESC`, params);
  return ok({ packages: rows });
});

// 供应商装箱登记：一个包装码对应一个目标班级，每件校服只能装入一个有效包装码
export const POST = api(async (_req: NextRequest, body: any, user) => {
  if (!body.package_code || !body.plan_id) return fail('包装码、订购计划必填');
  const plan = await one<any>('SELECT * FROM plans WHERE id=?', [body.plan_id]);
  if (!plan) return fail('订购计划不存在', 404);
  if (user.supplier_id && plan.supplier_id !== user.supplier_id) return fail('只能为本供应商的计划装箱', 403);
  const dup = await one('SELECT id FROM packages WHERE package_code=?', [body.package_code]);
  if (dup) return fail('包装码已存在，不能重复使用');

  const items: any[] = body.items || [];
  if (!items.length) return fail('请至少装入一件校服');

  const id = await tx(async (conn) => {
    let classId = body.intended_class_id ? Number(body.intended_class_id) : null;
    const ois = await conn.query(
      `SELECT oi.id, o.class_id, o.plan_id, o.status FROM order_items oi JOIN orders o ON o.id=oi.order_id
        WHERE oi.id IN (?)`, [items.map((i) => Number(i.order_item_id))]);
    const oiRows = ois[0] as any[];
    if (oiRows.length !== items.length) throw Object.assign(new Error('部分订单明细不存在'), { status: 400 });
    for (const r of oiRows) {
      if (r.plan_id !== plan.id) throw Object.assign(new Error('包装码内只能装入同一订购计划的校服'), { status: 400 });
      if (r.status !== 'paid') throw Object.assign(new Error('只能为已缴费订单的校服装箱'), { status: 400 });
      if (!classId) classId = r.class_id;
      else if (classId !== r.class_id && !body.allow_mixed) {
        throw Object.assign(new Error(`包装码只能对应一个班级：检测到跨班混装（班级#${classId} 与 #${r.class_id}），如确为混包请勾选混装登记`), { status: 400 });
      }
      const [[used]]: any = await conn.query(
        `SELECT pk.package_code FROM package_items pi
           JOIN packages pk ON pk.id=pi.package_id
          WHERE pi.order_item_id=? AND pk.status IN ('active','merged_flagged') LIMIT 1`, [r.id]);
      if (used) throw Object.assign(new Error(`明细#${r.id} 已装入包装码 ${used.package_code}，不能重复装箱`), { status: 400 });
    }
    const grade = classId ? await one<any>('SELECT campus_id FROM classes cl JOIN grades g ON g.id=cl.grade_id WHERE cl.id=?', [classId]) : null;
    const [pr]: any = await conn.query(
      `INSERT INTO packages (package_code,plan_id,supplier_id,shipment_id,batch_id,intended_class_id,intended_campus_id,status,note,packed_by)
       VALUES (?,?,?,?,?,?,?, 'active',?,?)`,
      [body.package_code, plan.id, plan.supplier_id, body.shipment_id || null, body.batch_id || null,
       classId, grade?.campus_id || null, body.note || null, user.id]);
    const pid = pr.insertId;
    for (const it of items) {
      await conn.query('INSERT INTO package_items (package_id,order_item_id,qty) VALUES (?,?,?)',
        [pid, Number(it.order_item_id), Math.max(1, Number(it.qty) || 1)]);
    }
    return pid;
  });

  await logActivity({ actor: user, action: '包装码装箱登记', detail: `${body.package_code} 共 ${items.length} 种明细` });
  return ok({ id });
}, ['supplier', 'factory', 'admin', 'general_affairs']);
