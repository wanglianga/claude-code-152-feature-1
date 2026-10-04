import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Controller,
  Get,
  Post,
  Param,
  UseGuards,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Settlement, SettlementEntry } from '../entities/settlement.entity';
import { Order } from '../entities/order.entity';
import { Item } from '../entities/item.entity';
import { Appraisal } from '../entities/appraisal.entity';
import { Ticket } from '../entities/ticket.entity';
import { Consignment } from '../entities/consignment.entity';
import { DeliveryBlock } from '../entities/delivery-block.entity';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard, Roles } from '../auth/roles.guard';

const STORAGE_DAILY_RATE = 3; // 仓储费 3 元/天
const money = (n: number) => n.toFixed(2);

const OPTION_LABEL: Record<string, string> = {
  DISASSEMBLY: '拆装上楼',
  HOIST: '吊装上楼',
  CHANGE_ADDRESS: '改送其他地址',
  RETURN: '退货',
};

const HOIST_CAUSE_LABEL: Record<string, string> = {
  BUYER_ENVIRONMENT: '买家环境限制',
  PLAN_MISJUDGE: '配送方案误判',
  THIRD_PARTY: '第三方（吊装公司）责任',
};

/**
 * 结算：成交价、佣金、翻新费、仓储费、配送费、售后赔付逐项列明来源。
 * 卖家应得 = 成交价 - 佣金 - 翻新费 - 仓储费 - 卖家责任赔付
 * 平台净收入 = 佣金 + 配送费 - 平台责任赔付（退货时翻新仓储由平台吸收）
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('settlements')
export class SettlementController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Roles('CS', 'OPS', 'ADMIN')
  @Get()
  async list() {
    const settlements = await this.ds.getRepository(Settlement).find({
      order: { createdAt: 'DESC' },
    });
    return settlements;
  }

  @Get('order/:orderId')
  async byOrder(@Param('orderId') orderId: string) {
    const settlement = await this.ds.getRepository(Settlement).findOne({
      where: { orderId },
    });
    if (!settlement) throw new NotFoundException('该订单尚未结算');
    const entries = await this.ds.getRepository(SettlementEntry).find({
      where: { settlementId: settlement.id },
      order: { createdAt: 'ASC' },
    });
    return { settlement, entries };
  }

  /** 客服/运营在送达或退货完结后生成结算单（幂等：每单仅一张） */
  @Roles('CS', 'OPS', 'ADMIN')
  @Post('order/:orderId/generate')
  async generate(@Param('orderId') orderId: string) {
    return this.ds.transaction(async (m) => {
      const existing = await m.findOne(Settlement, { where: { orderId } });
      if (existing) {
        throw new BadRequestException('该订单已生成结算单');
      }
      const order = await m.findOne(Order, { where: { id: orderId } });
      if (!order) throw new NotFoundException('订单不存在');
      if (!['DELIVERED', 'RETURNED'].includes(order.status)) {
        throw new BadRequestException(
          `订单当前 ${order.status}，需送达或退货完结后方可结算`,
        );
      }
      const item = await m.findOne(Item, { where: { id: order.itemId } });
      const appraisal = await m.findOne(Appraisal, {
        where: { consignmentId: order.consignmentId },
      });
      const consignment = await m.findOne(Consignment, {
        where: { id: order.consignmentId },
      });
      if (!item || !consignment) {
        throw new NotFoundException('商品/寄卖信息缺失');
      }

      const rate = Number(appraisal?.commissionRate || 0.15);
      const deal = Number(order.dealPrice);
      const returned = order.status === 'RETURNED';
      const refurb = Number(item.cleaningCost) + Number(item.refurbishCost);

      let storageDays = 0;
      if (item.enteredWarehouseAt) {
        storageDays = Math.max(
          0,
          Math.floor(
            (Date.now() - new Date(item.enteredWarehouseAt).getTime()) /
              86400000,
          ),
        );
      }
      const storageFee = item.location === 'WAREHOUSE' ? storageDays * STORAGE_DAILY_RATE : 0;
      const deliveryFee = Number(order.deliveryFee);

      // 已裁定的售后赔付按责任方分流
      const tickets = await m.find(Ticket, {
        where: { orderId: order.id },
      });
      const resolved = tickets.filter(
        (t) =>
          t.status === 'RESOLVED' && Number(t.compensationAmount) > 0,
      );
      const sellerBorne = resolved
        .filter((t) => t.liableParty === 'SELLER')
        .reduce((s, t) => s + Number(t.compensationAmount), 0);
      const platformBorne = resolved
        .filter((t) =>
          ['PLATFORM', 'DELIVERY', 'REFURBISHER'].includes(t.liableParty),
        )
        .reduce((s, t) => s + Number(t.compensationAmount), 0);

      // 大件进不了电梯的配送改约单（可能含拆装/吊装/改址附加费与吊装失败责任分担）
      const block = await m.findOne(DeliveryBlock, {
        where: { orderId: order.id },
      });
      const surcharge = Number(order.surchargeFee || 0);
      const buyerBorneOnReturn = block ? Number(block.buyerBorneOnReturn || 0) : 0;
      const thirdPartyClaim = block ? Number(block.thirdPartyClaimAmount || 0) : 0;
      const failedHoistCost =
        block && block.hoistStatus === 'FAILED' ? Number(block.hoistQuote || 0) : 0;

      const entries: Partial<SettlementEntry>[] = [];
      const add = (
        type: any,
        amount: number,
        source: string,
        sourceRefId: string | null = null,
      ) =>
        entries.push({ type, amount: money(amount), source, sourceRefId });

      add(
        'DEAL_PRICE',
        deal,
        `订单 ${order.code} 成交价（来源：下单成交价，估价寄卖价 ${appraisal?.consignmentPrice}，底价 ${appraisal?.minDealPrice}）`,
        order.id,
      );

      let sellerPayout = 0;
      let platformIncome = 0;

      if (returned) {
        // 退货：买家全额退款（买家环境限制导致吊装失败的已发生吊装费除外），卖家应得为 0；
        // 翻新/仓储/配送/失败吊装成本按吊装失败归因由平台吸收或向第三方追偿/由买家承担。
        const netRefund = Math.round((deal - buyerBorneOnReturn) * 100) / 100;
        add(
          'COMPENSATION',
          netRefund,
          buyerBorneOnReturn > 0
            ? `退货退款：订单 ${order.code} 成交款 ¥${money(deal)}，扣除买家环境限制导致吊装失败的已发生吊装费 ¥${money(buyerBorneOnReturn)}，实际退还买家 ¥${money(netRefund)}`
            : `退货退款：订单 ${order.code} 成交款全额退还买家（来源：退货/配送改约单）`,
          block?.id || null,
        );
        if (refurb > 0) {
          add(
            'REFURBISH_FEE',
            refurb,
            `清洁 ¥${item.cleaningCost} + 翻新 ¥${item.refurbishCost}（来源：商品作业记录；退货由平台吸收）`,
          );
        }
        if (storageFee > 0) {
          add(
            'STORAGE_FEE',
            storageFee,
            `库位 ${item.warehouseSlot || '-'} 入仓 ${storageDays} 天 × ¥${STORAGE_DAILY_RATE}/天（来源：入库时间；退货由平台吸收）`,
          );
        }
        if (deliveryFee > 0) {
          add(
            'DELIVERY_FEE',
            deliveryFee,
            `配送费（来源：楼层/电梯/旧家具搬出计价；退货返程由平台承担）`,
          );
        }
        let returnCost = refurb + storageFee + deliveryFee;
        if (failedHoistCost > 0) {
          const cause = block?.hoistFailCause;
          if (cause === 'THIRD_PARTY') {
            add(
              'RESCHEDULE_FEE',
              failedHoistCost,
              `吊装失败：平台先行垫付吊装费 ¥${money(failedHoistCost)}（吊装公司「${block?.hoistCompany}」责任），见第三方追偿条目冲抵`,
              block?.id || null,
            );
            if (thirdPartyClaim > 0) {
              add(
                'THIRD_PARTY_CLAIM',
                thirdPartyClaim,
                `第三方追偿：吊装失败归因【${HOIST_CAUSE_LABEL['THIRD_PARTY']}】，平台向吊装公司「${block?.hoistCompany}」追偿 ¥${money(thirdPartyClaim)}（来源：配送改约单 ${block?.code}）`,
                block?.id || null,
              );
            }
          } else if (cause === 'PLAN_MISJUDGE') {
            add(
              'RESCHEDULE_FEE',
              failedHoistCost,
              `吊装失败：归因【${HOIST_CAUSE_LABEL['PLAN_MISJUDGE']}】，吊装费 ¥${money(failedHoistCost)} 由平台吸收，不向买家收取`,
              block?.id || null,
            );
          } else {
            add(
              'RESCHEDULE_FEE',
              failedHoistCost,
              `吊装失败：归因【${HOIST_CAUSE_LABEL['BUYER_ENVIRONMENT']}】，已发生吊装费 ¥${money(failedHoistCost)} 由买家承担（退货时从退款扣除，冲抵平台垫付）`,
              block?.id || null,
            );
          }
          returnCost += failedHoistCost;
        }
        platformIncome = Math.round(
          (-returnCost + thirdPartyClaim + buyerBorneOnReturn) * 100,
        ) / 100;
      } else {
        const commission = Math.round(deal * rate * 100) / 100;
        add(
          'COMMISSION',
          commission,
          `平台佣金 = 成交价 ¥${money(deal)} × ${(rate * 100).toFixed(1)}%（来源：估价师估价单）`,
          appraisal?.id || null,
        );
        if (refurb > 0) {
          add(
            'REFURBISH_FEE',
            refurb,
            `清洁费 ¥${item.cleaningCost} + 翻新费 ¥${item.refurbishCost}（来源：仓库/翻新师作业记录，从卖家应得扣除）`,
          );
        }
        if (storageFee > 0) {
          add(
            'STORAGE_FEE',
            storageFee,
            `库位 ${item.warehouseSlot || '-'} 存放 ${storageDays} 天 × ¥${STORAGE_DAILY_RATE}/天（来源：入库时间戳）`,
          );
        }
        if (deliveryFee > 0) {
          add(
            'DELIVERY_FEE',
            deliveryFee,
            `配送费（来源：基础 ¥60 + 无电梯楼层 ¥15/层 + 旧家具搬出 ¥80）`,
          );
        }
        if (surcharge > 0 && block) {
          add(
            'RESCHEDULE_FEE',
            surcharge,
            `配送改约附加费（大件原无法上楼）：方案【${OPTION_LABEL[block.buyerOption || ''] || block.buyerOption}】` +
              (block.buyerOption === 'HOIST'
                ? `吊装公司「${block.hoistCompany}」吊装费`
                : block.buyerOption === 'DISASSEMBLY'
                  ? '现场拆装+人工加价'
                  : '改送他址转运费') +
              ` ¥${money(surcharge)}（来源：配送改约单 ${block.code}，在原配送费之外向买家收取）`,
            block.id,
          );
        }
        sellerPayout = Math.max(
          0,
          Math.round((deal - commission - refurb - storageFee - sellerBorne) * 100) / 100,
        );
        platformIncome =
          Math.round((commission + deliveryFee + surcharge - platformBorne) * 100) / 100;
      }

      resolved.forEach((t) => {
        add(
          'COMPENSATION',
          Number(t.compensationAmount),
          `售后赔付：工单「${t.title}」责任方 ${t.liableParty}（${
            t.liableParty === 'SELLER'
              ? '从卖家应得扣除，赔付买家'
              : '平台支付，计入平台支出'
          }）`,
          t.id,
        );
      });

      add(
        'SELLER_PAYOUT',
        sellerPayout,
        returned
          ? '退货完结：卖家应得 ¥0'
          : `卖家最终应得 = 成交价 - 佣金 - 翻新费 - 仓储费 - 卖家责任赔付`,
      );

      const settlement = await m.save(
        m.create(Settlement, {
          orderId: order.id,
          consignmentId: order.consignmentId,
          sellerId: order.sellerId,
          sellerPayout: money(sellerPayout),
          platformIncome: money(platformIncome),
        }),
      );
      for (const e of entries) {
        await m.save(
          m.create(SettlementEntry, { settlementId: settlement.id, ...e }),
        );
      }
      if (order.status === 'DELIVERED') {
        order.status = 'SETTLED';
        await m.save(order);
      }

      const fullEntries = await m.find(SettlementEntry, {
        where: { settlementId: settlement.id },
        order: { createdAt: 'ASC' },
      });
      return { settlement, entries: fullEntries };
    });
  }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Settlement,
      SettlementEntry,
      Order,
      Item,
      Appraisal,
      Ticket,
      Consignment,
      DeliveryBlock,
    ]),
  ],
  controllers: [SettlementController],
})
export class SettlementModule {}
