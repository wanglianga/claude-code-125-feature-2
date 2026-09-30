import { NextRequest } from 'next/server';
import { query, one, tx } from '@/lib/db';
import { api, ok, fail, logActivity } from '@/lib/api';

// 包装码列表（含重复扫描、混装标记）
export const GET = api(async (req: NextRequest, _b: any, user) => {
  const sp = req.nextUrl.searchParams;
  const where: string[] = [];
  const params: any[] = [];
  for (const k of ['shipment_id', 'batch_id', 'class_id', 'status']) {
    const v = sp.get(k);
    if (v) { where.push(`pc.${k}=?`); params.push(v); }
  }
  if (user.role === 'supplier' || user.role === 'factory') {
    where.push('p.supplier_id=?'); params.push(user.supplier_id);
  }
  const rows = await query(
    `SELECT pc.*, sh.shipment_no, pb.batch_no, c.name class_name, p.name plan_name,
            (SELECT COUNT(*) FROM pack_scans ps WHERE ps.pack_code_id=pc.id) scan_cnt,
            (SELECT COUNT(*) FROM pack_scans ps WHERE ps.pack_code_id=pc.id AND ps.duplicate=1) dup_cnt,
            (SELECT COUNT(*) FROM pack_items pi2 WHERE pi2.pack_code_id=pc.id) item_cnt,
            (SELECT COUNT(*) FROM pack_items pi2 WHERE pi2.pack_code_id=pc.id AND pi2.mismatch=1) mismatch_cnt
     FROM pack_codes pc
     LEFT JOIN shipments sh ON sh.id=pc.shipment_id
     LEFT JOIN production_batches pb ON pb.id=pc.batch_id
     LEFT JOIN classes c ON c.id=pc.class_id
     LEFT JOIN plans p ON p.id=pc.plan_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY pc.id DESC`, params);
  return ok({ packs: rows });
});

// 供应商登记到校包装码及其内装明细（按发货单行选择；包装标签班级与订单班级不一致自动标记混装）
export const POST = api(async (_req: NextRequest, body: any, user) => {
  if (!body.pack_code || !body.shipment_id) return fail('包装码与发货单必填');
  const dup = await one('SELECT id FROM pack_codes WHERE pack_code=?', [body.pack_code]);
  if (dup) return fail('包装码已存在，不能重复建包');
  const sh = await one<any>(
    `SELECT sh.*, pb.plan_id, pb.supplier_id, pb.id batch_id FROM shipments sh
     JOIN production_batches pb ON pb.id=sh.batch_id WHERE sh.id=?`, [body.shipment_id]);
  if (!sh) return fail('发货单不存在', 404);
  if (user.supplier_id && sh.supplier_id !== user.supplier_id) return fail('无权限', 403);

  const lineIds: number[] = (body.line_ids || []).map(Number).filter(Boolean);
  if (!lineIds.length) return fail('请选择包装内明细');
  const lines = await query<any>(
    `SELECT sl.id, sl.order_item_id, o.class_id, o.student_id
       FROM shipment_lines sl JOIN order_items oi ON oi.id=sl.order_item_id
       JOIN orders o ON o.id=oi.order_id
      WHERE sl.shipment_id=? AND sl.id IN (?)`, [sh.id, lineIds]);
  if (lines.length !== lineIds.length) return fail('存在不属于该发货单的明细');

  const labelClass = body.class_id ? Number(body.class_id) : null;
  const mismatchCnt = labelClass ? lines.filter((l) => l.class_id !== labelClass).length : 0;

  const packId = await tx(async (conn) => {
    const [r]: any = await conn.query(
      `INSERT INTO pack_codes (pack_code,shipment_id,batch_id,class_id,plan_id,status)
       VALUES (?,?,?,?,?,?)`,
      [body.pack_code, sh.id, sh.batch_id, labelClass, sh.plan_id,
       mismatchCnt > 0 ? 'mixed' : (sh.status === 'arrived' ? 'arrived' : 'shipped')]);
    const pid = r.insertId;
    for (const l of lines) {
      await conn.query(
        `INSERT INTO pack_items (pack_code_id,order_item_id,expected_class_id,actual_class_id,mismatch)
         VALUES (?,?,?,?,?)`,
        [pid, l.order_item_id, l.class_id, labelClass, labelClass && l.class_id !== labelClass ? 1 : 0]);
    }
    return pid;
  });
  await logActivity({ actor: user, action: '登记到校包装码',
    detail: `${body.pack_code}（${sh.shipment_no}）${mismatchCnt ? `发现 ${mismatchCnt} 件跨班混装` : ''}` });
  return ok({ id: packId, mismatch_cnt: mismatchCnt });
}, ['supplier', 'factory', 'general_affairs', 'admin']);
