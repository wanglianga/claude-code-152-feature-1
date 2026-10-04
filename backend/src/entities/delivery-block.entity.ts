import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * 大件家具进不了电梯/楼道时的「配送改约单」：
 * 配送员现场勘测（照片/楼层/通道尺寸/拆装可能性/人工加价）
 * → 买家选择方案（拆装上楼 / 吊装 / 退货 / 改送其他地址）
 * → 吊装需登记公司、物业许可、天气、保险；失败区分三类责任
 * → 退货回库并决定是否二次上架。
 *
 * 单据状态：
 * SURVEYED 已勘测，待买家选择方案
 * RESOLVING 买家已选定方案，执行中（拆装/吊装/改址）
 * DELIVERED 改约方案执行完成并送达
 * RETURN_DECIDED 买家选择退货，商品回库中
 * WAREHOUSED 已回仓复检，待上架决策
 * RELISTED 回仓后已二次上架
 * CLOSED 回仓后确认不再上架（终止）
 */
export type DeliveryBlockStatus =
  | 'SURVEYED'
  | 'RESOLVING'
  | 'DELIVERED'
  | 'RETURN_DECIDED'
  | 'WAREHOUSED'
  | 'RELISTED'
  | 'CLOSED';

/** 买家可选方案 */
export type BlockOption =
  | 'DISASSEMBLY' // 拆装上楼
  | 'HOIST' // 吊装
  | 'RETURN' // 退货
  | 'CHANGE_ADDRESS'; // 改送其他地址

/** 吊装执行状态 */
export type HoistStatus = 'NONE' | 'SCHEDULED' | 'SUCCESS' | 'FAILED';

/**
 * 吊装失败责任归因：
 * BUYER_ENVIRONMENT 买家环境限制（如外立面无吊点、物业临时禁吊）
 * PLAN_MISJUDGE 配送方案误判（平台/配送勘测误判，本可拆装却安排吊装等）
 * THIRD_PARTY 第三方责任（吊装公司操作不当/设备故障，可追偿）
 */
export type HoistFailCause =
  | 'BUYER_ENVIRONMENT'
  | 'PLAN_MISJUDGE'
  | 'THIRD_PARTY';

/** 退货回库后的二次上架决策 */
export type RelistDecision = 'PENDING' | 'RELIST' | 'NO_RELIST';

@Entity('delivery_blocks')
export class DeliveryBlock {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column()
  code: string;

  @Index()
  @Column({ type: 'uuid' })
  orderId: string;

  @Index()
  @Column({ type: 'uuid' })
  consignmentId: string;

  @Column({ type: 'uuid' })
  itemId: string;

  /** 协同工单（勘测登记时自动创建一张 ELEVATOR_BLOCK 工单） */
  @Index({ unique: true })
  @Column({ type: 'uuid', nullable: true })
  ticketId: string | null;

  @Index()
  @Column({ type: 'varchar', length: 20, default: 'SURVEYED' })
  status: DeliveryBlockStatus;

  // ---------- 现场勘测（配送员到楼下登记） ----------

  /** 现场照片（电梯铭牌/卷尺测量/楼道转角等） */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  photos: string[];

  /** 买家楼层 */
  @Column({ type: 'int', default: 1 })
  siteFloor: number;

  /** 电梯轿厢进深 cm（如 140） */
  @Column({ type: 'int', nullable: true })
  elevatorDepthCm: number | null;

  /** 电梯轿厢宽度 cm */
  @Column({ type: 'int', nullable: true })
  elevatorWidthCm: number | null;

  /** 电梯开门净宽 cm */
  @Column({ type: 'int', nullable: true })
  elevatorDoorCm: number | null;

  /** 楼梯宽度 cm */
  @Column({ type: 'int', nullable: true })
  stairWidthCm: number | null;

  /** 楼梯转角最小通过宽度 cm */
  @Column({ type: 'int', nullable: true })
  stairTurnWidthCm: number | null;

  /** 现场判断是否具备拆装可能性 */
  @Column({ default: false })
  disassemblable: boolean;

  /** 拆装评估说明（结构可否拆分、预计工时、风险） */
  @Column({ default: '' })
  disassemblyNote: string;

  /** 现场人工加价（高层步梯/转角搬运额外人工，元） */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  laborSurcharge: string;

  /** 现场情况备注 */
  @Column({ type: 'text', default: '' })
  siteNote: string;

  @Column({ type: 'uuid', nullable: true })
  surveyedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  surveyedAt: Date | null;

  // ---------- 买家方案选择 ----------

  @Column({ type: 'varchar', length: 20, nullable: true })
  buyerOption: BlockOption | null;

  /**
   * 方案附加费（在原配送费之外）：
   * DISASSEMBLY=拆装费、HOIST=吊装费、CHANGE_ADDRESS=改址转运费；RETURN 为 0。
   */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  optionFee: string;

  @Column({ type: 'text', default: '' })
  optionNote: string;

  /** 每次选择/改选留痕：{by, byRole, option, fee, at, note}[] */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  optionHistory: any[];

  /** 改送地址 */
  @Column({ default: '' })
  newAddress: string;

  @Column({ type: 'int', nullable: true })
  newFloor: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  newElevator: string | null;

  // ---------- 吊装专项信息 ----------

  @Column({ default: '' })
  hoistCompany: string;

  /** 物业是否许可吊装 */
  @Column({ default: false })
  propertyPermit: boolean;

  @Column({ default: '' })
  propertyPermitNote: string;

  /** 天气情况（风力/雨雪等） */
  @Column({ default: '' })
  weather: string;

  /** 保险是否确认 */
  @Column({ default: false })
  insuranceConfirmed: boolean;

  @Column({ default: '' })
  insurancePolicy: string;

  /** 吊装报价（吊装费，元） */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  hoistQuote: string;

  @Column({ type: 'varchar', length: 16, default: 'NONE' })
  hoistStatus: HoistStatus;

  @Column({ type: 'varchar', length: 20, nullable: true })
  hoistFailCause: HoistFailCause | null;

  @Column({ type: 'text', default: '' })
  hoistFailNote: string;

  /** 第三方责任时向吊装公司追偿的金额（元） */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  thirdPartyClaimAmount: string;

  @Column({ type: 'uuid', nullable: true })
  hoistArrangedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  hoistArrangedAt: Date | null;

  // ---------- 退货回库与二次上架 ----------

  @Column({ default: '' })
  warehouseSlot: string;

  @Column({ type: 'varchar', length: 12, default: 'PENDING' })
  relistDecision: RelistDecision;

  @Column({ default: '' })
  relistReason: string;

  @Column({ type: 'timestamptz', nullable: true })
  relistedAt: Date | null;

  /**
   * 退货时买家需承担的已发生不可退费用（如买家环境限制导致吊装失败的吊装费），
   * 结算时从退款中扣除；其余情况为 0（全额退款）。
   */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  buyerBorneOnReturn: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
