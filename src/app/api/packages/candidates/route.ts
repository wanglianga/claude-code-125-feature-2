import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { api, ok, fail } from '@/lib/api';

// 装箱候选：某计划（可按班级）已缴费订单明细，附带已发货/已到校/已装入包装码状态
export const GET = api(async (req: NextRequest, _b: any, user) => {
  const planId = req.nextUrl.searchParams.get('plan_id');
  const classId = req.nextUrl.searchParams.get('class_id');
  if (!planId) return fail('请指定 plan_id');
  const where = ['o.plan_id=?', "o.status='paid'"];
  const args: any[] = [planId];
  if (classId) { where.push('o.class_id=?'); args.push(classId); }
  const rows = await query(
    `SELECT oi.id order_item_id, oi.name item_name, oi.size, oi.garment_type, oi.qty,
            o.id order_id, o.order_no, s.id student_id, s.student_no, s.name student_name,
            c.id class_id, c.name class_name,
            (SELECT package_code FROM package_items pi2
               JOIN packages pk ON pk.id=pi2.package_id
              WHERE pi2.order_item_id=oi.id AND pk.status IN ('active','merged_flagged') LIMIT 1) packed_code,
            (SELECT pb.batch_no FROM batch_allocations ba
               JOIN batch_items bi ON bi.id=ba.batch_item_id
               JOIN production_batches pb ON pb.id=bi.batch_id
              WHERE ba.order_item_id=oi.id LIMIT 1) batch_no,
            (SELECT sh.shipment_no FROM shipment_lines sl
               JOIN shipments sh ON sh.id=sl.shipment_id
              WHERE sl.order_item_id=oi.id ORDER BY sl.id DESC LIMIT 1) shipment_no
       FROM order_items oi
       JOIN orders o ON o.id=oi.order_id
       JOIN students s ON s.id=o.student_id
       JOIN classes c ON c.id=o.class_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.id, s.student_no, oi.id`, args);
  return ok({ candidates: rows });
}, ['supplier', 'factory', 'admin', 'general_affairs']);
