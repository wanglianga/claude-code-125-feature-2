'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/fetch';
import { Badge, PackageBadge, useToast } from '@/components/ui';

const SCENE_LABELS: Record<string, string> = { arrival: '到校扫描', distribution: '发放现场扫描' };

export default function PackageDetailPage() {
  const { id } = useParams();
  const [d, setD] = useState<any>(null);
  const [dists, setDists] = useState<any[]>([]);
  const [scene, setScene] = useState('arrival');
  const [distId, setDistId] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const { show, node } = useToast();
  const load = () => api(`/api/packages/${id}`).then(setD);
  useEffect(() => { load(); api('/api/distributions').then((r) => setDists(r.distributions)); }, [id]);
  if (!d) return <div className="empty">加载中…</div>;
  const pk = d.package;

  return (
    <div>
      {node}
      <div className="spread">
        <h2>包装码 <span className="mono">{pk.package_code}</span> <PackageBadge status={pk.status} /></h2>
        <Link className="btn gray sm" href="/packages">返回</Link>
      </div>
      <p className="muted">
        目标：{pk.intended_campus_name} {pk.intended_class_name || '未指定班级'} · 计划 {pk.plan_name} ·
        批次 {pk.batch_no || '—'} · 发货单 {pk.shipment_no || '—'} · 装箱人 {pk.packer_name || '—'}
      </p>

      <div className="card">
        <h2>扫码登记（同一包装码第 2 次扫描自动触发错包预警并冻结相关发放批次）</h2>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <select value={scene} onChange={(e) => setScene(e.target.value)}>
            <option value="arrival">到校扫码</option>
            <option value="distribution">发放现场扫码</option>
          </select>
          {scene === 'distribution' && (
            <select value={distId} onChange={(e) => setDistId(Number(e.target.value))}>
              <option value="">选择发放场次</option>
              {dists.map((x) => <option key={x.id} value={x.id}>{x.class_name} · {x.name}（{x.status}）</option>)}
            </select>
          )}
          <input placeholder="备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 220 }} />
          <button className="btn" onClick={async () => {
            try {
              const r = await api(`/api/packages/${id}`, {
                method: 'POST',
                body: JSON.stringify({ id: pk.id, scene, distribution_id: distId || null, note }),
              });
              if (r.duplicate) show(`检测到第 ${r.seq} 次重复扫描，已生成错包事件 ${r.mispack.event_no} 并冻结 ${r.mispack.frozen} 个发放场次`, true);
              else show(`扫码成功（第 ${r.seq} 次）`);
              setNote(''); load();
            } catch (e: any) { show(e.message, true); }
          }}>扫码</button>
        </div>
      </div>

      {d.events.length > 0 && (
        <div className="card">
          <h2>关联错包事件</h2>
          <div className="row">
            {d.events.map((ev: any) => (
              <Link key={ev.id} className="tag-chip" style={{ padding: '4px 10px' }} href={`/mispacks/${ev.id}`}>
                {ev.event_no} <Badge status={ev.status} />
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2>包内校服（{d.items.length} 种）</h2>
        <table>
          <thead><tr><th>学号</th><th>学生</th><th>班级</th><th>品类</th><th>尺码</th><th>数量</th></tr></thead>
          <tbody>
            {d.items.map((it: any) => (
              <tr key={it.id}>
                <td className="mono">{it.student_no}</td><td>{it.student_name}</td><td>{it.class_name}</td>
                <td>{it.item_name}</td><td>{it.size}</td><td>{it.qty}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>扫码历史</h2>
        <table>
          <thead><tr><th>时间</th><th>场景</th><th>发放场次</th><th>扫描人</th><th>备注</th></tr></thead>
          <tbody>
            {d.scans.map((s: any) => (
              <tr key={s.id} style={s.id !== d.scans[0]?.id ? undefined : { background: '#f3faf5' }}>
                <td className="mono">{s.scanned_at}</td>
                <td><Badge status={s.scene} /></td>
                <td>{s.distribution_name || '—'}</td>
                <td>{s.scanner_user_name || s.scanner_name}</td><td>{s.note || '—'}</td>
              </tr>
            ))}
            {!d.scans.length && <tr><td colSpan={5} className="empty">尚未扫码</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
