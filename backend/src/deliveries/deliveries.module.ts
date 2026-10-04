import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Delivery } from '../entities/delivery.entity';
import { Order } from '../entities/order.entity';
import { Item } from '../entities/item.entity';
import {
  DeliveryReschedule,
  DeliveryReschedulePlan,
} from '../entities/delivery-reschedule.entity';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard, Roles } from '../auth/roles.guard';

class ScheduleDto {
  teamId?: string;
  vehicleType: string;
  scheduledWindow: string;
}

class FailDto {
  failReason: string;
  failNote?: string;
}

/**
 * 配送团队根据楼层、拆装、车辆、旧家具搬出和预约时间安排交付。
 * 失败原因进入统计（沙发进不了电梯、途中磕碰、买家不在、车辆不足、卖家反悔等）。
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('deliveries')
export class DeliveryController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Roles('DELIVERY', 'OPS', 'CS')
  @Get('queue')
  async queue() {
    // 常规待办（PENDING/SCHEDULED/FAILED）+ 改约中的任务 +
    // 已送达且有已完结改约单（可能在新地址再次受阻）的任务；已结算/退货/取消不出现
    return this.ds.getRepository(Delivery)
      .createQueryBuilder('d')
      .innerJoin(Order, 'o', 'o.id = d."orderId"')
      .leftJoin(
        DeliveryReschedule,
        'r',
        'r."orderId" = d."orderId" AND r.status = :completed',
        { completed: 'COMPLETED' },
      )
      .where('(d.status IN (:...sts) OR o.status = :rs OR (d.status = :done AND o.status = :delivered AND r.id IS NOT NULL))', {
        sts: ['PENDING', 'SCHEDULED', 'FAILED'],
        rs: 'RESCHEDULING',
        done: 'DONE',
        delivered: 'DELIVERED',
      })
      .orderBy('d."createdAt"', 'DESC')
      .getMany();
  }

  @Roles('DELIVERY', 'OPS')
  @Post(':orderId/schedule')
  async schedule(@Param('orderId') orderId: string, @Body() dto: ScheduleDto) {
    return this.ds.transaction(async (m) => {
      const delivery = await m.findOne(Delivery, { where: { orderId } });
      if (!delivery) throw new NotFoundException('配送任务不存在');
      if (!['PENDING', 'FAILED'].includes(delivery.status)) {
        throw new BadRequestException(`配送当前 ${delivery.status}，不可排班`);
      }
      const order = await m.findOne(Order, { where: { id: orderId } });
      if (!order || ['CANCELLED', 'RETURNED', 'SETTLED'].includes(order.status)) {
        throw new BadRequestException('订单状态不允许排班配送');
      }
      const activeRs = await m.findOne(DeliveryReschedule, { where: { orderId } });
      if (
        activeRs &&
        !['COMPLETED', 'CANCELLED', 'RELISTED'].includes(activeRs.status)
      ) {
        throw new BadRequestException('该订单在配送改约流程中，请在「配送改约」中按方案处理');
      }
      delivery.teamId = dto.teamId || delivery.teamId;
      delivery.vehicleType = dto.vehicleType || delivery.vehicleType;
      delivery.scheduledWindow = dto.scheduledWindow || delivery.scheduledWindow;
      delivery.status = 'SCHEDULED';
      delivery.failReason = 'NONE';
      delivery.failNote = '';
      order.status = 'DELIVERY_SCHEDULED';
      order.appointmentWindow = delivery.scheduledWindow;
      await m.save([delivery, order]);
      return { delivery, order };
    });
  }

  /** 装车出库：订单进入配送中，商品标记已售出 */
  @Roles('DELIVERY', 'OPS')
  @Post(':orderId/load')
  async load(@Param('orderId') orderId: string) {
    return this.ds.transaction(async (m) => {
      const delivery = await m.findOne(Delivery, { where: { orderId } });
      if (!delivery || delivery.status !== 'SCHEDULED') {
        throw new BadRequestException('仅已排班任务可装车');
      }
      delivery.status = 'LOADED';
      const order = await m.findOne(Order, { where: { id: orderId } });
      order!.status = 'IN_DELIVERY';
      const item = await m.findOne(Item, { where: { id: order!.itemId } });
      if (item && item.status === 'RESERVED') {
        item.status = 'SOLD';
        await m.save(item);
      }
      await m.save([delivery, order!]);
      return { delivery, order };
    });
  }

  /** 送达完成：订单已送达，等待买家确认/客服结算 */
  @Roles('DELIVERY', 'OPS')
  @Post(':orderId/done')
  async done(@Param('orderId') orderId: string, @Body() body: { note?: string }) {
    return this.ds.transaction(async (m) => {
      const delivery = await m.findOne(Delivery, { where: { orderId } });
      if (!delivery || !['LOADED', 'SCHEDULED'].includes(delivery.status)) {
        throw new BadRequestException('仅在途/已排班任务可标记送达');
      }
      delivery.status = 'DONE';
      const order = await m.findOne(Order, { where: { id: orderId } });
      order!.status = 'DELIVERED';
      order!.deliveryNote = body?.note || order!.deliveryNote;
      const item = await m.findOne(Item, { where: { id: order!.itemId } });
      if (item) {
        item.status = 'DELIVERED';
        await m.save(item);
      }
      // 改地址二次配送正常送达：改约单收尾
      const rs = await m.findOne(DeliveryReschedule, {
        where: { orderId, status: 'REDELIVERING' },
      });
      if (rs) {
        rs.status = 'COMPLETED';
        await m.save(rs);
        const plan = await m.findOne(DeliveryReschedulePlan, {
          where: { rescheduleId: rs.id, plan: 'CHANGE_ADDRESS', status: 'EXECUTING' },
        });
        if (plan) {
          plan.status = 'SUCCESS';
          await m.save(plan);
        }
      }
      await m.save([delivery, order!]);
      return { delivery, order };
    });
  }

  /** 配送失败：记录原因（计入失败率分析），等待客服工单介入 */
  @Roles('DELIVERY', 'OPS')
  @Post(':orderId/fail')
  async fail(@Param('orderId') orderId: string, @Body() dto: FailDto) {
    const valid = [
      'ELEVATOR_TOO_SMALL',
      'STAIR_TOO_NARROW',
      'BUYER_ABSENT',
      'TRANSIT_DAMAGE',
      'VEHICLE_UNAVAILABLE',
      'SELLER_BACKTRACK',
    ];
    if (!valid.includes(dto.failReason)) {
      throw new BadRequestException('未知失败原因');
    }
    return this.ds.transaction(async (m) => {
      const delivery = await m.findOne(Delivery, { where: { orderId } });
      if (!delivery) throw new NotFoundException('配送任务不存在');
      delivery.status = 'FAILED';
      delivery.failReason = dto.failReason as any;
      delivery.failNote = dto.failNote || '';
      await m.save(delivery);
      return delivery;
    });
  }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Delivery,
      Order,
      Item,
      DeliveryReschedule,
      DeliveryReschedulePlan,
    ]),
  ],
  controllers: [DeliveryController],
})
export class DeliveryModule {}
