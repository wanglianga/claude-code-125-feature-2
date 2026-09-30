-- 校园校服订购尺码试穿与售后换码平台 数据库结构
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS campuses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS suppliers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  contact VARCHAR(100),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS grades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campus_id INT NOT NULL,
  name VARCHAR(50) NOT NULL,
  graduation_year INT NULL,
  INDEX (campus_id),
  CONSTRAINT fk_grades_campus FOREIGN KEY (campus_id) REFERENCES campuses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(60) NOT NULL UNIQUE,
  password_hash VARCHAR(200) NOT NULL,
  salt VARCHAR(64) NOT NULL,
  real_name VARCHAR(60) NOT NULL,
  role ENUM('admin','general_affairs','head_teacher','parent','supplier','factory','after_sales') NOT NULL,
  campus_id INT NULL,
  supplier_id INT NULL,
  phone VARCHAR(30),
  CONSTRAINT fk_users_campus FOREIGN KEY (campus_id) REFERENCES campuses(id),
  CONSTRAINT fk_users_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS classes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  grade_id INT NOT NULL,
  name VARCHAR(50) NOT NULL,
  teacher_user_id INT NULL,
  INDEX (grade_id),
  CONSTRAINT fk_classes_grade FOREIGN KEY (grade_id) REFERENCES grades(id),
  CONSTRAINT fk_classes_teacher FOREIGN KEY (teacher_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 学生（家长端维护身高体重/常穿尺码/特殊版型；转学留痕）
CREATE TABLE IF NOT EXISTS students (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_no VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(60) NOT NULL,
  campus_id INT NOT NULL,
  grade_id INT NOT NULL,
  class_id INT NOT NULL,
  parent_user_id INT NULL,
  status ENUM('active','transferred','graduated') NOT NULL DEFAULT 'active',
  transferred_at DATETIME NULL,
  height_cm DECIMAL(5,1) NULL,
  weight_kg DECIMAL(5,1) NULL,
  usual_size VARCHAR(20) NULL,
  special_fit TINYINT(1) NOT NULL DEFAULT 0,
  special_fit_note VARCHAR(200),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (class_id), INDEX (parent_user_id),
  CONSTRAINT fk_students_campus FOREIGN KEY (campus_id) REFERENCES campuses(id),
  CONSTRAINT fk_students_grade FOREIGN KEY (grade_id) REFERENCES grades(id),
  CONSTRAINT fk_students_class FOREIGN KEY (class_id) REFERENCES classes(id),
  CONSTRAINT fk_students_parent FOREIGN KEY (parent_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 贫困生减免
CREATE TABLE IF NOT EXISTS subsidies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL,
  ratio DECIMAL(4,2) NOT NULL COMMENT '减免比例 0~1',
  reason VARCHAR(200),
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  approved_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_subsidy_student (student_id),
  CONSTRAINT fk_subsidy_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT fk_subsidy_approver FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 订购计划（多校区统一采购：plan_campuses 多条；毕业班补订 kind=makeup）
CREATE TABLE IF NOT EXISTS plans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  kind ENUM('annual','makeup') NOT NULL DEFAULT 'annual',
  academic_year VARCHAR(20) NOT NULL,
  season VARCHAR(20) NOT NULL,
  supplier_id INT NOT NULL,
  status ENUM('draft','open','closed') NOT NULL DEFAULT 'draft',
  order_deadline DATETIME NOT NULL,
  fitting_date DATE NULL,
  note VARCHAR(300),
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_plans_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_plans_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS plan_campuses (
  plan_id INT NOT NULL,
  campus_id INT NOT NULL,
  PRIMARY KEY (plan_id, campus_id),
  CONSTRAINT fk_pc_plan FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
  CONSTRAINT fk_pc_campus FOREIGN KEY (campus_id) REFERENCES campuses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS plan_grades (
  plan_id INT NOT NULL,
  grade_id INT NOT NULL,
  PRIMARY KEY (plan_id, grade_id),
  CONSTRAINT fk_pg_plan FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
  CONSTRAINT fk_pg_grade FOREIGN KEY (grade_id) REFERENCES grades(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 计划品类：季节套装/运动服/礼服/增购件 × 上衣/裤子/裙装/外套/鞋
CREATE TABLE IF NOT EXISTS plan_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  plan_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  suit_kind ENUM('season_set','sportswear','formal','extra') NOT NULL,
  garment_type ENUM('top','pants','skirt','coat','shoes') NOT NULL,
  price DECIMAL(8,2) NOT NULL DEFAULT 0,
  required TINYINT(1) NOT NULL DEFAULT 1,
  INDEX (plan_id),
  CONSTRAINT fk_pi_plan FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 试穿时段（班主任按时段组织）
CREATE TABLE IF NOT EXISTS fitting_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  plan_id INT NOT NULL,
  class_id INT NOT NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  location VARCHAR(100) NOT NULL,
  organizer_user_id INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (plan_id), INDEX (class_id),
  CONSTRAINT fk_fs_plan FOREIGN KEY (plan_id) REFERENCES plans(id),
  CONSTRAINT fk_fs_class FOREIGN KEY (class_id) REFERENCES classes(id),
  CONSTRAINT fk_fs_organizer FOREIGN KEY (organizer_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 试穿记录（工作人员登记五类尺码建议）
CREATE TABLE IF NOT EXISTS fitting_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  student_id INT NOT NULL,
  staff_name VARCHAR(60) NOT NULL,
  size_top VARCHAR(20) NULL,
  size_pants VARCHAR(20) NULL,
  size_skirt VARCHAR(20) NULL,
  size_coat VARCHAR(20) NULL,
  size_shoes VARCHAR(20) NULL,
  special_note VARCHAR(300),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_session_student (session_id, student_id),
  CONSTRAINT fk_fr_session FOREIGN KEY (session_id) REFERENCES fitting_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_fr_student FOREIGN KEY (student_id) REFERENCES students(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 订单（hold：迟缴费/转学等暂缓，供应商不可投产）
CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(40) NOT NULL UNIQUE,
  plan_id INT NOT NULL,
  student_id INT NOT NULL,
  class_id INT NOT NULL,
  status ENUM('draft','confirmed','paid','hold','cancelled') NOT NULL DEFAULT 'draft',
  hold_reason VARCHAR(200),
  payable_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  subsidy_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  due_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  paid_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  confirmed_at DATETIME NULL,
  paid_at DATETIME NULL,
  cancelled_at DATETIME NULL,
  parent_note VARCHAR(300),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX (plan_id), INDEX (student_id), INDEX (class_id),
  CONSTRAINT fk_orders_plan FOREIGN KEY (plan_id) REFERENCES plans(id),
  CONSTRAINT fk_orders_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT fk_orders_class FOREIGN KEY (class_id) REFERENCES classes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  plan_item_id INT NOT NULL,
  garment_type ENUM('top','pants','skirt','coat','shoes') NOT NULL,
  name VARCHAR(100) NOT NULL,
  size VARCHAR(20) NOT NULL,
  price DECIMAL(8,2) NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  is_extra TINYINT(1) NOT NULL DEFAULT 0,
  shipped_qty INT NOT NULL DEFAULT 0,
  signed_qty INT NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (order_id), INDEX (plan_item_id),
  CONSTRAINT fk_oi_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_oi_pi FOREIGN KEY (plan_item_id) REFERENCES plan_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 工厂生产批次
CREATE TABLE IF NOT EXISTS production_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_no VARCHAR(40) NOT NULL UNIQUE,
  plan_id INT NOT NULL,
  supplier_id INT NOT NULL,
  name VARCHAR(120) NOT NULL,
  status ENUM('planned','in_production','produced','part_shipped','completed') NOT NULL DEFAULT 'planned',
  expected_arrival DATE NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (plan_id),
  CONSTRAINT fk_pb_plan FOREIGN KEY (plan_id) REFERENCES plans(id),
  CONSTRAINT fk_pb_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_pb_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS batch_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  plan_item_id INT NOT NULL,
  size VARCHAR(20) NOT NULL,
  qty INT NOT NULL,
  produced_qty INT NOT NULL DEFAULT 0,
  INDEX (batch_id),
  CONSTRAINT fk_bi_batch FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE,
  CONSTRAINT fk_bi_pi FOREIGN KEY (plan_item_id) REFERENCES plan_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 批次明细分配到具体学生的订单明细（支撑按学生追踪生产进度）
CREATE TABLE IF NOT EXISTS batch_allocations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_item_id INT NOT NULL,
  order_item_id INT NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  UNIQUE KEY uq_bi_oi (batch_item_id, order_item_id),
  CONSTRAINT fk_ba_bi FOREIGN KEY (batch_item_id) REFERENCES batch_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_ba_oi FOREIGN KEY (order_item_id) REFERENCES order_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 供应商分批发货
CREATE TABLE IF NOT EXISTS shipments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shipment_no VARCHAR(40) NOT NULL UNIQUE,
  batch_id INT NOT NULL,
  carrier VARCHAR(80),
  tracking_no VARCHAR(80),
  shipped_at DATETIME NOT NULL,
  expected_arrival DATE NOT NULL,
  status ENUM('shipped','arrived') NOT NULL DEFAULT 'shipped',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (batch_id),
  CONSTRAINT fk_sh_batch FOREIGN KEY (batch_id) REFERENCES production_batches(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS shipment_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shipment_id INT NOT NULL,
  order_item_id INT NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  arrived_qty INT NOT NULL DEFAULT 0 COMMENT '实际到校数量，工厂漏发时小于 qty',
  missing_qty INT NOT NULL DEFAULT 0,
  INDEX (shipment_id), INDEX (order_item_id),
  CONSTRAINT fk_sl_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
  CONSTRAINT fk_sl_oi FOREIGN KEY (order_item_id) REFERENCES order_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 到校分批发放与补领安排
CREATE TABLE IF NOT EXISTS distributions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  plan_id INT NOT NULL,
  class_id INT NOT NULL,
  campus_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  kind ENUM('regular','supplementary') NOT NULL DEFAULT 'regular',
  scheduled_at DATETIME NOT NULL,
  location VARCHAR(100) NOT NULL,
  status ENUM('planned','in_progress','done') NOT NULL DEFAULT 'planned',
  frozen TINYINT(1) NOT NULL DEFAULT 0 COMMENT '错包冻结：仅冻结相关发放批次，无关班级可继续发放',
  freeze_reason VARCHAR(200),
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (plan_id), INDEX (class_id),
  CONSTRAINT fk_dist_plan FOREIGN KEY (plan_id) REFERENCES plans(id),
  CONSTRAINT fk_dist_class FOREIGN KEY (class_id) REFERENCES classes(id),
  CONSTRAINT fk_dist_campus FOREIGN KEY (campus_id) REFERENCES campuses(id),
  CONSTRAINT fk_dist_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 签收记录（漏发 missing / 班级错领 wrong_claim 留痕，handled 标记已闭环）
CREATE TABLE IF NOT EXISTS receipts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  distribution_id INT NOT NULL,
  order_item_id INT NOT NULL,
  student_id INT NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  status ENUM('issued','signed','wrong_claim','missing') NOT NULL DEFAULT 'issued',
  claimant_student_id INT NULL,
  signed_by VARCHAR(60),
  reason VARCHAR(200),
  handled TINYINT(1) NOT NULL DEFAULT 0,
  issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  signed_at DATETIME NULL,
  UNIQUE KEY uq_dist_oi (distribution_id, order_item_id),
  INDEX (student_id),
  CONSTRAINT fk_rc_dist FOREIGN KEY (distribution_id) REFERENCES distributions(id) ON DELETE CASCADE,
  CONSTRAINT fk_rc_oi FOREIGN KEY (order_item_id) REFERENCES order_items(id),
  CONSTRAINT fk_rc_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT fk_rc_claimant FOREIGN KEY (claimant_student_id) REFERENCES students(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 售后工单：换码/补发/退款/投诉/转学取消/错领，原因覆盖全部异常场景
CREATE TABLE IF NOT EXISTS aftersales_cases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_no VARCHAR(40) NOT NULL UNIQUE,
  student_id INT NOT NULL,
  order_id INT NULL,
  order_item_id INT NULL,
  type ENUM('exchange','resend','refund','complaint','transfer_cancel','wrong_claim') NOT NULL,
  reason ENUM('growth','fitting_deviation','factory_missing','wrong_class_claim','allergy','late_payment','transfer','other') NOT NULL,
  status ENUM('open','processing','resolved','rejected') NOT NULL DEFAULT 'open',
  priority ENUM('normal','high') NOT NULL DEFAULT 'normal',
  description VARCHAR(500),
  resolution VARCHAR(500),
  created_by INT NULL,
  assigned_to INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  INDEX (student_id), INDEX (status),
  CONSTRAINT fk_case_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT fk_case_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_case_oi FOREIGN KEY (order_item_id) REFERENCES order_items(id),
  CONSTRAINT fk_case_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_case_assignee FOREIGN KEY (assigned_to) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 换码（成长过快/试穿偏差等）
CREATE TABLE IF NOT EXISTS exchange_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  order_item_id INT NOT NULL,
  old_size VARCHAR(20) NOT NULL,
  new_size VARCHAR(20) NOT NULL,
  status ENUM('requested','returned','reshipped','done','rejected') NOT NULL DEFAULT 'requested',
  return_tracking VARCHAR(80),
  reship_tracking VARCHAR(80),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (case_id),
  CONSTRAINT fk_ex_case FOREIGN KEY (case_id) REFERENCES aftersales_cases(id),
  CONSTRAINT fk_ex_oi FOREIGN KEY (order_item_id) REFERENCES order_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 补发（工厂漏发/错领找回失败等）
CREATE TABLE IF NOT EXISTS resend_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  order_item_id INT NULL,
  plan_item_id INT NULL,
  size VARCHAR(20),
  qty INT NOT NULL DEFAULT 1,
  status ENUM('requested','shipped','arrived','done') NOT NULL DEFAULT 'requested',
  tracking_no VARCHAR(80),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (case_id),
  CONSTRAINT fk_rr_case FOREIGN KEY (case_id) REFERENCES aftersales_cases(id),
  CONSTRAINT fk_rr_oi FOREIGN KEY (order_item_id) REFERENCES order_items(id),
  CONSTRAINT fk_rr_pi FOREIGN KEY (plan_item_id) REFERENCES plan_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 退款（转学/迟缴费取消/过敏等）
CREATE TABLE IF NOT EXISTS refund_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  reason VARCHAR(200),
  status ENUM('requested','approved','refunded','rejected') NOT NULL DEFAULT 'requested',
  refunded_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (case_id),
  CONSTRAINT fk_ref_case FOREIGN KEY (case_id) REFERENCES aftersales_cases(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 供应商考核
CREATE TABLE IF NOT EXISTS supplier_assessments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  supplier_id INT NOT NULL,
  plan_id INT NULL,
  period VARCHAR(20) NOT NULL,
  score DECIMAL(5,2) NOT NULL,
  missing_count INT NOT NULL DEFAULT 0,
  delay_count INT NOT NULL DEFAULT 0,
  allergy_count INT NOT NULL DEFAULT 0,
  exchange_count INT NOT NULL DEFAULT 0,
  wrongpack_count INT NOT NULL DEFAULT 0 COMMENT '错包（班级混装）事件数',
  wrongpack_delay_count INT NOT NULL DEFAULT 0 COMMENT '错包补发再次超时次数',
  note VARCHAR(500),
  assessed_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (supplier_id),
  CONSTRAINT fk_sa_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_sa_plan FOREIGN KEY (plan_id) REFERENCES plans(id),
  CONSTRAINT fk_sa_user FOREIGN KEY (assessed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 围绕同一名学生/同一批校服的全过程留痕
CREATE TABLE IF NOT EXISTS activity_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NULL,
  order_id INT NULL,
  actor_role VARCHAR(30),
  actor_name VARCHAR(60),
  action VARCHAR(60),
  detail VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (student_id), INDEX (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===== 错包处理与批次可追溯 =====

-- 包装码：供应商到校尺码包的唯一箱/袋码（同一包装码重复扫描可识别）
CREATE TABLE IF NOT EXISTS pack_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pack_code VARCHAR(40) NOT NULL UNIQUE,
  shipment_id INT NULL COMMENT '到校发货单（到校后才能核验混装）',
  batch_id INT NULL COMMENT '生产批次（批次可追溯）',
  class_id INT NULL COMMENT '包装标签上的应到班级',
  plan_id INT NULL,
  status ENUM('shipped','arrived','scanned','mixed','frozen','repacked','closed') NOT NULL DEFAULT 'shipped',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (shipment_id), INDEX (batch_id), INDEX (class_id),
  CONSTRAINT fk_pack_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id),
  CONSTRAINT fk_pack_batch FOREIGN KEY (batch_id) REFERENCES production_batches(id),
  CONSTRAINT fk_pack_class FOREIGN KEY (class_id) REFERENCES classes(id),
  CONSTRAINT fk_pack_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 包装扫码事件：重复扫描同一包装码即在此留痕（冻结依据之一）
CREATE TABLE IF NOT EXISTS pack_scans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pack_code_id INT NOT NULL,
  distribution_id INT NULL,
  scanner_user_id INT NULL,
  scanner_name VARCHAR(60),
  scanned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  duplicate TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否为同一包装码的重复扫描',
  note VARCHAR(200),
  INDEX (pack_code_id), INDEX (distribution_id),
  CONSTRAINT fk_ps_pack FOREIGN KEY (pack_code_id) REFERENCES pack_codes(id),
  CONSTRAINT fk_ps_dist FOREIGN KEY (distribution_id) REFERENCES distributions(id),
  CONSTRAINT fk_ps_user FOREIGN KEY (scanner_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 包装明细：包装码内应装/实装的订单明细，mismatch=1 即混装（A班码里出现B班明细）
CREATE TABLE IF NOT EXISTS pack_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pack_code_id INT NOT NULL,
  order_item_id INT NOT NULL,
  expected_class_id INT NULL COMMENT '应到班级（按订单）',
  actual_class_id INT NULL COMMENT '包装标签班级',
  mismatch TINYINT(1) NOT NULL DEFAULT 0 COMMENT '实装班级与包装标签班级不一致=混装',
  INDEX (pack_code_id), INDEX (order_item_id),
  CONSTRAINT fk_pi2_pack FOREIGN KEY (pack_code_id) REFERENCES pack_codes(id) ON DELETE CASCADE,
  CONSTRAINT fk_pi2_oi FOREIGN KEY (order_item_id) REFERENCES order_items(id),
  CONSTRAINT fk_pi2_exp_class FOREIGN KEY (expected_class_id) REFERENCES classes(id),
  CONSTRAINT fk_pi2_act_class FOREIGN KEY (actual_class_id) REFERENCES classes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 错包工单：待核对→待重新分拣→补发中→已闭环
CREATE TABLE IF NOT EXISTS wrong_pack_cases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_no VARCHAR(40) NOT NULL UNIQUE,
  plan_id INT NOT NULL,
  campus_id INT NOT NULL,
  supplier_id INT NOT NULL,
  shipment_id INT NULL,
  batch_id INT NULL,
  title VARCHAR(160) NOT NULL,
  status ENUM('to_check','to_repack','resending','closed') NOT NULL DEFAULT 'to_check',
  trigger_reason ENUM('mixed_pack','duplicate_scan','class_signoff_mismatch') NOT NULL DEFAULT 'mixed_pack',
  description VARCHAR(500),
  -- 总务审核受影响名单后的处置决定
  review_decision ENUM('pending','priority_resend','defer_release') NOT NULL DEFAULT 'pending',
  reviewed_by INT NULL,
  reviewed_at DATETIME NULL,
  review_note VARCHAR(300),
  -- 重新分拣登记（供应商）
  repack_operator VARCHAR(60) COMMENT '重新分拣操作人',
  original_pack_destination VARCHAR(200) COMMENT '原包去向（退回供应商/改送某班/暂存）',
  repack_remark VARCHAR(300),
  repacked_at DATETIME NULL,
  -- 补发物流
  resend_tracking_no VARCHAR(80) COMMENT '补发单号',
  resend_expected_arrival DATE COMMENT '补发预计到校时间',
  resend_shipped_at DATETIME NULL,
  resend_arrived_at DATETIME NULL,
  resend_overdue TINYINT(1) NOT NULL DEFAULT 0 COMMENT '补发再次超时',
  -- 闭环：学生实际签收 + 班主任复核（双签）
  student_signed_by VARCHAR(60),
  student_signed_at DATETIME NULL,
  teacher_reviewed_by INT NULL,
  teacher_reviewed_at DATETIME NULL,
  -- 超时追责与替代调拨建议
  accountability_no VARCHAR(40) COMMENT '向供应商追责单号',
  accountability_note VARCHAR(300),
  transfer_suggestion VARCHAR(300) COMMENT '替代调拨建议（从其他班级/校区余量调拨）',
  closed_at DATETIME NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (plan_id), INDEX (campus_id), INDEX (supplier_id), INDEX (status),
  CONSTRAINT fk_wpc_plan FOREIGN KEY (plan_id) REFERENCES plans(id),
  CONSTRAINT fk_wpc_campus FOREIGN KEY (campus_id) REFERENCES campuses(id),
  CONSTRAINT fk_wpc_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_wpc_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id),
  CONSTRAINT fk_wpc_batch FOREIGN KEY (batch_id) REFERENCES production_batches(id),
  CONSTRAINT fk_wpc_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id),
  CONSTRAINT fk_wpc_teacher FOREIGN KEY (teacher_reviewed_by) REFERENCES users(id),
  CONSTRAINT fk_wpc_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 错包受影响学生/明细名单：逐件标注是否已签收、是否纳入冻结、补发与双签状态，避免已签收学生被重复发放
CREATE TABLE IF NOT EXISTS wrong_pack_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  student_id INT NOT NULL,
  order_item_id INT NOT NULL,
  class_id INT NOT NULL,
  pack_code_id INT NULL,
  already_signed TINYINT(1) NOT NULL DEFAULT 0 COMMENT '发现错包时该生是否已签收（已签收不重复发放）',
  item_status ENUM('affected','excluded','resending','signed','closed') NOT NULL DEFAULT 'affected',
  exclude_reason VARCHAR(200) COMMENT '核对排除原因（如已签收/找到原包）',
  resend_tracking_no VARCHAR(80),
  student_signed_by VARCHAR(60),
  student_signed_at DATETIME NULL,
  teacher_reviewed_at DATETIME NULL,
  INDEX (case_id), INDEX (student_id), INDEX (order_item_id),
  UNIQUE KEY uq_wpc_oi (case_id, order_item_id),
  CONSTRAINT fk_wpi_case FOREIGN KEY (case_id) REFERENCES wrong_pack_cases(id) ON DELETE CASCADE,
  CONSTRAINT fk_wpi_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT fk_wpi_oi FOREIGN KEY (order_item_id) REFERENCES order_items(id),
  CONSTRAINT fk_wpi_class FOREIGN KEY (class_id) REFERENCES classes(id),
  CONSTRAINT fk_wpi_pack FOREIGN KEY (pack_code_id) REFERENCES pack_codes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 被冻结的发放批次（只冻结相关班级发放场，而非整校停发）
CREATE TABLE IF NOT EXISTS wrong_pack_freezes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  distribution_id INT NOT NULL,
  class_id INT NOT NULL,
  reason VARCHAR(200),
  frozen_by INT NULL,
  frozen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  unfrozen TINYINT(1) NOT NULL DEFAULT 0,
  unfrozen_at DATETIME NULL,
  UNIQUE KEY uq_case_dist (case_id, distribution_id),
  INDEX (distribution_id),
  CONSTRAINT fk_wpf_case FOREIGN KEY (case_id) REFERENCES wrong_pack_cases(id) ON DELETE CASCADE,
  CONSTRAINT fk_wpf_dist FOREIGN KEY (distribution_id) REFERENCES distributions(id),
  CONSTRAINT fk_wpf_class FOREIGN KEY (class_id) REFERENCES classes(id),
  CONSTRAINT fk_wpf_user FOREIGN KEY (frozen_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 错包处置时间线（登记/冻结/分拣/审核/补发/签收/复核/追责每一步留痕，批次可追溯）
CREATE TABLE IF NOT EXISTS wrong_pack_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  actor_role VARCHAR(30),
  actor_name VARCHAR(60),
  action VARCHAR(60),
  detail VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (case_id),
  CONSTRAINT fk_wpl_case FOREIGN KEY (case_id) REFERENCES wrong_pack_cases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 错包超时追责单与替代调拨建议（补发再次超时自动生成）
CREATE TABLE IF NOT EXISTS supplier_liabilities (
  id INT AUTO_INCREMENT PRIMARY KEY,
  liability_no VARCHAR(40) NOT NULL UNIQUE,
  case_id INT NOT NULL,
  supplier_id INT NOT NULL,
  plan_id INT NULL,
  type ENUM('wrong_pack_overdue','wrong_pack_mix') NOT NULL DEFAULT 'wrong_pack_overdue',
  status ENUM('open','acknowledged','settled') NOT NULL DEFAULT 'open',
  amount DECIMAL(10,2) NULL COMMENT '建议扣罚/赔付金额',
  note VARCHAR(300),
  transfer_suggestion VARCHAR(300) COMMENT '替代调拨建议',
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  settled_at DATETIME NULL,
  INDEX (case_id), INDEX (supplier_id),
  CONSTRAINT fk_sl_case FOREIGN KEY (case_id) REFERENCES wrong_pack_cases(id),
  CONSTRAINT fk_sl_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_sl_plan FOREIGN KEY (plan_id) REFERENCES plans(id),
  CONSTRAINT fk_sl_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
