import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * 家具进不了电梯/楼道的「配送改约单」。
 * 配送员到楼下受阻后登记现场（照片/楼层/拆装可能性/人工加价），
 * 买家在四个方案中选择并逐次推进：
 * DISASSEMBLY 拆装上楼 / HOISTING 吊装 / RETURN 退货回库 / CHANGE_ADDRESS 改送其他地址
 */
export type ReschedulePlan =
  | 'DISASSEMBLY'
  | 'HOISTING'
  | 'RETURN'
  | 'CHANGE_ADDRESS';

/**
 * 改约单状态：
 * BLOCKED 现场受阻待买家选方案 /
 * IN_PROGRESS 方案执行中（拆装/吊装/改地址配送中）/
 * AWAITING_HOIST_CONFIRM 已选吊装，待四项前置确认（公司/物业/天气/保险）/
 * HOISTING 吊装作业中 /
 * RESCHEDULED 改地址后等待重新排班 /
 * REDELIVERING 二次配送中 /
 * RETURNED_TO_WAREHOUSE 退货已回库（待仓库复检，决定是否二次上架）/
 * RELISTED 回库后已二次上架 /
 * COMPLETED 改约完成（拆装/吊装/二次配送成功送达）/
 * CANCELLED 订单取消/退款完结
 */
export type RescheduleStatus =
  | 'BLOCKED'
  | 'IN_PROGRESS'
  | 'AWAITING_HOIST_CONFIRM'
  | 'HOISTING'
  | 'RESCHEDULED'
  | 'REDELIVERING'
  | 'RETURNED_TO_WAREHOUSE'
  | 'RELISTED'
  | 'COMPLETED'
  | 'CANCELLED';

/**
 * 吊装失败责任三分类：
 * BUYER_ENVIRONMENT 买家环境限制（承重墙无锚点/物业禁止/窗户不可拆等买家侧客观条件）
 * PLAN_MISJUDGMENT 配送方案误判（平台/配送勘测与方案选择错误，本可拆装或走楼梯）
 * THIRD_PARTY 第三方责任（吊装公司操作事故、设备故障、临时爽约）
 */
export type HoistingFailureLiability =
  | 'BUYER_ENVIRONMENT'
  | 'PLAN_MISJUDGMENT'
  | 'THIRD_PARTY';

@Entity('delivery_reschedules')
export class DeliveryReschedule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  orderId: string;

  @Index()
  @Column({ type: 'uuid' })
  deliveryId: string;

  @Column({ type: 'uuid' })
  itemId: string;

  @Column({ type: 'uuid' })
  consignmentId: string;

  /** 登记现场的配送员 */
  @Column({ type: 'uuid' })
  reportedBy: string;

  @Index()
  @Column({ type: 'varchar', length: 28, default: 'BLOCKED' })
  status: RescheduleStatus;

  /** 买家当前选择（最新一次）的方案 */
  @Column({ type: 'varchar', length: 20, default: '' })
  currentPlan: ReschedulePlan | '';

  // ---------- 现场记录（配送员登记） ----------
  /** 现场照片 URL 列表（电梯门/轿厢、楼梯转角、家具对比等） */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  sitePhotos: string[];

  /** 买家楼层（现场核对） */
  @Column({ type: 'int', default: 1 })
  siteFloor: number;

  /** 电梯轿厢进深（米），如 1.4；无电梯填 0 */
  @Column({ type: 'numeric', precision: 5, scale: 2, default: '0' })
  elevatorDepth: string;

  /** 电梯轿厢门宽（米） */
  @Column({ type: 'numeric', precision: 5, scale: 2, default: '0' })
  elevatorDoorWidth: string;

  /** 楼梯转角最小宽度（米），无法通过时记录 */
  @Column({ type: 'numeric', precision: 5, scale: 2, default: '0' })
  stairLandingWidth: string;

  /** 家具最大边（米），现场复核 */
  @Column({ type: 'numeric', precision: 5, scale: 2, default: '0' })
  furnitureMaxSide: string;

  /** 拆装可能性：DISASSEMBLABLE 可拆装 / PARTIAL 仅部分可拆 / NOT_DISASSEMBLABLE 不可拆装 */
  @Column({ type: 'varchar', length: 24, default: 'UNKNOWN' })
  disassemblyFeasibility: string;

  /** 现场人工加价（搬运/拆装人力追加，元） */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  laborSurcharge: string;

  @Column({ type: 'text', default: '' })
  siteNote: string;

  // ---------- 费用影响（随方案推进累计，结算引用） ----------
  /** 拆装费（元） */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  disassemblyFee: string;

  /** 吊装费（元） */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  hoistingFee: string;

  /** 吊装失败后已发生的作业/进场费用（元） */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  hoistingFailureCost: string;

  /** 退货回库运费（元） */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  returnFreight: string;

  /** 改地址二次配送费（元） */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  redeliveryFee: string;

  /** 仓储回库费（复检/重新入库人力，元） */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  restockingFee: string;

  // ---------- 吊装专项（最新一次吊装确认，历史在 plan 行留痕） ----------
  @Column({ default: '' })
  hoistingCompany: string;

  /** 物业许可：许可照片/批文 URL 或编号说明 */
  @Column({ default: '' })
  propertyPermit: string;

  /** 天气情况（风速/降雨等作业窗口判断） */
  @Column({ default: '' })
  weatherCondition: string;

  /** 保险确认：保单号/承保说明 */
  @Column({ default: '' })
  insuranceConfirmation: string;

  /** 吊装失败责任（最近一次）：买家环境/方案误判/第三方 */
  @Column({ type: 'varchar', length: 24, default: '' })
  hoistingFailureLiability: HoistingFailureLiability | '';

  /** 第三方责任赔付（吊装公司赔平台，元） */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  thirdPartyCompensation: string;

  // ---------- 回库 / 二次上架 ----------
  @Column({ default: '' })
  returnWarehouseSlot: string;

  @Column({ type: 'timestamptz', nullable: true })
  returnedAt: Date | null;

  /** 是否产生二次上架 */
  @Column({ default: false })
  relisted: boolean;

  @Column({ type: 'uuid', nullable: true })
  relistedItemId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

/**
 * 改约方案流水：买家每次选择/执行/失败都留一行，保留方案演进历史
 * （如：先吊装失败定责第三方，再改选拆装成功）。
 */
@Entity('delivery_reschedule_plans')
export class DeliveryReschedulePlan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  rescheduleId: string;

  @Column({ type: 'uuid' })
  chosenBy: string;

  @Column({ type: 'varchar', length: 16, default: 'BUYER' })
  chosenByRole: string;

  @Column({ type: 'varchar', length: 20 })
  plan: ReschedulePlan;

  /**
   * PENDING 已选择待执行 / CONFIRMED 吊装四项确认完成 /
   * EXECUTING 执行中 / SUCCESS 成功 / FAILED 失败 / ABANDONED 放弃改选其他方案
   */
  @Column({ type: 'varchar', length: 16, default: 'PENDING' })
  status: string;

  /** 该方案报价（拆装费/吊装费/退货运费/二次配送费，随方案而定） */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  quotedFee: string;

  /** 改地址方案：新地址 */
  @Column({ default: '' })
  newAddress: string;

  @Column({ type: 'int', nullable: true })
  newFloor: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  newElevator: string | null;

  // ---- 吊装四项前置确认（仅 HOISTING 方案行） ----
  @Column({ default: '' })
  hoistingCompany: string;

  @Column({ default: '' })
  propertyPermit: string;

  @Column({ default: '' })
  weatherCondition: string;

  @Column({ default: '' })
  insuranceConfirmation: string;

  // ---- 吊装失败定责 ----
  @Column({ type: 'varchar', length: 24, default: '' })
  failureLiability: HoistingFailureLiability | '';

  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  failureCost: string;

  /** 第三方认赔金额 */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  thirdPartyCompensation: string;

  @Column({ type: 'text', default: '' })
  failureNote: string;

  @Column({ type: 'text', default: '' })
  note: string;

  @CreateDateColumn()
  createdAt: Date;
}
