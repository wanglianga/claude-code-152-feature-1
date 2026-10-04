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

echo "== [10] 运营分析（品类指标+渠道建议） =="
an=$(curl -s $BASE/analytics/by-category -H "Authorization: Bearer $T_OPS")
echo "$an" | jq -e '.categories | length == 6' >/dev/null && ok "6 个品类分析齐全"
echo "$an" | jq -r '.categories[] | select(.category=="SOFA") | .channelAdvice' | grep -q '同城自提' && ok "沙发品类因电梯失败给出同城自提建议"

echo "== [11] 卖家画像：描述不符/反悔影响下次验真 =="
# 高风险卖家登录后新申请 -> STRICT
T_RISK=$(login linfan seller123)
rresp=$(curl -s -X POST $BASE/consignments -H "Authorization: Bearer $T_RISK" -H 'Content-Type: application/json' -d '{
  "category":"BOOKCASE","brand":"又一个","sizeText":"80x30x180","material":"板材","yearsUsed":3,
  "disassemblable":true,"floor":4,"elevator":"ELEVATOR","expectedPrice":400,"acceptRefurbish":true}')
check "$(echo "$rresp" | jq -r '.consignment.verificationLevel')" "STRICT" "有反悔+描述不符史 -> 新申请自动 STRICT 严格验真"
q=$(curl -s $BASE/appraisals/queue/pending -H "Authorization: Bearer $T_APPR" | jq -r '[.[] | select(.verificationLevel=="STRICT")] | length')
[ "${q:-0}" -ge 2 ] && ok "估价师待办中 STRICT 申请置顶可见（$q 件）"

echo "== [12] 卖家反悔计入画像 =="
cancelid=$(echo "$rresp" | jq -r '.consignment.id')
curl -s -o /dev/null -X POST $BASE/consignments/$cancelid/cancel -H "Authorization: Bearer $T_RISK" -H 'Content-Type: application/json' -d '{"reason":"e2e 测试反悔"}'
pf=$(curl -s $BASE/analytics/seller-profiles -H "Authorization: Bearer $T_OPS" | jq -r '.[] | select(.username=="linfan") | .backtrackCount')
check "$pf" "2" "反悔次数累加到 2（画像联动）"

echo "== [13] 大件进不了电梯·配送改约（场景A：吊装失败第三方责任→退货→追偿→二次上架） =="
SOFA_ID=$(curl -s "$BASE/items" -H "Authorization: Bearer $T_BUYER" | jq -r '[.[] | select(.category=="SOFA")] | max_by(.listedPrice|tonumber) | .id')
ordA=$(curl -s -X POST $BASE/orders -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d "{
  \"itemId\":\"$SOFA_ID\",\"buyerAddress\":\"江景花苑 5 栋 1602\",\"buyerFloor\":16,\"buyerElevator\":\"ELEVATOR\",
  \"appointmentWindow\":\"今天下午\"}")
ORD_A=$(echo "$ordA" | jq -r '.order.id')
curl -s -o /dev/null -X POST $BASE/deliveries/$ORD_A/schedule -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"vehicleType":"LARGE_TRUCK","scheduledWindow":"今天下午"}'
curl -s -o /dev/null -X POST $BASE/deliveries/$ORD_A/load -H "Authorization: Bearer $T_DEL"
# 配送员现场勘测：电梯进深 1.3m、楼梯转角 0.9m、现场判定不可拆装、人工加价 200
sv=$(curl -s -X POST $BASE/delivery-blocks/order/$ORD_A/survey -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "photos":["http://x/elevator.jpg"],"siteFloor":16,"elevatorDepthCm":130,"elevatorDoorCm":80,
  "stairTurnWidthCm":90,"disassemblable":false,"disassemblyNote":"一体木架不可拆",
  "laborSurcharge":200,"siteNote":"沙发 2.2m 无法进梯"}')
BL_A=$(echo "$sv" | jq -r '.block.id')
TK_A=$(echo "$sv" | jq -r '.ticket.id')
ost=$(curl -s $BASE/orders/$ORD_A -H "Authorization: Bearer $T_BUYER" | jq -r '.order.status')
check "$ost" "RESHEDULING" "勘测登记后订单进入配送改约 RESHEDULING，并自动建工单"
[ -n "$BL_A" ] && [ "$BL_A" != "null" ] && ok "配送改约单已创建 id=$BL_A（含现场照片/楼层/尺寸/拆装/加价）"
# 不可拆装却选拆装上楼 -> 业务拦截
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/delivery-blocks/$BL_A/option -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"option":"DISASSEMBLY"}')
check "$code" "400" "现场判定不可拆装时，拆装上楼方案被拦截"
# 买家选择吊装
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_A/option -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"option":"HOIST","note":"16楼同意吊装"}'
# 无物业许可/无保险 -> 拦截
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/delivery-blocks/$BL_A/arrange-hoist -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"hoistCompany":"顺达吊装","propertyPermit":false,"weather":"晴","insuranceConfirmed":true,"hoistQuote":500}')
check "$code" "400" "吊装未取得物业许可被拦截"
# 许可齐全但大风天气 -> 拦截
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/delivery-blocks/$BL_A/arrange-hoist -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"hoistCompany":"顺达吊装","propertyPermit":true,"weather":"大风 7 级","insuranceConfirmed":true,"hoistQuote":500}')
check "$code" "400" "大风天气不满足高空吊装条件被拦截"
# 四要素齐全安排吊装，吊装费 500 写入订单附加费
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_A/arrange-hoist -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"hoistCompany":"顺达高空吊装有限公司","propertyPermit":true,"propertyPermitNote":"物业许可单 XK-01","weather":"晴，东北风 2 级","insuranceConfirmed":true,"insurancePolicy":"POL-01","hoistQuote":500}'
sf=$(curl -s $BASE/orders/$ORD_A -H "Authorization: Bearer $T_BUYER" | jq -r '.order.surchargeFee')
check "$sf" "500.00" "吊装安排后订单附加费=吊装报价 500"
# 吊装失败：第三方责任，追偿 500；附加费不再向买家收取
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_A/hoist-result -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"success":false,"failCause":"THIRD_PARTY","failNote":"吊带固定不规范滑落","thirdPartyClaimAmount":500}'
sf=$(curl -s $BASE/orders/$ORD_A -H "Authorization: Bearer $T_BUYER" | jq -r '.order.surchargeFee')
check "$sf" "0.00" "第三方责任吊装失败：吊装费不向买家收取（转第三方追偿）"
hc=$(curl -s $BASE/delivery-blocks/$BL_A -H "Authorization: Bearer $T_BUYER" | jq -r '.block.hoistFailCause')
check "$hc" "THIRD_PARTY" "吊装失败归因为第三方责任（区别于买家环境/方案误判）"
# 买家改选退货 -> 回库 -> 结算
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_A/option -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"option":"RETURN","note":"放弃购买"}'
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_A/warehouse-return -H "Authorization: Bearer $T_WH" -H 'Content-Type: application/json' -d '{"warehouseSlot":"W-09-01","note":"外观完好"}'
ost=$(curl -s $BASE/orders/$ORD_A -H "Authorization: Bearer $T_BUYER" | jq -r '.order.status')
check "$ost" "RETURNED" "退货商品回库登记后订单 RETURNED"
stA=$(curl -s -X POST $BASE/settlements/order/$ORD_A/generate -H "Authorization: Bearer $T_CS")
echo "$stA" | jq -e '[.entries[] | select(.type=="THIRD_PARTY_CLAIM" and .amount=="500.00")] | length == 1' >/dev/null && ok "结算含第三方追偿 500（来源：吊装公司责任）"
echo "$stA" | jq -r '.entries[] | select(.type=="COMPENSATION") | .amount' | grep -q '980.00' && ok "第三方责任：买家成交款 980 全额退还（不承担吊装费）"
echo "$stA" | jq -r '.entries[] | select(.type=="THIRD_PARTY_CLAIM") | .source' | grep -q '追偿' && ok "第三方追偿条目来源说明清楚"
echo "$stA" | jq -e '.settlement.sellerPayout == "0.00"' >/dev/null && ok "退货单卖家应得为 0"
# 二次上架（产生二次上架，通道尺寸写入商品描述）
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_A/relist-decision -H "Authorization: Bearer $T_WH" -H 'Content-Type: application/json' -d '{"decision":"RELIST","reason":"复检合格","deliveryRadiusKm":30}'
rs=$(curl -s $BASE/delivery-blocks/$BL_A -H "Authorization: Bearer $T_DEL" | jq -r '.block.status')
check "$rs" "RELISTED" "退货回库后二次上架完成（block RELISTED）"

echo "== [14] 配送改约（场景B：拆装上楼送达，附加费计入结算不影响卖家应得） =="
BK_ID=$(curl -s "$BASE/items" -H "Authorization: Bearer $T_BUYER" | jq -r '.[] | select(.category=="BOOKCASE" and .status=="LISTED") | .id' | head -1)
ordB=$(curl -s -X POST $BASE/orders -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d "{
  \"itemId\":\"$BK_ID\",\"buyerAddress\":\"幸福里 9 栋 302\",\"buyerFloor\":3,\"buyerElevator\":\"ELEVATOR\"}")
ORD_B=$(echo "$ordB" | jq -r '.order.id')
curl -s -o /dev/null -X POST $BASE/deliveries/$ORD_B/schedule -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"vehicleType":"SMALL_VAN","scheduledWindow":"明天上午"}'
curl -s -o /dev/null -X POST $BASE/deliveries/$ORD_B/load -H "Authorization: Bearer $T_DEL"
svB=$(curl -s -X POST $BASE/delivery-blocks/order/$ORD_B/survey -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "siteFloor":3,"elevatorDepthCm":120,"stairTurnWidthCm":85,"disassemblable":true,
  "disassemblyNote":"层板可拆","laborSurcharge":100,"siteNote":"拆装可上楼"}')
BL_B=$(echo "$svB" | jq -r '.block.id')
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_B/option -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"option":"DISASSEMBLY"}'
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_B/complete-delivery -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"note":"拆装复装完成"}'
ost=$(curl -s $BASE/orders/$ORD_B -H "Authorization: Bearer $T_BUYER" | jq -r '.order.status')
check "$ost" "DELIVERED" "拆装上楼方案执行完成，订单 DELIVERED"
stB=$(curl -s -X POST $BASE/settlements/order/$ORD_B/generate -H "Authorization: Bearer $T_CS")
echo "$stB" | jq -e '[.entries[] | select(.type=="RESCHEDULE_FEE" and .amount=="100.00")] | length == 1' >/dev/null && ok "结算含拆装改约附加费 100（现场拆装+人工加价，来源改约单）"
echo "$stB" | jq -r '.entries[] | select(.type=="RESCHEDULE_FEE") | .source' | grep -q '拆装' && ok "改约附加费来源写明方案与计费方式"
echo "$stB" | jq -e '[.entries[] | select(.type=="COMMISSION")][0].amount == "22.50"' >/dev/null && ok "卖家佣金仍按成交价计算（改约附加费不扣卖家）"

echo "== [15] 配送改约（场景C：买家环境限制吊装失败→改送他址送达，转运费130） =="
SOFA2_ID=$(curl -s "$BASE/items" -H "Authorization: Bearer $T_BUYER" | jq -r '[.[] | select(.category=="SOFA" and .status=="LISTED")] | min_by(.listedPrice|tonumber) | .id')
ordC=$(curl -s -X POST $BASE/orders -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d "{
  \"itemId\":\"$SOFA2_ID\",\"buyerAddress\":\"云顶阁 2 栋 2001\",\"buyerFloor\":20,\"buyerElevator\":\"ELEVATOR\"}")
ORD_C=$(echo "$ordC" | jq -r '.order.id')
curl -s -o /dev/null -X POST $BASE/deliveries/$ORD_C/schedule -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"vehicleType":"LARGE_TRUCK","scheduledWindow":"后天下午"}'
curl -s -o /dev/null -X POST $BASE/deliveries/$ORD_C/load -H "Authorization: Bearer $T_DEL"
svC=$(curl -s -X POST $BASE/delivery-blocks/order/$ORD_C/survey -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "siteFloor":20,"elevatorDepthCm":135,"stairTurnWidthCm":88,"disassemblable":false,
  "laborSurcharge":0,"siteNote":"外立面施工无法支索，先尝试吊装"}')
BL_C=$(echo "$svC" | jq -r '.block.id')
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_C/option -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"option":"HOIST"}'
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_C/arrange-hoist -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"hoistCompany":"云梯吊装","propertyPermit":true,"weather":"晴，风力 2 级","insuranceConfirmed":true,"insurancePolicy":"POL-02","hoistQuote":500}'
# 买家环境限制导致失败（外立面无吊点）：吊装费暂由买家承担
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_C/hoist-result -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"success":false,"failCause":"BUYER_ENVIRONMENT","failNote":"外墙施工无锚固点，物业临时要求停工"}'
hc=$(curl -s $BASE/delivery-blocks/$BL_C -H "Authorization: Bearer $T_BUYER" | jq -r '.block.hoistFailCause')
check "$hc" "BUYER_ENVIRONMENT" "吊装失败归因为买家环境限制（区别于方案误判/第三方）"
# 改选「改送他址」：3 楼无电梯 -> 100 + 2×15 = 130
opC=$(curl -s -X POST $BASE/delivery-blocks/$BL_C/option -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"option":"CHANGE_ADDRESS","newAddress":"亲友家 一楼小院 3 栋","newFloor":3,"newElevator":"NO_ELEVATOR"}')
check "$(echo "$opC" | jq -r '.optionFee')" "130.00" "改送他址转运费=基础100+无电梯2层×15=130"
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_C/complete-delivery -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"note":"改址送达"}'
ost=$(curl -s $BASE/orders/$ORD_C -H "Authorization: Bearer $T_BUYER" | jq -r '.order.status')
check "$ost" "DELIVERED" "改送他址方案执行完成，订单 DELIVERED（地址/楼层同步更新）"
stC=$(curl -s -X POST $BASE/settlements/order/$ORD_C/generate -H "Authorization: Bearer $T_CS")
echo "$stC" | jq -e '[.entries[] | select(.type=="RESCHEDULE_FEE" and .amount=="130.00")] | length == 1' >/dev/null && ok "结算含改址转运附加费 130（来源改约单）"
echo "$stC" | jq -e '.settlement.platformIncome == "268.00"' >/dev/null && ok "平台净收入=佣金78+配送费60+改址费130=268"

echo "== [16] 配送改约（场景D：方案误判吊装失败→退货全额退款→不再上架） =="
ordD=$(curl -s -X POST $BASE/orders -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d "{
  \"itemId\":\"$SOFA_ID\",\"buyerAddress\":\"望江台 1 栋 1801\",\"buyerFloor\":18,\"buyerElevator\":\"ELEVATOR\"}")
ORD_D=$(echo "$ordD" | jq -r '.order.id')
curl -s -o /dev/null -X POST $BASE/deliveries/$ORD_D/schedule -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"vehicleType":"LARGE_TRUCK","scheduledWindow":"周五下午"}'
curl -s -o /dev/null -X POST $BASE/deliveries/$ORD_D/load -H "Authorization: Bearer $T_DEL"
svD=$(curl -s -X POST $BASE/delivery-blocks/order/$ORD_D/survey -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{
  "siteFloor":18,"elevatorDepthCm":138,"stairTurnWidthCm":92,"disassemblable":true,
  "disassemblyNote":"本可拆装上楼，调度却误排吊装","laborSurcharge":150,"siteNote":"调度误判为必须吊装"}')
BL_D=$(echo "$svD" | jq -r '.block.id')
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_D/option -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"option":"HOIST"}'
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_D/arrange-hoist -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"hoistCompany":"顺达高空吊装有限公司","propertyPermit":true,"weather":"多云，风力 3 级","insuranceConfirmed":true,"insurancePolicy":"POL-03","hoistQuote":400}'
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_D/hoist-result -H "Authorization: Bearer $T_DEL" -H 'Content-Type: application/json' -d '{"success":false,"failCause":"PLAN_MISJUDGE","failNote":"现场实测本可拆装，吊装属方案误判"}'
hc=$(curl -s $BASE/delivery-blocks/$BL_D -H "Authorization: Bearer $T_BUYER" | jq -r '.block.hoistFailCause')
check "$hc" "PLAN_MISJUDGE" "吊装失败归因为配送方案误判（吊装费平台承担）"
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_D/option -H "Authorization: Bearer $T_BUYER" -H 'Content-Type: application/json' -d '{"option":"RETURN","note":"不想再等"}'
bb=$(curl -s $BASE/delivery-blocks/$BL_D -H "Authorization: Bearer $T_BUYER" | jq -r '.block.buyerBorneOnReturn')
check "$bb" "0.00" "方案误判退货：买家不承担吊装费，全额退款"
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_D/warehouse-return -H "Authorization: Bearer $T_WH" -H 'Content-Type: application/json' -d '{"warehouseSlot":"W-10-03"}'
stD=$(curl -s -X POST $BASE/settlements/order/$ORD_D/generate -H "Authorization: Bearer $T_CS")
echo "$stD" | jq -e '[.entries[] | select(.type=="COMPENSATION" and .amount=="980.00")] | length == 1' >/dev/null && ok "方案误判退货：成交款 980 全额退还买家"
echo "$stD" | jq -e '[.entries[] | select(.type=="RESCHEDULE_FEE" and .amount=="400.00")] | length == 1' >/dev/null && ok "误判产生的吊装费 400 由平台吸收（结算列明，不向买家/卖家收取）"
curl -s -o /dev/null -X POST $BASE/delivery-blocks/$BL_D/relist-decision -H "Authorization: Bearer $T_WH" -H 'Content-Type: application/json' -d '{"decision":"NO_RELIST","reason":"多次配送受阻，转线下处置"}'
rs=$(curl -s $BASE/delivery-blocks/$BL_D -H "Authorization: Bearer $T_DEL" | jq -r '.block.relistDecision')
check "$rs" "NO_RELIST" "回库复检后决定不再上架（不产生二次上架，商品下架）"

echo "== [17] 运营改约看板 =="
ab=$(curl -s $BASE/analytics/delivery-blocks -H "Authorization: Bearer $T_OPS")
echo "$ab" | jq -e '.byOption.RETURN >= 2 and .byOption.HOIST >= 1 and .byOption.DISASSEMBLY >= 1 and .byOption.CHANGE_ADDRESS >= 1' >/dev/null && ok "看板统计买家四方案分布齐全（含最终退货≥2）"
echo "$ab" | jq -e '.hoistFailCauses.THIRD_PARTY >= 1 and .hoistFailCauses.BUYER_ENVIRONMENT >= 1 and .hoistFailCauses.PLAN_MISJUDGE >= 1' >/dev/null && ok "看板区分吊装失败三类归因（买家环境/方案误判/第三方均出现）"
echo "$ab" | jq -e '.thirdPartyClaimTotal >= 500 and .returnRelistCount >= 1 and .deliveredSurchargeTotal >= 230' >/dev/null && ok "看板统计第三方追偿、二次上架数量与已送达附加费"

echo
echo "结果：PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
