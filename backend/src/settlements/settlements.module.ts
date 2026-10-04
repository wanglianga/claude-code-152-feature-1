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
import {
  DeliveryReschedule,
  DeliveryReschedulePlan,
} from '../entities/delivery-reschedule.entity';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard, Roles } from '../auth/roles.guard';

const STORAGE_DAILY_RATE = 3; // 仓储费 3 元/天
const money = (n: number) => n.toFixed(2);

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

      // ---- 配送改约（家具进不了电梯/楼道）带来的费用与责任分流 ----
      const rs = await m.findOne(DeliveryReschedule, {
        where: { orderId: order.id },
      });
      const rsPlans = rs
        ? await m.find(DeliveryReschedulePlan, {
            where: { rescheduleId: rs.id },
            order: { createdAt: 'ASC' },
          })
        : [];
      let rsBuyerCharges = 0; // 买家承担的改约费用（平台收入/冲抵退款）
      let rsPlatformCosts = 0; // 平台吸收的改约损失
      let rsThirdPartyComp = 0; // 吊装公司赔付
      const rsEntries: {
        type: any;
        amount: number;
        source: string;
        ref: string | null;
      }[] = [];
      const r2 = (n: number) => Math.round(n * 100) / 100;
      if (rs) {
        if (returned) {
          const freight = Number(rs.returnFreight);
          const restock = Number(rs.restockingFee);
          if (freight > 0) {
            rsEntries.push({
              type: 'RESCHEDULE_FEE',
              amount: -freight,
              source: `退货回程运费 ¥${freight}（来源：改约单回库登记；电梯受阻退货，平台吸收）`,
              ref: rs.id,
            });
            rsPlatformCosts += freight;
          }
          if (restock > 0) {
            rsEntries.push({
              type: 'RESCHEDULE_FEE',
              amount: -restock,
              source: `回库复检/入库费 ¥${restock}（来源：改约单回库登记，平台吸收）`,
              ref: rs.id,
            });
            rsPlatformCosts += restock;
          }
        } else {
          // 送达完结：买家选定且成功的方案费用（拆装加价 / 吊装费 / 改地址二次配送费）
          const okPlan = rsPlans.find(
            (p) =>
              p.status === 'SUCCESS' &&
              ['DISASSEMBLY', 'HOISTING', 'CHANGE_ADDRESS'].includes(p.plan),
          );
          if (okPlan) {
            const fee = Number(okPlan.quotedFee);
            if (fee > 0) {
              const labelMap: Record<string, string> = {
                DISASSEMBLY: '现场拆装上楼人力加价',
                HOISTING: '吊装作业费（已完成吊装公司/物业许可/天气/保险四项确认）',
                CHANGE_ADDRESS: '改送新地址二次配送费',
              };
              const planMap: Record<string, string> = {
                DISASSEMBLY: '拆装上楼',
                HOISTING: '吊装',
                CHANGE_ADDRESS: '改送其他地址',
              };
              rsEntries.push({
                type: 'RESCHEDULE_FEE',
                amount: fee,
                source: `${labelMap[okPlan.plan]} ¥${fee}（来源：配送改约单，买家选择「${planMap[okPlan.plan]}」方案）`,
                ref: rs.id,
              });
              rsBuyerCharges += fee;
            }
          }
        }
        // 吊装失败的已发生费用按三类定责（送达/退货场景都可能先经历失败再改方案）
        for (const p of rsPlans.filter(
          (p) => p.plan === 'HOISTING' && p.status === 'FAILED',
        )) {
          const cost = Number(p.failureCost);
          const comp = Number(p.thirdPartyCompensation);
          if (p.failureLiability === 'BUYER_ENVIRONMENT') {
            rsEntries.push({
              type: 'RESCHEDULE_FEE',
              amount: cost,
              source: `吊装失败（买家环境限制：${p.failureNote || '锚点/窗型/物业等现场条件不具备'}）已发生费用 ¥${cost}，由买家承担（来源：改约单吊装失败定责）`,
              ref: rs.id,
            });
            rsBuyerCharges += cost;
          } else if (p.failureLiability === 'PLAN_MISJUDGMENT') {
            rsEntries.push({
              type: 'RESCHEDULE_FEE',
              amount: -cost,
              source: `吊装失败（配送方案误判：${p.failureNote || '勘测/选案错误'}）已发生费用 ¥${cost}，平台吸收（来源：改约单吊装失败定责）`,
              ref: rs.id,
            });
            rsPlatformCosts += cost;
          } else if (p.failureLiability === 'THIRD_PARTY') {
            rsEntries.push({
              type: 'RESCHEDULE_FEE',
              amount: -cost,
              source: `吊装失败（第三方责任：${p.failureNote || '吊装公司操作/设备问题'}）作业进场费 ¥${cost}，平台先行承担`,
              ref: rs.id,
            });
            rsEntries.push({
              type: 'THIRD_PARTY_COMPENSATION',
              amount: comp,
              source: `吊装公司认赔 ¥${comp}（来源：改约单第三方责任赔付，冲抵平台损失）`,
              ref: rs.id,
            });
            rsPlatformCosts += cost;
            rsThirdPartyComp += comp;
          }
        }
      }
      const rsDelta = r2(rsBuyerCharges + rsThirdPartyComp - rsPlatformCosts);

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
        // 退货：买家全额退款，卖家应得为 0；翻新/仓储/配送成本由平台吸收（工单另有赔付约定从其约定）
        add(
          'COMPENSATION',
          deal,
          `退货退款：订单 ${order.code} 成交款全额退还买家（来源：退货工单裁定）`,
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
        platformIncome = -(
          r2(refurb + storageFee + deliveryFee) -
          rsBuyerCharges -
          rsThirdPartyComp +
          rsPlatformCosts
        );
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
        sellerPayout = Math.max(
          0,
          Math.round((deal - commission - refurb - storageFee - sellerBorne) * 100) / 100,
        );
        platformIncome =
          r2(commission + deliveryFee - platformBorne) + rsDelta;
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

      rsEntries.forEach((e) => add(e.type, e.amount, e.source, e.ref));

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
      DeliveryReschedule,
      DeliveryReschedulePlan,
    ]),
  ],
  controllers: [SettlementController],
})
export class SettlementModule {}
