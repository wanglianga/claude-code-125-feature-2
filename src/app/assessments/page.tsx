'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/fetch';
import { Badge, useToast } from '@/components/ui';

export default function AssessmentsPage() {
  const [me, setMe] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [f, setF] = useState({ supplier_id: '', plan_id: '', period: '2026-2027学年度', score: 95, note: '' });
  const { show, node } = useToast();

  const load = () => api('/api/assessments').then((d) => setRows(d.assessments));
  useEffect(() => {
    api('/api/auth/me').then((d) => setMe(d.user));
    load();
    api('/api/suppliers').then((d) => setSuppliers(d.suppliers));
    api('/api/plans').then((d) => setPlans(d.plans));
  }, []);
  const isGA = me && ['general_affairs', 'admin'].includes(me.role);

  async function submit() {
    try {
      const d = await api('/api/assessments', {
        method: 'POST',
        body: JSON.stringify({ ...f, supplier_id: Number(f.supplier_id), plan_id: f.plan_id ? Number(f.plan_id) : null, score: Number(f.score) }),
      });
      show(`已考核（系统统计：漏发${d.stats.missing_count} 延期${d.stats.delay_count} 过敏${d.stats.allergy_count} 换码${d.stats.exchange_count} 错包${d.stats.mispack_count}）`);
      load();
    } catch (e: any) { show(e.message, true); }
  }

  return (
    <div>
      {node}
      <h2>供应商考核记录</h2>
      <p className="muted">发放完成后，学校依据漏发、延期、面料过敏投诉、换码率、<b>班级混装错包</b>等数据对供应商评分并留档；错包事件闭环后自动计入。</p>

      {isGA && (
        <div className="card">
          <h2>新增考核（选择计划后自动统计异常数量）</h2>
          <div className="grid grid-4">
            <div className="field"><label>供应商</label>
              <select value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}>
                <option value="">请选择</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="field"><label>关联计划（可选，用于自动统计）</label>
              <select value={f.plan_id} onChange={(e) => setF({ ...f, plan_id: e.target.value })}>
                <option value="">不关联</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field"><label>考核周期</label><input value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} /></div>
            <div className="field"><label>综合评分（0-100）</label><input type="number" value={f.score} onChange={(e) => setF({ ...f, score: Number(e.target.value) })} /></div>
          </div>
          <div className="field"><label>评语</label><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
          <button className="btn" onClick={submit}>提交考核</button>
        </div>
      )}

      <div className="card">
        <table>
          <thead><tr><th>供应商</th><th>周期</th><th>关联计划</th><th>评分</th><th>漏发</th><th>延期</th><th>过敏投诉</th><th>换码</th><th>错包</th><th>评语</th><th>考核人</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.supplier_name}</td><td>{r.period}</td><td>{plans.find((p) => p.id === r.plan_id)?.name || '—'}</td>
                <td><b style={{ color: Number(r.score) >= 90 ? 'var(--green)' : Number(r.score) >= 75 ? 'var(--amber)' : 'var(--red)' }}>{r.score}</b></td>
                <td>{r.missing_count}</td><td>{r.delay_count}</td><td>{r.allergy_count}</td><td>{r.exchange_count}</td>
                <td>{Number(r.mispack_count) > 0 ? <span style={{ color: 'var(--red)' }}>{r.mispack_count}</span> : 0}</td>
                <td>{r.note}</td><td>{r.assessor_name}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={11} className="empty">暂无考核记录</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
