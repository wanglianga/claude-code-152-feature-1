import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Item } from '../entities/item.entity';
import { Order } from '../entities/order.entity';
import { Delivery } from '../entities/delivery.entity';
import { Ticket } from '../entities/ticket.entity';
import { DeliveryBlock } from '../entities/delivery-block.entity';
import { SellerProfile } from '../entities/seller-profile.entity';
import { User } from '../entities/user.entity';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard, Roles } from '../auth/roles.guard';

const CATEGORY_LABELS: Record<string, string> = {
  SOFA: '沙发',
  DINING_TABLE: '餐桌',
  KIDS_BED: '儿童床',
  BOOKCASE: '书柜',
  OFFICE_CHAIR: '办公椅',
  APPLIANCE_CABINET: '家电柜',
};

const CATEGORIES = Object.keys(CATEGORY_LABELS);

/**
 * 运营分析：按品类沉淀成交周期、翻新投入、退货原因与配送失败率，
 * 判断哪些商品适合入仓寄卖、哪些只适合同城自提；并输出卖家风险画像列表。
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Roles('OPS', 'ADMIN', 'CS')
  @Get('by-category')
  async byCategory() {
    const items = await this.ds.getRepository(Item).find();
    const orders = await this.ds.getRepository(Order).find();
    const deliveries = await this.ds.getRepository(Delivery).find();
    const tickets = await this.ds.getRepository(Ticket).find();

    const itemMap = new Map(items.map((i) => [i.id, i]));
    const orderById = new Map(orders.map((o) => [o.id, o]));

    const result = CATEGORIES.map((category) => {
      const catItems = items.filter((i) => i.category === category);
      const catItemIds = new Set(catItems.map((i) => i.id));
      const catOrders = orders.filter((o) => catItemIds.has(o.itemId));
      const catOrderIds = new Set(catOrders.map((o) => o.id));
      const catDeliveries = deliveries.filter((d) => catOrderIds.has(d.orderId));
      const catTickets = tickets.filter((t) => {
        const it = t.itemId ? itemMap.get(t.itemId) : null;
        return it?.category === category;
      });

      const listed = catItems.filter((i) => i.listedAt).length;
      const sold = catItems.filter((i) =>
        ['SOLD', 'DELIVERED', 'RETURNED'].includes(i.status),
      ).length;
      const returnedOrders = catOrders.filter((o) => o.status === 'RETURNED');

      // 成交周期：上架时间 -> 下单时间（天）
      const cycles: number[] = [];
      catOrders.forEach((o) => {
        const it = itemMap.get(o.itemId);
        if (it?.listedAt) {
          cycles.push(
            Math.max(
              0,
              (new Date(o.createdAt).getTime() -
                new Date(it.listedAt).getTime()) /
                86400000,
            ),
          );
        }
      });
      const avgCycle = cycles.length
        ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 10) / 10
        : null;

      // 翻新投入：已成交商品的清洁+翻新均值，以及占均价比
      const refurbCosts = catItems.map(
        (i) => Number(i.cleaningCost) + Number(i.refurbishCost),
      );
      const totalRefurb = refurbCosts.reduce((a, b) => a + b, 0);
      const avgRefurb = sold
        ? Math.round((totalRefurb / Math.max(1, catItems.length)) * 100) / 100
        : 0;
      const dealPrices = catOrders
        .filter((o) => o.status !== 'RETURNED')
        .map((o) => Number(o.dealPrice));
      const avgDealPrice = dealPrices.length
        ? Math.round(dealPrices.reduce((a, b) => a + b, 0) / dealPrices.length)
        : 0;
      const refurbRatio = avgDealPrice
        ? Math.round((avgRefurb / avgDealPrice) * 1000) / 10
        : 0;

      // 退货原因：退货退款工单按工单类型聚类
      const returnReasons: Record<string, number> = {};
      catTickets
        .filter((t) => t.resolution === 'RETURN_REFUND')
        .forEach((t) => {
          returnReasons[t.type] = (returnReasons[t.type] || 0) + 1;
        });

      // 配送失败率
      const failed = catDeliveries.filter((d) => d.status === 'FAILED');
      const failRate = catDeliveries.length
        ? Math.round((failed.length / catDeliveries.length) * 1000) / 10
        : 0;
      const failReasons: Record<string, number> = {};
      failed.forEach((d) => {
        failReasons[d.failReason] = (failReasons[d.failReason] || 0) + 1;
      });

      const returnRate = catOrders.length
        ? Math.round((returnedOrders.length / catOrders.length) * 1000) / 10
        : 0;

      // 入仓 vs 自提建议：失败率>25% 或电梯/楼道受阻占比高 → 建议同城自提为主；
      // 翻新投入占比低、周期短、退货少 → 适合入仓寄卖
      const elevatorBlocks =
        (failReasons['ELEVATOR_TOO_SMALL'] || 0) +
        (failReasons['STAIR_TOO_NARROW'] || 0) +
        (failReasons['HOIST_FAILED'] || 0);
      let channelAdvice: string;
      if (failRate >= 25 || elevatorBlocks >= Math.max(1, failed.length / 2)) {
        channelAdvice = '建议同城自提为主（配送失败率高/大件进梯困难），可提供付费拆装搬运';
      } else if (avgCycle != null && avgCycle <= 7 && refurbRatio <= 12 && returnRate <= 15) {
        channelAdvice = '适合入仓寄卖（周转快、翻新投入低、退货少）';
      } else {
        channelAdvice = '可入仓但需控制翻新预算，按单评估配送范围';
      }

      return {
        category,
        categoryLabel: CATEGORY_LABELS[category],
        listedCount: listed,
        soldCount: sold,
        avgCycleDays: avgCycle,
        avgRefurbishCost: avgRefurb,
        avgDealPrice,
        refurbishCostRatioPct: refurbRatio,
        returnCount: returnedOrders.length,
        returnRatePct: returnRate,
        returnReasons,
        deliveryTotal: catDeliveries.length,
        deliveryFailed: failed.length,
        deliveryFailRatePct: failRate,
        deliveryFailReasons: failReasons,
        channelAdvice,
      }
    });

    return { categories: result, generatedAt: new Date() };
  }

  /**
   * 大件进不了电梯·配送改约看板：
   * 统计买家方案分布、吊装成功率与失败三归因、退货回库与二次上架比例、附加费规模。
   */
  @Roles('OPS', 'ADMIN', 'CS')
  @Get('delivery-blocks')
  async deliveryBlocks() {
    const blocks = await this.ds.getRepository(DeliveryBlock).find();
    const items = await this.ds.getRepository(Item).find();
    const itemMap = new Map(items.map((i) => [i.id, i]));

    const total = blocks.length;
    const count = (pred: (b: DeliveryBlock) => boolean) =>
      blocks.filter(pred).length;

    const byOption: Record<string, number> = {};
    blocks.forEach((b) => {
      if (b.buyerOption) byOption[b.buyerOption] = (byOption[b.buyerOption] || 0) + 1;
    });

    const hoistChosen = count((b) => b.buyerOption === 'HOIST');
    const hoistSuccess = count((b) => b.hoistStatus === 'SUCCESS');
    const hoistFailed = count((b) => b.hoistStatus === 'FAILED');
    const hoistFailCauses: Record<string, number> = {};
    blocks
      .filter((b) => b.hoistStatus === 'FAILED' && b.hoistFailCause)
      .forEach((b) => {
        hoistFailCauses[b.hoistFailCause!] = (hoistFailCauses[b.hoistFailCause!] || 0) + 1;
      });

    const returned = count((b) => b.buyerOption === 'RETURN');
    const relisted = count((b) => b.relistDecision === 'RELIST');
    const noRelist = count((b) => b.relistDecision === 'NO_RELIST');
    const surchargeSum = blocks.reduce(
      (s, b) => s + (b.status === 'DELIVERED' ? Number(b.optionFee || 0) : 0),
      0,
    );
    const claimSum = blocks.reduce(
      (s, b) => s + Number(b.thirdPartyClaimAmount || 0),
      0,
    );

    // 哪些品类最常发生「进不了电梯」改约
    const byCategory: Record<string, number> = {};
    blocks.forEach((b) => {
      const cat = itemMap.get(b.itemId)?.category || 'UNKNOWN';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    });

    return {
      total,
      byOption,
      hoistChosen,
      hoistSuccess,
      hoistFailed,
      hoistSuccessRatePct:
        hoistChosen ? Math.round((hoistSuccess / hoistChosen) * 1000) / 10 : 0,
      hoistFailCauses,
      returnCount: returned,
      returnRelistCount: relisted,
      returnNoRelistCount: noRelist,
      relistRatePct:
        relisted + noRelist
          ? Math.round((relisted / (relisted + noRelist)) * 1000) / 10
          : 0,
      deliveredSurchargeTotal: Math.round(surchargeSum * 100) / 100,
      thirdPartyClaimTotal: Math.round(claimSum * 100) / 100,
      byCategory,
    };
  }

  @Roles('OPS', 'ADMIN', 'CS', 'APPRAISER')
  @Get('seller-profiles')
  async sellerProfiles() {
    const profiles = await this.ds.getRepository(SellerProfile).find({
      order: { riskScore: 'DESC' },
    });
    const users = profiles.length
      ? await this.ds.getRepository(User).find({
          where: { id: In(profiles.map((p) => p.sellerId)) },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));
    return profiles.map((p) => ({
      ...p,
      sellerName: userMap.get(p.sellerId)?.name || '-',
      username: userMap.get(p.sellerId)?.username || '-',
    }));
  }

  @Roles('OPS', 'ADMIN', 'CS', 'APPRAISER')
  @Get('seller-profiles/:sellerId')
  async sellerProfile(@Param('sellerId') sellerId: string) {
    const profile = await this.ds
      .getRepository(SellerProfile)
      .findOne({ where: { sellerId } });
    if (!profile) {
      return {
        sellerId,
        backtrackCount: 0,
        mismatchCount: 0,
        disputeCount: 0,
        completedCount: 0,
        riskScore: '0',
        verificationLevel: 'NORMAL',
        riskNote: '新卖家，暂无历史记录',
      };
    }
    return profile;
  }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Item,
      Order,
      Delivery,
      Ticket,
      DeliveryBlock,
      SellerProfile,
      User,
    ]),
  ],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
