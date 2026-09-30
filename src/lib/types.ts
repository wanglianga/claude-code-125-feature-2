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
  // 错包追溯
  pending_check: '待核对', to_resort: '待重新分拣', resending: '补发中', closed: '已闭环',
  frozen: '已冻结',
  priority_resend: '优先补发', delayed: '延后发放',
  mixed_package: '班级混装/错包', duplicate_scan: '包装码重复扫描',
  arrival: '到校扫描', distribution: '发放现场扫描',
  merged_flagged: '混装预警', consumed: '已用尽',
  accountability: '供应商追责', transfer_suggestion: '替代调拨',
  suggested: '建议待处理', accepted: '已采纳',
};

// 包装码专用状态标签（returned 与换码"已寄回"同键，包装码页面用此映射）
export const PACKAGE_STATUS_LABELS: Record<string, string> = {
  active: '正常', merged_flagged: '混装预警', returned: '已退回分拣', consumed: '已用尽',
};

export function badgeClass(status: string) {
  if (['paid', 'signed', 'approved', 'resolved', 'arrived', 'completed', 'produced', 'done', 'active', 'closed', 'accepted'].includes(status)) return 'green';
  if (['hold', 'wrong_claim', 'missing', 'rejected', 'cancelled', 'transferred', 'overdue', 'shipped', 'frozen', 'merged_flagged', 'returned', 'accountability', 'priority_resend'].includes(status)) return status === 'shipped' ? 'amber' : 'red';
  if (['confirmed', 'open', 'requested', 'in_production', 'part_shipped', 'issued', 'processing', 'pending', 'planned', 'returned', 'reshipped', 'pending_check', 'to_resort', 'resending', 'suggested', 'transfer_suggestion', 'delayed'].includes(status)) return 'amber';
  if (['draft', 'graduated'].includes(status)) return 'gray';
  return 'blue';
}
