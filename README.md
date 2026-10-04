# 邻栖 · 城市二手家具寄卖估价上架配送与售后平台

围绕**一件家具**打通完整链路：居民寄卖申请 → 估价师上门验真报价 → 清洁/补漆/入仓/拍照/上架 →
买家下单 → 配送排班（楼层/电梯/拆装/车辆/旧家具搬出）→ 异常协同工单（卖家反悔、估价与实物不符、
翻新超支、色差、沙发进不了电梯、途中磕碰、退货）→ 逐项有来源的结算 → 品类运营分析与卖家风险画像。

技术栈：**React 18 + Vite + TypeScript**（前端）· **NestJS 10 + TypeORM**（后端）· **PostgreSQL 15**。

---

## 一、一键启动（Docker Compose，推荐）

需要 Docker 20.10+ 与 Docker Compose v2。

```bash
docker compose up --build
```

启动后：

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| 前端（Nginx 托管） | http://localhost:8080 | 全部业务页面 |
| 后端 API | http://localhost:3000/api | NestJS，仅后端调试时直接访问 |
| PostgreSQL | localhost:5432 | 库名/用户/密码：furniture / postgres / postgres |

首次启动后端会**自动建表并写入演示数据**（约 5~10 秒，等待 API 日志出现
`Furniture consignment API listening`）。清空数据重来：

```bash
docker compose down -v   # -v 删除数据卷
docker compose up --build
```

> 本项目为全栈应用（含完整前端业务页面），按任务约定不单独提供 Swagger UI；
> 后端 REST 接口可通过前端各角色页面操作验证，接口清单见文末附录。

## 二、本地开发启动（不用 Docker）

前置：Node.js 20+、一个可连接的 PostgreSQL 15。

### 1. 准备数据库

```bash
createdb -U postgres furniture
# 或：psql -U postgres -c "CREATE DATABASE furniture;"
```

### 2. 后端（端口 3000）

```bash
cd backend
npm install
# 按实际情况修改 backend/.env（DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME）
npm run dev          # 开发模式（ts-node）
# 或
npm run build && npm start
```

后端启动时自动建表（TypeORM synchronize）并在空库上写入演示种子数据。
若不需要种子，设置环境变量 `SEED_ON_BOOT=false`。

### 3. 前端（端口 5173）

```bash
cd frontend
npm install
npm run dev
```

Vite 已配置 `/api` 代理到 `http://127.0.0.1:3000`（可用环境变量 `VITE_API_TARGET` 覆盖）。
打开 http://localhost:5173 即可。

前端生产构建：`npm run build`（产物在 `frontend/dist`，容器中由 Nginx 托管）。

---

## 三、测试账号

| 角色 | 账号 | 密码 | 能做什么 |
| --- | --- | --- | --- |
| 卖家（信用良好） | `wangjiayi` | `seller123` | 提交寄卖、查看验真等级/估价、反悔、看自己的结算 |
| 卖家（高风险） | `linfan` | `seller123` | 有 1 次反悔 + 1 次描述不符，新寄卖自动触发**严格验真** |
| 卖家 | `liujing` | `seller123` | 有一单已成交结算的办公椅 |
| 买家 | `zhangmai` | `buyer123` | 逛市场、下单（含电梯/楼层/旧家具搬出计价）、发起售后；有一单三人沙发**到楼受阻待选方案** |
| 买家 | `sunmai` | `buyer123` | 一单"进不了电梯"退货回库待上架；另一单 16 楼**吊装失败（第三方责任）待重选方案** |
| 估价师 | `gujia` | `gujia123` | 上门预约、六项验真打分、寄卖价/底价/佣金、相符度、入仓/自提 |
| 仓库管理 | `cangguan` | `cangguan123` | 入库库位、拍照、上架描述、**退货回库复检与二次上架决策** |
| 翻新师 | `fanxin` | `fanxin123` | 清洁/补漆/维修作业登记（费用入结算） |
| 配送 | `peisong` | `peisong123` | 排班、车辆、装车、送达、**到楼受阻现场勘测发起改约**、吊装安排/结果归因 |
| 客服 | `kefu` | `kefu123` | 协同工单六方留言、客服裁定、生成结算单、查看全部改约单 |
| 运营 | `ops` | `ops123` | 品类分析看板、卖家风险画像、结算查看 |
| 管理员 | `admin` | `admin123` | 与运营/客服同等权限 |

登录页也提供"一键填充"按钮。买家/卖家还可在登录页自助注册（接口
`POST /api/auth/register`，仅开放 SELLER/BUYER 两种身份）。

## 四、推荐验证路径（业务主线）

1. **卖家 `wangjiayi` 登录**：顶部显示信用画像（风险分 0、常规验真）；可提交一件沙发寄卖。
2. 切换 **估价师 `gujia`**：待办队列里高风险卖家 `linfan` 的申请带"⚠ 严格验真"并置顶；
   对新申请逐项打分（结构/污渍/异味/虫蛀/变形/搬运难度），填写寄卖价、底价、佣金率、
   清洁翻新建议，选择"相符/轻微不符/严重不符"，决定入仓或留卖家家中、配送半径。
3. **翻新师 `fanxin` / 仓库 `cangguan`**：登记清洁、补漆费用 → 清洁完成 → 拍照 →
   填写上架描述/库位/配送范围 → 上架。
4. **买家 `zhangmai`**：市场下单，选择无电梯楼层、旧家具搬出，实时看到配送费计价；
   订单锁定商品。
5. **配送 `peisong`**：按楼层/拆装/车辆/旧家具搬出/预约时间排班 → 装车 → 送达。
6. **大件进不了电梯·配送改约**（三人位沙发主线，可直接用种子中张女士待处理的改约单）：
   - **配送**在配送中点击「到楼受阻·登记勘测」：上传现场照片、登记楼层、电梯进深/开门净宽、
     楼梯转角宽度、现场判断的**拆装可能性**与**人工加价**；提交后配送单失败、订单进入「配送改约中」，
     并自动创建一张协同工单。
   - **买家 `zhangmai`** 在「我的订单/售后」进入改约单，四选一：
     **① 拆装上楼**（取现场人工加价，成交后正常结算）/
     **② 吊装上楼** / **③ 退货**（回库复检后决定是否二次上架）/
     **④ 改送其他地址**（系统按 ¥100 基础 + 无电梯 ¥15/层试算转运费）；每次选择/改选均留痕。
   - 选择吊装后，**配送**必须登记**吊装公司、物业许可、天气、保险确认**与报价才能安排
     （无许可/未确认保险/大风雷雨会被系统拦截）；吊装结果可回填成功或失败，
     失败必须三选一归因：**买家环境限制 / 配送方案误判 / 第三方（吊装公司）责任**。
   - 第三方责任：吊装费不向买家收取，平台垫付后登记**向吊装公司追偿**；买家环境限制：
     吊装费由买家承担（退货时从退款扣除）；方案误判：吊装费由平台吸收。
   - 买家选择退货后，**仓库 `cangguan`** 在「大件退货回库·二次上架」页签登记回库库位，
     复检后决定**二次上架**（通道尺寸自动写入商品描述，避免下一位买家重蹈覆辙）或**不再上架**。
   - 种子中孙先生有一单 16 楼**吊装失败（第三方责任）待重新选择方案**、一单已回库待上架决策。
7. **买家**在订单页发起"色差/磕碰/退货"工单；**仓库、配送、客服**依次进入同一工单留言协同；
   **客服 `kefu`** 裁定处理结论（维持/降价/卖家或平台赔付/退货退款/重新上架/终止寄卖），
   订单、商品、寄卖单状态随之联动；电梯受阻工单内可直接跳转对应配送改约单。
8. **客服**在"结算管理"对已送达/退货单生成结算单：成交价、佣金、翻新费、仓储费（按在仓天数）、
   配送费、**改约附加费（拆装/吊装/改址）、第三方追偿**、售后赔付、卖家应得逐项列出**来源说明**；
   退货单展示平台吸收的成本。
9. **运营 `ops`**：查看六品类成交周期、翻新投入占比、退货原因、配送失败率（含吊装失败）、
   "适合入仓寄卖 / 建议同城自提"渠道建议，以及**「大件进不了电梯·配送改约看板」**
   （买家四方案分布、吊装成功率与三类失败归因、退货回库二次上架率、附加费与追偿规模）；
   查看卖家风险画像排序。
10. 用 **`linfan`** 再提交一件寄卖，确认申请自动带上"严格验真"；卖家在约估价后反悔，
    画像中反悔次数与风险分立即变化。

## 五、自动化验证

后端附端到端接口脚本（需要先启动后端与空库/种子库）：

```bash
cd backend
bash e2e-test.sh
```

覆盖：鉴权与角色拦截 → 申请（画像联动）→ 六项验真估价（含底价校验）→ 作业记账 →
上架 → 下单与配送费计价 → 排班/装车/送达 → 工单协同与客服裁定 → 结算金额与来源 →
品类分析与渠道建议 → 严格验真触发 → 反悔计入画像 →
**大件进不了电梯·配送改约四场景**（第三方责任吊装失败→退货→追偿→二次上架；
拆装上楼送达；买家环境限制失败→改送他址计价；方案误判失败→退货全额退款→不再上架），
共 **51 项断言**。

## 六、实际执行过的验证（本工作区）

- `cd backend && npx tsc` 编译通过；`cd frontend && npm run build`（tsc 类型检查 + vite 打包）通过。
- 在本机自建 PostgreSQL 15 独立实例（端口 5433，库 furniture）启动后端，自动建表并写入种子数据
  （含 3 张配送改约单：待买家选方案、第三方吊装失败待重选、退货已回仓待上架决策）。
- `bash backend/e2e-test.sh` 结果：**PASS=51 FAIL=0**。
- Vite dev server 返回 200，经其 `/api` 代理登录接口返回有效 JWT。
- Docker 守护进程在当前沙箱不可用，镜像未在本机实际构建；`docker-compose.yml`
  与两个 Dockerfile 已按标准 node:22-alpine / nginx:1.27-alpine 多阶段构建编写，
  请在有 Docker 的环境执行 `docker compose up --build` 验证。

## 七、核心业务规则

- **验真等级**：风险分 = 反悔×3 + 描述不符×2 + 售后争议×1 − 成交×0.5；≥4 分或描述不符 ≥2 次
  → 新寄卖自动 STRICT（估价师工作台置顶，逐项核对）。
- **价格**：最低成交价（底价）不可高于寄卖价；买家出价低于底价无法下单。
- **配送费**：基础 ¥60；无电梯/楼梯房 `（楼层−1)×¥15`；旧家具搬出 +¥80；配送半径 0km（同城自提）免配送费。
- **配送改约（大件进不了电梯/楼道）**：
  - 勘测必须记录现场照片、楼层、电梯进深/开门净宽、楼梯转角宽度、拆装可能性与人工加价，
    自动生成改约单与 ELEVATOR_BLOCK 协同工单，订单进入「配送改约中」。
  - 买家四方案：① 拆装上楼（附加费取现场人工加价）；② 吊装（费取吊装报价）；
    ③ 退货（无附加费，回库复检后决定是否二次上架）；④ 改送他址（¥100 基础 + 新址无电梯 ¥15/层）。
    现场判定不可拆装时，拆装上楼方案不可选；方案可改选并全程留痕。
  - 吊装必须四要素齐全（吊装公司 + 物业许可 + 适合作业天气 + 保险确认）方可安排；
    失败三归因——买家环境限制（吊装费买家承担，退货从退款扣除）、配送方案误判（平台承担）、
    第三方责任（平台垫付并向吊装公司追偿，结算列「第三方追偿」）。
  - 退货商品回仓后由仓库复检：二次上架则把现场通道尺寸写入商品描述（降低二次受阻概率），
    不再上架则商品下架、不产生二次上架。
- **仓储费**：在仓商品按 ¥3/天，从入库时间计至结算日；留卖家家中不收仓储费。
- **结算**：
  - 正常成交：卖家应得 = 成交价 − 佣金（估价单费率）− 清洁翻新费（作业记录）− 仓储费 − 卖家责任赔付；
    平台净收入 = 佣金 + 配送费 + **改约附加费（拆装/吊装/改址）** − 平台责任赔付；
    改约附加费不影响卖家应得（佣金仍只按成交价计）。
  - 退货：卖家应得为 0；成交款退还买家（买家环境限制导致的已发生吊装费除外）；
    翻新/仓储/配送成本由平台吸收；第三方责任吊装费以「第三方追偿」冲抵，
    方案误判吊装费由平台吸收。
- **渠道建议**：品类配送失败率 ≥25% 或电梯/楼道/吊装受阻占失败多数 → 建议同城自提为主；
  成交周期 ≤7 天、翻新占均价比 ≤12%、退货率 ≤15% → 适合入仓寄卖。

## 八、接口清单（附录）

所有接口前缀 `/api`，除 `auth/login`、`auth/register` 外均需 `Authorization: Bearer <token>`，
并按角色授权。

- `POST /auth/login`、`POST /auth/register`、`GET /auth/me`
- `POST /consignments`（卖家提交）、`GET /consignments`、`GET /consignments/:id`、
  `POST /consignments/:id/schedule`（估价师预约）、`POST /consignments/:id/cancel`（卖家反悔）
- `GET /appraisals/queue/pending`、`POST /appraisals/consignment/:id`（验真报价，接受则生成商品）、
  `GET /appraisals/consignment/:id`
- `GET /items`（买家仅见在售）、`GET /items/:id`、
  `POST /items/:id/work-logs`（清洁/补漆/维修/拍照/文案/入库）、`POST /items/:id/advance`（状态推进/上架）
- `POST /orders`（买家下单，含配送费试算）、`GET /orders`、`GET /orders/:id`、`POST /orders/:id/cancel`
- `GET /deliveries/queue`、`POST /deliveries/:orderId/schedule|load|done|fail`
- **配送改约（大件进不了电梯）**：
  `POST /delivery-blocks/order/:orderId/survey`（配送现场勘测，自动建工单）、
  `GET /delivery-blocks`、`GET /delivery-blocks/:id`、
  `POST /delivery-blocks/:id/option`（买家四方案：DISASSEMBLY/HOIST/RETURN/CHANGE_ADDRESS）、
  `POST /delivery-blocks/:id/arrange-hoist`（吊装公司/物业许可/天气/保险/报价）、
  `POST /delivery-blocks/:id/hoist-result`（成功；或失败归因 BUYER_ENVIRONMENT/PLAN_MISJUDGE/THIRD_PARTY）、
  `POST /delivery-blocks/:id/complete-delivery`（拆装/吊装成功/改址后交付）、
  `POST /delivery-blocks/:id/warehouse-return`（退货回库登记库位）、
  `POST /delivery-blocks/:id/relist-decision`（RELIST 二次上架 / NO_RELIST 不再上架）
- `POST /tickets`（任意相关方发起异常）、`GET /tickets`、`GET /tickets/:id`、
  `POST /tickets/:id/messages`（六方协同留言）、`POST /tickets/:id/resolve`（客服裁定）
- `GET /settlements`、`GET /settlements/order/:orderId`、`POST /settlements/order/:orderId/generate`
- `GET /analytics/by-category`（品类指标与渠道建议）、
  `GET /analytics/delivery-blocks`（大件受阻改约看板：方案分布/吊装归因/二次上架/附加费与追偿）、
  `GET /analytics/seller-profiles`、`GET /analytics/seller-profiles/:sellerId`

## 九、目录结构

```
.
├── docker-compose.yml          # db + backend + frontend 一键启动
├── backend/                    # NestJS + TypeORM + PostgreSQL
│   ├── Dockerfile
│   ├── src/
│   │   ├── entities/           # 11 张核心表（含 delivery_block 配送改约单）
│   │   ├── auth/               # JWT + 角色守卫
│   │   ├── risk/               # 卖家风险画像（全局服务）
│   │   ├── consignments/ appraisals/ items/ orders/
│   │   ├── deliveries/ delivery-blocks/  # 配送调度 + 大件受阻改约工作流
│   │   ├── tickets/ settlements/ analytics/ seeder/
│   │   └── main.ts
│   └── e2e-test.sh             # 51 项端到端断言
└── frontend/                   # React + Vite
    ├── Dockerfile  nginx.conf
    └── src/views/              # 登录 + 各角色工作台（含 DeliveryBlock 改约工作流）
```
