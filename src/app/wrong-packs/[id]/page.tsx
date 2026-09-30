'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/fetch';
import { Badge, useToast } from '@/components/ui';

const TRIGGER_LABEL: Record<string, string> = {
  mixed_pack: '两班尺码包混装', duplicate_scan: '同一包装码重复扫描', class_signoff_mismatch: '班级签收核对不符',
};

export default function WrongPackDetailPage() {
  const { id } = useParams();
  const [d, setD] = useState<any>(null);
  const [me, setMe] = useState<any>(null);
  const { show, node } = useToast();
  const load = () => api(`/api/wrong-packs/${id}`).then(setD);
  useEffect(() => { api('/api/auth/me').then((x) => setMe(x.user)); load(); }, [id]);
  if (!d || !me) return <div className="empty">加载中…</div>;
  const w = d.wpc;

  const isGA = ['general_affairs', 'admin'].includes(me.role);
  const isSupplier = ['supplier', 'factory', 'admin'].includes(me.role);
  const isTeacher = ['head_teacher', 'general_affairs', 'admin'].includes(me.role);

  async function act(body: any, okMsg = '操作成功') {
    try { await api(`/api/wrong-packs/${id}`, { method: 'POST', body: JSON.stringify({ id: Number(id), ...body }) }); show(okMsg); load(); }
    catch (e: any) { show(e.message, true); }
  }

  const activeItems = d.items.filter((i: any) => i.item_status !== 'excluded');
  const unsigned = activeItems.filter((i: any) => !i.student_signed_at);
  const unreviewed = activeItems.filter((i: any) => i.student_signed_at && !i.teacher_reviewed_at);

  return (
    <div>
      {node}
      <div className="spread">
        <h2>错包工单 <span className="mono" style={{ fontSize: 14 }}>{w.case_no}</span> <Badge status={w.status} /></h2>
        <Link className="btn gray sm" href="/wrong-packs">返回列表</Link>
      </div>
      <p className="muted">{w.title} · {TRIGGER_LABEL[w.trigger_reason]} · {w.campus_name} · {w.plan_name} · 供应商 {w.supplier_name}</p>

      <div className="grid grid-4">
        <div className="stat"><div className="num">{d.items.length}</div><div className="lbl">定位明细</div></div>
        <div className="stat"><div className="num" style={{ color: 'var(--amber)' }}>{activeItems.length}</div><div className="lbl">待补齐（已排除 {d.items.length - activeItems.length}）</div></div>
        <div className="stat"><div className="num" style={{ color: 'var(--green)' }}>{activeItems.length - unsigned.length}</div><div className="lbl">学生已签收</div></div>
        <div className="stat"><div className="num">{d.freezes.filter((f: any) => !f.unfrozen).length}/{d.freezes.length}</div><div className="lbl">冻结中/总冻结批次</div></div>
      </div>

      {w.resend_overdue && (
        <div className="card" style={{ borderColor: 'var(--red)', background: '#fff8f8' }}>
          <h2 style={{ color: 'var(--red)' }}>⚠ 补发再次超时</h2>
          <p>系统已自动生成向供应商追责单 <b className="mono">{w.accountability_no}</b>。{w.accountability_note}</p>
          {w.transfer_suggestion && <p><b>替代调拨建议：</b>{w.transfer_suggestion}</p>}
        </div>
      )}

      {/* 阶段一：总务核对名单并决定优先补发/延后发放 */}
      {w.status === 'to_check' && (
        <div className="card">
          <h2>① 总务核对受影响名单并决定处置方式</h2>
          <p className="muted">已签收学生默认排除，避免重复发放；可逐件纳入/排除。审核后进入供应商重新分拣。</p>
          <ReviewPanel onReview={(decision, note) => act({ action: 'review', decision, note }, decision === 'priority_resend' ? '已决定优先补发' : '已决定延后发放')} disabled={!isGA} />
        </div>
      )}

      {/* 阶段二：供应商重新分拣登记 */}
      {w.status === 'to_repack' && (
        <div className="card">
          <h2>② 供应商重新分拣登记</h2>
          <p className="muted">总务决定：<Badge status={w.review_decision} /> {w.review_note || ''}</p>
          <RepackPanel
            priority={w.review_decision === 'priority_resend'}
            disabled={!isSupplier}
            onSubmit={(v) => act({ action: 'repack', ...v }, v.resend_tracking_no ? '重新分拣完成，补发已发出' : '分拣登记已保存（延后发放）')}
          />
          {w.review_decision === 'defer_release' && (
            <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 10 }}>
              <p className="muted">延后发放确定补发时间后，补登记补发单号：</p>
              <ResendShipPanel disabled={!isSupplier} onSubmit={(v) => act({ action: 'resend_ship', ...v }, '补发单号已登记')} />
            </div>
          )}
        </div>
      )}

      {/* 阶段三：补发到校 + 双签 */}
      {w.status === 'resending' && (
        <div className="card">
          <h2>③ 补发到校与学生签收 / 班主任复核</h2>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
            <span>补发单号：<b className="mono">{w.resend_tracking_no || '—'}</b></span>
            <span>预计到校：<b>{w.resend_expected_arrival}</b></span>
            <span>实际到校：{w.resend_arrived_at || <span className="muted">未到校</span>}</span>
            {!w.resend_arrived_at && isGA && <button className="btn sm" onClick={() => act({ action: 'resend_arrive' }, '已确认补发到校，可安排学生签收')}>确认补发到校</button>}
            {w.review_decision === 'defer_release' && isSupplier && (
              <ResendShipPanel disabled={false} compact onSubmit={(v) => act({ action: 'resend_ship', ...v }, '补发信息已更新')} />
            )}
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            闭环条件：全部待补件均完成<b>学生实际签收</b>与<b>班主任复核</b>（剩余待签收 {unsigned.length}、待复核 {unreviewed.length}），系统将自动闭环并解冻相关发放批次。
          </p>
        </div>
      )}

      {/* 受影响名单 */}
      <div className="card">
        <h2>受影响学生名单（按学生订单 + 包装码 + 班级签收定位）</h2>
        <table>
          <thead><tr>
            <th>学号</th><th>学生</th><th>班级</th><th>品类</th><th>尺码</th><th>包装码/批次追溯</th>
            <th>发现时已签收</th><th>状态</th><th>学生签收</th><th>班主任复核</th><th>操作</th>
          </tr></thead>
          <tbody>
            {d.items.map((it: any) => (
              <tr key={it.id} style={it.item_status === 'excluded' ? { opacity: 0.55 } : undefined}>
                <td className="mono">{it.student_no}</td><td>{it.student_name}</td><td>{it.class_name}</td>
                <td>{it.item_name}</td><td>{it.size}</td>
                <td className="mono" style={{ fontSize: 11 }}>{it.pack_code || '—'}</td>
                <td>{it.already_signed ? <Badge status="signed" /> : <span className="muted">否</span>}</td>
                <td><Badge status={it.item_status} />{it.exclude_reason && <div className="muted" style={{ fontSize: 11 }}>{it.exclude_reason}</div>}</td>
                <td>{it.student_signed_at ? `${it.student_signed_by || ''} ${String(it.student_signed_at).slice(5, 16)}` : <span className="muted">—</span>}</td>
                <td>{it.teacher_reviewed_at ? <span style={{ color: 'var(--green)' }}>已复核 {String(it.teacher_reviewed_at).slice(5, 16)}</span> : <span className="muted">—</span>}</td>
                <td className="row" style={{ gap: 4 }}>
                  {w.status === 'to_check' && isGA && it.item_status !== 'excluded'
                    && <button className="btn danger sm" onClick={() => act({ action: 'tune_item', item_id: it.id, included: false, reason: '核对后排除（已签收/原包找回）' }, '已排除，不纳入补发')}>排除</button>}
                  {w.status === 'to_check' && isGA && it.item_status === 'excluded'
                    && <button className="btn secondary sm" onClick={() => act({ action: 'tune_item', item_id: it.id, included: true }, '已重新纳入名单')}>纳入</button>}
                  {['resending'].includes(w.status) && it.item_status !== 'excluded' && !it.student_signed_at && isTeacher
                    && <button className="btn sm" disabled={!w.resend_arrived_at && w.review_decision === 'priority_resend'}
                      onClick={() => act({ action: 'student_sign', item_id: it.id }, '学生实际签收已登记，已避免重复发放')}>学生签收</button>}
                  {w.status === 'resending' && it.student_signed_at && !it.teacher_reviewed_at && isTeacher
                    && <button className="btn secondary sm" onClick={() => act({ action: 'teacher_review', item_id: it.id }, '班主任复核通过')}>班主任复核</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 冻结的发放批次 */}
      <div className="card">
        <h2>被冻结的发放批次（仅相关班级，无关班级可继续发放）</h2>
        <table>
          <thead><tr><th>发放场次</th><th>计划时间</th><th>场次状态</th><th>冻结状态</th><th>解冻时间</th><th></th></tr></thead>
          <tbody>
            {d.freezes.map((f: any) => (
              <tr key={f.id}>
                <td>{f.distribution_name}</td><td>{f.scheduled_at}</td><td><Badge status={f.dist_status} /></td>
                <td>{f.unfrozen ? <span className="muted">已解冻</span> : <Badge status="frozen" />}</td>
                <td>{f.unfrozen_at || '—'}</td>
                <td><Link className="btn gray sm" href={`/distributions/${f.distribution_id}`}>打开发放场 ›</Link></td>
              </tr>
            ))}
            {!d.freezes.length && <tr><td colSpan={6} className="empty">未冻结发放批次（相关班级当时无未结束场次）</td></tr>}
          </tbody>
        </table>
      </div>

      {/* 追责单 */}
      {d.liabilities.length > 0 && (
        <div className="card">
          <h2>供应商追责与替代调拨建议</h2>
          <table>
            <thead><tr><th>追责单号</th><th>类型</th><th>状态</th><th>建议扣罚</th><th>说明</th><th>替代调拨建议</th></tr></thead>
            <tbody>
              {d.liabilities.map((l: any) => (
                <tr key={l.id}>
                  <td className="mono">{l.liability_no}</td><td><Badge status={l.type} /></td><td><Badge status={l.status} /></td>
                  <td>{l.amount ? `¥${l.amount}` : '—'}</td><td style={{ maxWidth: 260 }}>{l.note}</td>
                  <td style={{ maxWidth: 300 }}>{l.transfer_suggestion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 处置时间线 */}
      <div className="card">
        <h2>错包处置时间线（批次可追溯留痕）</h2>
        <div className="timeline">
          {d.logs.map((l: any) => (
            <div className="ev" key={l.id}>
              <div><b>{l.action}</b> <span className="muted">— {l.actor_name}（{l.actor_role}）</span></div>
              {l.detail && <div className="muted">{l.detail}</div>}
              <div className="t">{l.created_at}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewPanel({ onReview, disabled }: { onReview: (decision: string, note: string) => void; disabled: boolean }) {
  const [note, setNote] = useState('');
  return (
    <div>
      <div className="field"><label>审核意见</label><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：优先保证一(1)班已到校学生补发" /></div>
      <div className="row">
        <button className="btn" disabled={disabled} onClick={() => onReview('priority_resend', note)}>优先补发（影响班级暂停，待补发签收）</button>
        <button className="btn secondary" disabled={disabled} onClick={() => onReview('defer_release', note)}>延后发放（原包改送/暂存，稍后补发）</button>
        {disabled && <span className="muted">仅学校总务可审核</span>}
      </div>
    </div>
  );
}

function RepackPanel({ priority, disabled, onSubmit }: { priority: boolean; disabled: boolean; onSubmit: (v: any) => void }) {
  const [v, setV] = useState({ operator: '', original_pack_destination: '', remark: '', resend_tracking_no: '', resend_expected_arrival: '' });
  return (
    <div className="grid grid-2">
      <div className="field"><label>重新分拣操作人 *</label><input value={v.operator} onChange={(e) => setV({ ...v, operator: e.target.value })} placeholder="如：仓库分拣 王军" /></div>
      <div className="field"><label>原包去向 *</label>
        <select value={v.original_pack_destination} onChange={(e) => setV({ ...v, original_pack_destination: e.target.value })}>
          <option value="">请选择</option>
          <option>退回供应商仓库重新分拣</option>
          <option>校内暂存，待补领场发放</option>
          <option>改送至标签对应班级</option>
          <option>与另一混装包现场对调</option>
        </select>
      </div>
      <div className="field"><label>补发单号 {priority ? '*' : '（延后发放可后补）'}</label><input className="mono" value={v.resend_tracking_no} onChange={(e) => setV({ ...v, resend_tracking_no: e.target.value })} placeholder="如：RS20261001" /></div>
      <div className="field"><label>补发预计到校时间 {priority ? '*' : ''}</label><input type="date" value={v.resend_expected_arrival} onChange={(e) => setV({ ...v, resend_expected_arrival: e.target.value })} /></div>
      <div className="field" style={{ gridColumn: '1 / -1' }}><label>备注</label><input value={v.remark} onChange={(e) => setV({ ...v, remark: e.target.value })} /></div>
      <div style={{ gridColumn: '1 / -1', textAlign: 'right' }} className="row">
        {disabled && <span className="muted">仅供应商可登记</span>}
        <button className="btn" disabled={disabled} onClick={() => onSubmit(v)}>{priority ? '提交分拣并发出补发' : '保存分拣登记'}</button>
      </div>
    </div>
  );
}

function ResendShipPanel({ disabled, compact, onSubmit }: { disabled: boolean; compact?: boolean; onSubmit: (v: any) => void }) {
  const [v, setV] = useState({ resend_tracking_no: '', resend_expected_arrival: '' });
  return (
    <span className="row" style={compact ? { gap: 6 } : { gap: 8, flexWrap: 'wrap' }}>
      <input className="mono" placeholder="补发单号" value={v.resend_tracking_no} onChange={(e) => setV({ ...v, resend_tracking_no: e.target.value })} style={{ width: 150 }} />
      <input type="date" value={v.resend_expected_arrival} onChange={(e) => setV({ ...v, resend_expected_arrival: e.target.value })} />
      <button className="btn sm" disabled={disabled} onClick={() => v.resend_tracking_no && v.resend_expected_arrival && onSubmit(v)}>登记补发</button>
    </span>
  );
}
