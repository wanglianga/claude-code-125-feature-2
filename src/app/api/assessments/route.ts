import { NextRequest } from 'next/server';
import { query, one } from '@/lib/db';
import { api, ok, fail, logActivity } from '@/lib/api';

export const GET = api(async (req: NextRequest, _b: any, user) => {
  const sp = req.nextUrl.searchParams;
  const where: string[] = [];
  const params: any[] = [];
  if (user.role === 'supplier') { where.push('sa.supplier_id=?'); params.push(user.supplier_id); }
  if (sp.get('supplier_id')) { where.push('sa.supplier_id=?'); params.push(sp.get('supplier_id')); }
  const rows = await query(
    `SELECT sa.*, s.name supplier_name, u.real_name assessor_name
     FROM supplier_assessments sa JOIN suppliers s ON s.id=sa.supplier_id
     LEFT JOIN users u ON u.id=sa.assessed_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY sa.id DESC`, params);
  return ok({ assessments: rows });
});

// 总务对供应商考核：系统自动统计漏发/延期/过敏/换码数量，也可手工调整
export const POST = api(async (_req: NextRequest, body: any, user) => {
  if (!body.supplier_id || !body.period || body.score === undefined) return fail('供应商、周期、分数必填');
  let stats: any = { missing_count: 0, delay_count: 0, allergy_count: 0, exchange_count: 0, wrongpack_count: 0, wrongpack_delay_count: 0 };
  if (body.plan_id) {
    stats = await one<any>(
      `SELECT
         (SELECT COALESCE(SUM(sl.missing_qty),0) FROM shipment_lines sl
            JOIN shipments sh ON sh.id=sl.shipment_id
            JOIN production_batches pb ON pb.id=sh.batch_id
           WHERE pb.plan_id=?) missing_count,
         (SELECT COUNT(*) FROM shipments sh
            JOIN production_batches pb ON pb.id=sh.batch_id
           WHERE pb.plan_id=? AND sh.expected_arrival < CURDATE() AND sh.status='shipped') delay_count,
         (SELECT COUNT(*) FROM aftersales_cases ac
            JOIN orders o ON o.id=ac.order_id
           WHERE o.plan_id=? AND ac.reason='allergy') allergy_count,
         (SELECT COUNT(*) FROM aftersales_cases ac
            JOIN orders o ON o.id=ac.order_id
           WHERE o.plan_id=? AND ac.type='exchange') exchange_count,
         (SELECT COUNT(*) FROM wrong_pack_cases WHERE plan_id=?) wrongpack_count,
         (SELECT COUNT(*) FROM wrong_pack_cases WHERE plan_id=? AND resend_overdue=1) wrongpack_delay_count`,
      [body.plan_id, body.plan_id, body.plan_id, body.plan_id, body.plan_id, body.plan_id]);
  }
  const r = await query(
    `INSERT INTO supplier_assessments (supplier_id,plan_id,period,score,missing_count,delay_count,allergy_count,exchange_count,wrongpack_count,wrongpack_delay_count,note,assessed_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [body.supplier_id, body.plan_id || null, body.period, body.score,
     body.missing_count ?? stats.missing_count, body.delay_count ?? stats.delay_count,
     body.allergy_count ?? stats.allergy_count, body.exchange_count ?? stats.exchange_count,
     body.wrongpack_count ?? stats.wrongpack_count, body.wrongpack_delay_count ?? stats.wrongpack_delay_count,
     body.note || null, user.id]);
  await logActivity({ actor: user, action: '供应商考核', detail: `供应商#${body.supplier_id} 评分 ${body.score}，错包 ${body.wrongpack_count ?? stats.wrongpack_count} 起、超时 ${body.wrongpack_delay_count ?? stats.wrongpack_delay_count} 起` });
  return ok({ id: (r as any).insertId, stats });
}, ['general_affairs', 'admin']);
