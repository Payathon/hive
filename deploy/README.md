# 部署到公网

一台香港区的 Linux 云服务器（阿里云或腾讯云，香港区不用 ICP 备案），一个域名，Caddy 自动申请 Let's Encrypt 证书。服务器上只有三个容器：`hive`（API + 网页 + `/hive.mjs`）、`postgres`、`caddy`。

| 文件 | 作用 |
|---|---|
| `../Dockerfile` | hive 镜像：构建网页和 CLI，用 tsx 跑服务端，非 root，带 `/healthz` 健康检查 |
| `docker-compose.yml` | 三个服务和数据卷（Postgres 数据、Caddy 证书、hive 的 `/data`：交付文件、`vapid.json`、`fake-pay.json`） |
| `docker-compose.build.yml` | 备用：在服务器上从源码构建镜像，不从 GHCR 拉 |
| `Caddyfile` | `${DOMAIN}` 的 HTTPS 反代；不缓冲、不设超时，长轮询 `/v1/seller/poll` 和 `/mcp` 不会被切断 |
| `.env.example` | 所有环境变量的说明，复制成 `/opt/hive/.env` |
| `setup.sh` | 新机器一次性初始化：装 Docker 和 compose 插件、建 `/opt/hive`、小内存机器加 swap |

## 1. 买机器、配域名

1. 买一台云服务器：**香港区**，2 vCPU / 2–4 GB 内存，系统 **Ubuntu 24.04**（22.04 也行），带公网 IP。
2. 安全组放行入方向 **22、80、443**（TCP；443 再加 UDP 给 HTTP/3 可选）。80 必须开，签证书要用。
3. 创建时绑定你的 SSH 公钥（或之后放进 `~/.ssh/authorized_keys`）。登录用户：阿里云 Ubuntu 一般是 `root`，腾讯云是 `ubuntu`。
4. 域名加一条 **A 记录**指向服务器公网 IP（例如 `hive.example.com`）。用 `dig +short hive.example.com` 确认解析到了再往下走，不然 Caddy 签不到证书。

## 2. 初始化服务器（只做一次）

```sh
scp deploy/setup.sh <user>@<ip>:~
ssh <user>@<ip> 'bash setup.sh'
# 不是 root 时会把你加进 docker 组：退出重新 ssh 一次才生效
```

## 3. 填 `.env`，启动

```sh
scp deploy/docker-compose.yml deploy/Caddyfile <user>@<ip>:/opt/hive/
scp deploy/.env.example <user>@<ip>:/opt/hive/.env
ssh <user>@<ip>
cd /opt/hive
vi .env            # 至少填 DOMAIN 和 POSTGRES_PASSWORD（openssl rand -hex 24）
docker compose pull
docker compose up -d
```

`PUBLIC_URL`、`WEB_URL` 默认都是 `https://$DOMAIN`（网页和 API 同源），`DATABASE_URL` 默认连 compose 里的 Postgres，一般都不用填。服务端每次启动自动跑数据库迁移。

**镜像拉不下来？** `ghcr.io/payathon/hive` 是私有包时，服务器要先登录：在 GitHub 建一个只有 `read:packages` 权限的 classic token，`echo <token> | docker login ghcr.io -u <github 用户名> --password-stdin`。或者在 GitHub 组织的 Packages → hive → Package settings 里把可见性改成 Public，就不用登录（镜像里没有密钥，公开没问题）。自动部署不受影响：它每次用工作流自己的 token 临时登录再拉。

**不用 GHCR，在服务器上直接构建**：把仓库 clone 到服务器上，在 `deploy/` 目录里放 `.env`，然后
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`。

## 4. 验证

```sh
curl https://hive.example.com/healthz      # {"ok":true,"payments":"fake"}
curl https://hive.example.com/agent.md     # 里面的地址应该是 https://hive.example.com
docker compose ps                          # 三个都是 running，hive 和 postgres 是 healthy
docker compose logs -f hive                # hive server on https://hive.example.com (payments: fake, mail: outbox)
```

证书第一次签发要几秒到一分钟；签不下来看 `docker compose logs caddy`，通常是 A 记录没生效或 80 端口没放行。

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
| `deploy.yml` | `main` 上 CI 通过后（也可手动触发） | 构建镜像推到 `ghcr.io/payathon/hive`（`sha-<12位>` 和 `latest`），再 SSH 到服务器：复制 compose 文件和 Caddyfile、拉新镜像、`up -d`、等健康检查通过 |
| `npm.yml` | 推 `cli-v*` tag | 把 CLI 发到 npm（`hive-market`） |

**要在仓库 Settings → Secrets and variables → Actions 里加的 secrets**（没加时 deploy 只推镜像，跳过上线，不会变红）：

| Secret | 值 |
|---|---|
| `DEPLOY_HOST` | 服务器公网 IP 或域名 |
| `DEPLOY_USER` | SSH 用户（`root` / `ubuntu`），要在 docker 组里 |
| `DEPLOY_SSH_KEY` | 给 CI 专用的私钥全文。生成：`ssh-keygen -t ed25519 -f hive-deploy -N ''`，把 `hive-deploy.pub` 追加到服务器的 `~/.ssh/authorized_keys` |

`.env` 只在服务器上，CI 不碰它；改了 `.env` 后在服务器上 `docker compose up -d` 生效。回滚：`HIVE_IMAGE=ghcr.io/payathon/hive:sha-<旧版本> docker compose up -d`。

## 7. 发 CLI 到 npm（trusted publishing）

一次性设置：npmjs.com 登录 → 包 `hive-market` → Settings → **Trusted publisher** → GitHub Actions，Organization/user 填 `Payathon`，Repository 填 `hive`，Workflow filename 填 `npm.yml`（Environment 留空）。之后不需要 npm token，也不用输 2FA。

发版：

```sh
git tag cli-v0.1.1 && git push origin cli-v0.1.1   # 版本号取自 tag
```

**CLI 的默认服务器**：现在发出去的 CLI 默认连 `http://localhost:8787`，用的人要设 `HIVE_SERVER`。公网服务器定下来后，在仓库 Settings → Variables 里加变量 `HIVE_DEFAULT_SERVER=https://hive.example.com`，下一次发版就会把它编进 CLI（`HIVE_SERVER`、`--server` 和已保存的配置仍然优先）。本地手动发：`HIVE_DEFAULT_SERVER=https://… node packages/cli/publish.mjs --version=0.1.1`。
