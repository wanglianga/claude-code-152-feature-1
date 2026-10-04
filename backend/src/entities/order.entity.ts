import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * 订单状态：
 * CREATED 已下单待支付/待安排 / DELIVERY_SCHEDULED 已预约配送 /
 * IN_DELIVERY 配送中 / RESCHEDULING 到场受阻、配送改约中 /
 * DELIVERED 已送达 / SETTLED 已结算 /
 * CANCELLED 取消 / RETURNING 退货中 / RETURNED 已退货
 */
export type OrderStatus =
  | 'CREATED'
  | 'DELIVERY_SCHEDULED'
  | 'IN_DELIVERY'
  | 'RESCHEDULING'
  | 'DELIVERED'
  | 'SETTLED'
  | 'CANCELLED'
  | 'RETURNING'
  | 'RETURNED';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column()
  code: string;

  @Index()
  @Column({ type: 'uuid' })
  itemId: string;

  @Index()
  @Column({ type: 'uuid' })
  consignmentId: string;

  @Index()
  @Column({ type: 'uuid' })
  buyerId: string;

  @Column({ type: 'uuid' })
  sellerId: string;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  dealPrice: string;

  /** 配送费（下单时预收） */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: '0' })
  deliveryFee: string;

  @Column({ default: '' })
  buyerAddress: string;

  @Column({ type: 'int', default: 1 })
  buyerFloor: number;

  @Column({ type: 'varchar', length: 16, default: 'ELEVATOR' })
  buyerElevator: string;

  /** 是否需要搬出旧家具 */
  @Column({ default: false })
  needOldFurnitureRemoval: boolean;

  /** 预约送达时间段 */
  @Column({ default: '' })
  appointmentWindow: string;

  @Index()
  @Column({ type: 'varchar', length: 24, default: 'CREATED' })
  status: OrderStatus;

  /** 买家收货备注（色差/磕碰异议等） */
  @Column({ default: '' })
  deliveryNote: string;

  @CreateDateColumn()
  createdAt: Date;
}
