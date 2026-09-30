'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/fetch';
import { Badge, useToast } from '@/components/ui';

const TRIGGER_LABELS: Record<string, string> = {
  duplicate_scan: '包装码重复扫描', mixed_package: '班级混装上报',
};
const DISPO_LABELS: Record<string, string> = { pending: '待处置', resend: '补发中', recovered: '原包找回' };

export default function MispackDetailPage() {
  const { id } = useParams();
  const [d, setD] = useState<any>(null);
  const [me, setMe] = useState<any>(null);
  const { show, node } = useToast();
  const load = () => api(`/api/mispacks/${id}`).then(setD);
  useEffect(() => { load(); api('/api/auth/me').then((r) => setMe(r.user)); }, [id]);
  if (!d) return <div className="empty">加载中…</div>;
  const e = d.event;
  const role = me?.role;
  const isGA = role === 'general_affairs' || role === 'admin';
  const isSupplier = role === 'supplier' || role === 'factory';
  const isHT = role === 'head_teacher';

  async function act(body: any, okMsg = '操作成功') {
    try {
      await api(`/api/mispacks/${id}`, { method: 'POST', body: JSON.stringify({ id: Number(id), ...body }) });
      show(okMsg); load();
    } catch (err: any) { show(err.message, true); }
  }

  return (
    <div>
      {node}
      <div className="spread">
        <h2>错包事件 <span className="mono">{e.event_no}</span> <Badge status={e.status} /></h2>
        <Link className="btn gray sm" href="/mispacks">返回列表</Link>
      </div>
      <p className="muted">
        {TRIGGER_LABELS[e.trigger_type]} · {e.title}
        {e.timeout_flag ? <span style={{ color: 'var(--red)' }}> · ⚠ 补发再次超时，已自动生成追责与调拨建议</span> : null}
      </p>
      <p className="muted">{e.description}</p>

      {/* 状态流转条 */}
      <div className="card">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {['pending_check', 'to_resort', 'resending', 'closed'].map((s, i) => {
            const order = ['pending_check', 'to_resort', 'resending', 'closed'];
            const cur = order.indexOf(e.status);
            const active = i <= cur;
            return (
              <span key={s} className="row" style={{ gap: 8 }}>
                <span className={`badge ${active ? 'green' : 'gray'}`} style={{ fontSize: 13, padding: '4px 12px' }}>
                  {i + 1}. <Badge status={s} />
                </span>
                {i < 3 && <span className="muted">→</span>}
              </span>
            );
          })}
          <span className="muted" style={{ marginLeft: 'auto' }}>
            上报：{e.reporter_name || '系统'} · 供应商：{e.supplier_name}
          </span>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* 总务审核 */}
        <div className="card">
          <h2>① 学校总务审核（受影响名单处置决策）</h2>
          <ReviewCard e={e} disabled={!isGA} onAct={act} supplementDists={d.supplementDists} />
        </div>

        {/* 供应商重新分拣 */}
        <div className="card">
          <h2>② 供应商重新分拣登记</h2>
          <ResortCard e={e} disabled={!isSupplier} onAct={act} />
        </div>
      </div>

      {/* 冻结场次 */}
      <div className="card">
        <h2>冻结的发放批次（仅涉事班级场次；无关班级可继续发放）</h2>
        <table>
          <thead><tr><th>发放场次</th><th>班级</th><th>计划时间</th><th>当前状态</th><th>冻结前</th><th>解冻时间</th></tr></thead>
          <tbody>
            {d.frozen.map((f: any) => (
              <tr key={f.id}>
                <td><Link href={`/distributions/${f.distribution_id}`}>{f.distribution_name}</Link></td>
                <td>{f.class_name}</td><td className="mono">{f.scheduled_at}</td>
                <td><Badge status={f.dist_status} /></td><td>{f.prev_status}</td>
                <td>{f.unfrozen_at || <span style={{ color: 'var(--red)' }}>冻结中</span>}</td>
              </tr>
            ))}
            {!d.frozen.length && <tr><td colSpan={6} className="empty">无冻结场次</td></tr>}
          </tbody>
        </table>
      </div>

      {/* 受影响名单 */}
      <div className="card">
        <h2>受影响学生名单（已签收学生不再补发，防止重复发放）</h2>
        <table>
          <thead><tr>
            <th>学号</th><th>学生</th><th>班级</th><th>包装码</th><th>生产批次</th><th>品类/尺码</th>
            <th>定位时状态</th><th>处置</th><th>学生实际签收</th><th>班主任复核</th><th>补发工单</th><th>操作</th>
          </tr></thead>
          <tbody>
            {d.items.map((it: any) => (
              <tr key={it.id} style={it.already_signed ? { background: '#f6f6f6' } : !it.teacher_reviewed ? { background: '#fffdf5' } : undefined}>
                <td className="mono">{it.student_no}</td><td>{it.student_name}</td><td>{it.class_name}</td>
                <td className="mono" style={{ fontSize: 12 }}>{it.package_code || '—'}</td>
                <td className="mono" style={{ fontSize: 12 }}>{it.batch_no || '—'}</td>
                <td>{it.item_name}（{it.size}）</td>
                <td>{it.already_signed ? <Badge status="signed" /> : <Badge status="missing" />}</td>
                <td>{DISPO_LABELS[it.disposition]}</td>
                <td>{it.student_signed ? <span style={{ color: 'var(--green)' }}>✓ {it.student_signed_by}<br /><span className="muted" style={{ fontSize: 11 }}>{it.student_signed_at}</span></span> : <span className="muted">待签收</span>}</td>
                <td>{it.teacher_reviewed ? <span style={{ color: 'var(--green)' }}>✓ 已复核</span> : <span className="muted">待复核</span>}</td>
                <td>{it.case_id ? <Link href={`/cases/${it.case_id}`}>{it.case_no}</Link> : '—'}</td>
                <td className="row" style={{ gap: 4 }}>
                  {!it.already_signed && it.disposition === 'pending' && (isGA || isHT) &&
                    <button className="btn gray sm" onClick={() => act({ action: 'mark_recovered', item_id: it.id }, '已登记原包找回')}>原包找回</button>}
                  {!it.already_signed && it.disposition === 'resend' && !it.student_signed &&
                    <button className="btn sm" onClick={() => act({ action: 'student_sign', item_id: it.id }, '学生已实际签收')}>学生签收</button>}
                  {!it.already_signed && it.student_signed && !it.teacher_reviewed && (isGA || isHT) &&
                    <button className="btn secondary sm" onClick={() => act({ action: 'teacher_review', item_id: it.id }, '班主任复核通过')}>班主任复核</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">双签：补发件须由学生实际签收、班主任复核两关齐备后，事件才自动闭环并解冻发放场次。</p>
        {(isGA || isHT) && (
          <div style={{ textAlign: 'right' }}>
            <button className="btn gray" onClick={() => act({ action: 'close_recovered' }, '全部原包找回，事件已闭环')}>
              全部原包找回 · 直接闭环
            </button>
          </div>
        )}
      </div>

      {/* 超时建议 */}
      <div className="card">
        <h2>追责与替代调拨建议{<span className="muted">（补发再次超时由平台自动生成）</span>}</h2>
        {d.actions.length === 0 && <div className="empty">暂无建议；补发按预计到校时间超时后将自动生成。</div>}
        {d.actions.map((a: any) => (
          <div key={a.id} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 10, marginBottom: 8, background: a.kind === 'accountability' ? '#fff8f8' : '#f7faff' }}>
            <div className="spread">
              <b><Badge status={a.kind} /> {a.auto_generated ? '平台自动生成' : '人工录入'}</b>
              <Badge status={a.status} />
            </div>
            <p style={{ margin: '6px 0' }}>{a.content}</p>
            {isGA && a.status === 'suggested' && (
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm" onClick={() => act({ action: 'handle_action', action_id: a.id, decision: 'accepted' }, '已采纳')}>采纳</button>
                <button className="btn gray sm" onClick={() => act({ action: 'handle_action', action_id: a.id, decision: 'rejected' }, '已驳回')}>驳回</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 时间线 */}
      <div className="card">
        <h2>全过程留痕</h2>
        <table>
          <tbody>
            {d.logs.map((l: any) => (
              <tr key={l.id}>
                <td className="mono muted" style={{ width: 170 }}>{l.created_at}</td>
                <td style={{ width: 130 }}>{l.actor_name}（{l.actor_role}）</td>
                <td><b>{l.action}</b> {l.detail}</td>
              </tr>
            ))}
            {!d.logs.length && <tr><td className="empty">暂无留痕</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReviewCard({ e, disabled, onAct, supplementDists }: { e: any; disabled: boolean; onAct: (b: any, m?: string) => void; supplementDists: any[] }) {
  const [decision, setDecision] = useState(e.review_decision === 'pending' ? 'priority_resend' : e.review_decision);
  const [note, setNote] = useState(e.review_note || '');
  const [suppId, setSuppId] = useState<number | ''>(e.supplement_distribution_id || '');
  return (
    <div>
      <div className="field"><label>处置决策 *</label>
        <select value={decision} disabled={disabled || e.status !== 'pending_check'} onChange={(ev) => setDecision(ev.target.value)}>
          <option value="priority_resend">优先补发（供应商加急重发，安排补领场）</option>
          <option value="delayed">延后发放（等待原包重新分拣齐套后再发）</option>
        </select>
      </div>
      <div className="field"><label>审核意见</label>
        <input value={note} disabled={disabled || e.status !== 'pending_check'} onChange={(ev) => setNote(ev.target.value)} placeholder="如：优先保障一年级新生，二(1)班可延后" />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm" disabled={disabled || e.status !== 'pending_check'}
          onClick={() => onAct({ action: 'review', decision, note }, '审核决策已记录')}>保存审核决策</button>
        <button className="btn secondary sm" disabled={disabled || e.status !== 'pending_check' || e.review_decision === 'pending'}
          onClick={() => onAct({ action: 'confirm_check' }, '核对完成，转供应商重新分拣')}>核对完成 → 转分拣</button>
      </div>
      {e.status === 'resending' && (
        <div className="field" style={{ marginTop: 10 }}>
          <label>补发到校与补领场</label>
          <div className="row" style={{ gap: 8 }}>
            <select value={suppId} onChange={(ev) => setSuppId(Number(ev.target.value))} disabled={!!e.arrived_at}>
              <option value="">自动创建补领场</option>
              {supplementDists.map((s) => <option key={s.id} value={s.id}>{s.class_name} · {s.name}</option>)}
            </select>
            <button className="btn sm" disabled={disabled || !!e.arrived_at}
              onClick={() => onAct({ action: 'arrive', supplement_distribution_id: suppId || null }, '已确认补发到校，可在补领场签收')}>
              {e.arrived_at ? `已到校 ${String(e.arrived_at).slice(0, 16)}` : '确认补发到校'}
            </button>
          </div>
        </div>
      )}
      {e.status === 'closed' && <p style={{ color: 'var(--green)' }}>✓ {e.close_note || '事件已闭环'}（{String(e.closed_at).slice(0, 16)}）</p>}
    </div>
  );
}

function ResortCard({ e, disabled, onAct }: { e: any; disabled: boolean; onAct: (b: any, m?: string) => void }) {
  const [f, setF] = useState<any>({
    sort_operator: e.sort_operator || '',
    original_package_destination: e.original_package_destination || '',
    resend_tracking_no: e.resend_tracking_no || '',
    expected_arrival: e.expected_arrival ? String(e.expected_arrival).slice(0, 16).replace(' ', 'T') : '',
  });
  const canEdit = e.status === 'to_resort';
  if (e.status === 'pending_check') return <p className="muted">等待学校总务核对名单并审核决策…</p>;
  return (
    <div>
      <div className="field"><label>分拣操作人 *</label>
        <input value={f.sort_operator} disabled={disabled || !canEdit} onChange={(ev) => setF({ ...f, sort_operator: ev.target.value })} placeholder="如：仓库分拣员 王芳" />
      </div>
      <div className="field"><label>原包去向 *</label>
        <input value={f.original_package_destination} disabled={disabled || !canEdit} onChange={(ev) => setF({ ...f, original_package_destination: ev.target.value })} placeholder="如：退回供应商中心仓重新按班分拣" />
      </div>
      <div className="grid grid-2">
        <div className="field"><label>补发单号{e.review_decision === 'priority_resend' ? ' *' : ''}</label>
          <input value={f.resend_tracking_no} disabled={disabled || !canEdit} onChange={(ev) => setF({ ...f, resend_tracking_no: ev.target.value })} placeholder="如 SF-RS-20261025" />
        </div>
        <div className="field"><label>预计到校时间 *</label>
          <input type="datetime-local" value={f.expected_arrival} disabled={disabled || !canEdit} onChange={(ev) => setF({ ...f, expected_arrival: ev.target.value })} />
        </div>
      </div>
      <button className="btn sm" disabled={disabled || !canEdit}
        onClick={() => onAct({ action: 'resort', ...f, expected_arrival: f.expected_arrival ? f.expected_arrival.replace('T', ' ') + ':00' : '' },
          '重新分拣已登记，进入补发，已为缺包学生生成补发工单')}>
        登记分拣并进入补发
      </button>
      {(e.status === 'resending' || e.status === 'closed') && (
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          已登记：{e.sort_operator} · {e.original_package_destination} · 补发单号 {e.resend_tracking_no || '待补录'} · 预计到校 {e.expected_arrival}
        </div>
      )}
    </div>
  );
}
