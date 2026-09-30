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

  // 12. 错包处理与批次可追溯（两班尺码包混装）
  console.log('⑫ 错包：重复扫码定位/按批次冻结/四状态/双签闭环/超时追责');
  await login('zw');
  r = await req('GET', '/api/mispacks');
  const mp = find(r.events, (x) => x.event_no === 'MP20261001');
  check('错包事件定位5件：2件已签收/3件缺包',
    mp.affected_cnt === 5 && Number(mp.signed_cnt) === 2 && Number(mp.short_cnt) === 3, JSON.stringify({ a: mp.affected_cnt, s: mp.signed_cnt, h: mp.short_cnt }));
  check('冻结2个涉事班级发放场次（非整校停发）', Number(mp.frozen_cnt) === 2);
  let mpd = await req('GET', `/api/mispacks/${mp.id}`);
  const miChenPants = find(mpd.items, (x) => x.student_name === '陈晓' && x.item_name === '春秋运动长裤');
  const miChenCoat = find(mpd.items, (x) => x.student_name === '陈晓' && x.item_name === '礼服外套');
  const miZhengPants = find(mpd.items, (x) => x.student_name === '郑好' && x.item_name === '春秋运动长裤');
  const miChenTop = find(mpd.items, (x) => x.student_name === '陈晓' && x.item_name === '春秋运动上衣');
  check('已签收学生标记防重复发放', miChenTop.already_signed === 1);
  const frozenA = find(mpd.frozen, (x) => x.class_name === '一(1)班');
  const frozenB = find(mpd.frozen, (x) => x.class_name === '二(1)班');

  // 无关班级（知行六1班）场次不冻结、可继续发放
  let dists = (await req('GET', '/api/distributions')).distributions;
  const unrelated = find(dists, (x) => x.name.includes('六(1)班毕业礼服'));
  check('无关班级场次未被冻结', unrelated.status === 'planned');
  await req('POST', `/api/distributions/${unrelated.id}`, { distribution_id: unrelated.id, action: 'set_status', status: 'in_progress' });
  check('无关班级可继续发放', true);

  // 冻结场次不能发放/整批确认
  let frozenErr = '';
  try {
    await req('POST', `/api/distributions/${frozenA.distribution_id}`, { distribution_id: frozenA.distribution_id, action: 'set_status', status: 'done' });
  } catch (e) { frozenErr = e.message; }
  check('冻结场次禁止确认整批发放', frozenErr.includes('冻结'), frozenErr);

  // 看板反映冻结
  r = await req('GET', `/api/dashboard/progress?plan_id=${p1.id}`);
  const c11row = find(r.classes, (x) => x.class_name === '一(1)班');
  check('看板显示冻结场次与未闭环错包', Number(c11row.frozen_dist_cnt) >= 1 && Number(c11row.open_mispack_cnt) === 1, JSON.stringify(c11row));

  // 角色可见性：家长只看自己孩子相关事件
  await login('chen_ma');
  r = await req('GET', '/api/mispacks');
  check('家长端可看到孩子的错包补发状态', r.events.some((x) => x.id === mp.id));
  mpd = await req('GET', `/api/mispacks/${mp.id}`);

  // 未审核不能转分拣；已签收件不能再签收/找回
  await login('zw');
  let chkErr = '';
  try { await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'confirm_check' }); } catch (e) { chkErr = e.message; }
  check('未审核不能完成核对', chkErr.includes('审核'));
  let signErr = '';
  try { await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'student_sign', item_id: miChenTop.id }); } catch (e) { signErr = e.message; }
  check('已签收学生不能被重复发放', signErr.includes('已签收'), signErr);

  // 总务审核：优先补发 → 核对完成 → 待重新分拣
  await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'review', decision: 'priority_resend', note: '优先补发一年级' });
  await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'confirm_check' });
  mpd = await req('GET', `/api/mispacks/${mp.id}`);
  check('状态：待核对→待重新分拣', mpd.event.status === 'to_resort');

  // 供应商重新分拣登记（操作人/原包去向/补发单号/预计到校），预计时间给过去以触发再次超时
  await login('gys');
  let resortErr = '';
  try {
    await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'resort', sort_operator: '仓管员周强' });
  } catch (e) { resortErr = e.message; }
  check('分拣登记缺字段被拦截', resortErr.includes('原包去向'), resortErr);
  await req('POST', `/api/mispacks/${mp.id}`, {
    id: mp.id, action: 'resort', sort_operator: '仓管员周强',
    original_package_destination: '退回供应商中心仓按班重新分拣',
    resend_tracking_no: 'SF-RS-9988', expected_arrival: '2026-09-10 12:00:00',
  });
  mpd = await req('GET', `/api/mispacks/${mp.id}`);
  check('状态：待重新分拣→补发中，3名缺包学生生成补发工单',
    mpd.event.status === 'resending' && mpd.items.filter((x) => x.case_id).length === 3,
    JSON.stringify(mpd.items.map((x) => x.case_id)));

  // 未到校不能签收
  await login('wangls');
  let earlyErr = '';
  try { await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'student_sign', item_id: miChenPants.id }); } catch (e) { earlyErr = e.message; }
  check('补发未到校不能签收', earlyErr.includes('到校'), earlyErr);

  // 巡检超时：自动生成供应商追责 + 替代调拨建议
  await login('zw');
  r = await req('GET', '/api/mispacks?status=resending');
  const mpRow = find(r.events, (x) => x.id === mp.id);
  check('补发再次超时被标记', mpRow.timeout_flag === 1);
  mpd = await req('GET', `/api/mispacks/${mp.id}`);
  check('自动生成追责+替代调拨建议各1条',
    mpd.actions.filter((a) => a.kind === 'accountability').length === 1
    && mpd.actions.filter((a) => a.kind === 'transfer_suggestion').length === 1);
  const accAction = find(mpd.actions, (a) => a.kind === 'accountability');
  await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'handle_action', action_id: accAction.id, decision: 'accepted' });

  // 总务确认补发到校（自动按班级创建补领场）
  await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'arrive' });
  mpd = await req('GET', `/api/mispacks/${mp.id}`);
  check('已确认到校并安排补领场', mpd.event.arrived_at);

  // 双签：学生实际签收 + 班主任复核；跨班教师无权操作
  await login('wangls');
  await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'student_sign', item_id: miChenPants.id });
  await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'student_sign', item_id: miChenCoat.id });
  let crossErr = '';
  try {
    await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'student_sign', item_id: miZhengPants.id });
  } catch (e) { crossErr = e.message; }
  check('班主任不能操作其他班学生', crossErr.includes('本班'), crossErr);
  // 只复核一件，事件不应闭环
  await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'teacher_review', item_id: miChenPants.id });
  mpd = await req('GET', `/api/mispacks/${mp.id}`);
  check('双签未齐不闭环', mpd.event.status === 'resending');
  await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'teacher_review', item_id: miChenCoat.id });

  // 二(1)班：家长可签收自己孩子，班主任复核
  await login('zheng_ba');
  await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'student_sign', item_id: miZhengPants.id });
  await login('zhaols');
  await req('POST', `/api/mispacks/${mp.id}`, { id: mp.id, action: 'teacher_review', item_id: miZhengPants.id });
  mpd = await req('GET', `/api/mispacks/${mp.id}`);
  check('全部双签后事件自动闭环', mpd.event.status === 'closed');
  check('双签进度3/3签收 3/3复核', mpd.items.filter((x) => !x.already_signed).every((x) => x.student_signed === 1 && x.teacher_reviewed === 1));
  const fA = find(mpd.frozen, (x) => x.class_name === '一(1)班');
  const fB = find(mpd.frozen, (x) => x.class_name === '二(1)班');
  check('闭环后冻结场次解冻', !!fA.unfrozen_at && !!fB.unfrozen_at);
  await login('zw');
  dists = (await req('GET', '/api/distributions')).distributions;
  const dA = find(dists, (x) => x.id === frozenA.distribution_id);
  const dB = find(dists, (x) => x.id === frozenB.distribution_id);
  check('场次恢复冻结前状态（一1进行中/二1已计划）', dA.status === 'in_progress' && dB.status === 'planned', `${dA.status}/${dB.status}`);
  // 缺包补齐后可以确认整批发放
  await req('POST', `/api/distributions/${dA.id}`, { distribution_id: dA.id, action: 'set_status', status: 'done' });
  check('补齐闭环后可确认整批发放', true);
  // 补发工单全部解决
  const openResend = mpd.items.filter((x) => x.case_id && x.case_status !== 'resolved');
  check('补发工单随双签闭环', openResend.length === 0, JSON.stringify(openResend));

  // 看板：错包归零；考核错包数自动统计
  r = await req('GET', `/api/dashboard/progress?plan_id=${p1.id}`);
  const c11after = find(r.classes, (x) => x.class_name === '一(1)班');
  check('闭环后看板冻结/错包清零', Number(c11after.frozen_dist_cnt) === 0 && Number(c11after.open_mispack_cnt) === 0, JSON.stringify(c11after));
  r = await req('GET', '/api/assessments');
  check('供应商考核同步错包数', r.assessments.some((a) => Number(a.mispack_count) >= 1), JSON.stringify(r.assessments.map((a) => a.mispack_count)));

  // 重复扫码实时触发：新包装码第二次扫码自动建事件并冻结
  await login('gys');
  r = await req('GET', `/api/packages/candidates?plan_id=${p1.id}&class_id=${c11.id}`);
  const wuTop = find(r.candidates, (c) => c.student_name === '吴磊' && c.item_name === '春秋运动上衣');
  const code = `PKG-E2E-${Date.now()}`;
  r = await req('POST', '/api/packages', {
    package_code: code, plan_id: p1.id,
    items: [{ order_item_id: wuTop.order_item_id, qty: 1 }],
  });
  const newPkg = r.id;
  await login('zw');
  r = await req('POST', `/api/packages/${newPkg}`, { id: newPkg, scene: 'arrival' });
  check('首次扫码正常', r.duplicate === false);
  r = await req('POST', `/api/packages/${newPkg}`, { id: newPkg, scene: 'arrival' });
  check('第二次扫码自动触发错包事件并冻结批次', r.duplicate === true && !!r.mispack.eventNo && r.mispack.frozen >= 1, JSON.stringify(r.mispack));
  const dupId = r.mispack.eventId;
  mpd = await req('GET', `/api/mispacks/${dupId}`);
  const only = mpd.items[0];
  // 原包找回路径：审核→分拣前也可直接登记找回并闭环
  await req('POST', `/api/mispacks/${dupId}`, { id: dupId, action: 'mark_recovered', item_id: only.id });
  let closeErr = '';
  try {
    // review 决策未做不能 confirm_check，但全部找回可直接闭环
    await req('POST', `/api/mispacks/${dupId}`, { id: dupId, action: 'close_recovered' });
  } catch (e) { closeErr = e.message; }
  check('全部原包找回可直接闭环并解冻', !closeErr, closeErr);
  mpd = await req('GET', `/api/mispacks/${dupId}`);
  check('找回事件已闭环', mpd.event.status === 'closed');

  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch( (e) => { console.error('\n💥 E2E 异常中断:', e.message); process.exit(1); });
