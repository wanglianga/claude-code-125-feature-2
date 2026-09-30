import { NextRequest } from 'next/server';
import { query, one } from '@/lib/db';
import { api, ok, fail, logActivity } from '@/lib/api';

// 分批/补领发放安排（总务或班主任）
export const GET = api(async (req: NextRequest, _b: any, user) => {
  const sp = req.nextUrl.searchParams;
  const where: string[] = [];
  const params: any[] = [];
  if (sp.get('plan_id')) { where.push('d.plan_id=?'); params.push(sp.get('plan_id')); }
  if (user.role === 'head_teacher') { where.push('c.teacher_user_id=?'); params.push(user.id); }
  const rows = await query(
    `SELECT d.*, c.name class_name, cp.name campus_name, u.real_name creator_name,
            (SELECT COUNT(*) FROM receipts r WHERE r.distribution_id=d.id) issued,
            (SELECT SUM(CASE WHEN r.status='signed' THEN 1 ELSE 0 END) FROM receipts r WHERE r.distribution_id=d.id) signed_cnt,
            (SELECT SUM(CASE WHEN r.handled=0 AND r.status IN ('wrong_claim','missing') THEN 1 ELSE 0 END) FROM receipts r WHERE r.distribution_id=d.id) open_issues
     FROM distributions d
     JOIN classes c ON c.id=d.class_id
     JOIN campuses cp ON cp.id=d.campus_id
     LEFT JOIN users u ON u.id=d.created_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY d.scheduled_at`, params);
  return ok({ distributions: rows });
});

export const POST = api(async (_req: NextRequest, body: any, user) => {
  const cls = await one<any>('SELECT * FROM classes WHERE id=?', [body.class_id]);
  if (!cls) return fail('班级不存在', 404);
  const grade = await one<any>('SELECT campus_id FROM grades WHERE id=?', [cls.grade_id]);
  const kind = body.kind === 'supplementary' ? 'supplementary' : 'regular';
  const r = await query(
    `INSERT INTO distributions (plan_id,class_id,campus_id,name,kind,scheduled_at,location,status,created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [body.plan_id, cls.id, grade.campus_id, body.name, kind,
     body.scheduled_at, body.location, body.status || 'planned', user.id]);
  const distId = (r as any).insertId;

  await logActivity({ actor: user, action: kind === 'supplementary' ? '安排补领' : '安排分批发放',
    detail: `${body.name} ${body.scheduled_at} @ ${body.location}` });
  return ok({ id: distId });
}, ['general_affairs', 'head_teacher', 'admin']);
