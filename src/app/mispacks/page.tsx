'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/fetch';
import { Badge, PackageBadge, Modal, useToast } from '@/components/ui';

const TRIGGER_LABELS: Record<string, string> = {
  duplicate_scan: '重复扫码预警', mixed_package: '班级混装上报',
};

export default function MispacksPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  const [showReport, setShowReport] = useState(false);
  const { show, node } = useToast();
  const load = () => api(`/api/mispacks${status ? `?status=${status}` : ''}`).then((d) => setRows(d.events));
  useEffect(() => { load(); }, [status]);

  return (
    <div>
      {node}
      <div className="spread">
        <h2>错包处理与批次可追溯</h2>
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            <option value="pending_check">待核对</option>
            <option value="to_resort">待重新分拣</option>
            <option value="resending">补发中</option>
            <option value="closed">已闭环</option>
          </select>
          <button className="btn" onClick={() => setShowReport(true)}>＋ 上报混装错包</button>
        </div>
      </div>
      <p className="muted">
        平台依据<b>学生订单、包装码、生产批次、班级签收和未发放清单</b>定位错包范围；
        重复扫码或部分学生已签收时，仅<b>冻结涉事班级的发放批次</b>（无关班级继续发放），
        经「待核对 → 待重新分拣 → 补发中 → 已闭环」处理；补发须<b>学生实际签收 + 班主任复核</b>双签关闭，再次超时自动生成追责与调拨建议。
      </p>

      <div className="card">
        <table>
          <thead><tr>
            <th>事件号</th><th>触发</th><th>状态</th><th>计划/供应商</th><th>涉事班级</th>
            <th>受影响<br />(已签收/缺包)</th><th>双签进度<br />签收/复核</th><th>冻结场次</th>
            <th>审核决策</th><th>超时建议</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={r.timeout_flag ? { background: '#fff8f8' } : r.status === 'closed' ? undefined : { background: '#fffdf5' }}>
                <td className="mono"><b>{r.event_no}</b><br /><span className="muted" style={{ fontSize: 12 }}>{r.title}</span></td>
                <td>{TRIGGER_LABELS[r.trigger_type]}</td>
                <td><Badge status={r.status} />{r.timeout_flag && <div style={{ color: 'var(--red)', fontSize: 12 }}>补发超时</div>}</td>
                <td style={{ fontSize: 12 }}>{r.plan_name}<br />{r.supplier_name}</td>
                <td>{r.class_names}</td>
                <td>{r.affected_cnt}（<span style={{ color: 'var(--green)' }}>{r.signed_cnt}</span>/<span style={{ color: 'var(--red)' }}>{r.short_cnt}</span>）</td>
                <td>{r.restudent_signed}/{r.short_cnt} · {r.reteacher_reviewed}/{r.short_cnt}</td>
                <td>{r.frozen_cnt > 0 ? <Badge status="frozen" /> : <span className="muted">—</span>}</td>
                <td>{r.review_decision === 'pending' ? <span className="muted">待审核</span> : <Badge status={r.review_decision} />}</td>
                <td>{r.pending_action_cnt > 0 ? <Badge status="accountability" /> : <span className="muted">—</span>}</td>
                <td><Link className="btn secondary sm" href={`/mispacks/${r.id}`}>处理 ›</Link></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={11} className="empty">暂无错包事件</td></tr>}
          </tbody>
        </table>
      </div>

      {showReport && <ReportModal onClose={() => setShowReport(false)} onDone={() => { setShowReport(false); load(); }} show={show} />}
    </div>
  );
}

function ReportModal({ onClose, onDone, show }: { onClose: () => void; onDone: () => void; show: (t: string, err?: boolean) => void }) {
  const [packages, setPackages] = useState<any[]>([]);
  const [dists, setDists] = useState<any[]>([]);
  const [f, setF] = useState<any>({ package_ids: [], distribution_id: '', title: '', description: '' });
  useEffect(() => {
    api('/api/packages').then((d) => setPackages(d.packages));
    api('/api/distributions').then((d) => setDists(d.distributions));
  }, []);
  const togglePkg = (id: number) =>
    setF({ ...f, package_ids: f.package_ids.includes(id) ? f.package_ids.filter((x: number) => x !== id) : [...f.package_ids, id] });
  return (
    <Modal title="上报两班尺码包混装" onClose={onClose} wide>
      <div className="field"><label>涉事包装码（可多选，平台据此+订单/批次/签收清单定位范围）</label>
        <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
          {packages.map((p) => (
            <label key={p.id} className="spread" style={{ padding: '5px 10px' }}>
              <span><input type="checkbox" checked={f.package_ids.includes(p.id)} onChange={() => togglePkg(p.id)} />{' '}
                <b className="mono">{p.package_code}</b> → {p.intended_class_name}（{p.item_qty}件，扫码{p.scan_cnt}次）</span>
              <PackageBadge status={p.status} />
            </label>
          ))}
          {!packages.length && <div className="empty" style={{ padding: 12 }}>暂无包装码</div>}
        </div>
      </div>
      <div className="field"><label>或选择发放现场场次（按场内已发放明细定位）</label>
        <select value={f.distribution_id} onChange={(e) => setF({ ...f, distribution_id: Number(e.target.value) })}>
          <option value="">不指定</option>
          {dists.map((d) => <option key={d.id} value={d.id}>{d.class_name} · {d.name}</option>)}
        </select>
      </div>
      <div className="grid grid-2">
        <div className="field"><label>标题</label><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="如：一(1)/二(1)班尺码包混装" /></div>
        <div className="field"><label>情况说明</label><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <button className="btn" onClick={async () => {
          if (!f.package_ids.length && !f.distribution_id) return show('请选择涉事包装码或场次', true);
          try {
            const r = await api('/api/mispacks', { method: 'POST', body: JSON.stringify({ ...f, trigger_type: 'mixed_package' }) });
            show(`已定位 ${r.affected} 名学生，冻结 ${r.frozen} 个涉事班级场次`);
            onDone();
          } catch (e: any) { show(e.message, true); }
        }}>上报并自动定位冻结</button>
      </div>
    </Modal>
  );
}
