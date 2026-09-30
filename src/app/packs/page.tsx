'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/fetch';
import { Badge, Modal, useToast } from '@/components/ui';

export default function PacksPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [me, setMe] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const { show, node } = useToast();
  const load = () => api('/api/pack-codes').then((d) => setRows(d.packs));
  useEffect(() => { api('/api/auth/me').then((d) => setMe(d.user)); load(); }, []);
  const canCreate = me && ['supplier', 'factory', 'general_affairs', 'admin'].includes(me.role);

  return (
    <div>
      {node}
      <div className="spread">
        <h2>到校包装码（尺码包追溯）</h2>
        {canCreate && <button className="btn" onClick={() => setShowCreate(true)}>＋ 登记到校包装码</button>}
      </div>
      <p className="muted">
        每个到校尺码包有唯一包装码，绑定发货单、生产批次与标签班级。包装标签班级与内装订单班级不一致自动标记<b>混装</b>；
        发放现场<b>同一包装码重复扫描</b>将提示冻结相关发放批次核对。
      </p>
      <div className="card">
        <table>
          <thead><tr>
            <th>包装码</th><th>发货单</th><th>生产批次</th><th>标签班级</th><th>内装件</th><th>混装件</th>
            <th>扫码次数</th><th>重复扫描</th><th>状态</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={r.mismatch_cnt > 0 || r.dup_cnt > 0 ? { background: '#fff8f8' } : undefined}>
                <td className="mono">{r.pack_code}</td>
                <td>{r.shipment_no || '—'}</td><td>{r.batch_no || '—'}</td><td>{r.class_name || '未贴班级标签'}</td>
                <td>{r.item_cnt}</td>
                <td>{r.mismatch_cnt > 0 ? <span style={{ color: 'var(--red)' }}>{r.mismatch_cnt}</span> : 0}</td>
                <td>{r.scan_cnt}</td>
                <td>{r.dup_cnt > 0 ? <span style={{ color: 'var(--red)' }}>{r.dup_cnt} 次</span> : <span className="muted">—</span>}</td>
                <td><Badge status={r.status} /></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9} className="empty">暂无包装码</td></tr>}
          </tbody>
        </table>
      </div>
      {showCreate && <CreatePackModal onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); load(); show('包装码已登记'); }} />}
    </div>
  );
}

function CreatePackModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [shipments, setShipments] = useState<any[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [shipmentId, setShipmentId] = useState<number | ''>('');
  const [lines, setLines] = useState<any[]>([]);
  const [sel, setSel] = useState<number[]>([]);
  const [f, setF] = useState({ pack_code: '', class_id: '' });
  const { show, node } = useToast();

  useEffect(() => {
    api('/api/shipments').then((d) => setShipments(d.shipments));
    api('/api/classes').then((d) => setClasses(d.classes));
  }, []);
  useEffect(() => {
    setLines([]); setSel([]);
    if (shipmentId) api(`/api/shipments/${shipmentId}`).then((d) => setLines(d.lines));
  }, [shipmentId]);

  async function submit() {
    try {
      if (!f.pack_code) { show('请填写包装码', true); return; }
      if (!sel.length) { show('请勾选包内明细', true); return; }
      const d = await api('/api/pack-codes', {
        method: 'POST',
        body: JSON.stringify({ pack_code: f.pack_code, shipment_id: shipmentId, class_id: f.class_id ? Number(f.class_id) : null, line_ids: sel }),
      });
      if (d.mismatch_cnt > 0) show(`登记成功，发现 ${d.mismatch_cnt} 件跨班混装，请尽快发起错包处理`, true);
      onDone();
    } catch (e: any) { show(e.message, true); }
  }

  return (
    <Modal title="登记到校包装码" onClose={onClose} wide>
      {node}
      <div className="grid grid-3">
        <div className="field"><label>包装码 *</label><input className="mono" value={f.pack_code} onChange={(e) => setF({ ...f, pack_code: e.target.value })} placeholder="如：PK-MD-1001" /></div>
        <div className="field"><label>所属发货单 *</label>
          <select value={shipmentId} onChange={(e) => setShipmentId(Number(e.target.value))}>
            <option value="">请选择</option>{shipments.map((s) => <option key={s.id} value={s.id}>{s.shipment_no}（{s.batch_no}）</option>)}
          </select>
        </div>
        <div className="field"><label>包装标签班级</label>
          <select value={f.class_id} onChange={(e) => setF({ ...f, class_id: e.target.value })}>
            <option value="">未贴标签</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>
      <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
        <table>
          <thead><tr><th></th><th>学生</th><th>班级</th><th>品类</th><th>尺码</th><th>发货/到校</th></tr></thead>
          <tbody>
            {lines.map((l) => {
              const cross = f.class_id && l.class_name !== classes.find((c) => String(c.id) === f.class_id)?.name;
              return (
                <tr key={l.id} style={cross ? { background: '#fff8f8' } : undefined}>
                  <td><input type="checkbox" checked={sel.includes(l.id)} onChange={() =>
                    setSel(sel.includes(l.id) ? sel.filter((x) => x !== l.id) : [...sel, l.id])} /></td>
                  <td>{l.student_name}（{l.student_no}）</td>
                  <td>{l.class_name}{cross && <span style={{ color: 'var(--red)' }}> ⚠跨班</span>}</td>
                  <td>{l.item_name}</td><td>{l.size}</td><td>{l.qty}/{l.arrived_qty}</td>
                </tr>
              );
            })}
            {!lines.length && <tr><td colSpan={6} className="empty">请先选择发货单</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ textAlign: 'right', marginTop: 10 }}><button className="btn" onClick={submit}>登记包装码</button></div>
    </Modal>
  );
}
