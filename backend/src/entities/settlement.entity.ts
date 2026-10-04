import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * 结算明细：成交价、佣金、翻新费、仓储费、配送费、售后赔付都要有清楚来源
 * 正数=平台收入/扣减卖家款项；方向由 type 决定：
 * DEAL_PRICE 成交收入（买家支付）
 * COMMISSION 平台佣金（从卖家应得中扣除，平台收入）
 * REFURBISH_FEE 清洁翻新费（平台代付，从卖家应得扣除）
 * STORAGE_FEE 仓储费（按天计，从卖家应得扣除）
 * DELIVERY_FEE 配送费（买家支付，结算给配送团队/平台）
 * RESCHEDULE_FEE 改约附加费（拆装上楼/吊装/改址转运，买家支付）
 * COMPENSATION 售后赔付（责任方承担，来源工单）
 * THIRD_PARTY_CLAIM 第三方追偿（吊装公司责任，平台向其追偿，冲抵平台支出）
 * SELLER_PAYOUT 卖家最终应得（负数=付出）
 */
export type SettlementEntryType =
  | 'DEAL_PRICE'
  | 'COMMISSION'
  | 'REFURBISH_FEE'
  | 'STORAGE_FEE'
  | 'DELIVERY_FEE'
  | 'RESCHEDULE_FEE'
  | 'COMPENSATION'
  | 'THIRD_PARTY_CLAIM'
  | 'SELLER_PAYOUT';

@Entity('settlements')
export class Settlement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  orderId: string;

  @Index()
  @Column({ type: 'uuid' })
  consignmentId: string;

  @Column({ type: 'uuid' })
  sellerId: string;

  /** 卖家最终应得 */
  @Column({ type: 'numeric', precision: 10, scale: 2 })
  sellerPayout: string;

  /** 平台净收入 */
  @Column({ type: 'numeric', precision: 10, scale: 2 })
  platformIncome: string;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('settlement_entries')
export class SettlementEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  settlementId: string;

  @Column({ type: 'varchar', length: 20 })
  type: SettlementEntryType;

  /** 金额（对平台账目视角：正=收入，SELLER_PAYOUT 为负=付出） */
  @Column({ type: 'numeric', precision: 10, scale: 2 })
  amount: string;

  /** 来源说明，如 佣金=成交价 800×15% / 仓储=A-03-12 存放12天×3元 */
  @Column()
  source: string;

  /** 关联来源单据 id（工单/估价单/作业记录等），无则空 */
  @Column({ type: 'uuid', nullable: true })
  sourceRefId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
