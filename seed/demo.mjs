// Sets up a ready-to-use demo world against a running hive server:
//   买家「小王」      an account whose agent is already authorized (CLI config + MCP API key)
//   「hive 工作室」   a fully automatic seller: seed agents and Claude Code, accept: auto
//   「我的小店」      a seller you play: one listing approved-then-agent, two done by hand
// Usage (repo root, server running):  node seed/demo.mjs [--reset]
// Everything lands in .demo/ (git-ignored, HIVE_DEMO_DIR overrides); .demo/README.md has the links and commands.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const demo = process.env.HIVE_DEMO_DIR ? resolve(process.env.HIVE_DEMO_DIR) : join(root, ".demo");
const server = process.env.HIVE_SERVER ?? "http://localhost:8787";
const statePath = join(demo, "state.json");

async function call(method, path, token, body) {
  const res = await fetch(server + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return data;
}

// An agent token the same way a real agent gets one: `hive login`, then the owner approves the link.
async function authorizeAgent(ownerToken, label) {
  const dl = await call("POST", "/v1/device-logins", null, { label });
  await call("POST", "/v1/device-logins/approve", ownerToken, { userCode: dl.userCode });
  const r = await call("POST", `/v1/device-logins/${dl.id}/poll`, null, { secret: dl.secret });
  if (!r.token) throw new Error(`device login for ${label} was not approved`);
  return { token: r.token, webUrl: new URL(dl.verificationUri).origin };
}

async function persona(key, name, agentLabel) {
  const account = await call("POST", "/v1/accounts", null, { name });
  const agent = await authorizeAgent(account.token, agentLabel);
  const home = join(demo, key);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "config.json"), JSON.stringify({ server, token: agent.token, pendingLogin: null }, null, 2) + "\n", { mode: 0o600 });
  return { name, ownerToken: account.token, agentToken: agent.token, home, webUrl: agent.webUrl };
}

const yaml = (entries) =>
  entries
    .map((e) =>
      [
        `- category: ${e.category}`,
        `  accept: ${e.accept}`,
        `  daily_limit: ${e.daily_limit ?? 200}`,
        `  tags: [${e.tags.join(", ")}]`,
        `  intro: ${e.intro}`,
        e.run ? `  run: ${e.run}` : `  delivery_hours: ${e.delivery_hours}`,
      ].join("\n"),
    )
    .join("\n") + "\n";

const node = (script) => `node ${join(root, "seed", script)}`;

async function stillValid(state) {
  try {
    for (const p of [state.buyer, state.studio, state.shop]) await call("GET", "/v1/me", p.ownerToken);
    return true;
  } catch {
    return false;
  }
}

if (process.argv.includes("--reset")) rmSync(demo, { recursive: true, force: true });
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
if (state && !(await stillValid(state))) {
  console.log("existing .demo/ belongs to another database; recreating it");
  rmSync(demo, { recursive: true, force: true });
  state = null;
}

if (!state) {
  mkdirSync(demo, { recursive: true });
  const buyer = await persona("buyer", "小王", "小王的 Claude Code");
  const apiKey = await call("POST", "/v1/api-keys", buyer.ownerToken, { label: "远程 MCP" });
  const studio = await persona("studio", "hive 工作室", "工作室接单器");
  const shop = await persona("shop", "我的小店", "小店接单器");

  writeFileSync(
    join(studio.home, "capabilities.yaml"),
    yaml([
      { category: "data.market", accept: "auto", tags: ["竞品", "门店", "奶茶", "选址"], intro: "秒出示例竞品门店数据", run: node("data-agent.mjs") },
      { category: "design.chart", accept: "auto", tags: ["柱状图", "对比", "图表"], intro: "把数据画成 SVG 柱状图", run: node("chart-agent.mjs") },
      { category: "content.writing", accept: "auto", tags: ["文案", "小红书", "公众号"], intro: "Claude 写文案，几分钟交付", run: node("claude-agent.mjs") },
      { category: "content.translation", accept: "auto", tags: ["翻译", "英文", "日文"], intro: "Claude 翻译，几分钟交付", run: node("claude-agent.mjs") },
      { category: "content.summary", accept: "auto", tags: ["摘要", "纪要", "总结"], intro: "Claude 整理摘要和纪要", run: node("claude-agent.mjs") },
      { category: "data.research", accept: "auto", tags: ["调研", "资料", "报告"], intro: "Claude 上网查资料并整理", run: node("claude-agent.mjs") },
      { category: "dev.code", accept: "auto", tags: ["脚本", "Python", "自动化"], intro: "Claude 写脚本，以文件交付", run: node("claude-agent.mjs") },
    ]),
  );
  writeFileSync(
    join(shop.home, "capabilities.yaml"),
    yaml([
      // 审批 + agent: you approve on the 接单台, then Claude does the work.
      { category: "dev.review", accept: "ask", tags: ["代码审查", "review", "安全"], intro: "我先看需求再接，接了由 agent 审查", run: node("claude-agent.mjs") },
      // 审批 + 我自己来: an offline job you deliver from the phone camera.
      { category: "onsite.photo", accept: "ask", tags: ["拍照", "探店", "门头", "湖滨"], intro: "杭州湖滨附近，2 小时内拍好", delivery_hours: 2 },
      // 自动接单 + 我自己来: taken at once, you deliver by hand or through your agent's MCP.
      { category: "design.image", accept: "auto", tags: ["海报", "封面", "配图"], intro: "自动接单，24 小时内人工交付", delivery_hours: 24 },
    ]),
  );

  state = {
    server,
    webUrl: buyer.webUrl,
    mcpKey: apiKey.key,
    buyer: { ...buyer },
    studio: { ...studio },
    shop: { ...shop },
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

// Fake addresses: without SMTP, mail only reaches the dev outbox. Set every run so older .demo/ worlds get them too.
const emails = { buyer: "buyer@hive.demo", studio: "studio@hive.demo", shop: "shop@hive.demo" };
try {
  for (const [key, email] of Object.entries(emails)) await call("PATCH", "/v1/me", state[key].ownerToken, { email });
} catch {
  console.warn("this server predates email notifications; restart it to get them");
}

const login = (p) => `${state.webUrl}/welcome#token=${p.ownerToken}`;
// Push needs a secure context: https and http://localhost are, a plain-http LAN address is not.
const local = new URL(state.webUrl);
if (local.protocol === "http:") local.hostname = "localhost";
const localLogin = (p) => `${local.origin}/welcome#token=${p.ownerToken}`;
const cli = `node ${join(root, "packages/cli/dist/hive.mjs")}`;
const readme = `# hive 演示环境

由 \`node seed/demo.mjs\` 生成，连的是 ${state.server}。这些 token 只用于本地演示。

## 账号（点链接直接登录网页；一个浏览器同时只登一个账号，买家和卖家用两个浏览器或手机）

| 角色 | 网页登录 | agent |
|---|---|---|
| 买家「小王」 | ${login(state.buyer)} | 已授权：「小王的 Claude Code」，CLI 配置在 \`.demo/buyer\`；远程 MCP key 也已生成 |
| 卖家「我的小店」（你来扮演） | ${login(state.shop)} | 已授权：「小店接单器」 |
| 卖家「hive 工作室」（全自动） | ${login(state.studio)} | 已授权：「工作室接单器」 |

## 接入你自己的 agent（推荐先试这个）

用上面任一账号登录网页，进「我的 → 我的 agent」点「接入新的 agent」（没有 agent 的新账号直接就是这张卡），复制那句话给你的 Claude Code / Cursor / Codex。也可以直接复制：

> 读 ${state.webUrl}/agent.md，按里面的步骤把你接入 hive，以后帮我在 hive 上找服务、下单、验收。需要我授权时把链接发给我。

agent 会发来一个授权链接，点开点「同意」就行（没登录会先让你注册，再回到授权页）。想让它当卖家，选「帮我接单（卖家）」那句：它会下载 ${state.server}/hive.mjs、问你卖什么、启动 \`hive serve\`。

## 接单器

\`pnpm demo\` 已经把两个卖家的接单器跑起来了。只跑 \`node seed/demo.mjs\` 时，在仓库根目录另开两个终端：

\`\`\`sh
HIVE_HOME=.demo/studio ${cli} serve --capabilities .demo/studio/capabilities.yaml
HIVE_HOME=.demo/shop   ${cli} serve --capabilities .demo/shop/capabilities.yaml
\`\`\`

## 附录：手动接入（演示买家「小王」已授权好的凭证）

本地 MCP（Claude Code）：

\`\`\`sh
claude mcp add hive -e HIVE_HOME=${join(demo, "buyer")} -- ${cli} mcp
\`\`\`

远程 MCP：\`${state.server}/mcp\`，Header \`Authorization: Bearer ${state.mcpKey}\`

或者直接用 CLI：\`HIVE_HOME=.demo/buyer ${cli} categories\`

## 三种工作方式各试一单

| 工作方式 | 下单（买家） | 卖家这边 |
|---|---|---|
| 全自动 | 文案、翻译、摘要、调研、写代码、竞品数据、图表 | 工作室自动接单，付款后 agent 干活并交付 |
| 审批 + agent | 代码审查 \`dev.review\` | 「我的小店」接单台弹出派单，你点抢单；付款后 agent 自动审查交付 |
| 人工（线下） | 实地拍照 \`onsite.photo\`，要 3 张图片 | 你抢单，付款后在订单页拍照上传交付 |
| 人工（自动接单） | 图片设计 \`design.image\` | 平台直接替小店接单；你在网页上传，或让你的 agent 用 \`hive_deliver\` 交付 |

付款是假支付：订单页点「去支付宝付款」，或者打开 agent 给的链接点「确认付款」，就算付过了。

## 通知：人不在网页上也能收到

- **消息**：每个页面右上角的铃铛，红点是未读数；点开是全部消息，点一条进订单
- **系统通知（Web Push）**：要 https 或 localhost 才能开（本地演示时局域网地址是 http，不算安全环境，收不到推送，手机上只有铃铛）。用这两个链接打开：
  - 买家「小王」：${localLogin(state.buyer)}
  - 卖家「我的小店」：${localLogin(state.shop)}

  进「我的 → 通知 → 开启通知」，允许浏览器通知，点「发一条试试」确认能弹出。然后关掉标签页（Chrome 别退出），让 agent 下单：要付款、已交付（买家），新派单、买家已付款（小店）都会弹系统通知，点通知直接打开订单。全自动的「hive 工作室」只在出错时提醒
- **邮件**：三个账号已填测试邮箱（${Object.values(emails).join("、")}），可以在「我的」里改。没配 SMTP 时邮件不会真的发出，都在测试收件箱 ${state.server}/v1/dev/mail（每 5 秒刷新）；给服务端配 \`SMTP_URL\` 才真发

验证全部流程：\`node seed/e2e.mjs\`（加 \`--keep\` 会留着最后的交付不验收，方便在网页上看）。
`;
writeFileSync(join(demo, "README.md"), readme);
console.log(readme);
