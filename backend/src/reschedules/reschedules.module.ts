import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DeliveryReschedule,
  DeliveryReschedulePlan,
  ReschedulePlan,
  HoistingFailureLiability,
} from '../entities/delivery-reschedule.entity';
import { Delivery } from '../entities/delivery.entity';
import { Order } from '../entities/order.entity';
import { Item } from '../entities/item.entity';
import { Consignment } from '../entities/consignment.entity';
import { Ticket, TicketMessage } from '../entities/ticket.entity';
import { JwtAuthGuard, JwtPayload } from '../auth/jwt.guard';
import { RolesGuard, Roles } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';

const PLANS: ReschedulePlan[] = [
  'DISASSEMBLY',
  'HOISTING',
  'RETURN',
  'CHANGE_ADDRESS',
];
const LIABILITIES: HoistingFailureLiability[] = [
  'BUYER_ENVIRONMENT',
  'PLAN_MISJUDGMENT',
  'THIRD_PARTY',
];

const num = (v: any, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const money = (n: number) => n.toFixed(2);

/** 改地址二次配送费试算：基础 ¥60，无电梯/楼梯房每层 ¥15 */
function quoteRedeliveryFee(floor: number, elevator: string) {
  let fee = 60;
  if (elevator !== 'ELEVATOR') fee += Math.max(0, Number(floor) - 1) * 15;
  return fee;
}

class ReportSiteDto {
  sitePhotos?: string[];
  siteFloor?: number;
  elevatorDepth?: number;
  elevatorDoorWidth?: number;
  stairLandingWidth?: number;
  furnitureMaxSide?: number;
  disassemblyFeasibility?: string;
  laborSurcharge?: number;
  siteNote?: string;
  failReason?: string;
}

class ChoosePlanDto {
  plan: ReschedulePlan;
  newAddress?: string;
  newFloor?: number;
  newElevator?: string;
  note?: string;
}

class HoistConfirmDto {
  hoistingCompany: string;
  propertyPermit: string;
  weatherCondition: string;
  insuranceConfirmation: string;
  hoistingFee: number;
}

class HoistResultDto {
  failureLiability?: HoistingFailureLiability;
  failureCost?: number;
  thirdPartyCompensation?: number;
  failureNote?: string;
}

class WarehouseReturnDto {
  warehouseSlot: string;
  returnFreight?: number;
  restockingFee?: number;
  note?: string;
}

class RelistDto {
  listedPrice?: number;
  description?: string;
  photos?: string[];
  deliveryRadiusKm?: number;
  note?: string;
}

class RedeliveryScheduleDto {
  scheduledWindow: string;
  vehicleType?: string;
}

/**
 * 配送改约：家具进不了电梯/楼道后的现场登记 → 买家四方案选择 →
 * 拆装/吊装/退货回库/改地址二次配送的全流程，费用与责任全程留痕并进入结算。
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reschedules')
export class RescheduleController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** 配送员到楼下受阻：登记现场照片/楼层/通道尺寸/拆装可能性/人工加价 */
  @Roles('DELIVERY', 'OPS', 'ADMIN')
  @Post('deliveries/:orderId/report')
  async report(
    @CurrentUser() user: JwtPayload,
    @Param('orderId') orderId: string,
    @Body() dto: ReportSiteDto,
  ) {
    const feas = ['DISASSEMBLABLE', 'PARTIAL', 'NOT_DISASSEMBLABLE'];
    if (dto.disassemblyFeasibility && !feas.includes(dto.disassemblyFeasibility)) {
      throw new BadRequestException('拆装可能性取值非法');
    }
    return this.ds.transaction(async (m) => {
      const order = await m.findOne(Order, { where: { id: orderId } });
      if (!order) throw new NotFoundException('订单不存在');
      const delivery = await m.findOne(Delivery, { where: { orderId } });
      if (!delivery) throw new NotFoundException('配送任务不存在');
      if (!['LOADED', 'SCHEDULED', 'FAILED', 'DONE'].includes(delivery.status)) {
        throw new BadRequestException('仅配送中/已排班/已失败/已送达（改地址后再次受阻）任务可登记现场受阻');
      }

      const existed = await m.findOne(DeliveryReschedule, { where: { orderId } });
      if (existed && !['COMPLETED', 'CANCELLED'].includes(existed.status)) {
        throw new BadRequestException('该订单已存在处理中的改约单');
      }
      // 改地址送达后新地址再次受阻：复用同一改约单并重置现场信息，历史方案流水保留
      const rs = existed
        ? existed
        : m.create(DeliveryReschedule, {
            orderId,
            deliveryId: delivery.id,
            itemId: order.itemId,
            consignmentId: order.consignmentId,
            reportedBy: user.sub,
            sitePhotos: [],
          });
      rs.deliveryId = delivery.id;
      rs.itemId = order.itemId;
      rs.consignmentId = order.consignmentId;
      rs.reportedBy = user.sub;
      rs.status = 'BLOCKED';
      rs.currentPlan = '';
      rs.sitePhotos = dto.sitePhotos || [];
      rs.siteFloor = Number(dto.siteFloor) || order.buyerFloor || 1;
      rs.elevatorDepth = money(num(dto.elevatorDepth));
      rs.elevatorDoorWidth = money(num(dto.elevatorDoorWidth));
      rs.stairLandingWidth = money(num(dto.stairLandingWidth));
      rs.furnitureMaxSide = money(num(dto.furnitureMaxSide));
      rs.disassemblyFeasibility = dto.disassemblyFeasibility || 'UNKNOWN';
      rs.laborSurcharge = money(Math.max(0, num(dto.laborSurcharge)));
      rs.siteNote = dto.siteNote || '';
      rs.disassemblyFee = '0.00';
      rs.hoistingFee = '0.00';
      rs.hoistingFailureCost = '0.00';
      rs.hoistingFailureLiability = '';
      rs.thirdPartyCompensation = '0.00';
      rs.hoistingCompany = '';
      rs.propertyPermit = '';
      rs.weatherCondition = '';
      rs.insuranceConfirmation = '';
      if (existed) {
        // 新一轮受阻：上一轮方案相关费用与回库信息重置（结算只认本轮方案流水）
        rs.redeliveryFee = '0.00';
        rs.returnFreight = '0.00';
        rs.restockingFee = '0.00';
        rs.returnWarehouseSlot = '';
        rs.returnedAt = null;
        rs.relisted = false;
        rs.relistedItemId = null;
      }
      await m.save(rs);
      if (existed) {
        // 新一轮受阻：上一轮已成功方案不再计入本单最终结算（历史仍保留，备注说明）
        const oldPlans = await m.find(DeliveryReschedulePlan, {
          where: { rescheduleId: rs.id },
        });
        for (const p of oldPlans) {
          if (p.status === 'SUCCESS') {
            p.status = 'ABANDONED';
            p.note = `${p.note ? `${p.note}｜` : ''}新地址再次受阻发起新一轮改约，原方案费用不重复计入结算`;
            await m.save(p);
          }
        }
      }

      // 自动判定受阻原因（配送员可显式覆盖）
      let failReason = dto.failReason || '';
      if (!failReason) {
        const maxSide = num(dto.furnitureMaxSide);
        const depth = num(dto.elevatorDepth);
        const stair = num(dto.stairLandingWidth);
        if (depth > 0 && maxSide > depth) failReason = 'ELEVATOR_TOO_SMALL';
        else if (stair > 0 && maxSide > stair) failReason = 'STAIR_TOO_NARROW';
        else failReason = 'ELEVATOR_TOO_SMALL';
      }
      delivery.status = 'FAILED';
      delivery.failReason = failReason as any;
      delivery.failNote =
        (dto.siteNote || '') +
        (num(dto.elevatorDepth) > 0
          ? `｜现场测量：电梯进深 ${dto.elevatorDepth}m、门宽 ${num(dto.elevatorDoorWidth)}m、楼梯转角 ${num(dto.stairLandingWidth) || '-'}m、家具最大边 ${num(dto.furnitureMaxSide) || '-'}m`
          : '');
      await m.save(delivery);

      order.status = 'RESCHEDULING';
      await m.save(order);

      // 自动发起协同工单（六方围绕同一件家具处理），已存在开放的电梯工单则不重复建
      const openTicket = await m.findOne(Ticket, {
        where: { orderId, type: 'ELEVATOR_BLOCK', status: 'OPEN' },
      });
      if (!openTicket) {
        const ticket = await m.save(
          m.create(Ticket, {
            consignmentId: order.consignmentId,
            itemId: order.itemId,
            orderId,
            type: 'ELEVATOR_BLOCK',
            createdBy: user.sub,
            creatorRole: 'DELIVERY',
            status: 'OPEN',
            resolution: 'PENDING',
            liableParty: 'SHARED',
            title: '家具进不了电梯/楼道，已发起配送改约',
            description:
              `配送员现场登记：楼层 ${rs.siteFloor}，电梯进深 ${rs.elevatorDepth}m、` +
              `门宽 ${rs.elevatorDoorWidth}m，楼梯转角 ${rs.stairLandingWidth}m，` +
              `家具最大边 ${rs.furnitureMaxSide}m；拆装可能性：${rs.disassemblyFeasibility}；` +
              `现场人工加价 ¥${rs.laborSurcharge}。\n现场说明：${rs.siteNote || '无'}。\n` +
              `买家可在「我的订单 → 配送改约」选择：拆装上楼 / 吊装 / 退货 / 改送其他地址。`,
          }),
        );
        await m.save(
          m.create(TicketMessage, {
            ticketId: ticket.id,
            authorId: user.sub,
            authorRole: 'DELIVERY',
            authorName: user.name,
            content:
              '已登记现场照片与测量数据并发起配送改约，等待买家选择方案。吊装方案需补充吊装公司、物业许可、天气与保险确认。',
          }),
        );
      }
      return this.buildDetail(m, rs.id, user);
    });
  }

  /** 改约单列表（买家仅见自己的单；配送/客服/仓库/运营见全部） */
  @Get()
  async list(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: string,
  ) {
    const repo = this.ds.getRepository(DeliveryReschedule);
    let rows: DeliveryReschedule[];
    if (user.role === 'BUYER') {
      const orders = await this.ds.getRepository(Order).find({
        where: { buyerId: user.sub },
      });
      rows = orders.length
        ? await repo.find({
            where: { orderId: In(orders.map((o) => o.id)) },
            order: { createdAt: 'DESC' },
          })
        : [];
    } else if (user.role === 'SELLER') {
      const orders = await this.ds.getRepository(Order).find({
        where: { sellerId: user.sub },
      });
      rows = orders.length
        ? await repo.find({
            where: { orderId: In(orders.map((o) => o.id)) },
            order: { createdAt: 'DESC' },
          })
        : [];
    } else {
      rows = await repo.find({ order: { createdAt: 'DESC' } });
    }
    return status ? rows.filter((r) => r.status === status) : rows;
  }

  @Get('order/:orderId')
  async byOrder(
    @CurrentUser() user: JwtPayload,
    @Param('orderId') orderId: string,
  ) {
    const rs = await this.ds.getRepository(DeliveryReschedule).findOne({
      where: { orderId },
    });
    if (!rs) throw new NotFoundException('该订单暂无配送改约单');
    return this.buildDetail(this.ds.manager, rs.id, user, true);
  }

  @Get(':id')
  async detail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.buildDetail(this.ds.manager, id, user, true);
  }

  /** 买家（或客服代客）选择改约方案 */
  @Roles('BUYER', 'CS', 'OPS', 'ADMIN')
  @Post(':id/choose-plan')
  async choosePlan(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ChoosePlanDto,
  ) {
    if (!PLANS.includes(dto.plan)) {
      throw new BadRequestException('未知改约方案');
    }
    return this.ds.transaction(async (m) => {
      const rs = await this.getOwned(m, id, user);
      if (rs.status !== 'BLOCKED') {
        const staff = ['CS', 'OPS', 'ADMIN'].includes(user.role);
        if (!staff || ['COMPLETED', 'RELISTED', 'CANCELLED', 'RETURNED_TO_WAREHOUSE'].includes(rs.status)) {
          throw new BadRequestException('当前改约单不在待选择方案状态，请先完结或终止进行中的方案');
        }
      }
      if (dto.plan === 'CHANGE_ADDRESS') {
        if (!dto.newAddress?.trim() || !dto.newFloor) {
          throw new BadRequestException('改送其他地址需填写新地址与楼层');
        }
      }

      // 上一个未成功方案标记为放弃（吊装失败的已为 FAILED，不覆盖）
      await this.abandonOpenPlans(m, rs.id);

      const plan = m.create(DeliveryReschedulePlan, {
        rescheduleId: rs.id,
        chosenBy: user.sub,
        chosenByRole: user.role,
        plan: dto.plan,
        status: 'PENDING',
        note: dto.note || '',
      });

      switch (dto.plan) {
        case 'DISASSEMBLY': {
          if (rs.disassemblyFeasibility === 'NOT_DISASSEMBLABLE') {
            throw new BadRequestException('现场判定家具不可拆装，请选择其他方案');
          }
          plan.status = 'EXECUTING';
          plan.quotedFee = rs.laborSurcharge;
          rs.disassemblyFee = rs.laborSurcharge;
          rs.currentPlan = 'DISASSEMBLY';
          rs.status = 'IN_PROGRESS';
          break;
        }
        case 'HOISTING': {
          plan.quotedFee = '0.00';
          rs.currentPlan = 'HOISTING';
          rs.status = 'AWAITING_HOIST_CONFIRM';
          break;
        }
        case 'RETURN': {
          plan.quotedFee = '0.00';
          plan.status = 'EXECUTING';
          rs.currentPlan = 'RETURN';
          rs.status = 'IN_PROGRESS';
          break;
        }
        case 'CHANGE_ADDRESS': {
          plan.newAddress = dto.newAddress!.trim();
          plan.newFloor = Number(dto.newFloor);
          plan.newElevator = dto.newElevator || 'ELEVATOR';
          const fee = quoteRedeliveryFee(
            Number(dto.newFloor),
            plan.newElevator,
          );
          plan.quotedFee = money(fee);
          rs.redeliveryFee = money(fee);
          rs.currentPlan = 'CHANGE_ADDRESS';
          rs.status = 'RESCHEDULED';
          break;
        }
      }
      await m.save(plan);
      await m.save(rs);
      await this.ticketNote(
        m,
        rs,
        `${user.name}（${user.role}）选择方案：${this.planLabel(dto.plan)}` +
          (Number(plan.quotedFee) > 0 ? `，方案报价 ¥${plan.quotedFee}` : '') +
          (dto.plan === 'CHANGE_ADDRESS'
            ? `，新地址：${plan.newAddress}（${plan.newFloor} 层）`
            : ''),
      );
      return this.buildDetail(m, rs.id, null);
    });
  }

  /** 吊装前置四项确认：吊装公司 / 物业许可 / 天气 / 保险 + 吊装报价 */
  @Roles('DELIVERY', 'CS', 'OPS', 'ADMIN')
  @Post(':id/hoisting/confirm')
  async hoistConfirm(
    @Param('id') id: string,
    @Body() dto: HoistConfirmDto,
  ) {
    for (const [k, v] of Object.entries({
      吊装公司: dto.hoistingCompany,
      物业许可: dto.propertyPermit,
      天气情况: dto.weatherCondition,
      保险确认: dto.insuranceConfirmation,
    })) {
      if (!v?.trim()) throw new BadRequestException(`请填写${k}`);
    }
    if (num(dto.hoistingFee) <= 0) {
      throw new BadRequestException('吊装费报价需大于 0');
    }
    return this.ds.transaction(async (m) => {
      const rs = await m.findOne(DeliveryReschedule, { where: { id } });
      if (!rs) throw new NotFoundException('改约单不存在');
      const plan = await this.findOpenPlan(m, rs.id, 'HOISTING');
      if (!plan) throw new BadRequestException('当前没有待确认的吊装方案');
      plan.status = 'CONFIRMED';
      plan.hoistingCompany = dto.hoistingCompany.trim();
      plan.propertyPermit = dto.propertyPermit.trim();
      plan.weatherCondition = dto.weatherCondition.trim();
      plan.insuranceConfirmation = dto.insuranceConfirmation.trim();
      plan.quotedFee = money(num(dto.hoistingFee));
      rs.hoistingCompany = plan.hoistingCompany;
      rs.propertyPermit = plan.propertyPermit;
      rs.weatherCondition = plan.weatherCondition;
      rs.insuranceConfirmation = plan.insuranceConfirmation;
      rs.hoistingFee = plan.quotedFee;
      rs.status = 'HOISTING';
      await m.save([plan, rs]);
      await this.ticketNote(
        m,
        rs,
        `吊装前置确认完成：公司「${plan.hoistingCompany}」、物业许可 ${plan.propertyPermit}、` +
          `天气 ${plan.weatherCondition}、保险 ${plan.insuranceConfirmation}，吊装报价 ¥${plan.quotedFee}。`,
      );
      return this.buildDetail(m, rs.id, null);
    });
  }

  /** 吊装成功送达 */
  @Roles('DELIVERY', 'OPS', 'ADMIN')
  @Post(':id/hoisting/success')
  async hoistSuccess(@Param('id') id: string) {
    return this.ds.transaction(async (m) => {
      const rs = await m.findOne(DeliveryReschedule, { where: { id } });
      if (!rs) throw new NotFoundException('改约单不存在');
      const plan = await this.findOpenPlan(m, rs.id, 'HOISTING');
      if (!plan) throw new BadRequestException('当前没有执行中的吊装方案');
      await this.markDelivered(m, rs, plan);
      await this.ticketNote(m, rs, '吊装作业成功，家具已送达买家。');
      return this.buildDetail(m, rs.id, null);
    });
  }

  /** 吊装失败：区分买家环境限制 / 配送方案误判 / 第三方责任 */
  @Roles('DELIVERY', 'CS', 'OPS', 'ADMIN')
  @Post(':id/hoisting/fail')
  async hoistFail(@Param('id') id: string, @Body() dto: HoistResultDto) {
    if (!dto.failureLiability || !LIABILITIES.includes(dto.failureLiability)) {
      throw new BadRequestException('请选择吊装失败责任：买家环境限制/方案误判/第三方');
    }
    return this.ds.transaction(async (m) => {
      const rs = await m.findOne(DeliveryReschedule, { where: { id } });
      if (!rs) throw new NotFoundException('改约单不存在');
      const plan = await this.findOpenPlan(m, rs.id, 'HOISTING');
      if (!plan) throw new BadRequestException('当前没有执行中的吊装方案');

      const cost = Math.max(0, num(dto.failureCost));
      const thirdPartyComp =
        dto.failureLiability === 'THIRD_PARTY'
          ? Math.max(0, num(dto.thirdPartyCompensation))
          : 0;

      plan.status = 'FAILED';
      plan.failureLiability = dto.failureLiability;
      plan.failureCost = money(cost);
      plan.thirdPartyCompensation = money(thirdPartyComp);
      plan.failureNote = dto.failureNote || '';

      rs.hoistingFailureLiability = dto.failureLiability;
      rs.hoistingFailureCost = money(cost);
      rs.thirdPartyCompensation = money(thirdPartyComp);
      rs.hoistingFee = '0.00'; // 吊装未成功，吊装报价不向买家收取
      rs.status = 'BLOCKED'; // 回到待买家重新选方案
      rs.currentPlan = '';
      await m.save([plan, rs]);

      const delivery = await m.findOne(Delivery, { where: { id: rs.deliveryId } });
      if (delivery) {
        delivery.status = 'FAILED';
        delivery.failReason = 'ELEVATOR_TOO_SMALL';
        delivery.failNote = `吊装失败（${this.liabilityLabel(dto.failureLiability)}）：${dto.failureNote || '无'}`;
        await m.save(delivery);
      }
      await this.ticketNote(
        m,
        rs,
        `吊装失败，定责：${this.liabilityLabel(dto.failureLiability)}。` +
          `已发生费用 ¥${cost}${dto.failureLiability === 'THIRD_PARTY' ? `，吊装公司认赔 ¥${thirdPartyComp}` : ''}。` +
          `买家可重新选择拆装上楼/退货/改送其他地址。`,
      );
      return this.buildDetail(m, rs.id, null);
    });
  }

  /** 拆装上楼完成送达 */
  @Roles('DELIVERY', 'OPS', 'ADMIN')
  @Post(':id/disassembly/complete')
  async disassemblyComplete(@Param('id') id: string) {
    return this.ds.transaction(async (m) => {
      const rs = await m.findOne(DeliveryReschedule, { where: { id } });
      if (!rs) throw new NotFoundException('改约单不存在');
      const plan = await this.findOpenPlan(m, rs.id, 'DISASSEMBLY');
      if (!plan) throw new BadRequestException('当前没有执行中的拆装方案');
      await this.markDelivered(m, rs, plan);
      await this.ticketNote(
        m,
        rs,
        `现场拆装上楼完成并送达，拆装/人力加价 ¥${plan.quotedFee}。`,
      );
      return this.buildDetail(m, rs.id, null);
    });
  }

  /** 退货：家具回库登记（库位/回程运费/回库费），订单进入退货完结 */
  @Roles('DELIVERY', 'WAREHOUSE', 'OPS', 'ADMIN')
  @Post(':id/warehouse-return')
  async warehouseReturn(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: WarehouseReturnDto,
  ) {
    if (!dto.warehouseSlot?.trim()) {
      throw new BadRequestException('请登记回库库位');
    }
    return this.ds.transaction(async (m) => {
      const rs = await m.findOne(DeliveryReschedule, { where: { id } });
      if (!rs) throw new NotFoundException('改约单不存在');
      let plan = await this.findOpenPlan(m, rs.id, 'RETURN');
      if (!plan && rs.currentPlan === 'RETURN') {
        plan = await m.findOne(DeliveryReschedulePlan, {
          where: { rescheduleId: rs.id, plan: 'RETURN' },
          order: { createdAt: 'DESC' },
        });
      }
      if (!plan) throw new BadRequestException('买家尚未选择退货方案');

      const freight = Math.max(0, num(dto.returnFreight));
      const restock = Math.max(0, num(dto.restockingFee));
      plan.status = 'SUCCESS';
      plan.note = dto.note || plan.note;
      rs.returnFreight = money(freight);
      rs.restockingFee = money(restock);
      rs.returnWarehouseSlot = dto.warehouseSlot.trim();
      rs.returnedAt = new Date();
      rs.status = 'RETURNED_TO_WAREHOUSE';

      const item = await m.findOne(Item, { where: { id: rs.itemId } });
      if (item) {
        item.status = 'RETURNED';
        item.location = 'WAREHOUSE';
        item.warehouseSlot = rs.returnWarehouseSlot;
        await m.save(item);
      }
      const order = await m.findOne(Order, { where: { id: rs.orderId } });
      if (order) {
        order.status = 'RETURNED';
        await m.save(order);
      }
      const delivery = await m.findOne(Delivery, { where: { id: rs.deliveryId } });
      if (delivery) {
        delivery.status = 'FAILED';
        delivery.failReason = delivery.failReason || 'ELEVATOR_TOO_SMALL';
        await m.save(delivery);
      }
      await m.save([plan, rs]);
      await this.ticketNote(
        m,
        rs,
        `退货家具已回库 ${rs.returnWarehouseSlot}（登记人：${user.name}），` +
          `回程运费 ¥${freight}、回库复检/入库费 ¥${restock}。仓库复检后可决定是否二次上架。`,
      );
      return this.buildDetail(m, rs.id, null);
    });
  }

  /** 回库复检后二次上架（产生二次上架） */
  @Roles('WAREHOUSE', 'OPS', 'ADMIN')
  @Post(':id/relist')
  async relist(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RelistDto,
  ) {
    return this.ds.transaction(async (m) => {
      const rs = await m.findOne(DeliveryReschedule, { where: { id } });
      if (!rs) throw new NotFoundException('改约单不存在');
      if (rs.status !== 'RETURNED_TO_WAREHOUSE') {
        throw new BadRequestException('仅已回库待复检的改约单可二次上架');
      }
      const item = await m.findOne(Item, { where: { id: rs.itemId } });
      if (!item) throw new NotFoundException('商品不存在');
      if (dto.listedPrice && num(dto.listedPrice) > 0) {
        item.listedPrice = money(num(dto.listedPrice));
      }
      if (dto.description) item.description = dto.description;
      if (dto.photos?.length) item.photos = dto.photos;
      if (dto.deliveryRadiusKm !== undefined) {
        item.deliveryRadiusKm = Math.max(0, Number(dto.deliveryRadiusKm));
      }
      item.status = 'LISTED';
      item.listedAt = new Date();
      await m.save(item);

      rs.relisted = true;
      rs.relistedItemId = item.id;
      rs.status = 'RELISTED';
      await m.save(rs);
      await this.ticketNote(
        m,
        rs,
        `仓库复检完成，商品已二次上架（操作人：${user.name}），挂牌价 ¥${item.listedPrice}。`,
      );
      return this.buildDetail(m, rs.id, null);
    });
  }

  /** 改地址：配送按新地址重新排班（二次配送） */
  @Roles('DELIVERY', 'OPS', 'ADMIN')
  @Post(':id/redelivery/schedule')
  async redeliverySchedule(
    @Param('id') id: string,
    @Body() dto: RedeliveryScheduleDto,
  ) {
    if (!dto.scheduledWindow?.trim()) {
      throw new BadRequestException('请填写二次配送预约时间');
    }
    return this.ds.transaction(async (m) => {
      const rs = await m.findOne(DeliveryReschedule, { where: { id } });
      if (!rs) throw new NotFoundException('改约单不存在');
      const plan = await this.findOpenPlan(m, rs.id, 'CHANGE_ADDRESS');
      if (!plan) throw new BadRequestException('当前没有待排班的改地址方案');

      const order = await m.findOne(Order, { where: { id: rs.orderId } });
      if (!order) throw new NotFoundException('订单不存在');
      order.buyerAddress = plan.newAddress;
      order.buyerFloor = plan.newFloor || order.buyerFloor;
      order.buyerElevator = plan.newElevator || order.buyerElevator;
      order.appointmentWindow = dto.scheduledWindow.trim();
      order.status = 'DELIVERY_SCHEDULED';

      const delivery = await m.findOne(Delivery, { where: { id: rs.deliveryId } });
      if (delivery) {
        delivery.status = 'SCHEDULED';
        delivery.failReason = 'NONE';
        delivery.failNote = '';
        delivery.scheduledWindow = dto.scheduledWindow.trim();
        delivery.vehicleType = dto.vehicleType || delivery.vehicleType;
        delivery.dropoffFloor = order.buyerFloor;
        delivery.dropoffElevator = order.buyerElevator;
        await m.save(delivery);
      }
      plan.status = 'EXECUTING';
      rs.status = 'REDELIVERING';
      await m.save([plan, rs, order]);
      await this.ticketNote(
        m,
        rs,
        `改地址二次配送已排班：${plan.newAddress}（${plan.newFloor} 层，` +
          `${plan.newElevator === 'ELEVATOR' ? '有电梯' : '无电梯'}），时间 ${dto.scheduledWindow}，` +
          `二次配送费 ¥${plan.quotedFee}。`,
      );
      return this.buildDetail(m, rs.id, null);
    });
  }

  // ---------------- 内部辅助 ----------------

  private async getOwned(
    m: DataSource['manager'],
    id: string,
    user: JwtPayload,
  ): Promise<DeliveryReschedule> {
    const rs = await m.findOne(DeliveryReschedule, { where: { id } });
    if (!rs) throw new NotFoundException('改约单不存在');
    if (user.role === 'BUYER') {
      const order = await m.findOne(Order, { where: { id: rs.orderId } });
      if (order?.buyerId !== user.sub) {
        throw new ForbiddenException('只能处理自己订单的配送改约');
      }
    } else if (user.role === 'SELLER') {
      throw new ForbiddenException('改约方案由买家选择，卖家可在协同工单中查看进展');
    }
    return rs;
  }

  private async findOpenPlan(
    m: DataSource['manager'],
    rescheduleId: string,
    plan: ReschedulePlan,
  ): Promise<DeliveryReschedulePlan | null> {
    const rows = await m.find(DeliveryReschedulePlan, {
      where: { rescheduleId, plan },
      order: { createdAt: 'DESC' },
    });
    return rows.find((r) => ['PENDING', 'CONFIRMED', 'EXECUTING'].includes(r.status)) || null;
  }

  private async abandonOpenPlans(m: DataSource['manager'], rescheduleId: string) {
    const rows = await m.find(DeliveryReschedulePlan, { where: { rescheduleId } });
    for (const r of rows) {
      if (['PENDING', 'CONFIRMED', 'EXECUTING'].includes(r.status)) {
        r.status = 'ABANDONED';
        await m.save(r);
      }
    }
  }

  /** 拆装/吊装成功：统一推进送达状态 */
  private async markDelivered(
    m: DataSource['manager'],
    rs: DeliveryReschedule,
    plan: DeliveryReschedulePlan,
  ) {
    plan.status = 'SUCCESS';
    rs.status = 'COMPLETED';
    const delivery = await m.findOne(Delivery, { where: { id: rs.deliveryId } });
    if (delivery) {
      delivery.status = 'DONE';
      delivery.failReason = 'NONE';
      await m.save(delivery);
    }
    const order = await m.findOne(Order, { where: { id: rs.orderId } });
    if (order) {
      order.status = 'DELIVERED';
      await m.save(order);
    }
    const item = await m.findOne(Item, { where: { id: rs.itemId } });
    if (item) {
      item.status = 'DELIVERED';
      await m.save(item);
    }
    await m.save([plan, rs]);
  }

  private async ticketNote(
    m: DataSource['manager'],
    rs: DeliveryReschedule,
    content: string,
  ) {
    const ticket = await m.findOne(Ticket, {
      where: { orderId: rs.orderId, type: 'ELEVATOR_BLOCK' },
      order: { createdAt: 'DESC' },
    });
    if (!ticket) return;
    await m.save(
      m.create(TicketMessage, {
        ticketId: ticket.id,
        authorId: rs.reportedBy,
        authorRole: 'DELIVERY',
        authorName: '改约进度',
        content,
      }),
    );
  }

  private planLabel(p: ReschedulePlan) {
    return (
      {
        DISASSEMBLY: '拆装上楼',
        HOISTING: '吊装',
        RETURN: '退货回库',
        CHANGE_ADDRESS: '改送其他地址',
      } as Record<string, string>
    )[p];
  }

  private liabilityLabel(l: HoistingFailureLiability | '') {
    return (
      {
        BUYER_ENVIRONMENT: '买家环境限制',
        PLAN_MISJUDGMENT: '配送方案误判',
        THIRD_PARTY: '第三方（吊装公司）责任',
      } as Record<string, string>
    )[l] || l;
  }

  private async buildDetail(
    manager: DataSource['manager'] | DataSource,
    id: string,
    user: JwtPayload | null,
    checkAccess = false,
  ) {
    const m: any = manager;
    const rs = await m.findOne(DeliveryReschedule, { where: { id } });
    if (!rs) throw new NotFoundException('改约单不存在');
    if (checkAccess && user && (user.role === 'BUYER' || user.role === 'SELLER')) {
      const order = await m.findOne(Order, { where: { id: rs.orderId } });
      if (
        (user.role === 'BUYER' && order?.buyerId !== user.sub) ||
        (user.role === 'SELLER' && order?.sellerId !== user.sub)
      ) {
        throw new ForbiddenException('无权查看该改约单');
      }
    }
    const plans = await m.find(DeliveryReschedulePlan, {
      where: { rescheduleId: id },
      order: { createdAt: 'ASC' },
    });
    const order = await m.findOne(Order, { where: { id: rs.orderId } });
    const item = await m.findOne(Item, { where: { id: rs.itemId } });
    const delivery = await m.findOne(Delivery, { where: { id: rs.deliveryId } });
    const consignment = await m.findOne(Consignment, {
      where: { id: rs.consignmentId },
    });
    return { reschedule: rs, plans, order, item, delivery, consignment };
  }
}

/** TypeORM In 的轻量封装（保持与仓库内其他模块一致的写法） */

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DeliveryReschedule,
      DeliveryReschedulePlan,
      Delivery,
      Order,
      Item,
      Consignment,
      Ticket,
      TicketMessage,
    ]),
  ],
  controllers: [RescheduleController],
})
export class RescheduleModule {}
