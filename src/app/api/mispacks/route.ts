import { NextRequest } from 'next/server';
import { query, one } from '@/lib/db';
import { api, ok, fail } from '@/lib/api';
import { openMispackEvent, checkMispackTimeouts } from '@/lib/mispack';

// 错包事件列表（按角色可见），附带受影响人数/已签收/双签进度/冻结场次/超时建议数
export const GET = api(async (req: NextRequest, _b: any, user) => {
  // 补发再次超时：任何一方查看列表时平台自动巡检并生成追责/调拨建议（幂等）
  try { await checkMispackTimeouts(); } catch (e) { console.error('[mispack timeout check]', e); }

  const sp = req.nextUrl.searchParams;
  const where: string[] = [];
  const params: any[] = [];
  if (user.role === 'supplier' || user.role === 'factory') { where.push('me.supplier_id=?'); params.push(user.supplier_id); }
  if (user.role === 'head_teacher') {
    where.push('EXISTS(SELECT 1 FROM mispack_items mi2 WHERE mi2.event_id=me.id AND mi2.class_id IN (SELECT id FROM classes WHERE teacher_user_id=?))');
    params.push(user.id);
  }
  if (user.role === 'parent') {
    where.push('EXISTS(SELECT 1 FROM mispack_items mi2 JOIN students st ON st.id=mi2.student_id WHERE mi2.event_id=me.id AND st.parent_user_id=?)');
    params.push(user.id);
  }
  if (sp.get('status')) { where.push('me.status=?'); params.push(sp.get('status')); }
  if (sp.get('plan_id')) { where.push('me.plan_id=?'); params.push(sp.get('plan_id')); }

  const rows = await query(
    `SELECT me.*, p.name plan_name, s.name supplier_name,
            u.real_name reporter_name, u2.real_name reviewer_name,
            (SELECT COUNT(*) FROM mispack_items mi WHERE mi.event_id=me.id) affected_cnt,
            (SELECT COALESCE(SUM(mi.already_signed),0) FROM mispack_items mi WHERE mi.event_id=me.id) signed_cnt,
            (SELECT COALESCE(SUM(mi.already_signed=0),0) FROM mispack_items mi WHERE mi.event_id=me.id) short_cnt,
            (SELECT COALESCE(SUM(mi.student_signed=1 AND mi.already_signed=0),0) FROM mispack_items mi WHERE mi.event_id=me.id) restudent_signed,
            (SELECT COALESCE(SUM(mi.teacher_reviewed=1 AND mi.already_signed=0),0) FROM mispack_items mi WHERE mi.event_id=me.id) reteacher_reviewed,
            (SELECT COUNT(*) FROM mispack_frozen_distributions mfd WHERE mfd.event_id=me.id AND mfd.unfrozen_at IS NULL) frozen_cnt,
            (SELECT COUNT(*) FROM mispack_actions ma WHERE ma.event_id=me.id) action_cnt,
            (SELECT COUNT(*) FROM mispack_actions ma WHERE ma.event_id=me.id AND ma.status='suggested') pending_action_cnt,
            (SELECT GROUP_CONCAT(DISTINCT CONCAT(cl.name) SEPARATOR '、')
               FROM mispack_items mi JOIN classes cl ON cl.id=mi.class_id WHERE mi.event_id=me.id) class_names
       FROM mispack_events me
       JOIN plans p ON p.id=me.plan_id
       JOIN suppliers s ON s.id=me.supplier_id
       LEFT JOIN users u ON u.id=me.reported_by
       LEFT JOIN users u2 ON u2.id=me.reviewed_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY me.id DESC`, params);
  return ok({ events: rows });
});

// 总务/班主任人工上报混装错包（也可由包装码重复扫描自动触发）
export const POST = api(async (_req: NextRequest, body: any, user) => {
  const packageIds: number[] = (body.package_ids || []).map(Number).filter(Boolean);
  const distributionId = body.distribution_id ? Number(body.distribution_id) : null;
  if (!packageIds.length && !distributionId) return fail('请选择涉事包装码或发放场次');
  if (distributionId) {
    const d = await one<any>('SELECT * FROM distributions WHERE id=?', [distributionId]);
    if (!d) return fail('发放场次不存在', 404);
    if (user.role === 'head_teacher') {
      const cl = await one('SELECT teacher_user_id FROM classes WHERE id=?', [d.class_id]);
      if (cl?.teacher_user_id !== user.id) return fail('只能登记本班场次', 403);
    }
  }
  const scope = await openMispackEvent({
    actor: user,
    triggerType: body.trigger_type === 'duplicate_scan' ? 'duplicate_scan' : 'mixed_package',
    packageIds,
    distributionId,
    title: body.title,
    description: body.description,
  });
  return ok(scope);
}, ['general_affairs', 'head_teacher', 'admin']);
