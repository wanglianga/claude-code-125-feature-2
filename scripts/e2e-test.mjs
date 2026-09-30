// 端到端工作流验证：覆盖全部角色与异常场景
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
let cookie = '';
let pass = 0, fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  if (!res.ok || (json && json.ok === false)) {
    throw new Error(`${method} ${path} -> ${res.status}: ${json?.error || text.slice(0, 200)}`);
  }
  return json;
}
async function login(u) { cookie = ''; return req('POST', '/api/auth/login', { username: u, password: 'uniform123' }); }
const find = (arr, pred) => { const r = arr.find(pred); if (!r) throw new Error('not found: ' + pred.toString().slice(0, 80)); return r; };

(async () => {
  // 1. 登录与权限
  console.log('① 登录/权限');
  await login('gys');
  let r = await req('GET', '/api/plans');
  check('供应商只看到自己的计划', r.plans.length >= 2 && r.plans.every((p) => p.supplier_name.includes('锦绣')));
  r = await req('GET', '/api/dashboard/production-blockers');
  const linBlockBefore = r.blocked.filter((b) => b.student_name === '林小雨');
  check('供应商看到林小雨订单不可投产（未缴费）', linBlockBefore.length === 1, JSON.stringify(linBlockBefore));
  let blocked = false;
  try { await req('POST', '/api/plans', { name: 'x' }); } catch { blocked = true; }
  check('供应商不能创建订购计划', blocked);

  await login('chen_ma');
  r = await req('GET', '/api/students');
  check('家长只能看到自己孩子', r.students.length === 1 && r.students[0].name === '陈晓');
  const chenId = r.students[0].id;
  r = await req('GET', '/api/orders');
  check('家长看到自己订单', r.orders.length >= 1);
  const chenOrder = find(r.orders, (o) => o.student_name === '陈晓');

  // 2. 计划详情带试穿建议
  console.log('② 试穿建议带入下单');
  r = await req('GET', `/api/plans/${chenOrder.plan_id}?student_id=${chenId}`);
  check('陈晓试穿建议：上衣130/鞋34', r.fittingSuggestions?.top === '130' && r.fittingSuggestions?.shoes === '34',
    JSON.stringify(r.fittingSuggestions));

  // 3. 林小雨迟缴费：先挂起再缴费（超期路径），再解除/支付
  console.log('③ 林小雨缴费（投产前置条件）');
  await login('lin_ba');
  r = await req('GET', '/api/orders');
  const linOrder = find(r.orders, (o) => o.status === 'confirmed');
  await login('zw');
  await req('POST', `/api/orders/${linOrder.id}`, { id: linOrder.id, action: 'hold', reason: '迟缴费待核实' });
  r = await req('GET', `/api/orders/${linOrder.id}`);
  check('总务挂起迟缴费订单', r.order.status === 'hold');
  await req('POST', `/api/orders/${linOrder.id}`, { id: linOrder.id, action: 'release' });
  await login('lin_ba');
  await req('POST', `/api/orders/${linOrder.id}`, { id: linOrder.id, action: 'pay' });
  r = await req('GET', `/api/orders/${linOrder.id}`);
  check('家长缴费成功', r.order.status === 'paid' && Number(r.order.paid_amount) === Number(r.order.due_amount));
  await login('gys');
  r = await req('GET', '/api/dashboard/production-blockers');
  check('缴费后林小雨不再阻塞', !r.blocked.some((b) => b.student_name === '林小雨'));

  // 4. 供应商为林小雨明细建新批次（未分配的 120/120/33）
  console.log('④ 新批次：自动分配 FIFO');
  const p1 = find((await req('GET', '/api/plans')).plans, (p) => p.kind === 'annual');
  const pd = await req('GET', `/api/plans/${p1.id}`);
  const itemTop = find(pd.items, (i) => i.name === '春秋运动上衣');
  const itemPants = find(pd.items, (i) => i.name === '春秋运动长裤');
  const itemShoes = find(pd.items, (i) => i.name === '校鞋');
  r = await req('POST', '/api/batches', {
    plan_id: p1.id, name: '验证批次-林小雨补缴费', expected_arrival: '2026-11-01',
    lines: [
      { plan_item_id: itemTop.id, size: '120', qty: 1 },
      { plan_item_id: itemPants.id, size: '120', qty: 1 },
      { plan_item_id: itemShoes.id, size: '33', qty: 1 },
    ],
  });
  const newBatchId = r.id;
  r = await req('GET', `/api/batches/${newBatchId}`);
  check('批次自动分配到林小雨', r.lines.every((l) => l.alloc_detail.includes('林小雨')));
  // 可投产数量不足应报错
  let err = '';
  try {
    await req('POST', '/api/batches', { plan_id: p1.id, name: '超量批次', lines: [{ plan_item_id: itemTop.id, size: '999', qty: 5 }] });
  } catch (e) { err = e.message; }
  check('超量投产被拦截并提示差额', err.includes('可投产数量不足'), err);

  // 5. 开工→报产→分两批发货
  console.log('⑤ 开工/报产/分批发货');
  await req('POST', `/api/batches/${newBatchId}`, { id: newBatchId, action: 'start' });
  r = await req('GET', `/api/batches/${newBatchId}`);
  const produceLines = r.lines.map((l) => ({ batch_item_id: l.id, produced_qty: l.qty }));
  await req('POST', `/api/batches/${newBatchId}`, { id: newBatchId, action: 'produce', lines: produceLines });
  const cands = (await req('GET', `/api/batches/${newBatchId}/candidates`)).candidates;
  const candTop = find(cands, (c) => c.item_name === '春秋运动上衣');
  const candPants = find(cands, (c) => c.item_name === '春秋运动长裤');
  const candShoes = find(cands, (c) => c.item_name === '校鞋');
  // 第一批：上衣+裤子
  r = await req('POST', '/api/shipments', {
    batch_id: newBatchId, carrier: '顺达物流', tracking_no: 'SF111',
    shipped_at: '2026-10-28 09:00:00', expected_arrival: '2026-11-01',
    lines: [{ order_item_id: candTop.order_item_id, qty: 1 }, { order_item_id: candPants.order_item_id, qty: 1 }],
  });
  const ship1 = r.id;
  // 第二批：鞋
  r = await req('POST', '/api/shipments', {
    batch_id: newBatchId, carrier: '顺达物流', tracking_no: 'SF222',
    shipped_at: '2026-10-30 09:00:00', expected_arrival: '2026-11-03',
    lines: [{ order_item_id: candShoes.order_item_id, qty: 1 }],
  });
  const ship2 = r.id;
  check('一个批次支持分两批发货', ship1 && ship2 && ship1 !== ship2);

  // 6. 总务到校确认：第一批齐套，第二批工厂漏发（到校0）
  console.log('⑥ 到校确认与工厂漏发登记');
  await login('zw');
  let sl = (await req('GET', `/api/shipments/${ship1}`)).lines;
  await req('POST', `/api/shipments/${ship1}`, {
    id: ship1, lines: sl.map((l) => ({ id: l.id, arrived_qty: 1 })),
  });
  sl = (await req('GET', `/api/shipments/${ship2}`)).lines;
  await req('POST', `/api/shipments/${ship2}`, {
    id: ship2, lines: sl.map((l) => ({ id: l.id, arrived_qty: 0 })),
  });
  r = await req('GET', '/api/shipments');
  const s2row = find(r.shipments, (x) => x.id === ship2);
  check('漏发数量=1', Number(s2row.missing_qty) === 1, JSON.stringify(s2row));
  r = await req('GET', `/api/orders/${linOrder.id}`);
  const missLog = r.logs.some((l) => l.action === '确认到货-工厂漏发');
  check('漏发进入学生时间线', missLog);

  // 7. 分批发放：正常发放上衣，裤子登记班级错领
  console.log('⑦ 分批发放/错领/缺件');
  // 找一(1)班 id
  const cls = (await req('GET', '/api/classes')).classes;
  const c11 = find(cls, (c) => c.name === '一(1)班');
  r = await req('POST', '/api/distributions', {
    plan_id: p1.id, class_id: c11.id, name: '一(1)班验证发放场', kind: 'regular',
    scheduled_at: '2026-11-04 15:00:00', location: '一(1)班教室',
  });
  const dist1 = r.id;
  r = await req('GET', `/api/distributions/${dist1}`);
  const candIssueTop = find(r.candidates, (c) => c.item_name === '春秋运动上衣' && c.student_name === '林小雨');
  const candIssuePants = find(r.candidates, (c) => c.item_name === '春秋运动长裤' && c.student_name === '林小雨');
  await req('POST', `/api/distributions/${dist1}`, { distribution_id: dist1, action: 'set_status', status: 'in_progress' });
  await req('POST', `/api/distributions/${dist1}`, { distribution_id: dist1, action: 'issue', order_item_id: candIssueTop.order_item_id, status: 'issued' });
  await req('POST', `/api/distributions/${dist1}`, {
    distribution_id: dist1, action: 'issue', order_item_id: candIssuePants.order_item_id,
    status: 'wrong_claim', claimant_student_id: chenId, reason: '被陈晓错领',
  });
  r = await req('GET', `/api/distributions/${dist1}`);
  check('发放记录含正常+错领', r.receipts.some((x) => x.status === 'issued') && r.receipts.some((x) => x.status === 'wrong_claim'));
  const wrongReceipt = find(r.receipts, (x) => x.status === 'wrong_claim');
  check('错领记录未闭环', wrongReceipt.handled === 0);
  // 补领场安排
  r = await req('POST', '/api/distributions', {
    plan_id: p1.id, class_id: c11.id, name: '一(1)班补领场', kind: 'supplementary',
    scheduled_at: '2026-11-06 15:00:00', location: '一(1)班教室',
  });
  check('可安排补领场', r.id > 0);

  // 8. 售后全流程
  console.log('⑧ 售后：漏发补发 / 错领闭环 / 成长换码 / 过敏投诉 / 转学退款');
  // 8.1 林小雨漏发鞋 → 补发
  await login('lin_ba');
  const linStudent = (await req('GET', '/api/students')).students[0];
  r = await req('POST', '/api/cases', {
    student_id: linStudent.id, order_id: linOrder.id, order_item_id: candShoes.order_item_id,
    type: 'resend', reason: 'factory_missing', priority: 'high',
    description: '第二批到校确认校鞋漏发1双，申请补发',
  });
  const caseShoes = r.id;
  await login('kf');
  await req('POST', `/api/cases/${caseShoes}`, { id: caseShoes, action: 'resend', phase: 'request', order_item_id: candShoes.order_item_id, size: '33', qty: 1 });
  await req('POST', `/api/cases/${caseShoes}`, { id: caseShoes, action: 'resend', phase: 'shipped', tracking: 'RS001' });
  await req('POST', `/api/cases/${caseShoes}`, { id: caseShoes, action: 'resend', phase: 'arrived' });
  await req('POST', `/api/cases/${caseShoes}`, { id: caseShoes, action: 'resend', phase: 'done', resolution: '补发校鞋已补领' });
  r = await req('GET', `/api/cases/${caseShoes}`);
  check('漏发补发全流程闭环', r.case.status === 'resolved' && r.resends[0].status === 'done');

  // 8.2 错领工单（错领裤子找不回 → 补发）并闭环签收异常
  r = await req('POST', '/api/cases', {
    student_id: linStudent.id, order_id: linOrder.id, order_item_id: candPants.order_item_id,
    type: 'wrong_claim', reason: 'wrong_class_claim',
    description: '长裤被陈晓错领且无法找回，需补发',
  });
  const caseWrong = r.id;
  await req('POST', `/api/cases/${caseWrong}`, { id: caseWrong, action: 'resend', phase: 'request', order_item_id: candPants.order_item_id, size: '120', qty: 1 });
  await req('POST', `/api/cases/${caseWrong}`, { id: caseWrong, action: 'resend', phase: 'shipped' });
  await req('POST', `/api/cases/${caseWrong}`, { id: caseWrong, action: 'resend', phase: 'arrived' });
  await req('POST', `/api/cases/${caseWrong}`, { id: caseWrong, action: 'resend', phase: 'done' });
  r = await req('GET', `/api/distributions/${dist1}`);
  check('补发完成后错领签收记录自动闭环', find(r.receipts, (x) => x.id === wrongReceipt.id).handled === 1);

  // 8.3 陈晓换码（试穿偏差：上衣 130→140）
  await login('chen_ma');
  const chenDetail = await req('GET', `/api/orders/${chenOrder.id}`);
  const chenTopItem = find(chenDetail.items, (i) => i.garment_type === 'top');
  r = await req('POST', '/api/cases', {
    student_id: chenId, order_id: chenOrder.id, order_item_id: chenTopItem.id,
    type: 'exchange', reason: 'fitting_deviation',
    description: '成衣版型偏小，130紧绷，换140',
  });
  const caseEx = r.id;
  await login('gys');
  await req('POST', `/api/cases/${caseEx}`, { id: caseEx, action: 'exchange', phase: 'request', old_size: '130', new_size: '140' });
  await req('POST', `/api/cases/${caseEx}`, { id: caseEx, action: 'exchange', phase: 'returned', tracking: 'RET01' });
  await req('POST', `/api/cases/${caseEx}`, { id: caseEx, action: 'exchange', phase: 'reshipped', tracking: 'NEW01' });
  await req('POST', `/api/cases/${caseEx}`, { id: caseEx, action: 'exchange', phase: 'done', new_size: '140' });
  r = await req('GET', `/api/orders/${chenOrder.id}`);
  check('换码完成后订单明细尺码更新为140', find(r.items, (i) => i.id === chenTopItem.id).size === '140');

  // 8.4 何苗过敏投诉处理
  await login('kf');
  r = await req('GET', '/api/cases?status=open');
  const allergy = find(r.cases, (c) => c.reason === 'allergy');
  await req('POST', `/api/cases/${allergy.id}`, { id: allergy.id, action: 'resolve', resolution: '检测合格，提供纯棉换购' });
  r = await req('GET', `/api/cases/${allergy.id}`);
  check('面料过敏投诉可处理归档', r.case.status === 'resolved');

  // 8.5 转学 + 退款：孙朵朵
  await login('zw');
  let sunStudent;
  {
    const all = (await req('GET', '/api/students')).students;
    sunStudent = find(all, (s) => s.name === '孙朵朵');
  }
  r = await req('POST', '/api/students/transfer', { student_id: sunStudent.id });
  check('转学自动生成退款工单', Array.isArray(r.case_ids) && r.case_ids.length === 1, JSON.stringify(r));
  const transferCase = r.case_ids[0];
  r = await req('GET', `/api/cases/${transferCase}`);
  check('转学后订单挂起', (await req('GET', `/api/orders/${r.case.order_id}`)).order.status === 'hold');
  await req('POST', `/api/cases/${transferCase}`, { id: transferCase, action: 'refund', phase: 'approve' });
  await req('POST', `/api/cases/${transferCase}`, { id: transferCase, action: 'refund', phase: 'refunded' });
  r = await req('GET', `/api/cases/${transferCase}`);
  check('转学退款完成', r.refunds[0].status === 'refunded' && r.case.status === 'resolved');

  // 9. 贫困生减免金额
  console.log('⑨ 贫困生减免');
  const wuOrder = find((await req('GET', '/api/orders')).orders, (o) => o.student_name === '吴磊');
  check('吴磊减免50%', Number(wuOrder.subsidy_amount) === Number(wuOrder.payable_amount) * 0.5
    && Number(wuOrder.due_amount) === Number(wuOrder.payable_amount) * 0.5,
    `${wuOrder.subsidy_amount}/${wuOrder.payable_amount}`);

  // 10. 供应商考核自动统计
  console.log('⑩ 供应商考核');
  await req('POST', '/api/assessments', {
    supplier_id: wuOrder ? 1 : 1, plan_id: p1.id, period: '2026-2027验证', score: 88,
  });
  r = await req('GET', '/api/assessments');
  const a0 = r.assessments[0];
  check('考核自动统计漏发≥1', Number(a0.missing_count) >= 1, JSON.stringify({ m: a0.missing_count, al: a0.allergy_count, ex: a0.exchange_count }));

  // 11. 看板
  console.log('⑪ 进度看板按学生/班级汇总');
  r = await req('GET', `/api/dashboard/progress?plan_id=${p1.id}`);
  const chenRow = find(r.students, (x) => x.name === '陈晓');
  check('看板含缴费/试穿/签收列', chenRow.paid_cnt >= 1 && Number(chenRow.fitted) >= 1, JSON.stringify(chenRow));
  const classRow = find(r.classes, (x) => x.class_name === '一(1)班');
  check('班级汇总存在', classRow.students >= 4);

  // 12. 错包处理与批次可追溯
  console.log('⑫ 错包混装：定位/冻结/分拣/审核/双签闭环/超时追责');
  await login('zw');
  // 12.1 种子已生成超时工单，首次打开错包列表自动巡检 → 生成追责单+替代调拨建议
  r = await req('GET', '/api/wrong-packs');
  const overdueCase = find(r.cases, (c) => c.case_no === 'WP20260002');
  check('超时工单被巡检标记', overdueCase.resend_overdue === 1, JSON.stringify(overdueCase));
  let od = await req('GET', `/api/wrong-packs/${overdueCase.id}`);
  check('自动生成供应商追责单', od.liabilities.length >= 1 && od.liabilities[0].type === 'wrong_pack_overdue', JSON.stringify(od.liabilities));
  check('自动给出替代调拨建议', /替代调拨/.test(od.wpc.transfer_suggestion || ''), od.wpc.transfer_suggestion);

  // 12.2 待重新分拣的种子工单：供应商完成分拣+补发出校
  const wp1 = find(r.cases, (c) => c.case_no === 'WP20260001');
  let d1 = await req('GET', `/api/wrong-packs/${wp1.id}`);
  check('定位4件且1件已签收自动排除', d1.items.length === 4 && d1.items.filter((x) => x.item_status === 'excluded').length === 1);
  check('仅冻结两个相关班级发放批次', d1.freezes.length === 2 && d1.freezes.every((f) => !f.unfrozen));
  const frozenDistIds = d1.freezes.map((f) => f.distribution_id);
  const distList = (await req('GET', '/api/distributions')).distributions;
  const unrelated = find(distList, (x) => x.name.includes('六(1)班'));
  check('无关班级发放场未冻结可继续发放', unrelated.frozen === 0);

  // 12.3 冻结期间相关班级不能发放/确认整批
  const fzDist = await req('GET', `/api/distributions/${frozenDistIds[0]}`);
  let wpBlocked = false;
  try {
    await req('POST', `/api/distributions/${frozenDistIds[0]}`, { distribution_id: frozenDistIds[0], action: 'set_status', status: 'done' });
  } catch { wpBlocked = true; }
  check('冻结期间不能确认整批发放', wpBlocked);

  // 12.4 供应商重新分拣（已审核优先补发，需登记操作人/原包去向/补发单号/预计到校）
  await login('gys');
  await req('POST', `/api/wrong-packs/${wp1.id}`, {
    id: wp1.id, action: 'repack', operator: '仓库分拣 王军',
    original_pack_destination: '退回供应商仓库重新分拣', remark: 'E2E重新分拣',
    resend_tracking_no: 'RS-E2E-01', resend_expected_arrival: '2026-10-25',
  });
  d1 = await req('GET', `/api/wrong-packs/${wp1.id}`);
  check('分拣登记后进入补发中', d1.wpc.status === 'resending' && d1.wpc.resend_tracking_no === 'RS-E2E-01');
  check('分拣四要素已留痕', d1.wpc.repack_operator && d1.wpc.original_pack_destination && d1.wpc.resend_expected_arrival === '2026-10-25');

  // 缺字段应被拦截
  let repackErr = '';
  try { await req('POST', `/api/wrong-packs/${wp1.id}`, { id: wp1.id, action: 'repack', operator: '' }); } catch (e) { repackErr = e.message; }
  check('分拣必须登记操作人与原包去向', /操作人|原包去向/.test(repackErr), repackErr);

  // 12.5 总务确认到校 → 学生签收 + 班主任复核双签闭环
  await login('zw');
  await req('POST', `/api/wrong-packs/${wp1.id}`, { id: wp1.id, action: 'resend_arrive' });
  d1 = await req('GET', `/api/wrong-packs/${wp1.id}`);
  const pending = d1.items.filter((x) => x.item_status !== 'excluded');
  // 家长角色不能代签
  await login('chen_ma');
  let noSign = false;
  try { await req('POST', `/api/wrong-packs/${wp1.id}`, { id: wp1.id, action: 'student_sign', item_id: pending[0].id }); } catch { noSign = true; }
  check('家长不能直接登记错包签收', noSign);

  // 班主任逐件学生签收（按班级切换班主任：一(1)班王老师 / 二(1)班赵老师）
  const signLogin = async (className) => login(className.includes('一(1)') ? 'wangls' : 'zhaols');
  for (const it of pending) {
    await signLogin(it.class_name);
    await req('POST', `/api/wrong-packs/${wp1.id}`, { id: wp1.id, action: 'student_sign', item_id: it.id, signed_by: `${it.student_name}家长` });
  }
  // 未复核前不能闭环
  let earlyClose = false;
  await login('zw');
  try { await req('POST', `/api/wrong-packs/${wp1.id}`, { id: wp1.id, action: 'close' }); } catch { earlyClose = true; }
  check('缺班主任复核不能闭环', earlyClose);
  for (const it of pending) {
    await signLogin(it.class_name);
    await req('POST', `/api/wrong-packs/${wp1.id}`, { id: wp1.id, action: 'teacher_review', item_id: it.id });
  }
  await login('zw');
  d1 = await req('GET', `/api/wrong-packs/${wp1.id}`);
  check('双签完成自动闭环', d1.wpc.status === 'closed' && d1.wpc.closed_at);
  check('闭环后相关发放批次全部解冻', d1.freezes.every((f) => f.unfrozen === 1));
  const fd1 = await req('GET', `/api/distributions/${frozenDistIds[0]}`);
  check('发放场#1（一(1)班）已解冻可继续发放', fd1.distribution.frozen === 0);
  // 二(1)班发放场同时被另一起未闭环错包 WP20260002 冻结，WP20260001 闭环不能解除其他工单的冻结（精确到批次而非整校）
  const fd2 = await req('GET', `/api/distributions/${frozenDistIds[1]}`);
  check('发放场#2 因另一起错包未闭环仍冻结（非整校停发）', fd2.distribution.frozen === 1);
  check('补发件写入签收记录且已闭环', d1.items.filter((x) => x.item_status !== 'excluded').length === 3
    && d1.items.filter((x) => x.student_signed_at && x.teacher_reviewed_at).length >= 3);

  // 12.6 重复签收被拦截（防重复发放）
  const oneItem = pending[0];
  await signLogin(oneItem.class_name);
  let dupSign = false;
  try { await req('POST', `/api/wrong-packs/${wp1.id}`, { id: wp1.id, action: 'student_sign', item_id: oneItem.id }); } catch { dupSign = true; }
  check('已签收学生不能重复发放', dupSign);

  // 12.7 包装码重复扫描识别（PK-MD-1001 种子里已有两次扫描）
  await login('wangls');
  const packs = (await req('GET', '/api/pack-codes')).packs;
  const pk1 = find(packs, (p) => p.pack_code === 'PK-MD-1001');
  const pk2 = find(packs, (p) => p.pack_code === 'PK-MD-1002');
  const sr = await req('POST', `/api/pack-codes/${pk1.id}`, { id: pk1.id, distribution_id: null });
  check('同一包装码再次扫描判为重复', sr.duplicate === true);

  // 12.8 新登记一个错包：仅勾选重复扫描包装码，验证按包装码定位+自动冻结
  await login('zw');
  // 二(1)班场次仍被 WP20260002 冻结；新建一个未结束场次用于自动冻结验证
  const c21Cls = find((await req('GET', '/api/classes')).classes, (c) => c.name === '二(1)班');
  const newDist = (await req('POST', '/api/distributions', {
    plan_id: p1.id, class_id: c21Cls.id, name: '二(1)班补领验证场', kind: 'supplementary',
    scheduled_at: '2026-11-08 15:00:00', location: '二(1)班教室',
  })).id;
  const cr = await req('POST', '/api/wrong-packs', {
    pack_code_ids: [pk2.id], trigger_reason: 'duplicate_scan', title: 'E2E重复扫描冻结验证',
  });
  // PK-MD-1002 内陈晓外套已在 WP20260001 双签时签收，应自动排除，郑好上衣仍待补
  check('按包装码定位且已签收件自动排除', cr.affected >= 1 && cr.signed >= 1 && cr.frozen_distributions >= 1, JSON.stringify(cr));
  const nd = await req('GET', `/api/distributions/${newDist}`);
  check('新错包自动冻结相关班级新发放批次', nd.distribution.frozen === 1);

  // 无关班级（六(1)班）发放场可正常确认整批发放
  const c61Dist = find((await req('GET', '/api/distributions')).distributions, (x) => x.name.includes('六(1)班'));
  await req('POST', `/api/distributions/${c61Dist.id}`, { distribution_id: c61Dist.id, action: 'set_status', status: 'in_progress' }).catch(() => {});
  await req('POST', `/api/distributions/${c61Dist.id}`, { distribution_id: c61Dist.id, action: 'set_status', status: 'done' });
  const c61Done = await req('GET', `/api/distributions/${c61Dist.id}`);
  check('无关班级可正常确认整批发放', c61Done.distribution.status === 'done' && c61Done.distribution.frozen === 0);

  // 12.9 供应商考核自动统计错包数与超时数
  await req('POST', '/api/assessments', { supplier_id: 1, plan_id: p1.id, period: '2026-2027错包验证', score: 80 });
  const assess = (await req('GET', '/api/assessments')).assessments[0];
  check('考核自动统计错包与补发超时', Number(assess.wrongpack_count) >= 3 && Number(assess.wrongpack_delay_count) >= 1,
    JSON.stringify({ wp: assess.wrongpack_count, d: assess.wrongpack_delay_count }));

  // 12.10 看板与家长端同步
  r = await req('GET', `/api/dashboard/progress?plan_id=${p1.id}`);
  const c21Row = find(r.classes, (x) => x.class_name === '二(1)班');
  check('班级看板展示冻结场/待补件', Number(c21Row.open_wrongpack) >= 1, JSON.stringify(c21Row));
  await login('sun_ma');
  const sunOrders = (await req('GET', '/api/orders')).orders;
  const sunOrder = find(sunOrders, (o) => o.student_name === '孙朵朵');
  const sunDetail = await req('GET', `/api/orders/${sunOrder.id}`);
  check('家长端同步错包补发与追责状态', (sunDetail.wrongPacks || []).some((w) => w.case_no === 'WP20260002' && w.resend_overdue === 1),
    JSON.stringify(sunDetail.wrongPacks));

  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch( (e) => { console.error('\n💥 E2E 异常中断:', e.message); process.exit(1); });
