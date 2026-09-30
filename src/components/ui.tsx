'use client';
import { useState, ReactNode } from 'react';
import { STATUS_LABELS, PACKAGE_STATUS_LABELS, badgeClass } from '@/lib/types';

export function Badge({ status }: { status: string }) {
  return <span className={`badge ${badgeClass(status)}`}>{STATUS_LABELS[status] || status}</span>;
}

export function PackageBadge({ status }: { status: string }) {
  return <span className={`badge ${badgeClass(status)}`}>{PACKAGE_STATUS_LABELS[status] || STATUS_LABELS[status] || status}</span>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" style={wide ? { width: 900 } : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 12 }}>
          <h3>{title}</h3>
          <button className="btn gray sm" onClick={onClose}>关闭</button>
        </div>
        {children}
      </div>
    </div>
  );
}

let toastTimer: any = null;
export function useToast() {
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const show = (text: string, err = false) => {
    setMsg({ text, err });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setMsg(null), 2600);
  };
  const node = msg ? <div className={`toast ${msg.err ? 'err' : ''}`}>{msg.text}</div> : null;
  return { show, node };
}

export function fmtMoney(n: any) {
  return `¥${Number(n || 0).toFixed(2)}`;
}

export const GARMENT_LABELS: Record<string, string> = {
  top: '上衣', pants: '裤子', skirt: '裙装', coat: '外套', shoes: '鞋',
};
export const SUIT_LABELS: Record<string, string> = {
  season_set: '季节套装', sportswear: '运动服', formal: '礼服', extra: '增购件',
};
