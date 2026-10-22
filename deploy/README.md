# 部署到公网

现在跑在一台阿里云新加坡 ECS 上（2 vCPU / 3.5 GB，Ubuntu 22.04，`47.84.123.150`），和 [OpenShop](https://github.com/Payathon/openshop) 共用这台机器：

| 地址 | 应用 |
|---|---|
| https://hive.47-84-123-150.sslip.io | hive（API + 网页 + `/hive.mjs`） |
| https://shop.47-84-123-150.sslip.io | OpenShop |

还没有真域名，用的是 [sslip.io](https://sslip.io)：`<任意名字>.47-84-123-150.sslip.io` 自动解析到这个 IP，Let's Encrypt 照样能签证书。

## 服务器上的布局

```
/opt/edge     共用的 Caddy（项目名 edge）：占 80/443，签所有证书，按域名转给各个应用
  docker-compose.yml  Caddyfile  up.sh     ← 来自本仓库 deploy/edge/，hive 的 CD 每次覆盖
  sites/hive.caddy  sites/openshop.caddy   ← 各应用的 up.sh 生成，域名取自各自的 .env
/opt/hive     hive + postgres（项目名 hive，数据卷 hive_pgdata、hive_hive-data）
  .env  docker-compose*.yml  Caddyfile  site.caddy  up.sh  secrets/
/opt/openshop app + postgres + backup（项目名 openshop），见 openshop 仓库的 docs/deploy.md
```

三个 compose 项目通过一个外部 docker 网络 `edge` 连起来：hive 在上面叫 `hive`，OpenShop 叫 `openshop`。应用自己不占任何端口。哪个应用没起来，只有它的域名返回 502，别的不受影响。

| 文件 | 作用 |
|---|---|
| `../Dockerfile` | hive 镜像：构建网页和 CLI，用 tsx 跑服务端，非 root，带 `/healthz` 健康检查 |
| `docker-compose.yml` | hive、postgres 和数据卷（Postgres 数据、hive 的 `/data`：交付文件、`vapid.json`、`fake-pay.json`） |
| `docker-compose.edge.yml` | 共用服务器：hive 加入 `edge` 网络 |
| `docker-compose.caddy.yml` | 这台机器只跑 hive：自带 Caddy，占 80/443（用 `Caddyfile`） |
| `docker-compose.build.yml` | 备用：从源码构建镜像，不从 GHCR 拉 |
| `site.caddy` | hive 在共用 Caddy 上的站点配置模板；`up.sh` 填上域名写到 `/opt/edge/sites/hive.caddy`。不缓冲、不设超时，长轮询 `/v1/seller/poll` 和 `/mcp` 不会被切断 |
| `up.sh` | 启动或更新：拉镜像、`up -d`、写站点配置、启动或 reload 共用 Caddy。CD 和手动都用它 |
| `edge/` | 共用 Caddy 本身（compose、只有一行 `import` 的 Caddyfile、`up.sh`） |
| `.env.example` | 所有环境变量的说明，复制成 `/opt/hive/.env` |
| `setup.sh` | 新机器一次性初始化：装 Docker 和 compose 插件、建 `/opt/hive`、小内存机器加 swap |

用哪几个 compose 文件由 `.env` 里的 `COMPOSE_FILE` 决定（docker compose 自己会读），所以在 `/opt/hive` 里直接敲 `docker compose ps`、`docker compose logs -f hive` 就行，不用带 `-f`：

- 共用服务器：`COMPOSE_FILE=docker-compose.yml:docker-compose.edge.yml`（现在用的）
- 只跑 hive：`COMPOSE_FILE=docker-compose.yml:docker-compose.caddy.yml`

## 换成真域名

1. 域名加 A 记录指向服务器 IP（OpenShop 以后做店铺子域名时再加 `*`）。
2. 改 `/opt/hive/.env` 的 `DOMAIN`（`PUBLIC_URL`、`WEB_URL` 默认跟着它），在 `/opt/hive` 里跑 `./up.sh`。共用 Caddy 会重新生成站点配置并自动签新证书。OpenShop 同理：改 `/opt/openshop/.env` 的 `OPENSHOP_DOMAIN`，跑 `/opt/openshop/up.sh`。
3. 旧域名的站点会消失；已经发出去的一键登录链接、`/agent.md` 里写的地址要用新的重新发。

## 1. 买机器、配域名（新机器才需要）

1. 买一台云服务器：**新加坡区**（OpenShop 要从服务器调 Claude API，香港不行），2 vCPU / 2–4 GB 内存，系统 **Ubuntu 24.04**（22.04 也行），带公网 IP。
2. 安全组放行入方向 **TCP 22、80、443**（UDP 443 给 HTTP/3，可选），来源 `0.0.0.0/0`。80 必须开，签证书要用。
3. 创建时绑定你的 SSH 公钥（或之后放进 `~/.ssh/authorized_keys`）。登录用户：阿里云 Ubuntu 一般是 `root`，腾讯云是 `ubuntu`。
4. 有域名就加一条 **A 记录**指向服务器公网 IP，`dig +short hive.example.com` 确认解析到了再往下走；没有就用 `hive.<IP 用横线连>.sslip.io`。

## 2. 初始化服务器（只做一次）

```sh
scp deploy/setup.sh <user>@<ip>:~
ssh <user>@<ip> 'bash setup.sh'
# 不是 root 时会把你加进 docker 组：退出重新 ssh 一次才生效
```

## 3. 填 `.env`，启动

最省事的是先填好 `.env`，再让 CD（第 6 节）把其余文件拷上去并启动。手动的话：

```sh
ssh <user>@<ip> 'mkdir -p /opt/hive /opt/edge'
scp deploy/docker-compose*.yml deploy/Caddyfile deploy/site.caddy deploy/up.sh <user>@<ip>:/opt/hive/
scp deploy/edge/docker-compose.yml deploy/edge/Caddyfile deploy/edge/up.sh <user>@<ip>:/opt/edge/
scp deploy/.env.example <user>@<ip>:/opt/hive/.env
ssh <user>@<ip>
cd /opt/hive
vi .env            # 至少填 DOMAIN 和 POSTGRES_PASSWORD（openssl rand -hex 24），选好 COMPOSE_FILE
./up.sh
```

`PUBLIC_URL`、`WEB_URL` 默认都是 `https://$DOMAIN`（网页和 API 同源），`DATABASE_URL` 默认连 compose 里的 Postgres，一般都不用填。服务端每次启动自动跑数据库迁移。

**镜像拉不下来？** `ghcr.io/payathon/hive` 默认是私有包，服务器上手动 `./up.sh` 时拉不到就继续用机器上已有的镜像（CD 每次会用工作流自己的 token 临时登录再拉，不受影响）。想让手动也能拉：在 GitHub 组织的 Packages → hive → Package settings 里把可见性改成 Public（镜像里没有密钥），或者在服务器上 `docker login ghcr.io`（一个只有 `read:packages` 的 classic token）。

**不用 GHCR，在服务器上直接构建**：把仓库 clone 到服务器上，在 clone 的 `deploy/` 目录里放 `.env`，`COMPOSE_FILE` 末尾加上 `:docker-compose.build.yml`，然后在那里跑 `./up.sh`。

## 4. 验证

```sh
curl https://hive.example.com/healthz      # {"ok":true,"payments":"fake"}
curl https://hive.example.com/agent.md     # 里面的地址应该是 https://hive.example.com
docker compose ps                          # hive 和 postgres 都是 healthy
docker compose logs -f hive                # hive server on https://hive.example.com (payments: fake, mail: outbox)
```

证书第一次签发要几秒到一分钟；签不下来看 `docker compose -f /opt/edge/docker-compose.yml logs caddy`（只跑 hive 时是 `docker compose logs caddy`），通常是 A 记录没生效或 80/443 没放行（日志里是 `Timeout during connect (likely firewall problem)`）。

## 注意：假支付下的公开页面

没配支付宝凭证时是假支付（`/healthz` 里 `"payments":"fake"`）。这时 `/v1/dev/*` 是公开的：

- `/v1/dev/fake-pay/...`：任何拿到付款链接的人点「确认付款」都算付了款
- `/v1/dev/mail`：没配 SMTP 时，所有本该发出的邮件（含订单链接）谁都能看

黑客松 demo 没有真钱，这样可以接受；给真实用户用之前要么配上即刻收（`.env` 里的 `ALIPAY_*`、`NOWPAY_DIRECT_*`，见 `docs/mvp.md`「接真实收款」），要么配上 SMTP。配了真实收款后 `/v1/dev/*` 自动关闭。

## 5. 在公网服务器上搭演示世界

`seed/demo.mjs` 和两个卖家的接单器都在**你自己的电脑上**跑，只是指向公网服务器：

```sh
# 仓库根目录
export HIVE_SERVER=https://hive.example.com
export HIVE_DEMO_DIR=.demo-public          # 和本地 demo 的 .demo 分开（已在 .gitignore 里）
node seed/demo.mjs                          # 建「小王」「hive 工作室」「我的小店」，链接写到 .demo-public/README.md
pnpm --filter @hive/cli build               # 有 dist/hive.mjs 就不用

# 两个接单器（各开一个终端，或用 tmux）
HIVE_HOME=.demo-public/studio node packages/cli/dist/hive.mjs serve --capabilities .demo-public/studio/capabilities.yaml
HIVE_HOME=.demo-public/shop   node packages/cli/dist/hive.mjs serve --capabilities .demo-public/shop/capabilities.yaml

HIVE_DEMO_DIR=.demo-public node seed/e2e.mjs   # 把所有工作方式走一遍（只在假支付下能跑）
```

- `capabilities.yaml` 里的 `run:` 是你电脑上 `seed/*.mjs` 的绝对路径，所以接单器要在 clone 了仓库的机器上跑。
- 「hive 工作室」的文案、翻译、摘要、调研、写代码和「我的小店」的代码审查调用 `claude -p`：跑接单器的机器要装好 Claude Code 并已登录（`claude` 能直接用）。一般就是你的笔记本，服务器上不需要。
- 接单器只往外发请求（长轮询），笔记本在 NAT 后面也没关系；合上盖子接单器就离线，派单会跳过它。
- 一键登录链接（`/welcome#token=…`）等于账号密码，别发到公开的地方。

## 6. 自动部署（GitHub Actions）

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `ci.yml` | push、PR | 装依赖、typecheck、测试（PGlite 一遍、Postgres 16 一遍）、构建网页和 CLI、构建镜像（不推） |
| `deploy.yml` | `main` 上 CI 通过后（也可手动触发：`gh workflow run deploy.yml -R Payathon/hive`） | 构建镜像推到 `ghcr.io/payathon/hive`（`sha-<12位>` 和 `latest`），再 SSH 到服务器：把 `deploy/` 的文件拷到 `/opt/hive`、`deploy/edge/` 拷到 `/opt/edge`，临时登录 GHCR，`HIVE_IMAGE=…:sha-… ./up.sh`，等健康检查通过 |
| `npm.yml` | 推 `cli-v*` tag | 把 CLI 发到 npm（`hive-market`） |

**要在仓库 Settings → Secrets and variables → Actions 里加的 secrets**（没加时 deploy 只推镜像，跳过上线，不会变红）：

| Secret | 值 |
|---|---|
| `DEPLOY_HOST` | 服务器公网 IP 或域名 |
| `DEPLOY_USER` | SSH 用户（`root` / `ubuntu`），要在 docker 组里 |
| `DEPLOY_SSH_KEY` | 给 CI 专用的私钥全文。生成：`ssh-keygen -t ed25519 -f payathon-deploy -N ''`，把 `.pub` 追加到服务器的 `~/.ssh/authorized_keys` |

现在两个仓库（hive、openshop）都已经设好这三个 secret，用的是同一把 deploy key（`~/.ssh/payathon_deploy`，公钥在服务器 root 的 `authorized_keys` 里）：`DEPLOY_HOST=47.84.123.150`、`DEPLOY_USER=root`。

`.env` 只在服务器上，CI 不碰它；改了 `.env` 后在 `/opt/hive` 跑 `./up.sh` 生效。回滚：`HIVE_IMAGE=ghcr.io/payathon/hive:sha-<旧版本> ./up.sh`（私有包要先 `docker login ghcr.io`，或者用机器上还留着的镜像）。

## 7. 发 CLI 到 npm（trusted publishing）

一次性设置：npmjs.com 登录 → 包 `hive-market` → Settings → **Trusted publisher** → GitHub Actions，Organization/user 填 `Payathon`，Repository 填 `hive`，Workflow filename 填 `npm.yml`（Environment 留空）。之后不需要 npm token，也不用输 2FA。

发版：

```sh
git tag cli-v0.1.1 && git push origin cli-v0.1.1   # 版本号取自 tag
```

**CLI 的默认服务器**：现在发出去的 CLI 默认连 `http://localhost:8787`，用的人要设 `HIVE_SERVER`。公网服务器定下来后，在仓库 Settings → Variables 里加变量 `HIVE_DEFAULT_SERVER=https://hive.example.com`，下一次发版就会把它编进 CLI（`HIVE_SERVER`、`--server` 和已保存的配置仍然优先）。本地手动发：`HIVE_DEFAULT_SERVER=https://… node packages/cli/publish.mjs --version=0.1.1`。
