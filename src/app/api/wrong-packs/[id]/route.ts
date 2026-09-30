import { NextRequest } from 'next/server';
import { one, query, tx } from '@/lib/db';
import { api, ok, fail, logActivity } from '@/lib/api';
import { logWrongPack, buildTransferSuggestion } from '@/lib/wrong-pack';

// 错包工单详情：受影响名单、冻结批次、处置时间线、追责单
export const GET = api(async (_req: any, _b: any, user, ctx) => {
  const id = ctx.params.id;
  const wpc = await one<any>(
    `SELECT wpc.*, su.name supplier_name, cp.name campus_name, p.name plan_name,
            pb.batch_no, sh.shipment_no,
            ur.real_name reviewer_real, ut.real_name teacher_real
       FROM wrong_pack_cases wpc
       JOIN suppliers su ON su.id=wpc.supplier_id
       JOIN campuses cp ON cp.id=wpc.campus_id
       JOIN plans p ON p.id=wpc.plan_id
       LEFT JOIN production_batches pb ON pb.id=wpc.batch_id
       LEFT JOIN shipments sh ON sh.id=wpc.shipment_id
       LEFT JOIN users ur ON ur.id=wpc.reviewed_by
       LEFT JOIN users ut ON ut.id=wpc.teacher_reviewed_by
      WHERE wpc.id=?`, [id]);
  if (!wpc) return fail('错包工单不存在', 404);

  let items = await query(
    `SELECT wpi.*, s.student_no, s.name student_name, s.parent_user_id,
            c.name class_name, oi.name item_name, oi.size, oi.garment_type, oi.plan_item_id,
            pc.pack_code
       FROM wrong_pack_items wpi
       JOIN students s ON s.id=wpi.student_id
       JOIN classes c ON c.id=wpi.class_id
       JOIN order_items oi ON oi.id=wpi.order_item_id
       LEFT JOIN pack_codes pc ON pc.id=wpi.pack_code_id
      WHERE wpi.case_id=? ORDER BY c.id, s.student_no`, [id]);
  if (user.role === 'parent') items = items.filter((i: any) => i.parent_user_id === user.id);

  const [freezes, logs, liabilities] = await Promise.all([
    query(
      `SELECT wpf.*, d.name distribution_name, d.scheduled_at, d.status dist_status
         FROM wrong_pack_freezes wpf JOIN distributions d ON d.id=wpf.distribution_id
        WHERE wpf.case_id=? ORDER BY wpf.id`, [id]),
    query('SELECT * FROM wrong_pack_logs WHERE case_id=? ORDER BY id', [id]),
    query('SELECT * FROM supplier_liabilities WHERE case_id=? ORDER BY id', [id]),
  ]);
  return ok({ wpc, items, freezes, logs, liabilities });
});

// 名单核对：纳入/排除单件（已签收或已找到原包的学生可排除，避免重复发放）
async function tuneItem(conn: any, c: any, body: any, user: any) {
  const wpi = await one<any>('SELECT * FROM wrong_pack_items WHERE id=? AND case_id=?', [body.item_id, c.id]);
  if (!wpi) throw Object.assign(new Error('受影响明细不存在'), { status: 404 });
  if (body.included) {
    await conn.query("UPDATE wrong_pack_items SET item_status='affected', exclude_reason=NULL WHERE id=?", [wpi.id]);
  } else {
    await conn.query("UPDATE wrong_pack_items SET item_status='excluded', exclude_reason=? WHERE id=?",
      [body.reason || '核对后排除（已签收/原包已找回）', wpi.id]);
  }
  await logWrongPack(conn, c.id, user, body.included ? '核对纳入名单' : '核对排除名单',
    `明细#${wpi.id} ${body.included ? '' : body.reason || '排除'}`);
}

// 总务审核受影响名单：决定优先补发还是延后发放
async function review(conn: any, c: any, body: any, user: any) {
  if (!['priority_resend', 'defer_release'].includes(body.decision)) throw Object.assign(new Error('请选择优先补发或延后发放'), { status: 400 });
  await conn.query(
    `UPDATE wrong_pack_cases
        SET review_decision=?, reviewed_by=?, reviewed_at=NOW(), review_note=?, status='to_repack'
      WHERE id=?`,
    [body.decision, user.id, body.note || null, c.id]);
  await logWrongPack(conn, c.id, user, '总务审核名单',
    body.decision === 'priority_resend' ? `决定优先补发：${body.note || ''}` : `决定延后发放：${body.note || ''}`);
}

// 供应商重新分拣登记：操作人、原包去向、补发单号、预计到校时间（延后发放可只登记原包去向）
async function repack(conn: any, c: any, body: any, user: any) {
  if (c.review_decision === 'pending') throw Object.assign(new Error('总务尚未审核受影响名单，不能重新分拣'), { status: 400 });
  if (!body.operator || !body.original_pack_destination) throw Object.assign(new Error('请登记分拣操作人与原包去向'), { status: 400 });
  const withResend = !!body.resend_tracking_no && !!body.resend_expected_arrival;
  await conn.query(
    `UPDATE wrong_pack_cases
        SET repack_operator=?, original_pack_destination=?, repack_remark=?, repacked_at=NOW(),
            resend_tracking_no=COALESCE(?,resend_tracking_no),
            resend_expected_arrival=COALESCE(?,resend_expected_arrival),
            resend_shipped_at=${withResend ? 'COALESCE(?, NOW())' : 'resend_shipped_at'},
            status=${withResend ? "'resending'" : "'to_repack'"}
      WHERE id=?`,
    withResend
      ? [body.operator, body.original_pack_destination, body.remark || null,
         body.resend_tracking_no, body.resend_expected_arrival, body.shipped_at || null, c.id]
      : [body.operator, body.original_pack_destination, body.remark || null,
         body.resend_tracking_no || null, body.resend_expected_arrival || null, c.id]);
  if (withResend) {
    await conn.query(
      `UPDATE wrong_pack_items SET resend_tracking_no=?, item_status='resending'
        WHERE case_id=? AND item_status='affected'`,
      [body.resend_tracking_no, c.id]);
  }
  await logWrongPack(conn, c.id, user, '供应商重新分拣登记',
    `操作人：${body.operator}；原包去向：${body.original_pack_destination}${withResend ? `；补发单号 ${body.resend_tracking_no}，预计 ${body.resend_expected_arrival} 到校` : '（延后发放，暂不补发）'}`);
  await conn.query(
    'INSERT INTO activity_log (actor_role,actor_name,action,detail) VALUES (?,?,?,?)',
    [user.role, user.real_name, '错包重新分拣', `${c.case_no}：${body.original_pack_destination}`]);
}

// 延后发放场景下，供应商后续补登记补发单号
async function resendShip(conn: any, c: any, body: any) {
  if (!body.resend_tracking_no || !body.resend_expected_arrival) throw Object.assign(new Error('请填写补发单号与预计到校时间'), { status: 400 });
  await conn.query(
    `UPDATE wrong_pack_cases
        SET resend_tracking_no=?, resend_expected_arrival=?, resend_shipped_at=COALESCE(?, NOW()),
            resend_overdue=0, status='resending'
      WHERE id=?`,
    [body.resend_tracking_no, body.resend_expected_arrival, body.shipped_at || null, c.id]);
  await conn.query(
    `UPDATE wrong_pack_items SET resend_tracking_no=?, item_status='resending'
      WHERE case_id=? AND item_status='affected'`, [body.resend_tracking_no, c.id]);
  await logWrongPack(conn, c.id, { role: 'supplier', real_name: c.supplier_name }, '补登记补发单号',
    `${body.resend_tracking_no}，预计 ${body.resend_expected_arrival} 到校`);
}

async function resendArrive(conn: any, c: any, user: any) {
  await conn.query('UPDATE wrong_pack_cases SET resend_arrived_at=NOW() WHERE id=?', [c.id]);
  await logWrongPack(conn, c.id, user, '补发校服到校', `补发单号 ${c.resend_tracking_no || ''}`);
}

// 学生实际签收（逐件登记）；已签收学生不会再出现于名单，杜绝重复发放
async function studentSign(conn: any, c: any, body: any, user: any) {
  const wpi = await one<any>('SELECT * FROM wrong_pack_items WHERE id=? AND case_id=?', [body.item_id, c.id]);
  if (!wpi) throw Object.assign(new Error('受影响明细不存在'), { status: 404 });
  if (user.role === 'head_teacher') {
    const cls = await one<any>('SELECT teacher_user_id FROM classes WHERE id=?', [wpi.class_id]);
    if (!cls || cls.teacher_user_id !== user.id) throw Object.assign(new Error('班主任只能登记本班学生的签收'), { status: 403 });
  }
  if (wpi.item_status === 'excluded') throw Object.assign(new Error('该件已被核对排除，无需签收'), { status: 400 });
  if (wpi.student_signed_at) throw Object.assign(new Error('该生已实际签收，不能重复登记'), { status: 400 });
  if (c.review_decision === 'priority_resend' && !c.resend_arrived_at) throw Object.assign(new Error('补发尚未到校，不能签收'), { status: 400 });
  const signer = body.signed_by || user.real_name;
  await conn.query(
    `UPDATE wrong_pack_items SET student_signed_by=?, student_signed_at=NOW(), item_status='signed' WHERE id=?`,
    [signer, wpi.id]);
  // 同步发放链路：写一条已签收的补发记录到被冻结的本班发放场，并累计订单签收数
  const fz = await one<any>('SELECT distribution_id FROM wrong_pack_freezes WHERE case_id=? AND class_id=? LIMIT 1', [c.id, wpi.class_id]);
  if (fz) {
    const exists = await one('SELECT id FROM receipts WHERE distribution_id=? AND order_item_id=?', [fz.distribution_id, wpi.order_item_id]);
    if (!exists) {
      await conn.query(
        `INSERT INTO receipts (distribution_id,order_item_id,student_id,qty,status,signed_by,signed_at,handled,issued_at)
         VALUES (?,?,?,1,'signed',?,NOW(),1,NOW())`,
        [fz.distribution_id, wpi.order_item_id, wpi.student_id, signer]);
    } else {
      await conn.query("UPDATE receipts SET status='signed', signed_by=?, signed_at=NOW(), handled=1 WHERE id=?",
        [signer, exists.id]);
    }
  }
  if (!wpi.already_signed) await conn.query('UPDATE order_items SET signed_qty=signed_qty+1 WHERE id=?', [wpi.order_item_id]);
  // 工单层记录最后一次签收（必须用事务连接，才能读到本次未提交的签收更新）
  const [remainRows]: any = await conn.query(
    `SELECT COUNT(*) n FROM wrong_pack_items WHERE case_id=? AND item_status<>'excluded' AND student_signed_at IS NULL`, [c.id]);
  if (Number(remainRows[0].n) === 0) {
    await conn.query('UPDATE wrong_pack_cases SET student_signed_by=?, student_signed_at=NOW() WHERE id=?', [signer, c.id]);
  }
  await logWrongPack(conn, c.id, user, '学生实际签收', `明细#${wpi.id} 签收人：${signer}`);
  await conn.query(
    'INSERT INTO activity_log (student_id,actor_role,actor_name,action,detail) VALUES (?,?,?,?,?)',
    [wpi.student_id, user.role, user.real_name, '错包补发签收', `${c.case_no}：${signer}`]);
}

// 班主任逐件复核；所有应补件均"学生签收+班主任复核"后自动闭环并解冻相关发放批次
async function teacherReview(conn: any, c: any, body: any, user: any) {
  const wpi = await one<any>('SELECT * FROM wrong_pack_items WHERE id=? AND case_id=?', [body.item_id, c.id]);
  if (!wpi) throw Object.assign(new Error('受影响明细不存在'), { status: 404 });
  if (user.role === 'head_teacher') {
    const cls = await one<any>('SELECT teacher_user_id FROM classes WHERE id=?', [wpi.class_id]);
    if (!cls || cls.teacher_user_id !== user.id) throw Object.assign(new Error('班主任只能复核本班学生'), { status: 403 });
  }
  if (wpi.item_status === 'excluded') throw Object.assign(new Error('该件已被核对排除'), { status: 400 });
  if (!wpi.student_signed_at) throw Object.assign(new Error('学生尚未实际签收，不能复核'), { status: 400 });
  await conn.query('UPDATE wrong_pack_items SET teacher_reviewed_at=NOW() WHERE id=?', [wpi.id]);
  await logWrongPack(conn, c.id, user, '班主任复核', `明细#${wpi.id}`);

  const [pendingRows]: any = await conn.query(
    `SELECT COUNT(*) n FROM wrong_pack_items
      WHERE case_id=? AND item_status<>'excluded' AND (student_signed_at IS NULL OR teacher_reviewed_at IS NULL)`, [c.id]);
  if (Number(pendingRows[0].n) === 0) await closeCase(conn, c, user, '全部补发件学生签收且班主任复核完成');
}

async function closeCase(conn: any, c: any, user: any, note: string) {
  const [chkRows]: any = await conn.query(
    `SELECT COUNT(*) n FROM wrong_pack_items
      WHERE case_id=? AND item_status<>'excluded' AND (student_signed_at IS NULL OR teacher_reviewed_at IS NULL)`, [c.id]);
  if (Number(chkRows[0].n) > 0) throw Object.assign(new Error(`仍有 ${chkRows[0].n} 件未完成学生签收或班主任复核，不能闭环`), { status: 400 });
  await conn.query(
    `UPDATE wrong_pack_cases
        SET status='closed', teacher_reviewed_by=COALESCE(teacher_reviewed_by,?), teacher_reviewed_at=COALESCE(teacher_reviewed_at,NOW()),
            closed_at=NOW() WHERE id=?`, [user.id, c.id]);
  // 解冻相关发放批次（无关班级本来就未冻结；同一场次若仍被其他错包工单冻结则保持冻结）
  await conn.query('UPDATE wrong_pack_freezes SET unfrozen=1, unfrozen_at=NOW() WHERE case_id=? AND unfrozen=0', [c.id]);
  await conn.query(
    `UPDATE distributions SET frozen=0, freeze_reason=NULL
      WHERE id IN (SELECT distribution_id FROM wrong_pack_freezes WHERE case_id=?)
        AND id NOT IN (
          SELECT distribution_id FROM (
            SELECT wpf2.distribution_id FROM wrong_pack_freezes wpf2
             WHERE wpf2.unfrozen=0 AND wpf2.case_id<>?
          ) still_frozen
        )`, [c.id, c.id]);
  await conn.query("UPDATE pack_codes SET status='closed' WHERE id IN (SELECT DISTINCT pack_code_id FROM wrong_pack_items WHERE case_id=? AND pack_code_id IS NOT NULL)", [c.id]);
  await logWrongPack(conn, c.id, user, '错包闭环', note);
  await conn.query(
    'INSERT INTO activity_log (actor_role,actor_name,action,detail) VALUES (?,?,?,?)',
    [user.role, user.real_name, '错包工单闭环', `${c.case_no}：${note}，相关发放批次已解冻`]);
}

export const POST = api(async (_req: NextRequest, body: any, user) => {
  const c = await one<any>('SELECT * FROM wrong_pack_cases WHERE id=?', [body.id]);
  if (!c) return fail('错包工单不存在', 404);

  const staff = ['general_affairs', 'admin'];
  const supplierSide = ['supplier', 'factory', 'admin'];
  const teacherSide = ['head_teacher', 'general_affairs', 'admin'];

  try {
    await tx(async (conn) => {
      switch (body.action) {
        case 'tune_item':
          if (!staff.includes(user.role)) throw Object.assign(new Error('仅总务可核对名单'), { status: 403 });
          if (c.status !== 'to_check') throw Object.assign(new Error('仅待核对状态可调整名单'), { status: 400 });
          await tuneItem(conn, c, body, user); break;
        case 'review':
          if (!staff.includes(user.role)) throw Object.assign(new Error('仅总务可审核处置决定'), { status: 403 });
          if (c.status !== 'to_check') throw Object.assign(new Error('当前状态不能审核'), { status: 400 });
          await review(conn, c, body, user); break;
        case 'repack':
          if (!supplierSide.includes(user.role)) throw Object.assign(new Error('仅供应商可登记重新分拣'), { status: 403 });
          if (!['to_repack', 'resending'].includes(c.status)) throw Object.assign(new Error('当前状态不能分拣'), { status: 400 });
          await repack(conn, c, body, user); break;
        case 'resend_ship':
          if (!supplierSide.includes(user.role)) throw Object.assign(new Error('无权限'), { status: 403 });
          if (!['to_repack', 'resending'].includes(c.status)) throw Object.assign(new Error('当前状态不能补发'), { status: 400 });
          await resendShip(conn, c, body); break;
        case 'resend_arrive':
          if (!staff.includes(user.role) && user.role !== 'head_teacher') throw Object.assign(new Error('无权限'), { status: 403 });
          if (c.status !== 'resending') throw Object.assign(new Error('补发中状态才能确认到校'), { status: 400 });
          await resendArrive(conn, c, user); break;
        case 'student_sign':
          if (!teacherSide.includes(user.role)) throw Object.assign(new Error('无权限登记签收'), { status: 403 });
          await studentSign(conn, c, body, user); break;
        case 'teacher_review':
          if (!teacherSide.includes(user.role)) throw Object.assign(new Error('无权限复核'), { status: 403 });
          await teacherReview(conn, c, body, user); break;
        case 'close':
          if (!staff.includes(user.role) && user.role !== 'head_teacher') throw Object.assign(new Error('无权限闭环'), { status: 403 });
          await closeCase(conn, c, user, body.note || '人工确认闭环'); break;
        default:
          throw Object.assign(new Error('未知操作'), { status: 400 });
      }
    });
    return ok();
  } catch (e: any) {
    return fail(e.message, e.status || 400);
  }
});
