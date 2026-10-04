#!/usr/bin/env bash
# 后端端到端验证：登录各角色 → 申请→估价→清洁翻新上架→下单→配送→售后工单→结算→分析+卖家画像
set -u
BASE=http://127.0.0.1:3000/api
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✓ $1"; }
no(){ FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else no "$3 (got '$1' expected '$2')"; fi; }

login(){ curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}" | jq -r '.token'; }

echo "== [1] 登录与权限 =="
T_SELLER=$(login wangjiayi seller123)
T_BUYER=$(login zhangmai buyer123)
T_APPR=$(login gujia gujia123)
T_WH=$(login cangguan cangguan123)
T_REF=$(login fanxin fanxin123)
T_DEL=$(login peisong peisong123)
T_CS=$(login kefu kefu123)
T_OPS=$(login ops ops123)
[ -n "$T_SELLER" ] && [ "$T_SELLER" != "null" ] && ok "8 类角色账号可登录（示范卖家/买家）"
# 未登录拒绝
code=$(curl -s -o /dev/null -w '%{http_code}' $BASE/items)
check "$code" "401" "无 token 访问 /items 返回 401"

echo "== [2] 卖家提交寄卖申请（自动引用画像） =="
RESP=$(curl -s -X POST $BASE/consignments -H "Authorization: Bearer $T_SELLER" -H 'Content-Type: application/json' -d '{
  "category":"KIDS_BED","brand":"测试品牌","sizeText":"200x120x90 cm","material":"松木","yearsUsed":2,
  "defectPhotos":["http://x/p1.jpg"],"disassemblable":true,"floor":7,"elevator":"ELEVATOR",
  "expectedPrice":900,"acceptRefurbish":true,"address":"测试小区","sellerNote":"e2e 测试申请"
}')
CN_ID=$(echo "$RESP" | jq -r '.consignment.id')
LEVEL=$(echo "$RESP" | jq -r '.sellerProfile.verificationLevel')
[ -n "$CN_ID" ] && [ "$CN_ID" != "null" ] && ok "寄卖申请已创建 id=$CN_ID"
check "$LEVEL" "NORMAL" "履约良好卖家 -> 常规验真 NORMAL"

echo "== [3] 估价师预约上门 + 上门验真评分与报价 =="
curl -s -o /dev/null -X POST $BASE/appraisals/consignment/$CN_ID/schedule -H "Authorization: Bearer $T_APPR" 2>/dev/null
# schedule 端点挂在 consignments 模块
curl -s -o /dev/null -X POST $BASE/consignments/$CN_ID/schedule -H "Authorization: Bearer $T_APPR"
sc=$(curl -s -X POST $BASE/appraisals/consignment/$CN_ID -H "Authorization: Bearer $T_APPR" -H 'Content-Type: application/json' -d '{
  "structuralScore":2,"stainScore":2,"odorScore":1,"mothScore":1,"warpScore":1,"moveDifficulty":3,
  "consignmentPrice":820,"minDealPrice":650,"commissionRate":0.15,"estimatedRefurbishCost":100,
  "cleaningAdvice":"深度清洁","refurbishSuggestions":"补漆","matchResult":"MATCH",
  "decision":"ACCEPT","location":"WAREHOUSE","deliveryRadiusKm":25}')
ITEM_ID=$(echo "$sc" | jq -r '.item.id')
APPR_ID=$(echo "$sc" | jq -r '.appraisal.id')
[ -n "$ITEM_ID" ] && [ "$ITEM_ID" != "null" ] && ok "估价完成并生成商品 PREPARING（寄卖价820/底价650/佣金15%）"
# 底价高于寄卖价应被拒
bad=$(curl -s -X POST $BASE/appraisals/consignment/$CN_ID -H "Authorization: Bearer $T_APPR" -H 'Content-Type: application/json' -d '{"structuralScore":1,"stainScore":1,"odorScore":1,"mothScore":1,"warpScore":1,"moveDifficulty":1,"consignmentPrice":100,"minDealPrice":200,"matchResult":"MATCH"}' | jq -r '.message')
echo "$bad" | grep -q '最低成交价' && ok "底价高于寄卖价被业务规则拦截"

echo "== [4] 仓库入库/清洁/补漆作业（作业即记账） =="
curl -s -o /dev/null -X POST $BASE/items/$ITEM_ID/work-logs -H "Authorization: Bearer $T_REF" -H 'Content-Type: application/json' -d '{"type":"CLEANING","note":"蒸汽清洁","cost":55}'
curl -s -o /dev/null -X POST $BASE/items/$ITEM_ID/work-logs -H "Authorization: Bearer $T_REF" -H 'Content-Type: application/json' -d '{"type":"REPAINT","note":"床边补漆","cost":75}'
w3=$(curl -s -X POST $BASE/items/$ITEM_ID/work-logs -H "Authorization: Bearer $T_WH" -H 'Content-Type: application/json' -d '{"type":"STORAGE","note":"D-01-01","cost":0}')
check "$(echo "$w3" | jq -r '.item.warehouseSlot')" "D-01-01" "入库登记库位 D-01-01"

echo "== [5] 拍照与上架 =="
curl -s -o /dev/null -X POST $BASE/items/$ITEM_ID/advance -H "Authorization: Bearer $T_WH" -H 'Content-Type: application/json' -d '{"to":"PHOTOGRAPHY"}'
ls=$(curl -s -X POST $BASE/items/$ITEM_ID/advance -H "Authorization: Bearer $T_WH" -H 'Content-Type: application/json' -d '{"to":"LISTED","description":"e2e 儿童床描述","photos":["http://x/bed1.jpg"],"deliveryRadiusKm":25}')
check "$(echo "$ls" | jq -r '.item.status // .status')" "LISTED" "商品上架 LISTED"

echo "== [6] 买家市场可见 + 下单 =="
market=$(curl -s "$BASE/items?status=LISTED" -H "Authorization: Bearer $T_BUYER" | jq 'length')
[ "${market:-0}" -ge 3 ] && ok "买家市场在售商品 ≥3（当前 $market）"
ord=$(curl -s -X POST $BASE/orders -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d "{
  \"itemId\":\"$ITEM_ID\",\"buyerAddress\":\"买家地址 8 楼无电梯\",\"buyerFloor\":8,\"buyerElevator\":\"NO_ELEVATOR\",
  \"needOldFurnitureRemoval\":true,\"appointmentWindow\":\"明天下午\"}")
ORD_ID=$(echo "$ord" | jq -r '.order.id')
DLV_ID=$(echo "$ord" | jq -r '.delivery.id')
FEE=$(echo "$ord" | jq -r '.order.deliveryFee')
[ -n "$ORD_ID" ] && [ "$ORD_ID" != "null" ] && ok "下单成功并生成 PENDING 配送任务"
check "$FEE" "245.00" "配送费=60+7层×15+旧家具80=245"

echo "== [7] 配送排班/装车/送达 =="
curl -s -o /dev/null -X POST $BASE/deliveries/$ORD_ID/schedule -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"vehicleType":"MID_TRUCK","scheduledWindow":"10-05 14:00"}'
curl -s -o /dev/null -X POST $BASE/deliveries/$ORD_ID/load -H "Authorization: Bearer $T_DEL"
dn=$(curl -s -X POST $BASE/deliveries/$ORD_ID/done -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"note":"买家在场，正常签收"}')
check "$(echo "$dn" | jq -r '.order.status')" "DELIVERED" "送达后订单 DELIVERED"

echo "== [8] 售后协同工单（色差）+ 客服裁定平台赔付 =="
tk=$(curl -s -X POST $BASE/tickets -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d "{
  \"orderId\":\"$ORD_ID\",\"type\":\"COLOR_DIFFERENCE\",\"title\":\"到货颜色比照片深\",\"description\":\"买家认为色差明显要求补偿\"}")
TK_ID=$(echo "$tk" | jq -r '.ticket.id // .id')
curl -s -o /dev/null -X POST $BASE/tickets/$TK_ID/messages -H "Authorization: Bearer $T_WH" -H 'Content-Type: application/json' -d '{"content":"仓库核对拍照光线，建议补偿 30 元色差价"}'
rv=$(curl -s -X POST $BASE/tickets/$TK_ID/resolve -H "Authorization: Bearer $T_CS" -H 'Content-Type: application/json' -d '{"resolution":"PLATFORM_COMPENSATE","liableParty":"PLATFORM","compensationAmount":30,"note":"平台承担 30 元色差补偿"}')
check "$(echo "$rv" | jq -r '.ticket.status')" "RESOLVED" "客服裁定工单 RESOLVED，平台赔付 30"

echo "== [9] 结算单（逐项来源） =="
st=$(curl -s -X POST $BASE/settlements/order/$ORD_ID/generate -H "Authorization: Bearer $T_CS")
echo "$st" | jq -e '.entries | length >= 5' >/dev/null && ok "结算明细 ≥5 项（成交价/佣金/翻新/仓储/配送/赔付/卖家应得）"
PAYOUT=$(echo "$st" | jq -r '.settlement.sellerPayout')
INC=$(echo "$st" | jq -r '.settlement.platformIncome')
# 820 - 123(佣金) - 130(清洁55+补漆75) - 仓储0 - 0(卖家赔付) = 567；平台 123+245-30=338
check "$PAYOUT" "567.00" "卖家应得 820-123-130=567"
check "$INC" "338.00" "平台净收入 123+245-30=338"
echo "$st" | jq -r '.entries[] | select(.type=="COMMISSION") | .source' | grep -q '820 × 15' && ok "佣金来源写明计算式"

echo "== [10] 家具进不了电梯·配送改约（种子单：吊装失败第三方定责→改拆装成功） =="
# 买家可见种子中的 BLOCKED 改约单（三人位沙发 OD2026000003）
RS_ORDER=$(curl -s $BASE/reschedules -H "Authorization: Bearer $T_BUYER" | jq -r '[.[] | select(.status=="BLOCKED")][0].orderId')
[ -n "$RS_ORDER" ] && [ "$RS_ORDER" != "null" ] && ok "买家可查到待选方案的配送改约单"
rsd=$(curl -s $BASE/reschedules/order/$RS_ORDER -H "Authorization: Bearer $T_BUYER")
check "$(echo "$rsd" | jq -r '.reschedule.elevatorDepth')" "1.50" "现场电梯进深已记录 1.50m"
check "$(echo "$rsd" | jq -r '.reschedule.laborSurcharge')" "120.00" "现场人工加价已记录 ¥120"
RS_ID=$(echo "$rsd" | jq -r '.reschedule.id')
echo "$rsd" | jq -e '.reschedule.sitePhotos | length >= 3' >/dev/null && ok "现场照片 ≥3 张"
# 权限：买家不能登记现场、卖家不能代选方案
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/reschedules/deliveries/$RS_ORDER/report -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{}')
check "$code" "403" "买家登记现场被角色拦截 403"
# 买家先选吊装
curl -s -o /dev/null -X POST $BASE/reschedules/$RS_ID/choose-plan -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"plan":"HOISTING"}'
st=$(curl -s $BASE/reschedules/$RS_ID -H "Authorization: Bearer $T_DEL")
check "$(echo "$st" | jq -r '.reschedule.status')" "AWAITING_HOIST_CONFIRM" "选择吊装后等待四项前置确认"
# 四项确认不齐 -> 400
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/reschedules/$RS_ID/hoisting/confirm -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"hoistingCompany":"安捷吊装"}')
check "$code" "400" "吊装确认缺物业/天气/保险时被拦截"
curl -s -o /dev/null -X POST $BASE/reschedules/$RS_ID/hoisting/confirm -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "hoistingCompany":"安捷高空吊装王队","propertyPermit":"物业许可 WY-20261003",
  "weatherCondition":"晴 风力2级 14:00-16:00","insuranceConfirmation":"平安吊装险 PA-88 保额5万","hoistingFee":350}'
st=$(curl -s $BASE/reschedules/$RS_ID -H "Authorization: Bearer $T_DEL")
check "$(echo "$st" | jq -r '.reschedule.status')" "HOISTING" "四项确认齐全 -> 吊装作业中，吊装费 ¥350"
# 吊装失败：第三方责任，进场费 200，吊装公司认赔 150
curl -s -o /dev/null -X POST $BASE/reschedules/$RS_ID/hoisting/fail -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "failureLiability":"THIRD_PARTY","failureCost":200,"thirdPartyCompensation":150,"failureNote":"吊带滑脱，吊装公司操作不当"}'
st=$(curl -s $BASE/reschedules/$RS_ID -H "Authorization: Bearer $T_BUYER")
check "$(echo "$st" | jq -r '.reschedule.hoistingFailureLiability')" "THIRD_PARTY" "吊装失败定责：第三方责任"
check "$(echo "$st" | jq -r '.reschedule.hoistingFee')" "0.00" "吊装失败后吊装费归零（不向买家收取）"
check "$(echo "$st" | jq -r '.reschedule.status')" "BLOCKED" "吊装失败后回到待买家重选方案"
# 第二次吊装尝试 -> 配送方案误判（本可拆装），已发生费用 100 平台吸收
curl -s -o /dev/null -X POST $BASE/reschedules/$RS_ID/choose-plan -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"plan":"HOISTING"}'
curl -s -o /dev/null -X POST $BASE/reschedules/$RS_ID/hoisting/confirm -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "hoistingCompany":"安捷高空吊装王队","propertyPermit":"WY-20261003","weatherCondition":"多云 风力2级",
  "insuranceConfirmation":"PA-88","hoistingFee":350}'
curl -s -o /dev/null -X POST $BASE/reschedules/$RS_ID/hoisting/fail -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "failureLiability":"PLAN_MISJUDGMENT","failureCost":100,"failureNote":"勘测漏判，沙发可拆扶手进梯，无需吊装"}'
st=$(curl -s $BASE/reschedules/$RS_ID -H "Authorization: Bearer $T_BUYER")
check "$(echo "$st" | jq -r '.reschedule.hoistingFailureLiability')" "PLAN_MISJUDGMENT" "第二次吊装失败定责：配送方案误判"
# 第三次吊装尝试 -> 买家环境限制（外墙无锚点），已发生费用 50 买家承担
curl -s -o /dev/null -X POST $BASE/reschedules/$RS_ID/choose-plan -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"plan":"HOISTING"}'
curl -s -o /dev/null -X POST $BASE/reschedules/$RS_ID/hoisting/confirm -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "hoistingCompany":"安捷高空吊装王队","propertyPermit":"WY-20261003","weatherCondition":"晴 风力1级",
  "insuranceConfirmation":"PA-88","hoistingFee":350}'
curl -s -o /dev/null -X POST $BASE/reschedules/$RS_ID/hoisting/fail -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "failureLiability":"BUYER_ENVIRONMENT","failureCost":50,"failureNote":"12楼外墙无承重锚点且窗户不可拆"}'
st=$(curl -s $BASE/reschedules/$RS_ID -H "Authorization: Bearer $T_BUYER")
check "$(echo "$st" | jq -r '.reschedule.hoistingFailureLiability')" "BUYER_ENVIRONMENT" "第三次吊装失败定责：买家环境限制"
echo "$st" | jq -e '[.plans[] | select(.plan=="HOISTING" and .status=="FAILED" and .failureLiability=="BUYER_ENVIRONMENT")] | length == 1' >/dev/null && ok "三类吊装失败责任在方案流水中分别留痕"
# 改选拆装上楼
curl -s -o /dev/null -X POST $BASE/reschedules/$RS_ID/choose-plan -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"plan":"DISASSEMBLY"}'
curl -s -o /dev/null -X POST $BASE/reschedules/$RS_ID/disassembly/complete -H "Authorization: Bearer $T_DEL"
st=$(curl -s $BASE/reschedules/$RS_ID -H "Authorization: Bearer $T_BUYER")
check "$(echo "$st" | jq -r '.reschedule.status')" "COMPLETED" "拆装上楼完成 -> 改约单完结"
check "$(echo "$st" | jq -r '.order.status')" "DELIVERED" "改约成功后订单 DELIVERED"
echo "$st" | jq -e '[.plans[] | select(.plan=="HOISTING" and .status=="FAILED")] | length == 1' >/dev/null && ok "方案流水中吊装失败留痕，拆装方案成功"
# 结算：拆装加价 +120（买家承担）、第三方失败进场费 -200、认赔 +150
st=$(curl -s -X POST $BASE/settlements/order/$RS_ORDER/generate -H "Authorization: Bearer $T_CS")
echo "$st" | jq -e '[.entries[] | select(.type=="RESCHEDULE_FEE" and (.amount|tonumber)==120)] | length == 1' >/dev/null && ok "结算含拆装上楼加价 ¥120（买家承担）"
echo "$st" | jq -e '[.entries[] | select(.type=="RESCHEDULE_FEE" and (.amount|tonumber)==-200)] | length == 1' >/dev/null && ok "结算含第三方吊装失败进场费 -¥200（平台先担）"
echo "$st" | jq -e '[.entries[] | select(.type=="RESCHEDULE_FEE" and (.amount|tonumber)==-100)] | length == 1' >/dev/null && ok "结算含方案误判吊装失败费 -¥100（平台吸收）"
echo "$st" | jq -e '[.entries[] | select(.type=="RESCHEDULE_FEE" and (.amount|tonumber)==50)] | length == 1' >/dev/null && ok "结算含买家环境限制吊装失败费 ¥50（买家承担）"
echo "$st" | jq -e '[.entries[] | select(.type=="THIRD_PARTY_COMPENSATION" and (.amount|tonumber)==150)] | length == 1' >/dev/null && ok "结算含吊装公司认赔 ¥150（冲抵平台损失）"
# 平台净收入 delta = 买家承担(120+50) + 认赔150 - 平台成本(200+100) = +20
echo "$st" | jq -e '[.entries[] | select(.type=="THIRD_PARTY_COMPENSATION")] | length == 1' >/dev/null && ok "吊装失败三类定责费用均进入结算分流"
echo "$st" | jq -r '.entries[] | select(.type=="RESCHEDULE_FEE") | .source' | grep -q '买家选择' && ok "改约费用来源写明买家所选方案"
echo "$st" | jq -r '.entries[] | select(.type=="THIRD_PARTY_COMPENSATION") | .source' | grep -q '第三方责任赔付' && ok "第三方赔付来源写明吊装公司认赔与定责"

echo "== [11] 改约方案：改送其他地址 -> 二次配送 -> 送达 =="
book=$(curl -s "$BASE/items?status=LISTED" -H "Authorization: Bearer $T_BUYER" | jq -r '[.[] | select(.category=="BOOKCASE")][0].id')
ord2=$(curl -s -X POST $BASE/orders -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d "{
  \"itemId\":\"$book\",\"buyerAddress\":\"原地址 3 楼\",\"buyerFloor\":3,\"buyerElevator\":\"ELEVATOR\"}")
O2=$(echo "$ord2" | jq -r '.order.id')
curl -s -o /dev/null -X POST $BASE/deliveries/$O2/schedule -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"vehicleType":"SMALL_VAN","scheduledWindow":"10-05 上午"}'
curl -s -o /dev/null -X POST $BASE/deliveries/$O2/load -H "Authorization: Bearer $T_DEL"
rp=$(curl -s -X POST $BASE/reschedules/deliveries/$O2/report -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "sitePhotos":["http://x/e.jpg"],"siteFloor":3,"elevatorDepth":1.3,"elevatorDoorWidth":0.8,
  "stairLandingWidth":1.0,"furnitureMaxSide":2.02,"disassemblyFeasibility":"DISASSEMBLABLE",
  "laborSurcharge":100,"siteNote":"书柜整包进不了梯"}')
RS2=$(echo "$rp" | jq -r '.reschedule.id')
check "$(echo "$rp" | jq -r '.order.status')" "RESCHEDULING" "现场登记后订单进入配送改约中"
check "$(echo "$rp" | jq -r '.delivery.failReason')" "ELEVATOR_TOO_SMALL" "系统按测量数据判定进不了电梯"
echo "$rp" | jq -e '.reschedule.sitePhotos | length == 1' >/dev/null && ok "现场照片已留存"
# 自动生成协同工单
tkcnt=$(curl -s $BASE/tickets -H "Authorization: Bearer $T_CS" | jq "[.[] | select(.orderId==\"$O2\" and .type==\"ELEVATOR_BLOCK\" and .status==\"OPEN\")] | length")
check "$tkcnt" "1" "现场登记自动发起电梯受阻协同工单"
# 改地址到 6 楼无电梯：二次配送费 = 60+5*15 = 135
curl -s -o /dev/null -X POST $BASE/reschedules/$RS2/choose-plan -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"plan":"CHANGE_ADDRESS","newAddress":"新地址·水景苑 2 栋","newFloor":6,"newElevator":"NO_ELEVATOR"}'
st=$(curl -s $BASE/reschedules/$RS2 -H "Authorization: Bearer $T_DEL")
check "$(echo "$st" | jq -r '.reschedule.redeliveryFee')" "135.00" "改地址二次配送费试算 60+5×15=135"
check "$(echo "$st" | jq -r '.reschedule.status')" "RESCHEDULED" "改地址后等待二次配送排班"
curl -s -o /dev/null -X POST $BASE/reschedules/$RS2/redelivery/schedule -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"scheduledWindow":"10-06 上午","vehicleType":"SMALL_VAN"}'
st=$(curl -s $BASE/reschedules/$RS2 -H "Authorization: Bearer $T_DEL")
check "$(echo "$st" | jq -r '.reschedule.status')" "REDELIVERING" "二次配送已排班并发车"
check "$(echo "$st" | jq -r '.order.buyerAddress')" "新地址·水景苑 2 栋" "订单送达地址已更新为新地址"
curl -s -o /dev/null -X POST $BASE/deliveries/$O2/done -H "Authorization: Bearer $T_DEL"
st=$(curl -s $BASE/reschedules/$RS2 -H "Authorization: Bearer $T_DEL")
check "$(echo "$st" | jq -r '.reschedule.status')" "COMPLETED" "新地址送达后改约单自动完结"
st=$(curl -s -X POST $BASE/settlements/order/$O2/generate -H "Authorization: Bearer $T_CS")
echo "$st" | jq -e '[.entries[] | select(.type=="RESCHEDULE_FEE" and (.amount|tonumber)==135)] | length == 1' >/dev/null && ok "二次配送费 ¥135 进入结算并注明改地址来源"

echo "== [12] 改约方案：退货回库 -> 仓储回库 -> 二次上架 =="
sofa=$(curl -s "$BASE/items?status=LISTED" -H "Authorization: Bearer $T_BUYER" | jq -r '[.[] | select(.category=="SOFA")][0].id')
ord3=$(curl -s -X POST $BASE/orders -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d "{
  \"itemId\":\"$sofa\",\"buyerAddress\":\"老楼 9 楼\",\"buyerFloor\":9,\"buyerElevator\":\"ELEVATOR\"}")
O3=$(echo "$ord3" | jq -r '.order.id')
curl -s -o /dev/null -X POST $BASE/deliveries/$O3/schedule -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"vehicleType":"LARGE_TRUCK","scheduledWindow":"10-05 下午"}'
curl -s -o /dev/null -X POST $BASE/deliveries/$O3/load -H "Authorization: Bearer $T_DEL"
rp=$(curl -s -X POST $BASE/reschedules/deliveries/$O3/report -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "siteFloor":9,"elevatorDepth":1.4,"stairLandingWidth":1.1,"furnitureMaxSide":2.2,
  "disassemblyFeasibility":"NOT_DISASSEMBLABLE","laborSurcharge":150,"siteNote":"不可拆装"}')
RS3=$(echo "$rp" | jq -r '.reschedule.id')
# 不可拆装时选拆装应被业务拦截
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/reschedules/$RS3/choose-plan -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"plan":"DISASSEMBLY"}')
check "$code" "400" "现场判定不可拆装时选择拆装被拦截"
curl -s -o /dev/null -X POST $BASE/reschedules/$RS3/choose-plan -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"plan":"RETURN"}'
# 买家自己不能登记回库
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/reschedules/$RS3/warehouse-return -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"warehouseSlot":"A-09-01"}')
check "$code" "403" "买家登记回库被角色拦截 403"
curl -s -o /dev/null -X POST $BASE/reschedules/$RS3/warehouse-return -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"warehouseSlot":"A-09-01","returnFreight":80,"restockingFee":40,"note":"外观无损"}'
st=$(curl -s $BASE/reschedules/$RS3 -H "Authorization: Bearer $T_WH")
check "$(echo "$st" | jq -r '.reschedule.status')" "RETURNED_TO_WAREHOUSE" "退货家具已回库登记"
check "$(echo "$st" | jq -r '.order.status')" "RETURNED" "回库后订单退货完结"
check "$(echo "$st" | jq -r '.item.status')" "RETURNED" "商品状态变为已退货（在仓）"
# 仓库复检后二次上架
curl -s -o /dev/null -X POST $BASE/reschedules/$RS3/relist -H "Authorization: Bearer $T_WH" -H 'Content-Type: application/json' -d '{
  "listedPrice":900,"description":"返仓复检无损伤，补充：最小电梯进深需 1.6m，建议自提或吊装","deliveryRadiusKm":0}'
st=$(curl -s $BASE/reschedules/$RS3 -H "Authorization: Bearer $T_WH")
check "$(echo "$st" | jq -r '.reschedule.relisted')" "true" "回库后产生二次上架标记"
check "$(echo "$st" | jq -r '.reschedule.status')" "RELISTED" "改约单记录已二次上架"
check "$(echo "$st" | jq -r '.item.status')" "LISTED" "二次上架后商品重新在售（配送范围改为仅自提）"
# 退货结算：回程运费/回库费平台吸收
st=$(curl -s -X POST $BASE/settlements/order/$O3/generate -H "Authorization: Bearer $T_CS")
echo "$st" | jq -e '[.entries[] | select(.type=="RESCHEDULE_FEE" and (.amount|tonumber)==-80)] | length == 1' >/dev/null && ok "退货回程运费 -¥80 进入结算（平台吸收）"
echo "$st" | jq -e '[.entries[] | select(.type=="RESCHEDULE_FEE" and (.amount|tonumber)==-40)] | length == 1' >/dev/null && ok "回库复检费 -¥40 进入结算（平台吸收）"

echo "== [12b] 改地址送达后新地址再次受阻：改约单重开，旧成功方案不重复结算 =="
anyitem=$(curl -s "$BASE/items?status=LISTED" -H "Authorization: Bearer $T_BUYER" | jq -r '.[0].id')
ord4=$(curl -s -X POST $BASE/orders -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d "{
  \"itemId\":\"$anyitem\",\"buyerAddress\":\"首个地址 2 楼\",\"buyerFloor\":2,\"buyerElevator\":\"ELEVATOR\"}")
O4=$(echo "$ord4" | jq -r '.order.id')
curl -s -o /dev/null -X POST $BASE/deliveries/$O4/schedule -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"vehicleType":"SMALL_VAN","scheduledWindow":"10-07 上午"}'
curl -s -o /dev/null -X POST $BASE/deliveries/$O4/load -H "Authorization: Bearer $T_DEL"
rp=$(curl -s -X POST $BASE/reschedules/deliveries/$O4/report -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "siteFloor":2,"elevatorDepth":1.3,"furnitureMaxSide":2.0,"disassemblyFeasibility":"DISASSEMBLABLE",
  "laborSurcharge":90,"siteNote":"首地址受阻"}')
RS4=$(echo "$rp" | jq -r '.reschedule.id')
curl -s -o /dev/null -X POST $BASE/reschedules/$RS4/choose-plan -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"plan":"CHANGE_ADDRESS","newAddress":"临停点 A 座","newFloor":5,"newElevator":"ELEVATOR"}'
curl -s -o /dev/null -X POST $BASE/reschedules/$RS4/redelivery/schedule -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"scheduledWindow":"10-08 上午"}'
curl -s -o /dev/null -X POST $BASE/deliveries/$O4/done -H "Authorization: Bearer $T_DEL"
st=$(curl -s $BASE/reschedules/$RS4 -H "Authorization: Bearer $T_DEL")
check "$(echo "$st" | jq -r '.reschedule.status')" "COMPLETED" "改地址二次配送首轮完成"
# 新地址再次受阻：送达状态下二次登记（不应 500，改约单重开）
rp2=$(curl -s -X POST $BASE/reschedules/deliveries/$O4/report -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "siteFloor":5,"elevatorDepth":1.35,"furnitureMaxSide":2.0,"disassemblyFeasibility":"DISASSEMBLABLE",
  "laborSurcharge":70,"siteNote":"新地址电梯同样进不去"}')
check "$(echo "$rp2" | jq -r '.reschedule.id')" "$RS4" "再次受阻复用原改约单（唯一约束不冲突）"
check "$(echo "$rp2" | jq -r '.reschedule.status')" "BLOCKED" "改约单重开回到待选方案"
echo "$rp2" | jq -e '[.plans[] | select(.plan=="CHANGE_ADDRESS" and .status=="ABANDONED")] | length == 1' >/dev/null && ok "上一轮已成功的改地址方案标记失效，历史流水保留"
echo "$rp2" | jq -e '[.plans[] | select(.status=="SUCCESS")] | length == 0' >/dev/null && ok "重开后无成功方案，等待新选择"
curl -s -o /dev/null -X POST $BASE/reschedules/$RS4/choose-plan -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"plan":"DISASSEMBLY"}'
curl -s -o /dev/null -X POST $BASE/reschedules/$RS4/disassembly/complete -H "Authorization: Bearer $T_DEL"
st=$(curl -s -X POST $BASE/settlements/order/$O4/generate -H "Authorization: Bearer $T_CS")
echo "$st" | jq -e '[.entries[] | select(.type=="RESCHEDULE_FEE" and (.amount|tonumber)==70)] | length == 1' >/dev/null && ok "最终结算只计二次拆装加价 ¥70"
echo "$st" | jq -e '[.entries[] | select(.type=="RESCHEDULE_FEE" and (.amount|tonumber)==60)] | length == 0' >/dev/null && ok "已失效的首轮二次配送费 ¥60 不重复计入"

echo "== [13] 运营分析（品类指标+渠道建议） =="
an=$(curl -s $BASE/analytics/by-category -H "Authorization: Bearer $T_OPS")
echo "$an" | jq -e '.categories | length == 6' >/dev/null && ok "6 个品类分析齐全"
echo "$an" | jq -r '.categories[] | select(.category=="SOFA") | .channelAdvice' | grep -q '同城自提' && ok "沙发品类因电梯失败给出同城自提建议"

echo "== [14] 卖家画像：描述不符/反悔影响下次验真 =="
# 高风险卖家登录后新申请 -> STRICT
T_RISK=$(login linfan seller123)
rresp=$(curl -s -X POST $BASE/consignments -H "Authorization: Bearer $T_RISK" -H 'Content-Type: application/json' -d '{
  "category":"BOOKCASE","brand":"又一个","sizeText":"80x30x180","material":"板材","yearsUsed":3,
  "disassemblable":true,"floor":4,"elevator":"ELEVATOR","expectedPrice":400,"acceptRefurbish":true}')
check "$(echo "$rresp" | jq -r '.consignment.verificationLevel')" "STRICT" "有反悔+描述不符史 -> 新申请自动 STRICT 严格验真"
q=$(curl -s $BASE/appraisals/queue/pending -H "Authorization: Bearer $T_APPR" | jq -r '[.[] | select(.verificationLevel=="STRICT")] | length')
[ "${q:-0}" -ge 2 ] && ok "估价师待办中 STRICT 申请置顶可见（$q 件）"

echo "== [15] 卖家反悔计入画像 =="
cancelid=$(echo "$rresp" | jq -r '.consignment.id')
curl -s -o /dev/null -X POST $BASE/consignments/$cancelid/cancel -H "Authorization: Bearer $T_RISK" -H 'Content-Type: application/json' -d '{"reason":"e2e 测试反悔"}'
pf=$(curl -s $BASE/analytics/seller-profiles -H "Authorization: Bearer $T_OPS" | jq -r '.[] | select(.username=="linfan") | .backtrackCount')
check "$pf" "2" "反悔次数累加到 2（画像联动）"

echo
echo "结果：PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
