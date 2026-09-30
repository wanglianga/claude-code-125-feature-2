import { NextRequest } from 'next/server';
import { one, query, tx } from '@/lib/db';
import { api, ok, fail, logActivity, genNo } from '@/lib/api';
import { unfreezeEvent } from '@/lib/mispack';

// 事件详情：受影响名单 / 冻结场次 / 追责调拨建议 / 全过程留痕
export const GET = api(async (_req: NextRequest, _b: any, user, ctx) => {
  const id = ctx.params.id;
  const e = await one<any>(
    `SELECT me.*, p.name plan_name, s.name supplier_name,
            u.real_name reporter_name, u2.real_name reviewer_name, u3.real_name sort_user_name
       FROM mispack_events me
       JOIN plans p ON p.id=me.plan_id
       JOIN suppliers s ON s.id=me.supplier_id
       LEFT JOIN users u ON u.id=me.reported_by
       LEFT JOIN users u2 ON u2.id=me.reviewed_by
       LEFT JOIN users u3 ON u3.id=me.sort_registered_by
      WHERE me.id=?`, [id]);
  if (!e) return fail('错包事件不存在', 404);

  if (user.role === 'parent') {
    const hit = await one(
      `SELECT 1 FROM mispack_items mi JOIN students st ON st.id=mi.student_id
        WHERE mi.event_id=? AND st.parent_user_id=? LIMIT 1`, [id, user.id]);
    if (!hit) return fail('无权限查看该事件', 403);
  }
  if ((user.role === 'supplier' || user.role === 'factory') && e.supplier_id !== user.supplier_id) {
    return fail('无权限', 403);
  }
  if (user.role === 'head_teacher') {
    const hit = await one(
      `SELECT 1 FROM mispack_items mi JOIN classes cl ON cl.id=mi.class_id
        WHERE mi.event_id=? AND cl.teacher_user_id=? LIMIT 1`, [id, user.id]);
    if (!hit) return fail('只能查看本班错包事件', 403);
  }

  const [items, frozen, actions, logs, supplementDists] = await Promise.all([
    query(
      `SELECT mi.*, st.name student_name, st.student_no, cl.name class_name,
              ac.case_no, ac.status case_status
         FROM mispack_items mi
         JOIN students st ON st.id=mi.student_id
         JOIN classes cl ON cl.id=mi.class_id
         LEFT JOIN aftersales_cases ac ON ac.id=mi.case_id
        WHERE mi.event_id=? ORDER BY cl.id, st.student_no, mi.id`, [id]),
    query(
      `SELECT mfd.*, d.name distribution_name, d.status dist_status, d.scheduled_at, cl.name class_name
         FROM mispack_frozen_distributions mfd
         JOIN distributions d ON d.id=mfd.distribution_id
         JOIN classes cl ON cl.id=mfd.class_id
        WHERE mfd.event_id=? ORDER BY mfd.id`, [id]),
    query(
      `SELECT ma.*, u.real_name handler_name FROM mispack_actions ma
         LEFT JOIN users u ON u.id=ma.handled_by
        WHERE ma.event_id=? ORDER BY ma.id`, [id]),
    query(
      `SELECT * FROM activity_log WHERE detail LIKE ? ORDER BY id DESC LIMIT 50`,
      [`${e.event_no}%`]),
    query(
      `SELECT d.id, d.name, d.class_id, cl.name class_name, d.scheduled_at
         FROM distributions d JOIN classes cl ON cl.id=d.class_id
        WHERE d.plan_id=? AND d.kind='supplementary'
          AND cl.id IN (SELECT DISTINCT class_id FROM mispack_items WHERE event_id=?)
        ORDER BY d.id DESC`, [e.plan_id, id]),
  ]);

  // 双签进度：需补发（定位时未签收且未找回）的名单
  const needResend = items.filter((i: any) => !i.already_signed && i.disposition !== 'recovered');
  const allSigned = needResend.every((i: any) => i.student_signed);
  const allReviewed = needResend.every((i: any) => i.teacher_reviewed);

  return ok({ event: e, items, frozen, actions, logs, supplementDists, allSigned, allReviewed });
});

export const POST = api(async (_req: NextRequest, body: any, user) => {
  const e = await one<any>('SELECT * FROM mispack_events WHERE id=?', [body.id]);
  if (!e) return fail('错包事件不存在', 404);
  if ((user.role === 'supplier' || user.role === 'factory') && e.supplier_id !== user.supplier_id) {
    return fail('无权限', 403);
  }
  const assertGA = () => {
    if (!['general_affairs', 'admin'].includes(user.role)) throw Object.assign(new Error('仅学校总务可执行该操作'), { status: 403 });
  };
  const assertClassTeacher = async (classId: number) => {
    if (['general_affairs', 'admin', 'parent'].includes(user.role)) return; // 家长由各动作自行校验亲子关系
    if (user.role !== 'head_teacher') throw Object.assign(new Error('无权限'), { status: 403 });
    const cl = await one('SELECT teacher_user_id FROM classes WHERE id=?', [classId]);
    if (cl?.teacher_user_id !== user.id) throw Object.assign(new Error('只能操作本班学生'), { status: 403 });
  };

  // 总务核对名单：原包找回的学生标记 recovered，不进入补发（避免重复发放）
  if (body.action === 'mark_recovered') {
    if (!['general_affairs', 'admin', 'head_teacher'].includes(user.role)) return fail('无权限', 403);
    const mi = await one<any>('SELECT * FROM mispack_items WHERE id=? AND event_id=?', [body.item_id, e.id]);
    if (!mi) return fail('名单记录不存在', 404);
    await assertClassTeacher(mi.class_id);
    if (mi.already_signed) return fail('该学生已签收，校服本就持有，无需找回登记');
    if (mi.student_signed) return fail('已通过补发签收，不能再标记找回');
    await query("UPDATE mispack_items SET disposition='recovered' WHERE id=?", [mi.id]);
    await logActivity({ student_id: mi.student_id, order_id: mi.order_id, actor: user, action: '错包-原包找回', detail: `${e.event_no} ${mi.item_name}(${mi.size}) 原包找回，不再补发` });
    return ok();
  }

  // 总务审核受影响名单：优先补发 / 延后发放
  if (body.action === 'review') {
    assertGA();
    if (!['priority_resend', 'delayed'].includes(body.decision)) return fail('决策必须为优先补发或延后发放');
    await query(
      `UPDATE mispack_events SET review_decision=?, reviewed_by=?, reviewed_at=NOW(), review_note=? WHERE id=?`,
      [body.decision, user.id, body.note || null, e.id]);
    await logActivity({ actor: user, action: '错包审核', detail: `${e.event_no} 决定${body.decision === 'priority_resend' ? '优先补发' : '延后发放'}${body.note ? '：' + body.note : ''}` });
    return ok();
  }

  // 核对完成 → 待重新分拣
  if (body.action === 'confirm_check') {
    assertGA();
    if (e.status !== 'pending_check') return fail('仅待核对状态可完成核对');
    if (e.review_decision === 'pending') return fail('请先审核受影响名单并决定优先补发或延后发放');
    await query("UPDATE mispack_events SET status='to_resort' WHERE id=?", [e.id]);
    await logActivity({ actor: user, action: '错包核对完成', detail: `${e.event_no} 名单核对无误，转供应商重新分拣` });
    return ok();
  }

  // 供应商重新分拣登记：操作人 / 原包去向 / 补发单号 / 预计到校时间
  if (body.action === 'resort') {
    if (!['supplier', 'factory', 'admin'].includes(user.role)) return fail('仅供应商可登记重新分拣', 403);
    if (e.status !== 'to_resort') return fail('仅待重新分拣状态可登记分拣');
    if (!body.sort_operator || !body.original_package_destination || !body.expected_arrival) {
      return fail('请填写操作人、原包去向和预计到校时间');
    }
    const priority = e.review_decision === 'priority_resend';
    if (priority && !body.resend_tracking_no) return fail('优先补发决策下必须填写补发单号');

    await tx(async (conn) => {
      await conn.query(
        `UPDATE mispack_events
            SET sort_operator=?, sort_registered_by=?, sorted_at=NOW(),
                original_package_destination=?, resend_tracking_no=?,
                resend_shipped_at=NOW(), expected_arrival=?, status='resending'
          WHERE id=?`,
        [body.sort_operator, user.id, body.original_package_destination,
         body.resend_tracking_no || null, body.expected_arrival, e.id]);

      // 为每个未签收且未找回的学生生成补发工单（已签收学生不再补发）
      const [rows] = await conn.query(
        `SELECT * FROM mispack_items WHERE event_id=? AND already_signed=0 AND disposition='pending' FOR UPDATE`, [e.id]);
      for (const mi of rows as any[]) {
        const [caseRow]: any = await conn.query(
          `INSERT INTO aftersales_cases
             (case_no,student_id,order_id,order_item_id,type,reason,status,priority,description,created_by,assigned_to)
           VALUES (?,?,?,?,?, 'mixed_package','processing',?,?,?,?)`,
          [genNo('AS'), mi.student_id, mi.order_id, mi.order_item_id, 'resend',
           priority ? 'high' : 'normal',
           `错包事件 ${e.event_no}：${mi.item_name}(${mi.size}) 两班混装${priority ? '，学校决定优先补发' : '，学校决定延后发放（原包重新分拣后到校）'}`,
           e.reported_by, user.id]);
        const caseId = caseRow.insertId;
        await conn.query(
          `INSERT INTO resend_records (case_id,order_item_id,size,qty,status,tracking_no)
           VALUES (?,?,?,?, 'shipped',?)`,
          [caseId, mi.order_item_id, mi.size, mi.qty, body.resend_tracking_no || null]);
        await conn.query("UPDATE mispack_items SET disposition='resend', case_id=? WHERE id=?", [caseId, mi.id]);
        await conn.query(
          `INSERT INTO activity_log (student_id,order_id,actor_role,actor_name,action,detail)
           VALUES (?,?,?,?,?,?)`,
          [mi.student_id, mi.order_id, user.role, user.real_name, '错包重新分拣',
           `${e.event_no} 操作人${body.sort_operator}，原包去向：${body.original_package_destination}，${priority ? '补发' : '重发'}单号 ${body.resend_tracking_no || '待补录'}，预计 ${body.expected_arrival} 到校`]);
      }
      // 包装码按去向更新
      const [pkRows] = await conn.query('SELECT DISTINCT package_id FROM mispack_items WHERE event_id=? AND package_id IS NOT NULL', [e.id]);
      for (const r of pkRows as any[]) {
        await conn.query("UPDATE packages SET status=? WHERE id=?",
          [body.resend_tracking_no ? 'returned' : 'merged_flagged', r.package_id]);
      }
    });
    await logActivity({ actor: user, action: '错包-重新分拣登记', detail: `${e.event_no} 操作人${body.sort_operator}，预计${body.expected_arrival}到校` });
    return ok();
  }

  // 总务确认补发到校；可为涉事班级安排/关联补领场
  if (body.action === 'arrive') {
    assertGA();
    if (e.status !== 'resending') return fail('仅补发中状态可确认到校');
    await tx(async (conn) => {
      await conn.query('UPDATE mispack_events SET arrived_at=NOW() WHERE id=?', [e.id]);
      await conn.query(
        `UPDATE resend_records rr JOIN mispack_items mi ON mi.case_id=rr.case_id
            SET rr.status='arrived' WHERE mi.event_id=? AND rr.status='shipped'`,
        [e.id]);

      // 按涉事班级安排补领场：指定的场次仅用于其本班，其余班级自动创建补领场
      let firstSuppId: number | null = body.supplement_distribution_id ? Number(body.supplement_distribution_id) : null;
      const chosenDist = firstSuppId
        ? await one<any>('SELECT id, class_id FROM distributions WHERE id=?', [firstSuppId])
        : null;
      const classIds = (await conn.query(
        'SELECT DISTINCT class_id FROM mispack_items WHERE event_id=? AND already_signed=0 AND disposition=\'resend\'',
        [e.id]))[0] as any[];
      for (const { class_id } of classIds) {
        let did: number | null = chosenDist && chosenDist.class_id === class_id ? firstSuppId : null;
        if (!did) {
          const [clRows]: any = await conn.query('SELECT grade_id FROM classes WHERE id=?', [class_id]);
          const [grRows]: any = await conn.query('SELECT campus_id FROM grades WHERE id=?', [clRows[0].grade_id]);
          const [dr]: any = await conn.query(
            `INSERT INTO distributions (plan_id,class_id,campus_id,name,kind,scheduled_at,location,status,created_by)
             VALUES (?,?,?,?, 'supplementary', DATE_ADD(NOW(), INTERVAL 1 DAY), '学校补领点', 'planned',?)`,
            [e.plan_id, class_id, grRows[0].campus_id, `错包补发补领场（${e.event_no} ${class_id}班）`, user.id]);
          did = dr.insertId;
        }
        if (!firstSuppId) firstSuppId = did;
      }
      if (firstSuppId) await conn.query('UPDATE mispack_events SET supplement_distribution_id=? WHERE id=?', [firstSuppId, e.id]);

      await conn.query(
        `INSERT INTO activity_log (actor_role,actor_name,action,detail) VALUES (?,?,?,?)`,
        [user.role, user.real_name, '错包补发到校', `${e.event_no} 补发件已到校，等待学生在补领场签收`]);
    });
    await logActivity({ actor: user, action: '错包补发到校确认', detail: e.event_no });
    return ok();
  }

  // 学生实际签收（补领场发放，双签之一）
  if (body.action === 'student_sign') {
    if (!['general_affairs', 'admin', 'head_teacher', 'parent'].includes(user.role)) return fail('无权限', 403);
    const mi = await one<any>('SELECT * FROM mispack_items WHERE id=? AND event_id=?', [body.item_id, e.id]);
    if (!mi) return fail('名单记录不存在', 404);
    await assertClassTeacher(mi.class_id);
    if (user.role === 'parent') {
      const st = await one('SELECT parent_user_id FROM students WHERE id=?', [mi.student_id]);
      if (st?.parent_user_id !== user.id) return fail('只能签收自己孩子的补发件', 403);
    }
    if (mi.already_signed) return fail('该学生在校服混装前已签收，无需也不能重复发放');
    if (mi.disposition === 'recovered') return fail('该生原包已找回，不通过补发签收');
    if (mi.disposition !== 'resend') return fail('补发尚未进入发放环节');
    if (mi.student_signed) return fail('该生已实际签收，请勿重复操作');
    if (!e.arrived_at) return fail('补发件尚未确认到校');

    // 找到该生本班的补发补领场（自动创建时按班级分别建场）
    const suppDist = await one<any>(
      `SELECT id FROM distributions
        WHERE plan_id=? AND class_id=? AND kind='supplementary'
          AND name LIKE ?
        ORDER BY id DESC LIMIT 1`,
      [e.plan_id, mi.class_id, `%${e.event_no}%`]);
    if (!suppDist) return fail('该班尚未安排补领场');

    await tx(async (conn) => {
      await conn.query(
        `UPDATE mispack_items SET student_signed=1, student_signed_by=?, student_signed_at=NOW() WHERE id=?`,
        [body.signed_by || user.real_name, mi.id]);
      // 补领场签收留痕，计入订单签收数量
      await conn.query(
        `INSERT INTO receipts (distribution_id,order_item_id,student_id,qty,status,signed_by,signed_at,handled,mispack_item_id)
         VALUES (?,?,?,?, 'signed',?,NOW(),1,?)`,
        [suppDist.id, mi.order_item_id, mi.student_id, mi.qty,
         body.signed_by || user.real_name, mi.id]);
      await conn.query('UPDATE order_items SET signed_qty=signed_qty+? WHERE id=?', [mi.qty, mi.order_item_id]);
      await conn.query(
        `INSERT INTO activity_log (student_id,order_id,actor_role,actor_name,action,detail)
         VALUES (?,?,?,?,?,?)`,
        [mi.student_id, mi.order_id, user.role, user.real_name, '错包补发-学生签收',
         `${e.event_no} ${mi.item_name}(${mi.size}) 学生实际签收，待班主任复核`]);
    });
    await tryAutoClose(e.id, user);
    return ok();
  }

  // 班主任复核（双签之二）
  if (body.action === 'teacher_review') {
    if (!['general_affairs', 'admin', 'head_teacher'].includes(user.role)) return fail('仅班主任/总务可复核', 403);
    const mi = await one<any>('SELECT * FROM mispack_items WHERE id=? AND event_id=?', [body.item_id, e.id]);
    if (!mi) return fail('名单记录不存在', 404);
    await assertClassTeacher(mi.class_id);
    if (mi.already_signed) return fail('该生原本已签收，无需复核');
    if (mi.disposition === 'recovered') return fail('该生为原包找回，请通过总务闭环事件');
    if (!mi.student_signed) return fail('须学生实际签收后班主任才能复核');
    if (mi.teacher_reviewed) return fail('已复核，请勿重复操作');
    await query(
      `UPDATE mispack_items SET teacher_reviewed=1, teacher_reviewed_by=?, teacher_reviewed_at=NOW() WHERE id=?`,
      [user.id, mi.id]);
    // 复核通过即关闭该生补发工单
    await query(
      `UPDATE aftersales_cases SET status='resolved', resolution='错包补发：学生已签收且班主任复核通过', resolved_at=NOW()
        WHERE id=? AND status<>'resolved'`, [mi.case_id]);
    await query("UPDATE resend_records SET status='done' WHERE case_id=? AND status='arrived'", [mi.case_id]);
    await logActivity({ student_id: mi.student_id, order_id: mi.order_id, actor: user, action: '错包补发-班主任复核', detail: `${e.event_no} ${mi.item_name}(${mi.size}) 复核通过，补发工单闭环` });
    await tryAutoClose(e.id, user);
    return ok();
  }

  // 全部原包找回、无人需要补发时：总务直接闭环并解冻
  if (body.action === 'close_recovered') {
    assertGA();
    const pending = await one<any>(
      `SELECT COALESCE(SUM(already_signed=0 AND disposition='pending'),0) cnt
         FROM mispack_items WHERE event_id=?`, [e.id]);
    if (Number(pending.cnt) > 0) return fail('仍有学生既未签收也未确认原包找回，不能闭环');
    await tx(async (conn) => {
      await conn.query(
        `UPDATE mispack_events SET status='closed', closed_at=NOW(),
            close_note=COALESCE(?,close_note) WHERE id=?`,
        [body.note || '涉事校服全部原包找回，无需补发', e.id]);
      await unfreezeEvent(conn, e.id);
      const [pkRows] = await conn.query('SELECT DISTINCT package_id FROM mispack_items WHERE event_id=? AND package_id IS NOT NULL', [e.id]);
      for (const r of pkRows as any[]) await conn.query("UPDATE packages SET status='returned' WHERE id=?", [r.package_id]);
    });
    await syncAssessment(e);
    await logActivity({ actor: user, action: '错包事件闭环', detail: `${e.event_no} 原包全部找回，冻结场次已解冻` });
    return ok();
  }

  // 采纳/驳回超时生成的追责或调拨建议
  if (body.action === 'handle_action') {
    if (!['general_affairs', 'admin'].includes(user.role)) return fail('仅总务可处理追责/调拨建议', 403);
    if (!['accepted', 'rejected'].includes(body.decision)) return fail('决策非法');
    await query('UPDATE mispack_actions SET status=?, handled_by=?, handled_at=NOW() WHERE id=? AND event_id=?',
      [body.decision, user.id, body.action_id, e.id]);
    const a = await one<any>('SELECT * FROM mispack_actions WHERE id=?', [body.action_id]);
    await logActivity({ actor: user, action: body.decision === 'accepted' ? '采纳错包处置建议' : '驳回错包处置建议', detail: `${e.event_no} ${a?.kind}` });
    return ok();
  }

  return fail('未知操作');
});

// 双签全部完成 → 自动闭环：关闭工单、解冻发放场次、同步供应商考核
async function tryAutoClose(eventId: number, actor: any) {
  const e = await one<any>('SELECT * FROM mispack_events WHERE id=?', [eventId]);
  if (!e || e.status !== 'resending') return;
  const stat = await one<any>(
    `SELECT
        COALESCE(SUM(already_signed=0 AND disposition='resend'),0) need_cnt,
        COALESCE(SUM(already_signed=0 AND disposition='resend' AND student_signed=1 AND teacher_reviewed=1),0) done_cnt,
        COALESCE(SUM(already_signed=0 AND disposition='pending'),0) pending_cnt
       FROM mispack_items WHERE event_id=?`, [eventId]);
  if (Number(stat.done_cnt) < Number(stat.need_cnt) || Number(stat.pending_cnt) > 0) return;

  await tx(async (conn) => {
    await conn.query(
      `UPDATE mispack_events SET status='closed', closed_at=NOW(),
          close_note='全部补发件经学生实际签收与班主任复核双签闭环' WHERE id=?`, [eventId]);
    await conn.query(
      `UPDATE aftersales_cases ac JOIN mispack_items mi ON mi.case_id=ac.id
          SET ac.status='resolved', ac.resolution='错包补发双签闭环', ac.resolved_at=NOW()
        WHERE mi.event_id=? AND ac.status<>'resolved'`, [eventId]);
    await unfreezeEvent(conn, eventId);
    const [pkRows] = await conn.query('SELECT DISTINCT package_id FROM mispack_items WHERE event_id=? AND package_id IS NOT NULL', [eventId]);
    for (const r of pkRows as any[]) await conn.query("UPDATE packages SET status='consumed' WHERE id=?", [r.package_id]);
    await conn.query(
      `INSERT INTO activity_log (actor_role,actor_name,action,detail) VALUES (?,?,?,?)`,
      [actor.role, actor.real_name, '错包事件闭环', `${e.event_no} 双签完成，相关发放场次解冻，无关班级发放不受影响`]);
  });
  await syncAssessment(e);
  await logActivity({ actor, action: '错包事件自动闭环', detail: e.event_no });
}

// 平台同步更新供应商考核：该计划已有考核则错包数 +1，否则留待考核时自动统计
async function syncAssessment(e: any) {
  const a = await one<any>('SELECT id, mispack_count FROM supplier_assessments WHERE plan_id=? ORDER BY id DESC LIMIT 1', [e.plan_id]);
  if (a) await query('UPDATE supplier_assessments SET mispack_count=mispack_count+1 WHERE id=?', [a.id]);
}
