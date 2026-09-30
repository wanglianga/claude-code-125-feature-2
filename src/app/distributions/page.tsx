'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/fetch';
import { Badge, Modal, useToast } from '@/components/ui';

export default function DistributionsPage() {
  const [plans, setPlans] = useState<any[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [f, setF] = useState<any>({ plan_id: '', class_id: '', name: '', kind: 'regular', scheduled_at: '', location: '' });
  const { show, node } = useToast();
  const load = () => api('/api/distributions').then((d) => setRows(d.distributions));
  useEffect(() => {
    api('/api/plans').then((d) => setPlans(d.plans));
    api('/api/classes').then((d) => setClasses(d.classes));
    load();
  }, []);

  return (
    <div>
      {node}
      <div className="spread">
        <h2>分批发放与补领安排</h2>
        <button className="btn" onClick={() => setShowCreate(true)}>＋ 安排发放/补领场次</button>
      </div>
      <p className="muted">换码高峰和到校发放拥堵时，学校可按班级分多批发放，并为缺件、错领、未到学生安排“补领场”，减轻班主任工作量。</p>
      <div className="card">
        <table>
          <thead><tr><th>场次</th><th>类型</th><th>计划</th><th>班级</th><th>时间</th><th>地点</th><th>状态</th><th>发放/签收</th><th>未闭环异常</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={r.frozen ? { background: '#fff8f8' } : undefined}>
                <td>{r.name}{r.frozen ? <span className="tag-chip" style={{ marginLeft: 6 }}>已冻结</span> : null}</td>
                <td><Badge status={r.kind} /></td>
                <td>{plans.find((p) => p.id === r.plan_id)?.name}</td>
                <td>{r.campus_name} {r.class_name}</td><td>{r.scheduled_at}</td><td>{r.location}</td>
                <td><Badge status={r.status} />{r.frozen && <div className="muted" style={{ fontSize: 11, color: 'var(--red)' }}>{r.freeze_reason}</div>}</td>
                <td>{r.issued}/{r.signed_cnt}</td>
                <td>{r.open_issues > 0 ? <Badge status="wrong_claim" /> : <span className="muted">—</span>}</td>
                <td><Link className="btn secondary sm" href={`/distributions/${r.id}`}>进入发放 ›</Link></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={10} className="empty">暂无发放安排</td></tr>}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <Modal title="安排发放/补领场次" onClose={() => setShowCreate(false)}>
          <div className="field"><label>类型</label>
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="regular">常规分批发放</option><option value="supplementary">补领场（缺件/错领/未到学生）</option>
            </select>
          </div>
          <div className="field"><label>场次名称</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="如：一(1)班第一批发放" /></div>
          <div className="grid grid-2">
            <div className="field"><label>订购计划</label>
              <select value={f.plan_id} onChange={(e) => setF({ ...f, plan_id: Number(e.target.value) })}>
                <option value="">请选择</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field"><label>班级</label>
              <select value={f.class_id} onChange={(e) => setF({ ...f, class_id: Number(e.target.value) })}>
                <option value="">请选择</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field"><label>发放时间</label><input placeholder="2026-10-22 15:00:00" value={f.scheduled_at} onChange={(e) => setF({ ...f, scheduled_at: e.target.value })} /></div>
            <div className="field"><label>地点</label><input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="如：一(1)班教室" /></div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <button className="btn" onClick={async () => {
              try {
                await api('/api/distributions', { method: 'POST', body: JSON.stringify(f) });
                setShowCreate(false); show('已安排'); load();
              } catch (e: any) { show(e.message, true); }
            }}>创建</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
