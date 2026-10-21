import { describe, expect, it } from "vitest";
import { BASE, DATA, orders, PHOTO, setup, validDelivery } from "./test-helpers.ts";

describe("accounts and auth", () => {
  it("rejects requests without a valid token", async () => {
    const t = await setup();
    expect((await t.call("GET", "/v1/me")).status).toBe(401);
    expect((await t.call("GET", "/v1/me", "hive_nope")).status).toBe(401);
  });

  it("binds an agent through the device flow and hands the token out once", async () => {
    const t = await setup();
    const alice = await t.account("alice");
    const dl = await t.ok("POST", "/v1/device-logins", undefined, { label: "claude" });
    expect(await t.ok("POST", `/v1/device-logins/${dl.id}/poll`, undefined, { secret: dl.secret })).toEqual({
      status: "pending",
    });
    await t.ok("POST", "/v1/device-logins/approve", alice.token, { userCode: dl.userCode.toLowerCase() });
    const { token } = await t.ok("POST", `/v1/device-logins/${dl.id}/poll`, undefined, { secret: dl.secret });
    expect((await t.ok("GET", "/v1/me", token)).actor).toBe("agent");
    expect((await t.call("POST", `/v1/device-logins/${dl.id}/poll`, undefined, { secret: dl.secret })).status).toBe(409);
  });

  it("hands out an approval link the owner opens to see who is asking", async () => {
    const t = await setup();
    const alice = await t.account("alice");
    const dl = await t.ok("POST", "/v1/device-logins", undefined, { label: "claude" });
    expect(dl.verificationUri).toBe(`${BASE}/approve`);
    expect(dl.verificationUriComplete).toBe(`${BASE}/approve?code=${dl.userCode}`);
    expect(await t.ok("GET", `/v1/device-logins/${dl.userCode}`, alice.token)).toMatchObject({ label: "claude", approved: false });
    await t.ok("POST", "/v1/device-logins/approve", alice.token, { userCode: dl.userCode });
    expect((await t.ok("GET", `/v1/device-logins/${dl.userCode}`, alice.token)).approved).toBe(true);
    expect((await t.call("GET", "/v1/device-logins/NOPE0000", alice.token)).status).toBe(404);
  });

  it("lists the owner's agents with their last order and revokes one at a time", async () => {
    const t = await setup();
    await t.agentSeller("data-agent", DATA, 500);
    const alice = await t.account("alice");
    const cli = await t.agentToken(alice.token);
    const { key } = await t.ok("POST", "/v1/api-keys", alice.token, { label: "cursor" });
    const order = await t.ok("POST", "/v1/orders", cli, orders[DATA]);

    const agents = await t.ok("GET", "/v1/agents", alice.token);
    expect(agents.map((a: { label: string; source: string }) => [a.label, a.source])).toEqual([
      ["cursor", "api_key"],
      ["test agent", "login"],
    ]);
    expect(agents[0].lastOrderAt).toBeNull();
    expect(agents[1].lastOrderAt).toBe(order.createdAt);
    expect((await t.call("GET", "/v1/agents", key)).status).toBe(403);

    await t.ok("POST", `/v1/agents/${agents[1].id}/revoke`, alice.token);
    expect((await t.call("GET", "/v1/me", cli)).status).toBe(401);
    expect((await t.ok("GET", "/v1/me", key)).actor).toBe("agent");
    expect((await t.ok("GET", "/v1/agents", alice.token)).map((a: { label: string }) => a.label)).toEqual(["cursor"]);

    // Other accounts' agents and the owner token itself are out of reach.
    const bob = await t.account("bob");
    expect((await t.call("POST", `/v1/agents/${agents[0].id}/revoke`, bob.token)).status).toBe(404);
  });

  it("does not let an agent approve logins or change its owner's rules", async () => {
    const t = await setup();
    const alice = await t.account("alice");
    const agent = await t.agentToken(alice.token);
    const dl = await t.ok("POST", "/v1/device-logins", undefined, {});
    expect((await t.call("POST", "/v1/device-logins/approve", agent, { userCode: dl.userCode })).status).toBe(403);
    expect((await t.call("PATCH", "/v1/me/rules", agent, { paused: true })).status).toBe(403);
  });

  it("lets only the owner create API keys, which act as agents", async () => {
    const t = await setup();
    const alice = await t.account("alice");
    const { key } = await t.ok("POST", "/v1/api-keys", alice.token, { label: "cursor" });
    expect((await t.ok("GET", "/v1/me", key)).actor).toBe("agent");
    expect((await t.call("POST", "/v1/api-keys", key, {})).status).toBe(403);
  });
});

describe("remote MCP", () => {
  const rpc = (app: { request: (url: string, init: RequestInit) => Response | Promise<Response> }, token: string | null, method: string, params = {}) =>
    app.request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

  it("needs an agent API key", async () => {
    const t = await setup();
    const alice = await t.account("alice");
    expect((await rpc(t.app, null, "tools/list")).status).toBe(401);
    expect((await rpc(t.app, alice.token, "tools/list")).status).toBe(403);
  });

  it("serves the buying tools with the caller's key, without a login tool", async () => {
    const t = await setup();
    const alice = await t.account("alice");
    const { key } = await t.ok("POST", "/v1/api-keys", alice.token, {});
    const list = await (await rpc(t.app, key, "tools/list")).json();
    const names = list.result.tools.map((x: { name: string }) => x.name);
    expect(names).toContain("hive_order");
    expect(names).toContain("hive_deliver");
    expect(names).not.toContain("hive_login");
    const me = await (await rpc(t.app, key, "tools/call", { name: "hive_whoami", arguments: {} })).json();
    expect(JSON.parse(me.result.content[0].text)).toMatchObject({ name: "alice", actor: "agent" });
  });
});

it("lists the categories and how each seller in them works", async () => {
  const t = await setup();
  await t.agentSeller("data-agent", DATA, 500, ["奶茶"]);
  await t.humanSeller("wang", PHOTO, 1500, { deliveryHours: 3 });
  const cats = await t.ok("GET", "/v1/categories");
  expect(cats).toHaveLength(20);
  expect(cats.map((c: { id: string }) => c.id).slice(0, 3)).toEqual([DATA, "data.research", "data.cleaning"]);
  const byId = Object.fromEntries(cats.map((c: { id: string }) => [c.id, c]));
  expect(byId[DATA]).toMatchObject({ title: "竞品/市场数据", workTimeoutMs: 10 * 60_000, manualTimeoutMs: 24 * 3600_000 });
  expect(byId[DATA].tags).toContain("竞品");
  expect(byId[DATA].sellers[0]).toMatchObject({ name: "data-agent", tags: ["奶茶"], workStyle: "agent 全自动", workTimeoutMs: 10 * 60_000 });
  expect(byId[PHOTO].sellers[0]).toMatchObject({ name: "wang", workStyle: "需卖家审批 · 人工交付 · 3 小时内", workTimeoutMs: 3 * 3600_000 });
});

it("lists priced listings in the market, cheapest first, with presence", async () => {
  const t = await setup();
  await t.agentSeller("pricey", DATA, 800);
  await t.agentSeller("cheap", DATA, 300);
  const human = await t.humanSeller("wang", PHOTO, 1500);
  await t.ok("POST", "/v1/seller/accepting", human.token, { on: false });
  await t.ok("PUT", `/v1/listings/${DATA}`, (await t.account("unpriced")).token, { acceptMode: "auto", dailyLimit: 1 });

  const market = await t.ok("GET", "/v1/categories");
  const byType = Object.fromEntries(market.map((m: { id: string }) => [m.id, m]));
  expect(byType[DATA].title).toBe("竞品/市场数据");
  expect(byType[DATA].sellers.map((s: { name: string }) => s.name)).toEqual(["cheap", "pricey"]);
  expect(byType[DATA].sellers[0]).toMatchObject({ workMode: "agent", acceptMode: "auto", priceFen: 300, online: true, completed: 0, passRate: null });
  expect(byType[PHOTO].sellers[0]).toMatchObject({ name: "wang", workMode: "manual", acceptMode: "ask", online: false });
  expect(byType["design.chart"].sellers).toEqual([]);
});

describe("the full agent-to-agent order", () => {
  it("goes from order to completion with payment in between", async () => {
    const t = await setup();
    const seller = await t.agentSeller("data-agent", DATA, 500);
    const buyer = await t.account("xiaowang");
    const buyerAgent = await t.agentToken(buyer.token);

    const created = await t.ok("POST", "/v1/orders", buyerAgent, orders[DATA]);
    expect(created.status).toBe("OFFERED");
    expect(created.createdByActor).toBe("agent");

    const inbox = await t.ok("GET", "/v1/seller/poll", seller.agent);
    expect(inbox.offers.map((o: { id: string }) => o.id)).toEqual([created.id]);

    const accepted = await t.ok("POST", `/v1/orders/${created.id}/accept-offer`, seller.agent);
    expect(accepted.status).toBe("AWAITING_PAYMENT");
    expect(accepted.priceFen).toBe(500);
    const notes = await t.ok("GET", "/v1/notifications", buyer.token);
    expect(notes[0].kind).toBe("payment_required");

    // Not paid yet: checking leaves it waiting.
    expect((await t.ok("POST", `/v1/orders/${created.id}/check-payment`, buyerAgent)).status).toBe("AWAITING_PAYMENT");
    await t.pay(accepted);
    expect((await t.ok("POST", `/v1/orders/${created.id}/check-payment`, buyerAgent)).status).toBe("PAID");

    const work = await t.ok("GET", "/v1/seller/poll", seller.agent);
    expect(work.work.map((o: { id: string }) => o.id)).toEqual([created.id]);
    await t.ok("POST", `/v1/orders/${created.id}/start`, seller.agent);

    const bad = await t.call("POST", `/v1/orders/${created.id}/deliver`, seller.agent, { data: { nope: 1 } });
    expect(bad.status).toBe(422);
    const delivered = await t.ok("POST", `/v1/orders/${created.id}/deliver`, seller.agent, validDelivery);
    expect(delivered.status).toBe("DELIVERED");
    expect(delivered.deliveryAttempts).toBe(2);

    const done = await t.ok("POST", `/v1/orders/${created.id}/verdict`, buyerAgent, { verdict: "accepted" });
    expect(done.status).toBe("COMPLETED");
    expect(done.verdict).toBe("accepted");

    const bill = await t.ok("GET", "/v1/me/bill", buyer.token);
    expect(bill.spentFen).toBe(500);
    expect(bill.spent[0].createdByActor).toBe("agent");
    expect((await t.ok("GET", "/v1/me/bill", seller.token)).earnedFen).toBe(500);
    const detail = await t.ok("GET", `/v1/orders/${created.id}`, buyer.token);
    expect(detail.sellerName).toBe("data-agent");
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual([
      "dispatch", "offer", "seller_accept", "payment_requested", "payment_confirmed",
      "work_started", "delivery_submitted", "delivery_submitted", "buyer_verdict",
    ]);
    // The paid count was consumed on delivery.
    expect(await t.payments.remainingQuota({ product: { productId: seller.listingId, ownerId: seller.id, productName: "" }, buyerId: buyer.id })).toBe(0);
  });
});

describe("dispatch", () => {
  it("cancels when no seller is online", async () => {
    const t = await setup();
    const seller = await t.agentSeller("data-agent", DATA);
    t.advance(61_000); // listener went quiet
    const buyer = await t.account("buyer");
    const o = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    expect(o.status).toBe("CANCELLED");
    expect(o.cancelReason).toBe("no_seller");
    expect(seller).toBeTruthy();
  });

  it("offers the cheapest seller first and moves on when the offer expires", async () => {
    const t = await setup();
    const cheap = await t.agentSeller("cheap", DATA, 300);
    const pricey = await t.agentSeller("pricey", DATA, 800);
    const buyer = await t.account("buyer");
    const o = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    expect((await t.ok("GET", `/v1/orders/${o.id}`, cheap.agent)).status).toBe("OFFERED");

    t.advance(30_000);
    await t.ok("GET", "/v1/seller/poll", pricey.agent); // still online after the clock moved
    await t.hive.tick();
    const inbox = await t.ok("GET", "/v1/seller/poll", pricey.agent);
    expect(inbox.offers.map((x: { id: string }) => x.id)).toEqual([o.id]);
    expect((await t.call("POST", `/v1/orders/${o.id}/accept-offer`, cheap.agent)).status).toBe(409);
  });

  it("re-dispatches after a decline and cancels once everyone has passed", async () => {
    const t = await setup();
    const a = await t.agentSeller("a", DATA, 300);
    const b = await t.agentSeller("b", DATA, 400);
    const buyer = await t.account("buyer");
    const o = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    await t.ok("POST", `/v1/orders/${o.id}/decline-offer`, a.agent);
    expect((await t.ok("GET", "/v1/seller/poll", b.agent)).offers).toHaveLength(1);
    await t.ok("POST", `/v1/orders/${o.id}/decline-offer`, b.agent);
    expect((await t.ok("GET", `/v1/orders/${o.id}`, buyer.token)).status).toBe("CANCELLED");
  });

  it("broadcasts to accepting humans and gives the order to the first one", async () => {
    const t = await setup();
    const h1 = await t.humanSeller("h1", PHOTO);
    const h2 = await t.humanSeller("h2", PHOTO);
    const offline = await t.humanSeller("h3", PHOTO);
    await t.ok("POST", "/v1/seller/accepting", offline.token, { on: false });
    const buyer = await t.account("buyer");

    const o = await t.ok("POST", "/v1/orders", buyer.token, orders[PHOTO]);
    expect(o.offerKind).toBe("human");
    for (const h of [h1, h2]) {
      expect((await t.ok("GET", "/v1/notifications", h.token))[0].kind).toBe("offer");
    }
    expect(await t.ok("GET", "/v1/notifications", offline.token)).toEqual([]);

    await t.ok("POST", `/v1/orders/${o.id}/accept-offer`, h2.token);
    expect((await t.call("POST", `/v1/orders/${o.id}/accept-offer`, h1.token)).status).toBe(409);
    expect((await t.ok("GET", `/v1/orders/${o.id}`, buyer.token)).sellerAccountId).toBe(h2.id);
  });

  it("skips sellers who reached their daily limit", async () => {
    const t = await setup();
    const seller = await t.agentSeller("busy", DATA);
    await t.ok("PUT", `/v1/listings/${DATA}`, seller.agent, { acceptMode: "auto", dailyLimit: 1 });
    const buyer = await t.account("buyer");
    const first = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    await t.ok("POST", `/v1/orders/${first.id}/accept-offer`, seller.agent);
    const second = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    expect(second.status).toBe("CANCELLED");
  });

  it("counts an owner-token listener as agent presence", async () => {
    const t = await setup();
    const owner = await t.account("owner");
    await t.ok("PUT", `/v1/listings/${DATA}`, owner.token, { acceptMode: "auto", dailyLimit: 10 });
    await t.ok("POST", `/v1/listings/${DATA}/payment-setup`, owner.token);
    await t.ok("GET", "/v1/seller/poll", owner.token); // a plain owner poll is human presence
    const buyer = await t.account("buyer");
    expect((await t.ok("POST", "/v1/orders", buyer.token, orders[DATA])).status).toBe("CANCELLED");
    await t.ok("GET", "/v1/seller/poll?listener=1", owner.token);
    expect((await t.ok("POST", "/v1/orders", buyer.token, orders[DATA])).status).toBe("OFFERED");
  });

  it("dispatches to a seller who works by hand without a listener, as long as they were active", async () => {
    const t = await setup();
    const h = await t.humanSeller("wang", PHOTO);
    const buyer = await t.account("buyer");
    t.advance(23 * 3600_000); // no listener and the 接单台 closed: still taking orders
    await t.ok("GET", "/v1/me", buyer.token);
    expect((await t.ok("POST", "/v1/orders", buyer.token, orders[PHOTO])).status).toBe("OFFERED");
    expect((await t.ok("GET", "/v1/notifications", h.token))[0].kind).toBe("offer");

    t.advance(25 * 3600_000); // gone quiet for over a day: no more orders
    const o = await t.ok("POST", "/v1/orders", buyer.token, orders[PHOTO]);
    expect(o.status).toBe("CANCELLED");
  });

  it("takes the order for an auto listing done by hand and times the work by the seller's promise", async () => {
    const t = await setup();
    const h = await t.humanSeller("wang", PHOTO, 1500, { acceptMode: "auto", deliveryHours: 5 });
    const buyer = await t.account("buyer");
    const o = await t.ok("POST", "/v1/orders", buyer.token, orders[PHOTO]);
    expect(o).toMatchObject({ status: "AWAITING_PAYMENT", sellerAccountId: h.id });

    await t.pay(o);
    const paid = await t.ok("POST", `/v1/orders/${o.id}/check-payment`, buyer.token);
    expect(new Date(paid.deadline).getTime() - new Date(paid.paidAt).getTime()).toBe(5 * 3600_000);
    // No listener is up, and none is needed: the heartbeat check leaves it alone.
    t.advance(4 * 3600_000);
    await t.hive.tick();
    expect((await t.ok("GET", `/v1/orders/${o.id}`, buyer.token)).status).toBe("PAID");
    await t.ok("POST", `/v1/orders/${o.id}/start`, h.token);
    const photo = await t.upload(h.token, o.id, "door.jpg", "image/jpeg", "jpeg");
    await t.ok("POST", `/v1/orders/${o.id}/deliver`, h.token, { note: "门面", files: [photo.body.id] });
    expect((await t.ok("GET", `/v1/orders/${o.id}`, buyer.token)).status).toBe("DELIVERED");
  });

  it("gives work done by hand the category's usual time when the seller sets none", async () => {
    const t = await setup();
    const h = await t.account("wang");
    const listing = await t.ok("PUT", `/v1/listings/${PHOTO}`, h.token, { acceptMode: "ask", workMode: "manual", dailyLimit: 5 });
    expect(listing.deliveryHours).toBe(4);
    expect((await t.call("PUT", "/v1/listings/nope", h.token, { acceptMode: "ask", dailyLimit: 5 })).status).toBe(404);
  });

  it("offers the seller whose tags match the order before a cheaper one", async () => {
    const t = await setup();
    const cheap = await t.agentSeller("cheap", DATA, 300, ["咖啡"]);
    const tea = await t.agentSeller("tea", DATA, 600, ["奶茶", "湖滨"]);
    const buyer = await t.account("buyer");
    const o = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    expect((await t.ok("GET", "/v1/seller/poll", tea.agent)).offers.map((x: { id: string }) => x.id)).toEqual([o.id]);
    expect((await t.ok("GET", "/v1/seller/poll", cheap.agent)).offers).toEqual([]);
  });

  it("wakes a waiting long-poll when an offer arrives", async () => {
    const t = await setup();
    const seller = await t.agentSeller("data-agent", DATA);
    const buyer = await t.account("buyer");
    const started = Date.now();
    const poll = t.ok("GET", "/v1/seller/poll?wait=5", seller.agent);
    await new Promise((r) => setTimeout(r, 50));
    const o = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    const inbox = await poll;
    expect(inbox.offers.map((x: { id: string }) => x.id)).toEqual([o.id]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("owner rules", () => {
  it("refuses orders from a paused account", async () => {
    const t = await setup();
    await t.agentSeller("s", DATA);
    const buyer = await t.account("buyer");
    await t.ok("PATCH", "/v1/me/rules", buyer.token, { paused: true });
    const r = await t.call("POST", "/v1/orders", buyer.token, orders[DATA]);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("account_paused");
  });

  it("only offers sellers within the per-order cap", async () => {
    const t = await setup();
    await t.agentSeller("pricey", DATA, 900);
    const cheap = await t.agentSeller("cheap", DATA, 700);
    const buyer = await t.account("buyer");
    await t.ok("PATCH", "/v1/me/rules", buyer.token, { perOrderCapFen: 800 });
    const o = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    expect((await t.ok("GET", "/v1/seller/poll", cheap.agent)).offers.map((x: { id: string }) => x.id)).toEqual([o.id]);

    await t.ok("PATCH", "/v1/me/rules", buyer.token, { perOrderCapFen: 500 });
    const tooCheap = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    expect(tooCheap.cancelReason).toBe("no_seller");
  });

  it("stops new orders once the daily cap is spent", async () => {
    const t = await setup();
    const seller = await t.agentSeller("s", DATA, 500);
    const buyer = await t.account("buyer");
    await t.ok("PATCH", "/v1/me/rules", buyer.token, { dailyCapFen: 500 });
    const o = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    await t.ok("POST", `/v1/orders/${o.id}/accept-offer`, seller.agent);
    const r = await t.call("POST", "/v1/orders", buyer.token, orders[DATA]);
    expect(r.body.error).toBe("daily_cap_reached");
  });

  it("validates the category, the brief and the delivery format", async () => {
    const t = await setup();
    const buyer = await t.account("buyer");
    const post = (body: object) => t.call("POST", "/v1/orders", buyer.token, { ...orders[DATA], ...body });
    expect((await post({ category: "nope" })).status).toBe(404);
    expect((await post({ brief: "  " })).status).toBe(400);
    expect((await post({ delivery: { kind: "json", schema: { type: "nope" } } })).body.error).toBe("invalid_delivery_spec");
    expect((await post({ delivery: { kind: "email" } })).body.error).toBe("invalid_delivery_spec");
    // No format given: anything goes, and no structured input is needed.
    const open = await t.ok("POST", "/v1/orders", buyer.token, { category: "content.writing", brief: "写一句奶茶店开业文案" });
    expect(open).toMatchObject({ deliverySpec: { kind: "any" }, input: null, brief: "写一句奶茶店开业文案" });
  });
});

describe("payment and failure", () => {
  async function acceptedOrder() {
    const t = await setup();
    const seller = await t.agentSeller("s", DATA, 500);
    const buyer = await t.account("buyer");
    const o = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    const accepted = await t.ok("POST", `/v1/orders/${o.id}/accept-offer`, seller.agent);
    return { t, seller, buyer, order: accepted };
  }

  it("cancels an unpaid order after 15 minutes", async () => {
    const { t, buyer, order } = await acceptedOrder();
    t.advance(15 * 60_000);
    await t.hive.tick();
    const o = await t.ok("GET", `/v1/orders/${order.id}`, buyer.token);
    expect(o.cancelReason).toBe("payment_expired");
  });

  it("detects payment in the background sweep", async () => {
    const { t, buyer, order } = await acceptedOrder();
    await t.pay(order);
    await t.hive.tick();
    expect((await t.ok("GET", `/v1/orders/${order.id}`, buyer.token)).status).toBe("PAID");
  });

  it("lets the buyer cancel before paying but not after", async () => {
    const { t, buyer, order } = await acceptedOrder();
    await t.pay(order);
    await t.ok("POST", `/v1/orders/${order.id}/check-payment`, buyer.token);
    expect((await t.call("POST", `/v1/orders/${order.id}/cancel`, buyer.token)).status).toBe(409);
  });

  it("fails a paid order when the agent seller's listener goes quiet", async () => {
    const { t, buyer, order } = await acceptedOrder();
    await t.pay(order);
    await t.ok("POST", `/v1/orders/${order.id}/check-payment`, buyer.token);
    t.advance(2 * 60_000 + 1);
    await t.hive.tick();
    const o = await t.ok("GET", `/v1/orders/${order.id}`, buyer.token);
    expect(o.status).toBe("FAILED");
    expect(o.failReason).toBe("heartbeat_lost");
    expect(o.refundEligible).toBe(true);
    expect((await t.ok("GET", "/v1/notifications", buyer.token))[0].kind).toBe("failed");
  });

  it("uses leftover credit to pay the next order on the same listing", async () => {
    const { t, seller, buyer, order } = await acceptedOrder();
    // The buyer pays only after the order already timed out, leaving one unused count.
    t.advance(15 * 60_000);
    await t.hive.tick();
    await t.pay(order);
    await t.ok("GET", "/v1/seller/poll", seller.agent);
    const next = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    const accepted = await t.ok("POST", `/v1/orders/${next.id}/accept-offer`, seller.agent);
    expect(accepted.status).toBe("PAID");
  });

  it("auto-accepts a delivery the buyer never reviews", async () => {
    const { t, seller, buyer, order } = await acceptedOrder();
    await t.pay(order);
    await t.ok("POST", `/v1/orders/${order.id}/check-payment`, buyer.token);
    await t.ok("POST", `/v1/orders/${order.id}/start`, seller.agent);
    await t.ok("POST", `/v1/orders/${order.id}/deliver`, seller.agent, validDelivery);
    t.advance(30 * 60_000);
    await t.ok("GET", "/v1/seller/poll", seller.agent);
    await t.hive.tick();
    expect((await t.ok("GET", `/v1/orders/${order.id}`, buyer.token)).verdict).toBe("auto_accepted");
  });

  it("hides orders from unrelated accounts", async () => {
    const { t, order } = await acceptedOrder();
    const stranger = await t.account("stranger");
    expect((await t.call("GET", `/v1/orders/${order.id}`, stranger.token)).status).toBe(404);
  });
});

describe("delivered files", () => {
  async function paidPhotoOrder() {
    const t = await setup();
    const h = await t.humanSeller("wang", PHOTO, 1500, { acceptMode: "auto" });
    const buyer = await t.account("buyer");
    const o = await t.ok("POST", "/v1/orders", buyer.token, { ...orders[PHOTO], delivery: { kind: "files", accept: "image/*", count: 2 } });
    await t.pay(o);
    await t.ok("POST", `/v1/orders/${o.id}/check-payment`, buyer.token);
    return { t, h, buyer, o };
  }

  it("checks the count and type, then serves the files sandboxed", async () => {
    const { t, h, buyer, o } = await paidPhotoOrder();
    const a = (await t.upload(h.token, o.id, "门头.jpg", "image/jpeg", "jpeg-bytes")).body;
    expect(a).toMatchObject({ name: "门头.jpg", mime: "image/jpeg", size: 10, url: `/v1/files/${a.id}` });
    const clip = (await t.upload(h.token, o.id, "clip.mp4", "video/mp4", "mp4")).body;
    await t.ok("POST", `/v1/orders/${o.id}/start`, h.token);

    const one = await t.call("POST", `/v1/orders/${o.id}/deliver`, h.token, { files: [a.id] });
    expect(one).toMatchObject({ status: 422, body: { error: "invalid_output" } });
    const wrongType = await t.call("POST", `/v1/orders/${o.id}/deliver`, h.token, { files: [a.id, clip.id] });
    expect(wrongType.body.message).toContain("clip.mp4");

    const b = (await t.upload(h.token, o.id, "queue.png", "image/png", "png")).body;
    const done = await t.ok("POST", `/v1/orders/${o.id}/deliver`, h.token, { note: "两张", files: [a.id, b.id] });
    expect(done.status).toBe("DELIVERED");
    const seen = await t.ok("GET", `/v1/orders/${o.id}`, buyer.token);
    expect(seen.output).toEqual({ note: "两张", data: null, files: [a, b] });

    const res = await t.app.request(`${BASE}${a.url}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("jpeg-bytes");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("content-disposition")).toContain(encodeURIComponent("门头.jpg"));
    expect((await t.app.request(`${BASE}/v1/files/file_${"0".repeat(32)}`)).status).toBe(404);
  });

  it("only takes uploads from the order's seller while it's being worked on", async () => {
    const { t, h, buyer, o } = await paidPhotoOrder();
    expect((await t.upload(buyer.token, o.id, "x.jpg", "image/jpeg", "x")).status).toBe(404);
    expect((await t.upload(h.token, o.id, "empty.jpg", "image/jpeg", "")).status).toBe(400);
    const other = await t.ok("POST", "/v1/orders", buyer.token, orders[PHOTO]);
    expect((await t.upload(h.token, other.id, "x.jpg", "image/jpeg", "x")).status).toBe(409); // not paid yet

    // A file uploaded to another order can't be passed off as this one's.
    await t.pay(other);
    await t.ok("POST", `/v1/orders/${other.id}/check-payment`, buyer.token);
    const elsewhere = (await t.upload(h.token, other.id, "x.jpg", "image/jpeg", "x")).body;
    await t.ok("POST", `/v1/orders/${o.id}/start`, h.token);
    const r = await t.call("POST", `/v1/orders/${o.id}/deliver`, h.token, { files: [elsewhere.id] });
    expect(r).toMatchObject({ status: 422, body: { error: "unknown_file" } });
  });
});
