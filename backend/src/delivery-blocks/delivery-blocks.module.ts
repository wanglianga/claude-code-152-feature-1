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
  ForbiddenException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { DeliveryBlock, BlockOption, HoistFailCause } from '../entities/delivery-block.entity';
import { Delivery } from '../entities/delivery.entity';
import { Order } from '../entities/order.entity';
import { Item } from '../entities/item.entity';
import { Consignment } from '../entities/consignment.entity';
import { Ticket, TicketMessage } from '../entities/ticket.entity';
import { JwtAuthGuard, JwtPayload } from '../auth/jwt.guard';
import { RolesGuard, Roles } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';

class SurveyDto {
  photos?: string[];
  siteFloor?: number;
  elevatorDepthCm?: number;
  elevatorWidthCm?: number;
  elevatorDoorCm?: number;
  stairWidthCm?: number;
  stairTurnWidthCm?: number;
  disassemblable?: boolean;
  disassemblyNote?: string;
  laborSurcharge?: number;
  siteNote?: string;
}

class OptionDto {
  option: BlockOption;
  fee?: number;
  note?: string;
  newAddress?: string;
  newFloor?: number;
  newElevator?: string;
}

class ArrangeHoistDto {
  hoistCompany: string;
  propertyPermit: boolean;
  propertyPermitNote?: string;
  weather: string;
  insuranceConfirmed: boolean;
  insurancePolicy?: string;
  hoistQuote: number;
}

class HoistResultDto {
  success: boolean;
  failCause?: HoistFailCause;
  failNote?: string;
  thirdPartyClaimAmount?: number;
}

class WarehouseReturnDto {
  warehouseSlot: string;
  note?: string;
}

class RelistDecisionDto {
  decision: 'RELIST' | 'NO_RELIST';
  reason?: string;
  newPrice?: number;
  deliveryRadiusKm?: number;
}

/** 改送他址转运附加费：基础 ¥100，新地址无电梯再按楼层 ¥15/层 */
function estimateChangeAddressFee(dto: OptionDto) {
  let fee = 100;
  if (dto.newElevator && dto.newElevator !== 'ELEVATOR') {
    fee += Math.max(0, Number(dto.newFloor || 1) - 1) * 15;
  }
  return fee;
}

const BAD_WEATHER = /大风|6\s*级|七\s*级|雷雨|暴雨|台风|雨雪|冰雹/;

/**
 * 大件家具进不了电梯/楼道的「配送改约」：
 * 现场勘测（照片/楼层/通道尺寸/拆装可能性/人工加价）
 * → 买家四方案（拆装上楼/吊装/退货/改送他址），各方案影响配送费、卖家结算、回库与二次上架
 * → 吊装登记公司/物业许可/天气/保险，失败区分买家环境/方案误判/第三方责任
 * → 退货回库并决定是否二次上架。
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('delivery-blocks')
export class DeliveryBlockController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** 配送员现场勘测登记：配送置失败、订单进入改约，并自动开一张协同工单 */
  @Roles('DELIVERY', 'OPS', 'CS', 'ADMIN')
  @Post('order/:orderId/survey')
  async survey(
    @CurrentUser() user: JwtPayload,
    @Param('orderId') orderId: string,
    @Body() dto: SurveyDto,
  ) {
    return this.ds.transaction(async (m) => {
      const order = await m.findOne(Order, { where: { id: orderId } });
      if (!order) throw new NotFoundException('订单不存在');
      if (['CANCELLED', 'RETURNED', 'SETTLED'].includes(order.status)) {
        throw new BadRequestException(`订单当前 ${order.status}，不可登记配送受阻`);
      }
      const existed = await m.findOne(DeliveryBlock, { where: { orderId } });
      if (existed) {
        throw new BadRequestException('该订单已存在配送改约单，请在改约单中继续处理');
      }
      const item = await m.findOne(Item, { where: { id: order.itemId } });
      if (!item) throw new NotFoundException('商品不存在');

      const delivery = await m.findOne(Delivery, { where: { orderId } });
      if (delivery) {
        delivery.status = 'FAILED';
        delivery.failReason =
          dto.stairTurnWidthCm != null &&
          (dto.elevatorDepthCm == null || Number(dto.elevatorDepthCm) === 0)
            ? 'STAIR_TOO_NARROW'
            : 'ELEVATOR_TOO_SMALL';
        delivery.failNote =
          dto.siteNote ||
          `现场勘测：电梯进深 ${dto.elevatorDepthCm ?? '-'}cm，楼梯转角 ${dto.stairTurnWidthCm ?? '-'}cm`;
        await m.save(delivery);
      }
      order.status = 'RESHEDULING';
      await m.save(order);

      const countRow: { m: string | null } | undefined = await m
        .createQueryBuilder(DeliveryBlock, 'b')
        .select('MAX(b.code)', 'm')
        .getRawOne();
      const lastSeq = countRow?.m ? Number(countRow.m.slice(-6)) || 0 : 0;
      const block = m.create(DeliveryBlock, {
        code: `BL${new Date().getFullYear()}${String(lastSeq + 1).padStart(6, '0')}`,
        orderId: order.id,
        consignmentId: order.consignmentId,
        itemId: item.id,
        status: 'SURVEYED',
        photos: dto.photos || [],
        siteFloor: Number(dto.siteFloor) || order.buyerFloor || 1,
        elevatorDepthCm: dto.elevatorDepthCm ?? null,
        elevatorWidthCm: dto.elevatorWidthCm ?? null,
        elevatorDoorCm: dto.elevatorDoorCm ?? null,
        stairWidthCm: dto.stairWidthCm ?? null,
        stairTurnWidthCm: dto.stairTurnWidthCm ?? null,
        disassemblable: !!dto.disassemblable,
        disassemblyNote: dto.disassemblyNote || '',
        laborSurcharge: Number(dto.laborSurcharge || 0).toFixed(2),
        siteNote: dto.siteNote || '',
        surveyedBy: user.sub,
        surveyedAt: new Date(),
      });
      await m.save(block);

      const dims = [
                dto.elevatorDepthCm ? `电梯进深 ${dto.elevatorDepthCm}cm` : '',
        dto.elevatorDoorCm ? `开门净宽 ${dto.elevatorDoorCm}cm` : '',
        dto.stairWidthCm ? `楼梯宽 ${dto.stairWidthCm}cm` : '',
        dto.stairTurnWidthCm ? `转角净宽 ${dto.stairTurnWidthCm}cm` : '',
      ].filter(Boolean).join('；');
      const ticket = m.create(Ticket, {
        consignmentId: order.consignmentId,
        itemId: item.id,
        orderId: order.id,
        blockId: block.id,
        type: 'ELEVATOR_BLOCK',
        createdBy: user.sub,
        creatorRole: user.role,
        status: 'OPEN',
        resolution: 'PENDING',
        liableParty: 'SHARED',
        title: `大件家具到楼无法上楼（配送改约 ${block.code}）`,
        description:
          `现场勘测：${order.buyerAddress} ${block.siteFloor} 层。${dims}。` +
          `拆装可能性：${dto.disassemblable ? '可拆装' : '不可拆装'}${dto.disassemblyNote ? `（${dto.disassemblyNote}）` : ''}。` +
          `现场人工加价 ¥${block.laborSurcharge}。${dto.siteNote ? ` 备注：${dto.siteNote}` : ''} ` +
          `请买家在拆装上楼 / 吊装 / 退货 / 改送他址中选择方案。`,
      });
      await m.save(ticket);
      block.ticketId = ticket.id;
      await m.save(block);
      return { block, ticket };
    });
  }

  @Get()
  async list(@CurrentUser() user: JwtPayload) {
    const repo = this.ds.getRepository(DeliveryBlock);
    if (['DELIVERY', 'OPS', 'CS', 'ADMIN', 'WAREHOUSE', 'APPRAISER', 'REFURBISHER'].includes(user.role)) {
      return repo.find({ order: { createdAt: 'DESC' } });
    }
    if (user.role === 'BUYER') {
      const orders = await this.ds.getRepository(Order).find({ where: { buyerId: user.sub } });
      const ids = orders.map((o) => o.id);
      return ids.length ? repo.find({ where: { orderId: In(ids) }, order: { createdAt: 'DESC' } }) : [];
    }
    const consignments = await this.ds.getRepository(Consignment).find({ where: { sellerId: user.sub } });
    const cids = consignments.map((c) => c.id);
    return cids.length ? repo.find({ where: { consignmentId: In(cids) }, order: { createdAt: 'DESC' } }) : [];
  }

  @Get(':id')
  async detail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const block = await this.ds.getRepository(DeliveryBlock).findOne({ where: { id } });
    if (!block) throw new NotFoundException('配送改约单不存在');
    const order = await this.ds.getRepository(Order).findOne({ where: { id: block.orderId } });
    if (user.role === 'BUYER' && order?.buyerId !== user.sub) {
      throw new ForbiddenException('无权查看该改约单');
    }
    if (user.role === 'SELLER' && order?.sellerId !== user.sub) {
      throw new ForbiddenException('无权查看该改约单');
    }
    const [item, delivery, ticket] = await Promise.all([
      this.ds.getRepository(Item).findOne({ where: { id: block.itemId } }),
      this.ds.getRepository(Delivery).findOne({ where: { orderId: block.orderId } }),
      block.ticketId
        ? this.ds.getRepository(Ticket).findOne({ where: { id: block.ticketId } })
        : Promise.resolve(null),
    ]);
    return { block, order, item, delivery, ticket };
  }

  /** 买家选择方案（客服/运营可代操作）；不同方案决定附加费、订单走向、回库与二次上架 */
  @Post(':id/option')
  async chooseOption(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: OptionDto,
  ) {
    const options: BlockOption[] = ['DISASSEMBLY', 'HOIST', 'RETURN', 'CHANGE_ADDRESS'];
    if (!options.includes(dto.option)) throw new BadRequestException('未知配送方案');
    return this.ds.transaction(async (m) => {
      const block = await m.findOne(DeliveryBlock, { where: { id } });
      if (!block) throw new NotFoundException('配送改约单不存在');
      const order = await m.findOne(Order, { where: { id: block.orderId } });
      if (!order) throw new NotFoundException('订单不存在');
      if (user.role === 'BUYER' && order.buyerId !== user.sub) {
        throw new ForbiddenException('只能为自己的订单选择方案');
      }
      if (!['SURVEYED', 'RESOLVING', 'RETURN_DECIDED'].includes(block.status)) {
        throw new BadRequestException(`改约单当前 ${block.status}，不可再选择方案`);
      }
      // 吊装已成功待交付时不允许改选
      if (block.hoistStatus === 'SUCCESS') {
        throw new BadRequestException('吊装已成功，等待交付，不可改选');
      }
      const isStaff = ['CS', 'OPS', 'ADMIN'].includes(user.role);

      let fee = 0;
      switch (dto.option) {
        case 'DISASSEMBLY':
          if (!block.disassemblable) {
            throw new BadRequestException('现场勘测判定该家具不可拆装，请选择吊装、退货或改送他址');
          }
          fee = isStaff && dto.fee != null ? Number(dto.fee) : Number(block.laborSurcharge);
          block.status = 'RESOLVING';
          break;
        case 'HOIST':
          // 吊装费在「安排吊装」报价后落定
          fee = Number(block.hoistQuote || 0);
          block.status = 'RESOLVING';
          break;
        case 'CHANGE_ADDRESS':
          if (!dto.newAddress || !dto.newAddress.trim()) {
            throw new BadRequestException('改送他址请填写新收货地址');
          }
          fee = isStaff && dto.fee != null ? Number(dto.fee) : estimateChangeAddressFee(dto);
          block.newAddress = dto.newAddress.trim();
          block.newFloor = Number(dto.newFloor) || 1;
          block.newElevator = dto.newElevator || 'ELEVATOR';
          block.status = 'RESOLVING';
          break;
        case 'RETURN':
          fee = 0;
          block.status = 'RETURN_DECIDED';
          break;
      }

      block.buyerOption = dto.option;
      block.optionFee = fee.toFixed(2);
      block.optionNote = dto.note || '';
      block.optionHistory = [
        ...(block.optionHistory || []),
        {
          by: user.sub,
          byRole: user.role,
          byName: user.name,
          option: dto.option,
          fee: fee.toFixed(2),
          at: new Date(),
          note: dto.note || '',
        },
      ];

      // 吊装失败后买家改选：按归因决定退货时买家是否承担已发生吊装费
      if (dto.option === 'RETURN' && block.hoistStatus === 'FAILED') {
        block.buyerBorneOnReturn =
          block.hoistFailCause === 'BUYER_ENVIRONMENT'
            ? Number(block.hoistQuote || 0).toFixed(2)
            : '0.00';
      }
      if (dto.option !== 'RETURN') {
        block.buyerBorneOnReturn = '0.00';
      }

      order.surchargeFee = fee.toFixed(2);
      if (dto.option === 'RETURN') {
        order.status = 'RETURNING';
        const delivery = await m.findOne(Delivery, { where: { orderId: order.id } });
        if (delivery && delivery.status !== 'DONE') {
          delivery.status = 'FAILED';
          if (!delivery.failReason || delivery.failReason === 'NONE') {
            delivery.failReason = 'ELEVATOR_TOO_SMALL';
          }
          await m.save(delivery);
        }
      } else {
        order.status = 'RESHEDULING';
      }
      await m.save(order);
      await m.save(block);

      await this.note(
        m,
        block,
        user,
        `买家选择方案【${this.optionLabel(dto.option)}】` +
          (dto.option === 'RETURN'
            ? Number(block.buyerBorneOnReturn) > 0
              ? `；因买家环境限制导致吊装失败，已发生吊装费 ¥${block.buyerBorneOnReturn} 将在退款时扣除`
              : '；商品将返仓，等待复检与二次上架决策'
            : `；方案附加费 ¥${fee.toFixed(2)}（在原配送费之外）`) +
          (dto.option === 'CHANGE_ADDRESS' ? `；新地址：${block.newAddress} ${block.newFloor} 层` : '') +
          (dto.note ? `。说明：${dto.note}` : ''),
      );
      return block;
    });
  }

  /** 安排吊装：必须登记吊装公司、物业许可、天气、保险与报价 */
  @Roles('DELIVERY', 'OPS', 'CS', 'ADMIN')
  @Post(':id/arrange-hoist')
  async arrangeHoist(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ArrangeHoistDto,
  ) {
    if (!dto.hoistCompany?.trim()) throw new BadRequestException('请填写吊装公司');
    if (!dto.weather?.trim()) throw new BadRequestException('请记录作业当日天气');
    if (!dto.propertyPermit) {
      throw new BadRequestException('物业尚未许可吊装，取得书面/口头许可后再安排');
    }
    if (!dto.insuranceConfirmed) {
      throw new BadRequestException('吊装保险未确认，禁止安排高空作业');
    }
    if (BAD_WEATHER.test(dto.weather)) {
      throw new BadRequestException('当日天气不满足高空吊装安全条件（大风/雷雨/雨雪等），请改期');
    }
    if (!(Number(dto.hoistQuote) >= 0)) throw new BadRequestException('吊装报价不合法');

    return this.ds.transaction(async (m) => {
      const block = await m.findOne(DeliveryBlock, { where: { id } });
      if (!block) throw new NotFoundException('配送改约单不存在');
      if (block.buyerOption !== 'HOIST') {
        throw new BadRequestException('买家选择的方案不是吊装');
      }
      if (block.hoistStatus === 'SUCCESS') {
        throw new BadRequestException('吊装已成功，无需重复安排');
      }
      Object.assign(block, {
        hoistCompany: dto.hoistCompany.trim(),
        propertyPermit: true,
        propertyPermitNote: dto.propertyPermitNote || '物业已许可',
        weather: dto.weather.trim(),
        insuranceConfirmed: true,
        insurancePolicy: dto.insurancePolicy || '',
        hoistQuote: Number(dto.hoistQuote).toFixed(2),
        hoistStatus: 'SCHEDULED',
        hoistFailCause: null,
        hoistFailNote: '',
        hoistArrangedBy: user.sub,
        hoistArrangedAt: new Date(),
        optionFee: Number(dto.hoistQuote).toFixed(2),
        status: 'RESOLVING',
      });
      const order = await m.findOne(Order, { where: { id: block.orderId } });
      if (order) {
        order.surchargeFee = block.optionFee;
        order.status = 'RESHEDULING';
        await m.save(order);
      }
      await m.save(block);
      await this.note(
        m,
        block,
        user,
        `已安排吊装：公司「${block.hoistCompany}」，物业许可（${block.propertyPermitNote}），` +
          `天气「${block.weather}」，保险已确认${block.insurancePolicy ? `（保单 ${block.insurancePolicy}）` : ''}，` +
          `吊装报价 ¥${block.hoistQuote}。`,
      );
      return block;
    });
  }

  /** 回填吊装结果；失败必须在买家环境限制 / 配送方案误判 / 第三方责任中归因 */
  @Roles('DELIVERY', 'OPS', 'CS', 'ADMIN')
  @Post(':id/hoist-result')
  async hoistResult(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: HoistResultDto,
  ) {
    return this.ds.transaction(async (m) => {
      const block = await m.findOne(DeliveryBlock, { where: { id } });
      if (!block) throw new NotFoundException('配送改约单不存在');
      if (block.buyerOption !== 'HOIST' || !['SCHEDULED'].includes(block.hoistStatus)) {
        throw new BadRequestException('仅已安排的吊装可回填结果');
      }
      const order = await m.findOne(Order, { where: { id: block.orderId } });

      if (dto.success) {
        block.hoistStatus = 'SUCCESS';
        block.hoistFailCause = null;
        block.hoistFailNote = '';
        block.status = 'RESOLVING';
        if (order) {
          order.surchargeFee = block.hoistQuote;
          await m.save(order);
        }
        await m.save(block);
        await this.note(m, block, user, '吊装成功，家具已运至楼层，可办理交付。');
        return block;
      }

      const causes: HoistFailCause[] = ['BUYER_ENVIRONMENT', 'PLAN_MISJUDGE', 'THIRD_PARTY'];
      if (!dto.failCause || !causes.includes(dto.failCause)) {
        throw new BadRequestException('吊装失败必须选择责任归因');
      }
      block.hoistStatus = 'FAILED';
      block.hoistFailCause = dto.failCause;
      block.hoistFailNote = dto.failNote || '';
      // 回到待买家重新选择方案
      block.status = 'SURVEYED';

      if (dto.failCause === 'THIRD_PARTY') {
        block.thirdPartyClaimAmount = Number(
          dto.thirdPartyClaimAmount != null ? dto.thirdPartyClaimAmount : block.hoistQuote,
        ).toFixed(2);
        if (order) order.surchargeFee = '0.00'; // 平台先垫付并向吊装公司追偿，不向买家收取
      } else if (dto.failCause === 'PLAN_MISJUDGE') {
        if (order) order.surchargeFee = '0.00'; // 方案误判由平台承担，买家不付吊装费
      }
      // BUYER_ENVIRONMENT：吊装费保留为买家已发生费用（改选成功则计入账单，退货从退款扣除）
      if (order) {
        order.status = 'RESHEDULING';
        await m.save(order);
      }
      const delivery = await m.findOne(Delivery, { where: { orderId: block.orderId } });
      if (delivery && delivery.status !== 'DONE') {
        delivery.status = 'FAILED';
        delivery.failReason = 'HOIST_FAILED';
        await m.save(delivery);
      }
      await m.save(block);
      await this.note(
        m,
        block,
        user,
        `吊装失败，责任归因【${this.hoistCauseLabel(dto.failCause)}】。` +
          (dto.failCause === 'THIRD_PARTY'
            ? `平台先垫付吊装费 ¥${block.hoistQuote}，将向「${block.hoistCompany}」追偿 ¥${block.thirdPartyClaimAmount}。`
            : dto.failCause === 'PLAN_MISJUDGE'
              ? '属于配送方案误判，吊装费由平台承担，买家无需支付，请重新选择方案。'
              : '属于买家现场环境限制，已发生吊装费由买家承担，请重新选择方案。') +
          (dto.failNote ? ` 现场说明：${dto.failNote}` : ''),
      );
      return block;
    });
  }

  /** 拆装 / 改址 / 吊装成功后完成交付 */
  @Roles('DELIVERY', 'OPS', 'CS', 'ADMIN')
  @Post(':id/complete-delivery')
  async completeDelivery(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: { note?: string },
  ) {
    return this.ds.transaction(async (m) => {
      const block = await m.findOne(DeliveryBlock, { where: { id } });
      if (!block) throw new NotFoundException('配送改约单不存在');
      if (block.status === 'DELIVERED') throw new BadRequestException('该改约单已完成交付');
      if (!block.buyerOption) throw new BadRequestException('买家尚未选择方案');

      if (block.buyerOption === 'DISASSEMBLY' && !block.disassemblable) {
        throw new BadRequestException('该家具不可拆装，不能按拆装方案交付');
      }
      if (block.buyerOption === 'HOIST' && block.hoistStatus !== 'SUCCESS') {
        throw new BadRequestException('吊装尚未成功，不能交付');
      }
      if (block.buyerOption === 'CHANGE_ADDRESS' && !block.newAddress) {
        throw new BadRequestException('缺少改送地址');
      }
      if (block.buyerOption === 'RETURN') {
        throw new BadRequestException('买家已选择退货，请办理退货回库而非交付');
      }

      const order = await m.findOne(Order, { where: { id: block.orderId } });
      if (!order) throw new NotFoundException('订单不存在');
      const delivery = await m.findOne(Delivery, { where: { orderId: order.id } });
      const item = await m.findOne(Item, { where: { id: block.itemId } });

      if (block.buyerOption === 'CHANGE_ADDRESS') {
        order.finalAddress = block.newAddress;
        order.buyerAddress = block.newAddress;
        order.buyerFloor = block.newFloor || order.buyerFloor;
        order.buyerElevator = block.newElevator || order.buyerElevator;
        if (delivery) {
          delivery.dropoffFloor = order.buyerFloor;
          delivery.dropoffElevator = order.buyerElevator;
        }
      } else if (!order.finalAddress) {
        order.finalAddress = order.buyerAddress;
      }
      if (body?.note) order.deliveryNote = body.note;
      order.status = 'DELIVERED';
      if (delivery) {
        delivery.status = 'DONE';
        delivery.failReason = 'NONE';
        delivery.failNote = `改约方案「${this.optionLabel(block.buyerOption)}」交付完成`;
      }
      if (item) item.status = 'DELIVERED';
      block.status = 'DELIVERED';

      await m.save([order, block]);
      if (delivery) await m.save(delivery);
      if (item) await m.save(item);
      await this.note(
        m,
        block,
        user,
        `改约方案【${this.optionLabel(block.buyerOption)}】执行完成，家具已送达签收。` +
          `本单配送费 ¥${order.deliveryFee} + 方案附加费 ¥${order.surchargeFee}。`,
      );
      return { block, order, delivery };
    });
  }

  /** 退货商品回库：登记库位，等待是否二次上架 */
  @Roles('WAREHOUSE', 'CS', 'OPS', 'ADMIN')
  @Post(':id/warehouse-return')
  async warehouseReturn(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: WarehouseReturnDto,
  ) {
    if (!dto.warehouseSlot?.trim()) throw new BadRequestException('请登记回库库位');
    return this.ds.transaction(async (m) => {
      const block = await m.findOne(DeliveryBlock, { where: { id } });
      if (!block) throw new NotFoundException('配送改约单不存在');
      if (!['RETURN_DECIDED', 'SURVEYED'].includes(block.status) || block.buyerOption !== 'RETURN') {
        throw new BadRequestException('仅买家选择退货的改约单可办理回库');
      }
      const order = await m.findOne(Order, { where: { id: block.orderId } });
      const item = await m.findOne(Item, { where: { id: block.itemId } });
      if (order) {
        order.status = 'RETURNED';
        order.surchargeFee = '0.00';
        await m.save(order);
      }
      if (item) {
        item.status = 'RETURNED';
        item.location = 'WAREHOUSE';
        item.warehouseSlot = dto.warehouseSlot.trim();
        await m.save(item);
      }
      block.warehouseSlot = dto.warehouseSlot.trim();
      block.relistDecision = 'PENDING';
      block.status = 'WAREHOUSED';
      await m.save(block);
      await this.note(
        m,
        block,
        user,
        `退货商品已回仓复检，库位 ${block.warehouseSlot}。等待二次上架决策。` +
          (dto.note ? ` 复检情况：${dto.note}` : ''),
      );
      return block;
    });
  }

  /** 回库复检后决定是否二次上架（决定是否产生二次上架） */
  @Roles('WAREHOUSE', 'CS', 'OPS', 'ADMIN')
  @Post(':id/relist-decision')
  async relistDecision(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RelistDecisionDto,
  ) {
    if (!['RELIST', 'NO_RELIST'].includes(dto.decision)) {
      throw new BadRequestException('决策必须为 RELIST 或 NO_RELIST');
    }
    return this.ds.transaction(async (m) => {
      const block = await m.findOne(DeliveryBlock, { where: { id } });
      if (!block) throw new NotFoundException('配送改约单不存在');
      if (block.status !== 'WAREHOUSED') {
        throw new BadRequestException('商品尚未回仓复检，不能做出上架决策');
      }
      const item = await m.findOne(Item, { where: { id: block.itemId } });
      if (!item) throw new NotFoundException('商品不存在');
      const ticket = block.ticketId
        ? await m.findOne(Ticket, { where: { id: block.ticketId } })
        : null;

      if (dto.decision === 'RELIST') {
        if (item.status !== 'RETURNED') {
          throw new BadRequestException(`商品当前 ${item.status}，不可二次上架`);
        }
        if (dto.newPrice && Number(dto.newPrice) > 0) {
          item.listedPrice = Number(dto.newPrice).toFixed(2);
          if (Number(item.minDealPrice) > Number(dto.newPrice)) {
            item.minDealPrice = Number(dto.newPrice).toFixed(2);
          }
        }
        if (dto.deliveryRadiusKm != null) {
          item.deliveryRadiusKm = Number(dto.deliveryRadiusKm);
        }
        item.status = 'LISTED';
        item.warehouseSlot = block.warehouseSlot;
        item.listedAt = new Date();
        // 把现场通道尺寸沉淀到商品描述，避免下一位买家重蹈覆辙
        item.description =
          `${item.description ? `${item.description}\n` : ''}` +
          `【二次上架·配送提示】本件曾因通道尺寸退货返仓：电梯进深 ${block.elevatorDepthCm ?? '-'}cm、` +
          `开门净宽 ${block.elevatorDoorCm ?? '-'}cm、楼梯转角 ${block.stairTurnWidthCm ?? '-'}cm，` +
          `下单前请核对通道尺寸；建议同城自提或预约拆装/吊装。`;
        block.relistDecision = 'RELIST';
        block.relistReason = dto.reason || '复检合格，二次上架';
        block.relistedAt = new Date();
        block.status = 'RELISTED';
        if (ticket) {
          ticket.resolution = 'RE_LIST';
          ticket.status = ticket.status === 'CLOSED' ? ticket.status : 'RESOLVED';
          await m.save(ticket);
        }
        await this.note(
          m,
          block,
          user,
          `复检合格，商品二次上架（产生二次上架），挂牌价 ¥${item.listedPrice}，配送范围 ${item.deliveryRadiusKm}km；` +
            `已在商品描述补充电梯/楼道通道尺寸提示。${dto.reason ? ` 说明：${dto.reason}` : ''}`,
        );
      } else {
        item.status = 'OFF_SHELF';
        block.relistDecision = 'NO_RELIST';
        block.relistReason = dto.reason || '复检不适合再次销售';
        block.status = 'CLOSED';
        await this.note(
          m,
          block,
          user,
          `复检后决定不再二次上架，商品下架（${block.relistReason}）。`,
        );
      }
      await m.save(item);
      await m.save(block);
      return block;
    });
  }

  private async note(
    m: DataSource['manager'],
    block: DeliveryBlock,
    user: JwtPayload,
    content: string,
  ) {
    if (!block.ticketId) return;
    await m.save(
      m.create(TicketMessage, {
        ticketId: block.ticketId,
        authorId: user.sub,
        authorRole: user.role,
        authorName: user.name,
        content,
      }),
    );
  }

  private optionLabel(o: BlockOption) {
    return {
      DISASSEMBLY: '拆装上楼',
      HOIST: '吊装上楼',
      RETURN: '退货',
      CHANGE_ADDRESS: '改送其他地址',
    }[o];
  }

  private hoistCauseLabel(c: HoistFailCause) {
    return {
      BUYER_ENVIRONMENT: '买家环境限制',
      PLAN_MISJUDGE: '配送方案误判',
      THIRD_PARTY: '第三方（吊装公司）责任',
    }[c];
  }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DeliveryBlock,
      Delivery,
      Order,
      Item,
      Consignment,
      Ticket,
      TicketMessage,
    ]),
  ],
  controllers: [DeliveryBlockController],
})
export class DeliveryBlockModule {}
