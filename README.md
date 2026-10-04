# 邻栖 · 城市二手家具寄卖估价上架配送与售后平台

围绕**一件家具**打通完整链路：居民寄卖申请 → 估价师上门验真报价 → 清洁/补漆/入仓/拍照/上架 →
买家下单 → 配送排班（楼层/电梯/拆装/车辆/旧家具搬出）→
**家具进不了电梯/楼道的配送改约**（现场照片/楼层/拆装可能性/人工加价 → 买家选择
拆装上楼·吊装·退货·改送其他地址 → 吊装四项确认与失败三分类定责 → 回库复检与二次上架）→
异常协同工单（卖家反悔、估价与实物不符、翻新超支、色差、沙发进不了电梯、途中磕碰、退货）→
逐项有来源的结算 → 品类运营分析与卖家风险画像。

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
| 买家 | `zhangmai` | `buyer123` | 逛市场、下单（含电梯/楼层/旧家具搬出计价）、发起售后；有一单**三人位沙发到场进不了电梯**的改约待办 |
| 买家 | `sunmai` | `buyer123` | 有一单"沙发进不了电梯"退货回库工单（仓库可演示二次上架） |
| 估价师 | `gujia` | `gujia123` | 上门预约、六项验真打分、寄卖价/底价/佣金、相符度、入仓/自提 |
| 仓库管理 | `cangguan` | `cangguan123` | 入库库位、拍照、上架描述、退货返仓重新上架 |
| 翻新师 | `fanxin` | `fanxin123` | 清洁/补漆/维修作业登记（费用入结算） |
| 配送 | `peisong` | `peisong123` | 排班、车辆、装车、送达、失败原因登记 |
| 客服 | `kefu` | `kefu123` | 协同工单六方留言、客服裁定、生成结算单 |
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
5. **配送 `peisong`**：按楼层/拆装/车辆/旧家具搬出/预约时间排班 → 装车 → 送达；
   对种子中张女士的**三人位功能沙发**点"🛗 进不了电梯·发起改约"，
   登记现场照片、电梯进深 1.5m、楼梯转角、拆装可能性、人工加价。
6. **买家 `zhangmai`**：在"我的订单/售后"看到订单变为**配送改约中**，进入改约单四选一：
   - **拆装上楼**：按现场人工加价收费，配送确认后送达；
   - **吊装**：配送必须补齐**吊装公司 / 物业许可 / 天气 / 保险**四项并报价才能施工；
     施工可能成功或失败，失败时区分**买家环境限制 / 配送方案误判 / 第三方（吊装公司）责任**，
     定责后买家可重新选择方案；
   - **退货回库**：配送/仓库登记回程运费与回库库位，订单退货完结；
     仓库 `cangguan` 复检后可**二次上架**（补充通道尺寸、可改为仅同城自提）；
   - **改送其他地址**：填新地址/楼层/电梯，系统试算二次配送费，配送重新排班并送达。
   每一步都会自动写入该单的"沙发进不了电梯"协同工单，方案演进与费用在改约单全程留痕。
7. **买家**在订单页发起"色差/磕碰/退货"工单；**仓库、配送、客服**依次进入同一工单留言协同；
   **客服 `kefu`** 裁定处理结论（维持/降价/卖家或平台赔付/退货退款/重新上架/终止寄卖），
   订单、商品、寄卖单状态随之联动。
8. **客服**在"结算管理"对已送达订单生成结算单：成交价、佣金、翻新费、仓储费（按在仓天数）、
   配送费、**改约费（拆装加价/吊装费/二次配送费，按定责在买家与平台间分流）**、
   **吊装公司第三方赔付**、售后赔付、卖家应得逐项列出**来源说明**；退货单展示平台吸收的成本。
9. **运营 `ops`**：查看六品类成交周期、翻新投入占比、退货原因、配送失败率与
   "适合入仓寄卖 / 建议同城自提"渠道建议；查看卖家风险画像排序。
10. 用 **`linfan`** 再提交一件寄卖，确认申请自动带上"严格验真"；卖家在约估价后反悔，
    画像中反悔次数与风险分立即变化。

## 五、自动化验证

后端附端到端接口脚本（需要先启动后端与空库/种子库）：

```bash
cd backend
bash e2e-test.sh
```

覆盖：鉴权与角色拦截 → 申请（画像联动）→ 六项验真估价（含底价校验）→ 作业记账 →
上架 → 下单与配送费计价 → 排班/装车/送达 →
**配送改约全链路（现场登记与自动开工单 → 吊装四项确认 → 吊装失败三类定责 ×3 → 改拆装成功、
改地址二次配送、退货回库二次上架 → 改约费用与第三方赔付进入结算）** →
工单协同与客服裁定 → 结算金额与来源 →
品类分析与渠道建议 → 严格验真触发 → 反悔计入画像，共 71 项断言。

> e2e 脚本面向**全新种子库一次性运行**（会创建新订单/改约单），重复执行前请重置数据：
> `docker compose down -v && docker compose up --build`，或本地 `dropdb furniture && createdb furniture` 后重启后端。

## 六、实际执行过的验证（本工作区）

- `cd backend && npx tsc` 编译通过；`cd frontend && npm run build`（tsc 类型检查 + vite 打包）通过。
- 本机临时 PostgreSQL 15 实例（127.0.0.1:5433，trust 认证全新空库）上启动后端，
  种子数据（含一单 BLOCKED 三人沙发改约、一单已回库退货改约）成功写入。
- `bash backend/e2e-test.sh`（全新种子库）结果：**PASS=71 FAIL=0**。
- Vite dev server 返回 200，经其 `/api` 代理登录接口返回有效 JWT。
- Docker 守护进程在当前沙箱不可用，镜像未在本机实际构建；`docker-compose.yml`
  与两个 Dockerfile 已按标准 node:22-alpine / nginx:1.27-alpine 多阶段构建编写，
  请在有 Docker 的环境执行 `docker compose up --build` 验证。

## 七、核心业务规则

- **验真等级**：风险分 = 反悔×3 + 描述不符×2 + 售后争议×1 − 成交×0.5；≥4 分或描述不符 ≥2 次
  → 新寄卖自动 STRICT（估价师工作台置顶，逐项核对）。
- **价格**：最低成交价（底价）不可高于寄卖价；买家出价低于底价无法下单。
- **配送费**：基础 ¥60；无电梯/楼梯房 `（楼层−1)×¥15`；旧家具搬出 +¥80；配送半径 0km（同城自提）免配送费。
- **仓储费**：在仓商品按 ¥3/天，从入库时间计至结算日；留卖家家中不收仓储费。
- **配送改约（家具进不了电梯/楼道）**：
  - 配送员到场受阻必须登记：现场照片、楼层、电梯进深/门宽、楼梯转角宽度、家具最大边、
    拆装可能性（可拆/部分可拆/不可拆）、现场人工加价；系统据此自动判定
    ELEVATOR_TOO_SMALL / STAIR_TOO_NARROW 计入品类失败率，并自动开 ELEVATOR_BLOCK 协同工单。
  - 买家四选一：**拆装上楼**（收现场人工加价）/ **吊装**（须先确认吊装公司、物业许可、
    天气、保险四项并报价）/ **退货回库**（买家全额退款，回程运费+回库费按定责分流）/
    **改送其他地址**（二次配送费 = ¥60 + 无电梯（楼层−1）×¥15）。
  - **吊装失败三分类**：买家环境限制 → 已发生费用买家承担；配送方案误判 → 平台吸收；
    第三方（吊装公司）→ 平台先承担、第三方认赔冲抵；失败后买家可重新选择方案，历史留痕。
  - 退货回库后商品置 RETURNED 在仓，仓库复检后可二次上架（可改价/改配送半径/补通道尺寸），
    未二次上架则不产生新的在售记录。
- **结算**：
  - 正常成交：卖家应得 = 成交价 − 佣金（估价单费率）− 清洁翻新费（作业记录）− 仓储费 − 卖家责任赔付；
    平台净收入 = 佣金 + 配送费 − 平台责任赔付。
  - 退货：买家全额退款，卖家应得为 0，已发生的翻新/仓储/配送成本由平台吸收（工单另有约定从其约定）。
- **渠道建议**：品类配送失败率 ≥25% 或电梯/楼道受阻占失败多数 → 建议同城自提为主；
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
- **配送改约**（前缀 `/reschedules`）：
  - `POST /reschedules/deliveries/:orderId/report`（配送员登记现场照片/楼层/通道尺寸/拆装可能性/人工加价，自动开工单）
  - `GET /reschedules`（按角色过滤）、`GET /reschedules/:id`、`GET /reschedules/order/:orderId`
  - `POST /reschedules/:id/choose-plan`（买家选择 DISASSEMBLY / HOISTING / RETURN / CHANGE_ADDRESS）
  - `POST /reschedules/:id/hoisting/confirm`（吊装公司/物业许可/天气/保险四项+报价）、
    `POST /reschedules/:id/hoisting/success`、
    `POST /reschedules/:id/hoisting/fail`（三分类定责 BUYER_ENVIRONMENT / PLAN_MISJUDGMENT / THIRD_PARTY）
  - `POST /reschedules/:id/disassembly/complete`（拆装上楼送达）
  - `POST /reschedules/:id/warehouse-return`（回库库位/回程运费/回库费）、
    `POST /reschedules/:id/relist`（仓库复检后二次上架）
  - `POST /reschedules/:id/redelivery/schedule`（改地址二次配送排班）
- `POST /tickets`（任意相关方发起异常）、`GET /tickets`、`GET /tickets/:id`、
  `POST /tickets/:id/messages`（六方协同留言）、`POST /tickets/:id/resolve`（客服裁定）
- `GET /settlements`、`GET /settlements/order/:orderId`、`POST /settlements/order/:orderId/generate`
  （明细含 RESCHEDULE_FEE 改约费、THIRD_PARTY_COMPENSATION 第三方赔付，均带来源说明）
- `GET /analytics/by-category`（品类指标与渠道建议）、
  `GET /analytics/seller-profiles`、`GET /analytics/seller-profiles/:sellerId`

## 九、目录结构

```
.
├── docker-compose.yml          # db + backend + frontend 一键启动
├── backend/                    # NestJS + TypeORM + PostgreSQL
│   ├── Dockerfile
│   ├── src/
│   │   ├── entities/           # 14 张核心表（含配送改约单+方案流水）
│   │   ├── auth/               # JWT + 角色守卫
│   │   ├── risk/               # 卖家风险画像（全局服务）
│   │   ├── consignments/ appraisals/ items/ orders/
│   │   ├── deliveries/ reschedules/ tickets/ settlements/ analytics/ seeder/
│   │   └── main.ts
│   └── e2e-test.sh             # 64 项端到端断言
└── frontend/                   # React + Vite
    ├── Dockerfile  nginx.conf
    └── src/views/              # 登录 + 7 类角色工作台 + 配送改约共享页
```
