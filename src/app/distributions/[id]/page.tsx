'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/fetch';
import { Badge, useToast } from '@/components/ui';

export default function DistributionDetailPage() {
  const { id } = useParams();
  const [d, setD] = useState<any>(null);
  const [wrongFor, setWrongFor] = useState<any>(null);
  const { show, node } = useToast();
  const load = () => api(`/api/distributions/${id}`).then(setD);
  useEffect(() => { load(); }, [id]);
  if (!d) return <div className="empty">加载中…</div>;
  const dist = d.distribution;

  async function act(body: any, okMsg = '操作成功') {
    try {
      await api(`/api/distributions/${id}`, { method: 'POST', body: JSON.stringify({ distribution_id: Number(id), ...body }) });
      show(okMsg); load();
    } catch (e: any) { show(e.message, true); }
  }

  return (
    <div>
      {node}
      <div className="spread">
        <h2>{dist.name} <Badge status={dist.kind} /></h2>
        <div className="row"><Badge status={dist.status} /><Link className="btn gray sm" href="/distributions">返回</Link></div>
      </div>
      <p className="muted">{dist.class_name} · {dist.scheduled_at} · {dist.location}</p>

      <div className="card row">
        {dist.status === 'frozen' && (
          <span style={{ color: 'var(--red)', fontWeight: 700 }}>
            ⛔ 本场次因错包事件已冻结：缺失包补齐并双签闭环后自动解冻；无关班级场次不受影响，可继续发放。
          </span>
        )}
        {dist.status === 'planned' && <button className="btn" onClick={() => act({ action: 'set_status', status: 'in_progress' })}>开始发放</button>}
        {dist.status === 'in_progress' && <button className="btn" onClick={() => act({ action: 'set_status', status: 'done' }, '本场发放已结束')}>结束本场</button>}
        <span className="muted">正常发放即登记并视为签收；错领、缺件需登记异常，后续安排补领场闭环。</span>
      </div>

      <div className="card">
        <h2>本场已发放记录</h2>
        <table>
          <thead><tr><th>学号</th><th>应领学生</th><th>品类</th><th>尺码</th><th>状态</th><th>错领人</th><th>签收</th><th>操作</th></tr></thead>
          <tbody>
            {d.receipts.map((r: any) => (
              <tr key={r.id} style={r.handled ? undefined : r.status === 'signed' ? undefined : { background: '#fff8f8' }}>
                <td className="mono">{r.student_no}</td><td>{r.student_name}</td>
                <td>{r.item_name}</td><td>{r.size}</td>
                <td><Badge status={r.status} />{r.handled ? <span className="tag-chip">已闭环</span> : null}</td>
                <td>{r.claimant_name || '—'}</td>
                <td>{r.signed_by ? `${r.signed_by} ${r.signed_at || ''}` : <span className="muted">—</span>}</td>
                <td className="row" style={{ gap: 4 }}>
                  {r.status === 'issued' && <button className="btn sm" onClick={() => act({ action: 'sign', receipt_id: r.id }, '已签收')}>家长签收</button>}
                  {r.status !== 'signed' && !r.handled &&
                    <button className="btn secondary sm" onClick={() => act({ action: 'resolve', receipt_id: r.id, note: '异常已处理' }, '异常已闭环')}>标记异常处理</button>}
                </td>
              </tr>
            ))}
            {!d.receipts.length && <tr><td colSpan={8} className="empty">本场还未发放</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>可发放明细（已到校、本班、已缴费、本场未发）</h2>
        <table>
          <thead><tr><th>学号</th><th>学生</th><th>品类</th><th>尺码</th><th>到校余量</th><th>操作</th></tr></thead>
          <tbody>
            {d.candidates.map((c: any) => (
              <tr key={c.shipment_line_id}>
                <td className="mono">{c.student_no}</td><td>{c.student_name}</td>
                <td>{c.item_name}</td><td>{c.size}</td>
                <td>{c.arrived_qty - c.already_issued}</td>
                <td className="row" style={{ gap: 4 }}>
                  <button className="btn sm" onClick={() => act({ action: 'issue', order_item_id: c.order_item_id, status: 'issued' }, '已发放并签收')}>正常发放</button>
                  <button className="btn danger sm" onClick={() => act({ action: 'issue', order_item_id: c.order_item_id, status: 'missing', reason: '包裹内缺件' }, '已登记缺件，等待补发')}>缺件未发</button>
                  <button className="btn secondary sm" onClick={() => setWrongFor(c)}>班级错领</button>
                </td>
              </tr>
            ))}
            {!d.candidates.length && <tr><td colSpan={6} className="empty">暂无可发放明细（校服未到校或已全部发放）</td></tr>}
          </tbody>
        </table>
      </div>

      {wrongFor && <WrongClaimModal candidate={wrongFor} students={d.allStudents || []} receiptsStudents={[]}
        onClose={() => setWrongFor(null)}
        onSubmit={async (claimantId: number) => {
          await act({ action: 'issue', order_item_id: wrongFor.order_item_id, status: 'wrong_claim', claimant_student_id: claimantId, reason: '发放现场发现被其他班/同学错领' }, '错领已登记，将发起找回或补发');
          setWrongFor(null);
        }} />}
    </div>
  );
}

function WrongClaimModal({ candidate, onClose, onSubmit }: { candidate: any; students: any[]; receiptsStudents: any[]; onClose: () => void; onSubmit: (id: number) => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<any[]>([]);
  useEffect(() => { api('/api/students').then((d) => setList(d.students.filter((s: any) => s.id !== candidate.student_id))); }, []);
  const filtered = list.filter((s) => !q || s.name.includes(q) || s.student_no.includes(q));
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>登记错领人 · {candidate.item_name}（{candidate.size}）</h3>
        <input placeholder="搜索错领学生姓名/学号" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          {filtered.slice(0, 50).map((s) => (
            <div key={s.id} className="spread" style={{ padding: '6px 2px', borderBottom: '1px solid var(--line)' }}>
              <span>{s.student_no} {s.name}（{s.campus_name} {s.class_name}）</span>
              <button className="btn sm" onClick={() => onSubmit(s.id)}>选TA</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
