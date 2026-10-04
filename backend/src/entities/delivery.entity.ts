import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * 配送任务状态：PENDING 待安排 / SCHEDULED 已排班 / LOADED 已装车 /
 * DONE 已完成 / FAILED 配送失败（进不了电梯/买家不在/磕碰退回/吊装失败）
 */
export type DeliveryStatus =
  | 'PENDING'
  | 'SCHEDULED'
  | 'LOADED'
  | 'DONE'
  | 'FAILED';

/** 失败原因（用于失败率分析） */
export type DeliveryFailReason =
  | 'ELEVATOR_TOO_SMALL' // 沙发进不了电梯
  | 'STAIR_TOO_NARROW'
  | 'HOIST_FAILED' // 吊装失败（具体责任归因见配送改约单）
  | 'BUYER_ABSENT'
  | 'TRANSIT_DAMAGE' // 配送途中磕碰
  | 'VEHICLE_UNAVAILABLE'
  | 'SELLER_BACKTRACK' // 卖家临时反悔导致无法提货
  | 'NONE';

@Entity('deliveries')
export class Delivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  orderId: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  teamId: string | null;

  /** 车辆类型：SMALL_VAN / MID_TRUCK / LARGE_TRUCK */
  @Column({ type: 'varchar', length: 16, default: 'SMALL_VAN' })
  vehicleType: string;

  /** 是否需要拆装作业 */
  @Column({ default: false })
  needsDisassembly: boolean;

  /** 是否需要旧家具搬出 */
  @Column({ default: false })
  oldFurnitureRemoval: boolean;

  @Column({ type: 'int', default: 1 })
  pickupFloor: number;

  @Column({ type: 'varchar', length: 16, default: 'ELEVATOR' })
  pickupElevator: string;

  @Column({ type: 'int', default: 1 })
  dropoffFloor: number;

  @Column({ type: 'varchar', length: 16, default: 'ELEVATOR' })
  dropoffElevator: string;

  @Column({ default: '' })
  scheduledWindow: string;

  @Index()
  @Column({ type: 'varchar', length: 16, default: 'PENDING' })
  status: DeliveryStatus;

  @Column({ type: 'varchar', length: 24, default: 'NONE' })
  failReason: DeliveryFailReason;

  @Column({ default: '' })
  failNote: string;

  @CreateDateColumn()
  createdAt: Date;
}
