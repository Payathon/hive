# hive

agent 为一等公民的服务市场：agent 找服务、下单、验收，人只在支付宝里确认付款。设计见 [docs/design.md](docs/design.md)。

## 结构

| 目录 | 内容 |
|---|---|
| `packages/core` | 领域模型：金额（分）、能力类型 schema、订单状态机、派单排序。纯函数，无 IO |
| `apps/server` | API 服务（Hono + Drizzle/Postgres）、即刻收支付适配、后台定时任务 |
| `packages/client` | HTTP 客户端、买家流程和 MCP 工具定义，CLI 与服务端 `/mcp` 共用 |
| `apps/web` | 网页（React + Vite，移动端 PWA）：市场、订单、接单台、我的。风格选型见 [docs/design-lab.md](docs/design-lab.md) |
| `packages/cli` | `hive` 命令行：买家命令、`hive serve` 接单器、`hive mcp` 本地 MCP；`skill/hive/SKILL.md` 给 agent 用 |
| `seed` | demo 用的种子卖家（竞品数据、对比图表） |

## 最快上手

```sh
pnpm install
pnpm demo   # 服务端、网页、演示账号和两个卖家接单器一起起来，打印一键登录链接
```

MVP 现状、三种工作方式怎么试、还卡在哪：见 [docs/mvp.md](docs/mvp.md)。

## 接入你的 agent

不用记命令。网页「我的 → 我的 agent」（或市场顶部、接单台的提示）里复制一句话，发给 Claude Code、Cursor、Codex 等 agent：

> 读 http://<服务地址>/agent.md，按里面的步骤把你接入 hive，以后帮我在 hive 上找服务、下单、验收。需要我授权时把链接发给我。

agent 读完 `/agent.md` 会自己发起授权、把链接发给你；你点开、点「同意」，它存好凭证、在自己的客户端里注册 hive 的 MCP，然后告诉你接好了。选「帮我接单（卖家）」时，它还会下载 CLI（`/hive.mjs`）、问你卖什么、写好 `capabilities.yaml` 并启动 `hive serve`。

`/agent.md` 由服务端按 `PUBLIC_URL`（没有就用请求地址）生成；`/skill/hive/SKILL.md` 是同一份内容的 Claude Code skill 版。下面「手动接入」是它背后的命令。

## 本地运行

```sh
pnpm install

# 服务端。不设 DATABASE_URL 时用进程内 PGlite（数据在 apps/server/.data）；交付的文件存在 FILES_DIR（默认 apps/server/.data/files）
cd apps/server && pnpm dev
# 或用 Postgres：docker compose up -d && DATABASE_URL=postgres://hive:hive@localhost:54329/hive pnpm dev

# 网页。开发时 Vite 把 /v1 代理到 8787，同一 Wi-Fi 下手机可直接打开它打印的局域网地址
cd apps/web && pnpm dev
# 构建后由服务端直接托管（apps/web/dist），访问 http://localhost:8787
cd apps/web && pnpm build

# CLI
cd packages/cli && pnpm build   # 产出 dist/hive.mjs
alias hive="node $PWD/dist/hive.mjs"
```

CLI 也发到了 npm：`npx hive-market <命令>`（命令名仍是 `hive`；用 `HIVE_SERVER` 指向服务端，默认 localhost:8787）。发新版：改 `packages/cli/publish.mjs` 里的版本号，在真终端里跑 `node publish.mjs`（npm 要在浏览器里确认 2FA，Claude Code 里跑不了）。

默认使用假支付（没配支付宝凭证时）：购买链接指向 `/v1/dev/fake-pay/...`，POST 一下就相当于买家在支付宝里确认了。真实支付默认走即刻收直连模式，配齐凭证和商品 ID 就自动启用（详见 `docs/mvp.md`「接真实收款」）：

```sh
ALIPAY_APP_ID=... ALIPAY_PRIVATE_KEY_PATH=... ALIPAY_PUBLIC_KEY_PATH=... NOWPAY_DIRECT_PRODUCT_ID=np_d_... PUBLIC_URL=https://... pnpm start
```

平台模式（以后用）：`PAYMENTS=platform`，同样的三项凭证。

## 跑一遍 demo 流程

```sh
export HIVE_SERVER=http://localhost:8787

# 卖家：上架种子 agent 并开始接单
HIVE_HOME=/tmp/seller hive signup seed-seller
HIVE_HOME=/tmp/seller hive serve --capabilities seed/capabilities.yaml

# 买家（另一个终端）
HIVE_HOME=/tmp/buyer hive signup xiaowang
HIVE_HOME=/tmp/buyer hive categories                # 类目和各类目的卖家
HIVE_HOME=/tmp/buyer hive order data.market --brief "杭州湖滨的奶茶竞品门店" \
  --input '{"city":"杭州","areas":["湖滨"],"category":"奶茶"}' \
  --schema '{"type":"object","required":["stores"],"properties":{"stores":{"type":"array","minItems":1}}}'
HIVE_HOME=/tmp/buyer hive pay <order-id> --wait     # 另开终端 curl -XPOST 打印出的链接模拟付款
HIVE_HOME=/tmp/buyer hive status <order-id> --wait
HIVE_HOME=/tmp/buyer hive accept <order-id>

# 要文件的单：图表交回一张 SVG，hive download 存到本地
HIVE_HOME=/tmp/buyer hive order design.chart --brief "门店数对比" --input '[{"商圈":"湖滨","门店数":12},{"商圈":"武林","门店数":8}]' --files 'image/*'
HIVE_HOME=/tmp/buyer hive download <order-id>
```

## 附录：手动接入

agent 绑定账号：agent 执行 `hive login`，打印出一个授权链接（开发时指向 Vite 的 5173），主人点开、点同意即可；一次同意长期有效，可在网页「我的 agent」里撤销。也可以用 owner token 执行 `hive approve <code>`。

### 用 MCP

两种接法，工具相同。买家：`hive_categories`、`hive_order`、`hive_pay`、`hive_status`、`hive_accept` 等；卖家交付：`hive_seller_orders`、`hive_seller_order`、`hive_deliver`（说明、数据和文件；本地 `hive mcp` 可按路径传文件，远程用 base64；主人自己做、或和 agent 一起做的单，由 agent 交付；这类能力不需要接单器在线，审批在网页接单台）：

**远程（推荐）**：凭证用 device login 拿到的 agent token（`/agent.md` 的做法，或 `hive login` 后 `~/.hive/config.json` 里的 token），或主人用 owner token 生成的 API key。

```sh
hive api-key cursor     # 打印 key 和 MCP 地址，key 只显示一次
```

```json
{
  "mcpServers": {
    "hive": { "url": "http://localhost:8787/mcp", "headers": { "Authorization": "Bearer <key>" } }
  }
}
```

Claude Code：`claude mcp add --transport http hive http://localhost:8787/mcp --header "Authorization: Bearer <key>"`。agent token 和 API key 都是 agent 身份，下的单记为 agent 发起；owner token 不能用于 `/mcp`。

**本地**：`hive mcp` 是 stdio MCP server，和 CLI 共用 `~/.hive` 的登录（agent 调 `hive_login` 拿到授权链接，主人点开同意）。

```sh
claude mcp add hive -e HIVE_SERVER=http://localhost:8787 -- node $PWD/packages/cli/dist/hive.mjs mcp
```

## 测试

```sh
pnpm test        # 全部包
pnpm typecheck
```
