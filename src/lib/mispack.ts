import { query, one, tx } from './db';
import { genNo, logActivity } from './api';
import type { SessionUser } from './auth';

// 错包事件共享服务端逻辑：范围定位、按发放批次冻结、分拣/补发、双签闭环、超时追责

export interface EventScope {
  eventId: number;
  eventNo: string;
  merged: boolean;
  affected: number;
  frozen: number;
  alreadySigned: number;
}

interface ScopeItem {
  order_item_id: number;
  qty: number;
  package_id: number | null;
  package_code: string | null;
  item_name: string;
  size: string;
  order_id: number;
  student_id: number;
  class_id: number;
}

async function gatherItems(conn: any, packageIds: number[], extraDistributionId?: number | null): Promise<ScopeItem[]> {
  const map = new Map<number, ScopeItem>();
  if (packageIds.length) {
    const [rows] = await conn.query(
      `SELECT pi.order_item_id, pi.qty, pi.package_id, pk.package_code,
              oi.name item_name, oi.size, o.id order_id, o.student_id, o.class_id
         FROM package_items pi
         JOIN packages pk ON pk.id=pi.package_id
         JOIN order_items oi ON oi.id=pi.order_item_id
         JOIN orders o ON o.id=oi.order_id
        WHERE pi.package_id IN (${packageIds.map(() => '?').join(',')})`,
      packageIds);
    for (const r of rows as any[]) {
      const ex = map.get(r.order_item_id);
      if (ex) ex.qty += Number(r.qty);
      else map.set(r.order_item_id, { ...r, qty: Number(r.qty) });
    }
  }
  // 重复扫描发生在某个发放场：该场内涉及包装码所属班级之外的已发放明细也纳入范围
  if (extraDistributionId) {
    const [rows] = await conn.query(
      `SELECT rc.order_item_id, rc.qty, NULL package_id, NULL package_code,
              oi.name item_name, oi.size, o.id order_id, o.student_id, o.class_id
         FROM receipts rc
         JOIN order_items oi ON oi.id=rc.order_item_id
         JOIN orders o ON o.id=oi.order_id
        WHERE rc.distribution_id=?`,
      [extraDistributionId]);
    for (const r of rows as any[]) {
      if (!map.has(r.order_item_id)) map.set(r.order_item_id, { ...r, qty: Number(r.qty) });
    }
  }
  return [...map.values()];
}

/**
 * 定位错包范围并冻结相关发放批次（只冻结涉及班级的未结场次，无关班级照常发放）。
 * 若相同包装码已存在未闭环事件，则把新增名单/场次合并进该事件。
 */
export async function openMispackEvent(opts: {
  actor: SessionUser;
  triggerType: 'duplicate_scan' | 'mixed_package';
  packageIds: number[];
  distributionId?: number | null;
  title?: string;
  description?: string;
}): Promise<EventScope> {
  const { actor, triggerType, packageIds, distributionId } = opts;
  if (!packageIds.length && !distributionId) throw Object.assign(new Error('缺少包装码或发放场次'), { status: 400 });

  return tx(async (conn) => {
    const plan = await one<any>(
      `SELECT p.* FROM plans p
        ${packageIds.length ? `JOIN packages pk ON pk.plan_id=p.id AND pk.id IN (${packageIds.map(() => '?').join(',')})` : 'JOIN distributions d ON d.plan_id=p.id AND d.id=?'}
        LIMIT 1`,
      packageIds.length ? packageIds : [distributionId]);
    if (!plan) throw Object.assign(new Error('找不到对应订购计划'), { status: 404 });
    const supplierId = plan.supplier_id;

    const items = await gatherItems(conn, packageIds, distributionId);
    if (!items.length) throw Object.assign(new Error('包装码内没有可定位的学生订单明细'), { status: 400 });
    const classIds = [...new Set(items.map((i) => i.class_id))];
    const codes = packageIds.length
      ? (await conn.query(`SELECT package_code FROM packages WHERE id IN (${packageIds.map(() => '?').join(',')})`, packageIds))[0] as any[]
      : [];

    // 合并：任一包装码已挂在未闭环事件上
    let eventId = 0;
    let eventNo = '';
    let merged = false;
    if (packageIds.length) {
      const [[ex]]: any = await conn.query(
        `SELECT me.id, me.event_no FROM mispack_events me
          JOIN mispack_items mi ON mi.event_id=me.id
         WHERE me.status<>'closed' AND mi.package_id IN (${packageIds.map(() => '?').join(',')})
         LIMIT 1`,
        packageIds);
      if (ex) { eventId = ex.id; eventNo = ex.event_no; merged = true; }
    }

    if (!eventId) {
      const title = opts.title || `错包预警：${codes.map((c) => c.package_code).join('、') || '发放现场扫码'} 涉${classIds.length}个班级混装`;
      const [er]: any = await conn.query(
        `INSERT INTO mispack_events
           (event_no,plan_id,supplier_id,trigger_type,status,title,description,reported_by)
         VALUES (?,?,?,?, 'pending_check',?,?,?)`,
        [genNo('MP'), plan.id, supplierId, triggerType, title, opts.description || null, actor.id]);
      eventId = er.insertId;
      const [[nr]]: any = await conn.query('SELECT event_no FROM mispack_events WHERE id=?', [eventId]);
      eventNo = nr.event_no;
      await conn.query(
        `INSERT INTO activity_log (actor_role,actor_name,action,detail) VALUES (?,?,?,?)`,
        [actor.role, actor.real_name, triggerType === 'duplicate_scan' ? '错包预警-重复扫码' : '错包预警-混装上报',
          `${eventNo} ${title}`]);
    }

    // 写入受影响名单（已签收学生标记，防止重复发放）
    let affected = 0;
    let alreadySigned = 0;
    for (const it of items) {
      const [[dup]]: any = await conn.query('SELECT id, already_signed FROM mispack_items WHERE event_id=? AND order_item_id=? LIMIT 1', [eventId, it.order_item_id]);
      if (dup) continue;
      const [[batchRow]]: any = await conn.query(
        `SELECT pb.batch_no FROM batch_allocations ba
           JOIN batch_items bi ON bi.id=ba.batch_item_id
           JOIN production_batches pb ON pb.id=bi.batch_id
          WHERE ba.order_item_id=? LIMIT 1`, [it.order_item_id]);
      const [[signedRow]]: any = await conn.query(
        `SELECT 1 ok FROM receipts WHERE order_item_id=? AND status='signed' LIMIT 1`, [it.order_item_id]);
      const isSigned = signedRow ? 1 : 0;
      if (isSigned) alreadySigned++;
      await conn.query(
        `INSERT INTO mispack_items
           (event_id,student_id,order_id,order_item_id,class_id,package_id,package_code,batch_no,item_name,size,qty,already_signed)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [eventId, it.student_id, it.order_id, it.order_item_id, it.class_id,
         it.package_id, it.package_code, batchRow?.batch_no || null, it.item_name, it.size, it.qty, isSigned]);
      await conn.query(
        `INSERT INTO activity_log (student_id,order_id,actor_role,actor_name,action,detail)
         VALUES (?,?,?,?,?,?)`,
        [it.student_id, it.order_id, actor.role, actor.real_name, '错包范围定位',
          `${eventNo} ${it.item_name}(${it.size}) 列入受影响名单${isSigned ? '，该生已签收不重复发放' : ''}`]);
      affected++;
    }

    // 冻结相关发放场次：涉事班级的 planned/in_progress 常规场次 + 触发场次本身；
    // 补领场（supplementary）服务于其他补发，不冻结；无关班级不动
    const [dists] = await conn.query(
      `SELECT id, class_id, status FROM distributions
        WHERE plan_id=? AND status IN ('planned','in_progress') AND kind='regular'
          AND class_id IN (${classIds.map(() => '?').join(',')})`,
      [plan.id, ...classIds]);
    const freezeIds = new Set<number>((dists as any[]).map((d) => d.id));
    if (distributionId) freezeIds.add(Number(distributionId));

    let frozen = 0;
    for (const did of freezeIds) {
      const [[d]]: any = await conn.query('SELECT id,class_id,status FROM distributions WHERE id=?', [did]);
      if (!d) continue;
      const [[exist]]: any = await conn.query(
        'SELECT id FROM mispack_frozen_distributions WHERE event_id=? AND distribution_id=?', [eventId, did]);
      if (exist) continue;
      await conn.query(
        `INSERT INTO mispack_frozen_distributions (event_id,distribution_id,class_id,prev_status,reason)
         VALUES (?,?,?,?,?)`,
        [eventId, did, d.class_id, d.status, `错包事件 ${eventNo} 冻结涉事班级发放场次`]);
      if (d.status !== 'frozen') {
        await conn.query("UPDATE distributions SET status='frozen' WHERE id=? AND status<>'frozen'", [did]);
        frozen++;
      }
      await conn.query(
        `INSERT INTO activity_log (actor_role,actor_name,action,detail) VALUES (?,?,?,?)`,
        [actor.role, actor.real_name, '冻结发放批次', `${eventNo} 冻结发放场次#${did}（班级#${d.class_id}），无关班级不受影响`]);
    }

    // 包装码打上混装预警
    for (const pid of packageIds) {
      await conn.query("UPDATE packages SET status='merged_flagged' WHERE id=? AND status='active'", [pid]);
    }

    return { eventId, eventNo, merged, affected, frozen, alreadySigned };
  });
}

// 补发再次超时：自动生成供应商追责 + 替代调拨建议
export async function checkMispackTimeouts() {
  const rows = await query<any>(
    `SELECT * FROM mispack_events
      WHERE status='resending' AND timeout_flag=0
        AND expected_arrival IS NOT NULL AND expected_arrival < NOW()`);
  for (const e of rows) {
    await tx(async (conn) => {
      await conn.query('UPDATE mispack_events SET timeout_flag=1, timeout_at=NOW() WHERE id=?', [e.id]);
      const sizes = await query<any>(
        `SELECT cl.name class_name, mi.size, COUNT(*) cnt, GROUP_CONCAT(DISTINCT mi.item_name) items
           FROM mispack_items mi JOIN classes cl ON cl.id=mi.class_id
          WHERE mi.event_id=? AND mi.already_signed=0
          GROUP BY cl.id, mi.size`, [e.id]);
      const summary = sizes.map((s) => `${s.class_name} ${s.items} ${s.size}码×${s.cnt}`).join('；') || '相关学生';
      await conn.query(
        `INSERT INTO mispack_actions (event_id,kind,content,auto_generated,created_by)
         VALUES (?, 'accountability', ?, 1, NULL)`,
        [e.id, `错包事件 ${e.event_no} 的补发再次超时（应于 ${String(e.expected_arrival).slice(0, 16)} 到校）。建议依据供应商考核条款追责：计入错包/延期扣分、约谈整改并由供应商承担加急与调拨费用。`]);
      await conn.query(
        `INSERT INTO mispack_actions (event_id,kind,content,auto_generated,created_by)
         VALUES (?, 'transfer_suggestion', ?, 1, NULL)`,
        [e.id, `建议启动替代调拨，优先从同计划其他已到校富余包装或供应商就近库存调拨：${summary}，到校后安排补领场发放。`]);
      await conn.query(
        `INSERT INTO activity_log (actor_role,actor_name,action,detail) VALUES ('system','平台','补发超时自动追责',?)`,
        [`${e.event_no} 补发超时，已生成供应商追责与替代调拨建议`]);
    });
  }
  return rows.length;
}

// 闭环后解冻：若没有其他未闭环事件冻结同一场次，恢复到冻结前状态
export async function unfreezeEvent(conn: any, eventId: number) {
  const [rows] = await conn.query(
    'SELECT id, distribution_id FROM mispack_frozen_distributions WHERE event_id=? AND unfrozen_at IS NULL',
    [eventId]);
  for (const r of rows as any[]) {
    await conn.query('UPDATE mispack_frozen_distributions SET unfrozen_at=NOW() WHERE id=?', [r.id]);
    const [[other]]: any = await conn.query(
      `SELECT COUNT(*) cnt FROM mispack_frozen_distributions mfd
         JOIN mispack_events me ON me.id=mfd.event_id
        WHERE mfd.distribution_id=? AND me.status<>'closed' AND mfd.unfrozen_at IS NULL`,
      [r.distribution_id]);
    if (Number(other.cnt) === 0) {
      const [[earliest]]: any = await conn.query(
        'SELECT prev_status FROM mispack_frozen_distributions WHERE distribution_id=? ORDER BY id ASC LIMIT 1',
        [r.distribution_id]);
      const target = earliest?.prev_status && earliest.prev_status !== 'frozen' ? earliest.prev_status : 'planned';
      await conn.query('UPDATE distributions SET status=? WHERE id=?', [target, r.distribution_id]);
    }
  }
}

export async function logMispack(actor: SessionUser, event: any, action: string, detail: string) {
  await logActivity({ actor, action, detail: `${event.event_no} ${detail}` });
}
