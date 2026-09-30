export const ROLE_LABELS: Record<string, string> = {
  admin: '系统管理员',
  general_affairs: '学校总务',
  head_teacher: '班主任',
  parent: '家长',
  supplier: '供应商',
  factory: '工厂',
  after_sales: '售后客服',
};

export interface SessionUserT {
  id: number;
  username: string;
  real_name: string;
  role: keyof typeof ROLE_LABELS | string;
  campus_id: number | null;
  supplier_id: number | null;
}

export const STATUS_LABELS: Record<string, string> = {
  draft: '草稿', confirmed: '待缴费', paid: '已缴费', hold: '已挂起', cancelled: '已取消',
  active: '在校', transferred: '已转学', graduated: '已毕业',
  open: '待处理', processing: '处理中', resolved: '已解决', rejected: '已驳回',
  planned: '已计划', in_production: '生产中', produced: '已完工', part_shipped: '部分发货', completed: '已完成',
  shipped: '运输中', arrived: '已到校',
  issued: '已发放', signed: '已签收', wrong_claim: '错领', missing: '缺件',
  pending: '待审批', approved: '已批准', rejected_b: '已驳回',
  requested: '待处理', returned: '已寄回', reshipped: '已重发', done: '完成',
  regular: '常规发放', supplementary: '补领场',
  annual: '年度统一采购', makeup: '毕业班补订',
  in_progress_d: '进行中',
  // 错包处理
  to_check: '待核对', to_repack: '待重新分拣', resending: '补发中', closed: '已闭环',
  mixed: '混装', frozen: '已冻结', repacked: '已重新分拣', scanned: '已扫码',
  priority_resend: '优先补发', defer_release: '延后发放',
  affected: '受影响', excluded: '已排除',
  wrong_pack_overdue: '补发超时追责', wrong_pack_mix: '混装追责',
  acknowledged: '供应商已认责', settled: '已结清',
};

export function badgeClass(status: string) {
  if (['paid', 'signed', 'approved', 'resolved', 'arrived', 'completed', 'produced', 'done', 'active', 'closed', 'settled'].includes(status)) return 'green';
  if (['hold', 'wrong_claim', 'missing', 'rejected', 'cancelled', 'transferred', 'overdue', 'frozen', 'mixed', 'wrong_pack_overdue', 'wrong_pack_mix'].includes(status)) return 'red';
  if (['confirmed', 'open', 'requested', 'in_production', 'part_shipped', 'issued', 'processing', 'pending', 'planned', 'returned', 'reshipped', 'to_check', 'to_repack', 'resending', 'affected', 'priority_resend', 'acknowledged', 'scanned', 'repacked'].includes(status)) return 'amber';
  if (['draft', 'graduated', 'excluded', 'defer_release'].includes(status)) return 'gray';
  return 'blue';
}
