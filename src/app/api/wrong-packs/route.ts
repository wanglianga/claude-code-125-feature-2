import { NextRequest } from 'next/server';
import { query, one, tx } from '@/lib/db';
import { api, ok, fail, logActivity, genNo } from '@/lib/api';
import { runOverdueChecks, logWrongPack } from '@/lib/wrong-pack';

// 错包工单列表（打开列表时自动执行补发超时巡检，自动生成追责单与调拨建议）
export const GET = api(async (req: NextRequest, _b: any, user) => {
  await runOverdueChecks();
  const sp = req.nextUrl.searchParams;
  const where: string[] = [];
  const params: any[] = [];
  if (sp.get('status')) { where.push('wpc.status=?'); params.push(sp.get('status')); }
  if (sp.get('plan_id')) { where.push('wpc.plan_id=?'); params.push(sp.get('plan_id')); }
  if (user.role === 'supplier' || user.role === 'factory') { where.push('wpc.supplier_id=?'); params.push(user.supplier_id); }
  if (user.role === 'head_teacher') {
    where.push('wpc.id IN (SELECT wpi.case_id FROM wrong_pack_items wpi JOIN classes c ON c.id=wpi.class_id WHERE c.teacher_user_id=?)');
    params.push(user.id);
  }
  if (user.role === 'parent') {
    where.push('wpc.id IN (SELECT wpi.case_id FROM wrong_pack_items wpi JOIN students s ON s.id=wpi.student_id WHERE s.parent_user_id=?)');
    params.push(user.id);
  }
  const rows = await query(
    `SELECT wpc.*, su.name supplier_name, cp.name campus_name, p.name plan_name,
            u.real_name reviewer_name,
            (SELECT COUNT(*) FROM wrong_pack_items wpi WHERE wpi.case_id=wpc.id) affected_cnt,
            (SELECT COUNT(*) FROM wrong_pack_items wpi WHERE wpi.case_id=wpc.id AND wpi.item_status IN ('affected','resending')) pending_cnt,
            (SELECT COUNT(*) FROM wrong_pack_items wpi WHERE wpi.case_id=wpc.id AND wpi.already_signed=1) signed_cnt,
            (SELECT COUNT(*) FROM wrong_pack_freezes wpf WHERE wpf.case_id=wpc.id AND wpf.unfrozen=0) frozen_cnt,
            (SELECT COUNT(*) FROM supplier_liabilities sl WHERE sl.case_id=wpc.id) liability_cnt
       FROM wrong_pack_cases wpc
       JOIN suppliers su ON su.id=wpc.supplier_id
       JOIN campuses cp ON cp.id=wpc.campus_id
       JOIN plans p ON p.id=wpc.plan_id
       LEFT JOIN users u ON u.id=wpc.reviewed_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY wpc.id DESC`, params);
  return ok({ cases: rows });
});

// 登记错包：根据包装码/学生订单/班级签收/未发放清单定位范围，并仅冻结相关班级的发放批次
export const POST = api(async (_req: NextRequest, body: any, user) => {
  const packIds: number[] = (body.pack_code_ids || []).map(Number).filter(Boolean);
  const manualOiIds: number[] = (body.order_item_ids || []).map(Number).filter(Boolean);
  if (!packIds.length && !manualOiIds.length) return fail('请选择涉事包装码或受影响订单明细');

  const packs = packIds.length
    ? await query<any>(
        `SELECT pc.*, pb.supplier_id, pb.plan_id, sh.id shipment_id_real
           FROM pack_codes pc
           LEFT JOIN production_batches pb ON pb.id=pc.batch_id
           LEFT JOIN shipments sh ON sh.id=pc.shipment_id
          WHERE pc.id IN (?)`, [packIds])
    : [];
  if (packIds.length && packs.length !== packIds.length) return fail('部分包装码不存在');

  // 汇总涉事订单明细（包装明细 + 手工勾选的未发放明细）
  let oiIds: number[] = [...manualOiIds];
  if (packIds.length) {
    const fromPacks = await query<any>('SELECT DISTINCT order_item_id FROM pack_items WHERE pack_code_id IN (?)', [packIds]);
    oiIds = [...new Set([...oiIds, ...fromPacks.map((r) => r.order_item_id)])];
  }
  const oiRows = await query<any>(
    `SELECT oi.id order_item_id, oi.plan_item_id, oi.name item_name, oi.size,
            o.id order_id, o.student_id, o.class_id, o.plan_id,
            g.campus_id, s.parent_user_id
       FROM order_items oi
       JOIN orders o ON o.id=oi.order_id
       JOIN students s ON s.id=o.student_id
       JOIN classes c ON c.id=o.class_id
       JOIN grades g ON g.id=c.grade_id
      WHERE oi.id IN (?)`,
    [oiIds]);
  if (!oiRows.length) return fail('未定位到受影响学生名单');

  const planId = Number(body.plan_id) || oiRows[0].plan_id;
  const plan = await one<any>('SELECT * FROM plans WHERE id=?', [planId]);
  if (!plan) return fail('订购计划不存在', 404);
  const campusId = oiRows[0].campus_id;
  // 仅冻结"仍有待补（未签收）件"的班级；已全部签收的班级无需冻结
  const classIds = [...new Set(oiRows.filter((r) => !signedSet.has(r.order_item_id)).map((r) => r.class_id))];
  if (!classIds.length) return fail('定位到的学生均已实际签收，无需冻结或补发');

  // 是否已签收：按订单明细查最新签收（已签收学生不重复发放）
  const signedSet = new Set<number>();
  const signedRows = await query<any>(
    `SELECT DISTINCT order_item_id FROM receipts WHERE status='signed' AND order_item_id IN (?)`,
    [oiRows.map((r) => r.order_item_id)]);
  signedRows.forEach((r) => signedSet.add(r.order_item_id));

  // 触发原因：显式指定优先；否则任一包装码存在重复扫描 → duplicate_scan，有混装 → mixed_pack
  let trigger = '';
  const dupScan = packIds.length
    ? await one(`SELECT 1 FROM pack_scans WHERE pack_code_id IN (?) AND duplicate=1 LIMIT 1`, [packIds])
    : null;
  const hasMismatch = packs.some((p) => p.status === 'mixed')
    || !!(await one('SELECT 1 FROM pack_items WHERE pack_code_id IN (?) AND mismatch=1 LIMIT 1', [packIds.length ? packIds : [0]]));
  if (['mixed_pack', 'duplicate_scan', 'class_signoff_mismatch'].includes(body.trigger_reason)) trigger = body.trigger_reason;
  if (!trigger) trigger = dupScan ? 'duplicate_scan' : 'mixed_pack';
  const shipmentId = packs[0]?.shipment_id || packs[0]?.shipment_id_real || null;
  const batchId = packs[0]?.batch_id || null;
  const packMap = new Map<number, number>();
  if (packIds.length) {
    const pim = await query<any>('SELECT id, pack_code_id, order_item_id FROM pack_items WHERE pack_code_id IN (?)', [packIds]);
    pim.forEach((r) => packMap.set(r.order_item_id, r.pack_code_id));
  }

  // 冻结范围：受影响班级中未结束的发放批次（场），外加显式指定的场次；无关班级不动
  let freezeDistIds: number[] = (body.distribution_ids || []).map(Number).filter(Boolean);
  const autoDists = await query<any>(
    `SELECT id FROM distributions WHERE class_id IN (?) AND status IN ('planned','in_progress') AND frozen=0`,
    [classIds]);
  freezeDistIds = [...new Set([...freezeDistIds, ...autoDists.map((d) => d.id)])];

  const caseNo = genNo('WP');
  const title = body.title || `两班尺码包混装错包处理（${classIds.length}个班级 / ${oiRows.length}件）`;

  const caseId = await tx(async (conn) => {
    const [cr]: any = await conn.query(
      `INSERT INTO wrong_pack_cases
        (case_no,plan_id,campus_id,supplier_id,shipment_id,batch_id,title,status,trigger_reason,description,created_by)
       VALUES (?,?,?,?,?,?,?, 'to_check', ?, ?, ?)`,
      [caseNo, planId, campusId, plan.supplier_id, shipmentId || (packs[0]?.shipment_id_real || null),
       batchId, title, trigger, body.description || '供应商到校尺码包混装，平台按学生订单/包装码/生产批次/班级签收/未发放清单定位', user.id]);
    const cid = cr.insertId;

    for (const r of oiRows) {
      const isSigned = signedSet.has(r.order_item_id);
      await conn.query(
        `INSERT INTO wrong_pack_items
          (case_id,student_id,order_item_id,class_id,pack_code_id,already_signed,item_status,exclude_reason)
         VALUES (?,?,?,?,?,?,?,?)`,
        [cid, r.student_id, r.order_item_id, r.class_id, packMap.get(r.order_item_id) || null,
         isSigned ? 1 : 0, isSigned ? 'excluded' : 'affected',
         isSigned ? '该生已实际签收，不纳入补发，避免重复发放' : null]);
    }

    // 仅冻结相关班级的发放批次，而不是整校停发
    for (const did of freezeDistIds) {
      const d = await one<any>('SELECT * FROM distributions WHERE id=?', [did]);
      if (!d || !classIds.includes(d.class_id)) continue;
      await conn.query(
        `INSERT INTO wrong_pack_freezes (case_id,distribution_id,class_id,reason,frozen_by)
         VALUES (?,?,?,?,?)`,
        [cid, d.id, d.class_id, `错包 ${caseNo}：${title}`, user.id]);
      await conn.query('UPDATE distributions SET frozen=1, freeze_reason=? WHERE id=?',
        [`错包 ${caseNo} 待核对，暂停本班发放（无关班级不受影响）`, d.id]);
      await conn.query(
        'INSERT INTO activity_log (actor_role,actor_name,action,detail) VALUES (?,?,?,?)',
        [user.role, user.real_name, '冻结发放批次', `${d.name}（班级#${d.class_id}）因错包 ${caseNo} 冻结`]);
    }
    for (const pid of packIds) {
      await conn.query("UPDATE pack_codes SET status='frozen' WHERE id=?", [pid]);
    }
    await logWrongPack(conn, cid, user, '登记错包',
      `触发：${trigger}；受影响 ${oiRows.length} 件，已签收 ${signedSet.size} 件；冻结 ${freezeDistIds.length} 个本班发放批次`);
    return cid;
  });

  for (const r of oiRows) {
    await logActivity({ student_id: r.student_id, order_id: r.order_id, actor: user,
      action: '错包范围定位', detail: `${caseNo}：${r.item_name}(${r.size})${signedSet.has(r.order_item_id) ? '（已签收，不重复发放）' : ''}` });
  }
  return ok({ id: caseId, case_no: caseNo, affected: oiRows.length, signed: signedSet.size, frozen_distributions: freezeDistIds.length });
}, ['general_affairs', 'head_teacher', 'admin']);
