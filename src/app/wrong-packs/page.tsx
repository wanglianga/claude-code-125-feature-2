'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/fetch';
import { Badge, Modal, useToast } from '@/components/ui';

const TRIGGER_LABEL: Record<string, string> = {
  mixed_pack: '两班尺码包混装',
  duplicate_scan: '同一包装码重复扫描',
  class_signoff_mismatch: '班级签收核对不符',
};

export default function WrongPacksPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [me, setMe] = useState<any>(null);
  const { show, node } = useToast();
  const load = () => api(`/api/wrong-packs${status ? `?status=${status}` : ''}`).then((d) => setRows(d.cases));
  useEffect(() => { api('/api/auth/me').then((d) => setMe(d.user)); load(); }, [status]);

  return (
    <div>
      {node}
      <div className="spread">
        <h2>错包处理与批次追溯</h2>
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            <option value="to_check">待核对</option>
            <option value="to_repack">待重新分拣</option>
            <option value="resending">补发中</option>
            <option value="closed">已闭环</option>
          </select>
          {me && ['general_affairs', 'head_teacher', 'admin'].includes(me.role)
            && <button className="btn" onClick={() => setShowCreate(true)}>＋ 登记错包 / 定位范围</button>}
        </div>
      </div>
      <p className="muted">
        供应商将两个班级的尺码包混装到校后，平台依据<b>学生订单、包装码、生产批次、班级签收、未发放清单</b>定位错包范围；
        同一包装码重复扫描或部分学生已签收时，<b>仅冻结相关发放批次而非整校停发</b>，
        状态按 <Badge status="to_check" /> → <Badge status="to_repack" /> → <Badge status="resending" /> → <Badge status="closed" /> 推进，
        补发须由<b>学生实际签收 + 班主任复核</b>共同关闭。
      </p>

      <div className="card">
        <table>
          <thead><tr>
            <th>工单号</th><th>事由</th><th>触发原因</th><th>计划/校区</th><th>供应商</th>
            <th>受影响(待补/已签收)</th><th>冻结批次</th><th>总务决定</th><th>补发</th><th>追责</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={r.resend_overdue ? { background: '#fff8f8' } : undefined}>
                <td className="mono">{r.case_no}</td>
                <td style={{ maxWidth: 220 }}>{r.title}</td>
                <td>{TRIGGER_LABEL[r.trigger_reason] || r.trigger_reason}</td>
                <td>{r.plan_name}<br /><span className="muted">{r.campus_name}</span></td>
                <td>{r.supplier_name}</td>
                <td>{r.affected_cnt}（{r.pending_cnt} / {r.signed_cnt}）</td>
                <td>{r.frozen_cnt > 0 ? <Badge status="frozen" /> : <span className="muted">—</span>}</td>
                <td>{r.review_decision === 'pending' ? <span className="muted">待审核</span> : <Badge status={r.review_decision} />}</td>
                <td>
                  <Badge status={r.status} />
                  {r.resend_overdue ? <span className="tag-chip" style={{ marginLeft: 4 }}>补发超时</span> : null}
                </td>
                <td>{r.liability_cnt > 0 ? <span style={{ color: 'var(--red)' }}>{r.liability_cnt} 单</span> : <span className="muted">—</span>}</td>
                <td><Link className="btn secondary sm" href={`/wrong-packs/${r.id}`}>处置 ›</Link></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={11} className="empty">暂无错包工单</td></tr>}
          </tbody>
        </table>
      </div>

      {showCreate && <CreateWrongPackModal onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); show('错包已登记，相关班级发放批次已冻结'); load(); }} />}
    </div>
  );
}

function CreateWrongPackModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'pack' | 'unsigned'>('pack');
  const [packs, setPacks] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [selPacks, setSelPacks] = useState<number[]>([]);
  const [planId, setPlanId] = useState<number | ''>('');
  const [classId, setClassId] = useState<number | ''>('');
  const [unsigned, setUnsigned] = useState<any[]>([]);
  const [selOi, setSelOi] = useState<number[]>([]);
  const [f, setF] = useState({ title: '', description: '', trigger: 'mixed_pack' });
  const { show, node } = useToast();

  useEffect(() => {
    api('/api/pack-codes').then((d) => setPacks(d.packs));
    api('/api/plans').then((d) => setPlans(d.plans));
    api('/api/classes').then((d) => setClasses(d.classes));
  }, []);

  async function loadUnsigned() {
    if (!planId || !classId) { show('请选择计划和班级', true); return; }
    // 未发放清单：该班已到校但尚未签收的明细（通过发放场候选数据汇总）
    const dists = (await api(`/api/distributions`)).distributions.filter((d: any) => d.class_id === Number(classId));
    const seen = new Map<number, any>();
    for (const d of dists) {
      const det = await api(`/api/distributions/${d.id}`);
      for (const c of det.candidates || []) {
        const left = c.arrived_qty - c.already_issued;
        if (left > 0 && !seen.has(c.order_item_id)) seen.set(c.order_item_id, c);
      }
    }
    setUnsigned([...seen.values()]);
    if (!seen.size) show('该班未发放清单为空（可能已全部发放）');
  }

  async function submit() {
    try {
      const payload: any = {
        title: f.title || undefined,
        description: f.description || undefined,
        trigger_reason: f.trigger,
        plan_id: planId || undefined,
      };
      if (mode === 'pack') {
        if (!selPacks.length) { show('请勾选涉事包装码', true); return; }
        payload.pack_code_ids = selPacks;
      } else {
        if (!selOi.length) { show('请勾选未发放清单中的受影响明细', true); return; }
        payload.order_item_ids = selOi;
      }
      await api('/api/wrong-packs', { method: 'POST', body: JSON.stringify(payload) });
      onDone();
    } catch (e: any) { show(e.message, true); }
  }

  return (
    <Modal title="登记错包并定位影响范围" onClose={onClose} wide>
      {node}
      <div className="row" style={{ marginBottom: 10 }}>
        <button className={`btn sm ${mode === 'pack' ? '' : 'gray'}`} onClick={() => setMode('pack')}>按包装码定位（混装/重复扫描）</button>
        <button className={`btn sm ${mode === 'unsigned' ? '' : 'gray'}`} onClick={() => setMode('unsigned')}>按班级签收 + 未发放清单定位</button>
      </div>

      {mode === 'pack' ? (
        <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
          <table>
            <thead><tr><th></th><th>包装码</th><th>发货单</th><th>批次</th><th>标签班级</th><th>扫码/重复</th><th>混装件</th><th>状态</th></tr></thead>
            <tbody>
              {packs.map((p) => (
                <tr key={p.id}>
                  <td><input type="checkbox" checked={selPacks.includes(p.id)} onChange={() =>
                    setSelPacks(selPacks.includes(p.id) ? selPacks.filter((x) => x !== p.id) : [...selPacks, p.id])} /></td>
                  <td className="mono">{p.pack_code}</td>
                  <td>{p.shipment_no || '—'}</td><td>{p.batch_no || '—'}</td><td>{p.class_name || '—'}</td>
                  <td>{p.scan_cnt}{p.dup_cnt > 0 && <span style={{ color: 'var(--red)' }}> / 重复{p.dup_cnt}</span>}</td>
                  <td>{p.mismatch_cnt > 0 ? <span style={{ color: 'var(--red)' }}>{p.mismatch_cnt}</span> : 0}</td>
                  <td><Badge status={p.status} /></td>
                </tr>
              ))}
              {!packs.length && <tr><td colSpan={8} className="empty">暂无包装码，请先由供应商在「分批发货」中登记</td></tr>}
            </tbody>
          </table>
        </div>
      ) : (
        <div>
          <div className="grid grid-3">
            <div className="field"><label>订购计划</label>
              <select value={planId} onChange={(e) => setPlanId(Number(e.target.value))}>
                <option value="">请选择</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field"><label>签收核对班级</label>
              <select value={classId} onChange={(e) => setClassId(Number(e.target.value))}>
                <option value="">请选择</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field"><label>&nbsp;</label><button className="btn secondary" onClick={loadUnsigned}>加载未发放清单</button></div>
          </div>
          <div style={{ maxHeight: 240, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
            <table>
              <thead><tr><th></th><th>学号</th><th>学生</th><th>品类</th><th>尺码</th><th>到校余量</th></tr></thead>
              <tbody>
                {unsigned.map((u) => (
                  <tr key={u.order_item_id}>
                    <td><input type="checkbox" checked={selOi.includes(u.order_item_id)} onChange={() =>
                      setSelOi(selOi.includes(u.order_item_id) ? selOi.filter((x) => x !== u.order_item_id) : [...selOi, u.order_item_id])} /></td>
                    <td className="mono">{u.student_no}</td><td>{u.student_name}</td>
                    <td>{u.item_name}</td><td>{u.size}</td><td>{u.arrived_qty - u.already_issued}</td>
                  </tr>
                ))}
                {!unsigned.length && <tr><td colSpan={6} className="empty">先选择计划和班级并加载清单</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid grid-2" style={{ marginTop: 10 }}>
        <div className="field"><label>标题（可选）</label><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="如：一(1)班/二(1)班尺码包混装" /></div>
        <div className="field"><label>触发原因</label>
          <select value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })}>
            <option value="mixed_pack">两班混装</option>
            <option value="duplicate_scan">包装码重复扫描</option>
            <option value="class_signoff_mismatch">班级签收核对不符</option>
          </select>
        </div>
      </div>
      <div className="field"><label>情况说明</label><textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
      <p className="muted">登记后系统将自动：① 按订单/批次/签收定位受影响名单（已签收学生自动排除，防止重复发放）；② 仅冻结相关班级未结束的发放批次，无关班级可继续发放。</p>
      <div style={{ textAlign: 'right' }}><button className="btn" onClick={submit}>登记并冻结相关批次</button></div>
    </Modal>
  );
}
