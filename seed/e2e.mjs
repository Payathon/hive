// Walks every work mode end to end against the demo world from seed/demo.mjs:
//   1 全自动          data.market (JSON Schema) and design.chart (file), both seed agents
//   2 审批 + agent    dev.review: 我的小店 approves, its agent reviews after payment
//   3 审批 + 我自己来  onsite.photo: approve, pay, upload photos (too few first, then enough)
//   4 自动 + 我自己来  design.image: hive takes it for 我的小店, delivered over remote MCP
// Needs the server and both listeners from .demo/README.md running. Usage: node seed/e2e.mjs [--keep]
// --keep leaves the last delivery of each mode unreviewed so you can look at it in the web app.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const state = JSON.parse(readFileSync(join(root, ".demo/state.json"), "utf8"));
const server = state.server;
const keep = process.argv.includes("--keep");
const buyer = state.buyer.agentToken; // orders come from the buyer's agent, as in real use
const shop = state.shop.ownerToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, token, body, headers = {}) {
  const res = await fetch(server + path, {
    method,
    headers: { ...(body instanceof Uint8Array ? {} : { "content-type": "application/json" }), authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function ok(...args) {
  const r = await call(...args);
  if (r.status >= 300) throw new Error(`${args[0]} ${args[1]} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function waitFor(id, statuses, ms = 300_000) {
  const end = Date.now() + ms;
  for (;;) {
    let o = await ok("GET", `/v1/orders/${id}`, buyer);
    if (o.status === "AWAITING_PAYMENT") o = await ok("POST", `/v1/orders/${id}/check-payment`, buyer);
    if (statuses.includes(o.status)) return o;
    if (["CANCELLED", "FAILED"].includes(o.status)) throw new Error(`${id} ended ${o.status}: ${o.cancelReason ?? o.failReason}`);
    if (Date.now() > end) throw new Error(`${id} stuck in ${o.status}`);
    await sleep(1000);
  }
}

// What the owner's tap in Alipay does on the fake provider.
async function pay(o) {
  if (!o.purchaseUrl) throw new Error(`${o.id} has no purchase link`);
  const res = await fetch(new URL(new URL(o.purchaseUrl).pathname, server), { method: "POST" });
  if (!res.ok) throw new Error(`fake pay failed: ${res.status}`);
}

async function review(o) {
  if (!keep) await ok("POST", `/v1/orders/${o.id}/verdict`, buyer, { verdict: "accepted" });
}

function png(seed) {
  // Any bytes do for the fake check; a real phone sends JPEGs.
  return new TextEncoder().encode(`\x89PNG fake photo ${seed}`);
}

async function mcp(token, name, args) {
  const res = await fetch(`${server}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const r = await res.json();
  if (r.error || r.result?.isError) throw new Error(`${name}: ${JSON.stringify(r.error ?? r.result.content)}`);
  return r.result.content.map((c) => c.text).join("\n");
}

const results = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push(`PASS  ${name}  (${((Date.now() - t) / 1000).toFixed(1)}s)${detail ? `  ${detail}` : ""}`);
  } catch (e) {
    results.push(`FAIL  ${name}  ${e.message}`);
  }
  console.log(results.at(-1));
}

const stores = {
  type: "object",
  required: ["stores"],
  properties: { stores: { type: "array", minItems: 1, items: { type: "object", required: ["name", "area"], properties: { name: { type: "string" }, area: { type: "string" } } } } },
};

await step("1 全自动 · JSON Schema", async () => {
  let o = await ok("POST", "/v1/orders", buyer, {
    category: "data.market",
    brief: "杭州湖滨、武林的奶茶竞品门店",
    input: { city: "杭州", areas: ["湖滨", "武林"], category: "奶茶" },
    delivery: { kind: "json", schema: stores },
  });
  o = await waitFor(o.id, ["AWAITING_PAYMENT"]);
  await pay(o);
  o = await waitFor(o.id, ["DELIVERED"]);
  await review(o);
  return `${o.output.data.stores.length} 家门店`;
});

await step("1 全自动 · 文件", async () => {
  let o = await ok("POST", "/v1/orders", buyer, {
    category: "design.chart",
    brief: "画湖滨和武林门店数对比",
    input: { title: "门店数", data: [{ label: "湖滨", value: 5 }, { label: "武林", value: 3 }] },
    delivery: { kind: "files", accept: "image/svg+xml", count: 1 },
  });
  o = await waitFor(o.id, ["AWAITING_PAYMENT"]);
  await pay(o);
  o = await waitFor(o.id, ["DELIVERED"]);
  await review(o);
  return o.output.files.map((f) => f.name).join(", ");
});

await step("2 审批 + agent", async () => {
  let o = await ok("POST", "/v1/orders", buyer, {
    category: "dev.review",
    brief: "审查这段 Python，指出 bug 和安全风险",
    input: { code: 'import os\ndef run(cmd):\n    os.system("ls " + cmd)\n' },
  });
  o = await waitFor(o.id, ["OFFERED"]);
  if (o.offerKind !== "human") throw new Error(`expected a human offer, got ${o.offerKind}`);
  const poll = await ok("GET", "/v1/seller/poll", shop);
  if (!poll.offers?.some((x) => x.id === o.id)) throw new Error("the offer did not reach 我的小店's 接单台");
  await ok("POST", `/v1/orders/${o.id}/accept-offer`, shop);
  o = await waitFor(o.id, ["AWAITING_PAYMENT"]);
  await pay(o);
  o = await waitFor(o.id, ["DELIVERED"], 600_000);
  await review(o);
  return o.output.data ? "structured review" : `note ${String(o.output.note).length} chars`;
});

await step("3 审批 + 我自己来（线下拍照）", async () => {
  let o = await ok("POST", "/v1/orders", buyer, {
    category: "onsite.photo",
    brief: "去湖滨银泰门口拍 3 张奶茶店门头，看看排队",
    delivery: { kind: "files", accept: "image/*", count: 3 },
  });
  o = await waitFor(o.id, ["OFFERED"]);
  await ok("POST", `/v1/orders/${o.id}/accept-offer`, shop);
  o = await waitFor(o.id, ["AWAITING_PAYMENT"]);
  await pay(o);
  o = await waitFor(o.id, ["PAID"]);
  const ids = [];
  for (const n of [1, 2, 3]) {
    ids.push((await ok("POST", `/v1/orders/${o.id}/files?name=门头${n}.png`, shop, png(n), { "content-type": "image/png" })).id);
  }
  const short = await call("POST", `/v1/orders/${o.id}/deliver`, shop, { files: ids.slice(0, 2) });
  if (short.status !== 422) throw new Error(`two photos should be refused, got ${short.status}`);
  await ok("POST", `/v1/orders/${o.id}/deliver`, shop, { note: "门口排队约 10 人", files: ids });
  o = await waitFor(o.id, ["DELIVERED"]);
  await review(o);
  return "2 张被拒，3 张通过";
});

await step("4 自动接单 + 我自己来（MCP 交付）", async () => {
  let o = await ok("POST", "/v1/orders", buyer, {
    category: "design.image",
    brief: "做一张奶茶店开业海报",
    delivery: { kind: "files", accept: "image/*", count: 1 },
  });
  o = await waitFor(o.id, ["AWAITING_PAYMENT"]);
  if (o.sellerAccountId === null) throw new Error("no seller took it");
  await pay(o);
  o = await waitFor(o.id, ["PAID"]);
  const list = await mcp(state.shop.agentToken, "hive_seller_orders", {});
  if (!list.includes(o.id)) throw new Error(`hive_seller_orders doesn't list ${o.id}`);
  await mcp(state.shop.agentToken, "hive_deliver", {
    order_id: o.id,
    note: "开业海报一张",
    files: [{ name: "poster.png", mime: "image/png", base64: Buffer.from(png("poster")).toString("base64") }],
  });
  o = await waitFor(o.id, ["DELIVERED"]);
  await review(o);
  return "delivered by the shop's agent over MCP";
});

console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
process.exit(results.every((r) => r.startsWith("PASS")) ? 0 : 1);
