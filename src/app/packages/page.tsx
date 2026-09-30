'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/fetch';
import { Badge, PackageBadge, Modal, useToast } from '@/components/ui';

export default function PackagesPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [showPack, setShowPack] = useState(false);
  const { show, node } = useToast();
  const load = () => api('/api/packages').then((d) => setRows(d.packages));
  useEffect(() => {
    load();
    api('/api/plans').then((d) => setPlans(d.plans));
    api('/api/classes').then((d) => setClasses(d.classes));
  }, []);

  return (
    <div>
      {node}
      <div className="spread">
        <h2>包装码追溯（装箱 → 到校扫码 → 发放核对）</h2>
        <button className="btn" onClick={() => setShowPack(true)}>＋ 装箱登记包装码</button>
      </div>
      <p className="muted">
        供应商按班级装箱并登记包装码；一个包装码标注一个目标班级、每件校服只能装入一个有效包装码。
        到校或发放现场重复扫描同一包装码，平台自动判定两班尺码包混装并<b>冻结相关发放批次（不停整校）</b>。
      </p>
      <div className="card">
        <table>
          <thead><tr>
            <th>包装码</th><th>状态</th><th>计划</th><th>目标班级</th><th>批次/发货单</th>
            <th>件数</th><th>扫码次数</th><th>未闭环错包</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={r.open_mispack > 0 ? { background: '#fff8f8' } : undefined}>
                <td className="mono"><b>{r.package_code}</b></td>
                <td><PackageBadge status={r.status} /></td>
                <td>{r.plan_name}</td>
                <td>{r.intended_campus_name} {r.intended_class_name || <span className="muted">未指定</span>}</td>
                <td className="mono" style={{ fontSize: 12 }}>{r.batch_no || '—'}<br />{r.shipment_no || ''}</td>
                <td>{r.item_qty}（{r.item_kinds}种）</td>
                <td>{r.scan_cnt}</td>
                <td>{r.open_mispack > 0 ? <Badge status="pending_check" /> : <span className="muted">—</span>}</td>
                <td><Link className="btn secondary sm" href={`/packages/${r.id}`}>追溯/扫码 ›</Link></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9} className="empty">暂无包装码</td></tr>}
          </tbody>
        </table>
      </div>

      {showPack && <PackModal plans={plans} classes={classes} onClose={() => setShowPack(false)} onDone={() => { setShowPack(false); load(); }} show={show} />}
    </div>
  );
}

function PackModal({ plans, classes, onClose, onDone, show }: { plans: any[]; classes: any[]; onClose: () => void; onDone: () => void; show: (t: string, err?: boolean) => void }) {
  const [f, setF] = useState<any>({ package_code: '', plan_id: '', class_id: '', note: '', allow_mixed: false });
  const [cands, setCands] = useState<any[]>([]);
  const [pick, setPick] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!f.plan_id) { setCands([]); return; }
    api(`/api/packages/candidates?plan_id=${f.plan_id}${f.class_id ? `&class_id=${f.class_id}` : ''}`)
      .then((d) => setCands(d.candidates));
  }, [f.plan_id, f.class_id]);

  const grouped = cands.reduce((m: any, c) => {
    const k = c.class_name;
    (m[k] = m[k] || []).push(c);
    return m;
  }, {});
  const classCount = new Set(cands.filter((c) => pick[c.order_item_id]).map((c) => c.class_id)).size;

  return (
    <Modal title="装箱登记（一个包装码 → 一个目标班级）" onClose={onClose} wide>
      <div className="grid grid-2">
        <div className="field"><label>包装码 *</label>
          <input value={f.package_code} onChange={(e) => setF({ ...f, package_code: e.target.value })} placeholder="如 PKG20261020-A11" />
        </div>
        <div className="field"><label>订购计划 *</label>
          <select value={f.plan_id} onChange={(e) => setF({ ...f, plan_id: Number(e.target.value) })}>
            <option value="">请选择</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field"><label>目标班级（按班级过滤候选）</label>
          <select value={f.class_id} onChange={(e) => { setPick({}); setF({ ...f, class_id: Number(e.target.value) }); }}>
            <option value="">全部班级</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field"><label>备注</label><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
      </div>

      <div className="field">
        <label>装入校服（勾选；已装入其他有效包装码的不可重复选）</label>
        <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
          {Object.entries(grouped).map(([cn, list]: [string, any]) => (
            <div key={cn}>
              <div style={{ padding: '6px 10px', background: 'var(--gray-bg)', fontWeight: 700 }}>{cn}</div>
              {list.map((c) => {
                const disabled = !!c.packed_code;
                return (
                  <label key={c.order_item_id} className="spread" style={{ padding: '5px 10px', opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
                    <span>
                      <input type="checkbox" disabled={disabled} checked={!!pick[c.order_item_id]}
                        onChange={(e) => setPick({ ...pick, [c.order_item_id]: e.target.checked })} />{' '}
                      {c.student_no} {c.student_name} · {c.item_name}（{c.size}）
                      <span className="muted"> {c.batch_no || '无批次'} {c.shipment_no || ''}</span>
                    </span>
                    {disabled && <span className="tag-chip">已在 {c.packed_code}</span>}
                  </label>
                );
              })}
            </div>
          ))}
          {!cands.length && <div className="empty" style={{ padding: 16 }}>请先选择计划/班级（仅已缴费订单可装箱）</div>}
        </div>
      </div>
      {classCount > 1 && (
        <div className="field" style={{ background: '#fff8f8', padding: 8, borderRadius: 6 }}>
          <label><input type="checkbox" checked={f.allow_mixed} onChange={(e) => setF({ ...f, allow_mixed: e.target.checked })} /> 本次确为跨班混装登记（将直接打上混装预警）</label>
          <div className="muted">已选学生跨 {classCount} 个班级；正常包装码只能对应一个班级。</div>
        </div>
      )}
      <div style={{ textAlign: 'right' }}>
        <button className="btn" onClick={async () => {
          const items = cands.filter((c) => pick[c.order_item_id]).map((c) => ({ order_item_id: c.order_item_id, qty: 1 }));
          if (!f.package_code || !f.plan_id) return show('包装码与计划必填', true);
          if (!items.length) return show('请至少勾选一件校服', true);
          if (classCount > 1 && !f.allow_mixed) return show('跨班混装需勾选确认', true);
          try {
            await api('/api/packages', { method: 'POST', body: JSON.stringify({ ...f, items }) });
            show('装箱登记成功'); onDone();
          } catch (e: any) { show(e.message, true); }
        }}>提交装箱</button>
      </div>
    </Modal>
  );
}
