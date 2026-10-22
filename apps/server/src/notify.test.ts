import { describe, expect, it } from "vitest";
import { pushSubscriptions } from "./db/schema.ts";
import { OutboxMailer, type Mail, type Mailer } from "./mail.ts";
import type { PushMessage, PushSender, PushTarget } from "./push.ts";
import { DATA, orders, setup, validDelivery } from "./test-helpers.ts";

const sub = (n: number) => ({ endpoint: `https://push.test/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

// Records what would have been pushed; endpoints listed in `gone` answer 410 like an expired subscription.
class RecordingPush implements PushSender {
  readonly publicKey = "test-public-key";
  sent: { endpoint: string; message: PushMessage }[] = [];
  constructor(private readonly gone: string[] = []) {}
  async send(target: PushTarget, message: PushMessage) {
    if (this.gone.includes(target.endpoint)) throw Object.assign(new Error("gone"), { statusCode: 410 });
    this.sent.push({ endpoint: target.endpoint, message });
  }
}

// Order → offer to a person who approves → paid → delivered, as both sides do it from the web.
async function toDelivered(t: Awaited<ReturnType<typeof setup>>, seller: { token: string }, buyerToken: string) {
  const created = await t.ok("POST", "/v1/orders", buyerToken, orders[DATA]);
  const accepted = await t.ok("POST", `/v1/orders/${created.id}/accept-offer`, seller.token);
  await t.pay(accepted);
  expect((await t.ok("POST", `/v1/orders/${created.id}/check-payment`, buyerToken)).status).toBe("PAID");
  expect((await t.ok("POST", `/v1/orders/${created.id}/deliver`, seller.token, validDelivery)).status).toBe("DELIVERED");
  return created.id as string;
}

describe("mail", () => {
  it("collects mail in the dev outbox with a link to the order", async () => {
    const t = await setup();
    const seller = await t.humanSeller("shop", DATA, 500);
    const buyer = await t.account("xiaowang");
    await t.ok("PATCH", "/v1/me", buyer.token, { email: "buyer@hive.demo" });
    await t.ok("PATCH", "/v1/me", seller.token, { email: "shop@hive.demo" });
    expect((await t.ok("GET", "/v1/me", buyer.token)).email).toBe("buyer@hive.demo");

    const id = await toDelivered(t, seller, buyer.token);
    await t.hive.settle();

    const mails = await (t.hive.mailer as OutboxMailer).list();
    const to = (who: string) => mails.filter((m) => m.to === who).map((m) => m.subject).reverse();
    expect(to("buyer@hive.demo")).toEqual(["hive：待你付款", "hive：已交付，等你验收"]);
    expect(to("shop@hive.demo")).toEqual(["hive：新派单，等你抢单", "hive：买家已付款"]);
    expect(mails[0]!.text).toContain(`http://web.test/orders/${id}`);

    const page = await t.app.request("http://hive.test/v1/dev/mail");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("hive：待你付款");
    expect(html).toContain(`<a href="http://web.test/orders/${id}">`);
  });

  it("only lets the owner set a valid email, and clears it with null", async () => {
    const t = await setup();
    const a = await t.account("a");
    expect((await t.call("PATCH", "/v1/me", a.token, { email: "nope" })).status).toBe(400);
    expect((await t.call("PATCH", "/v1/me", await t.agentToken(a.token), { email: "a@hive.demo" })).status).toBe(403);
    await t.ok("PATCH", "/v1/me", a.token, { email: "a@hive.demo" });
    expect(await t.ok("PATCH", "/v1/me", a.token, { email: null })).toEqual({ email: null });
  });

  it("leaves a fully automatic seller alone unless something fails", async () => {
    const push = new RecordingPush();
    const t = await setup({ push });
    const seller = await t.agentSeller("studio", DATA, 500);
    await t.ok("PATCH", "/v1/me", seller.token, { email: "studio@hive.demo" });
    await t.ok("POST", "/v1/push/subscribe", seller.token, sub(1));
    const buyer = await t.account("xiaowang");
    const created = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    const accepted = await t.ok("POST", `/v1/orders/${created.id}/accept-offer`, seller.agent);
    await t.pay(accepted);
    await t.ok("POST", `/v1/orders/${created.id}/check-payment`, buyer.token);
    await t.ok("POST", `/v1/orders/${created.id}/deliver`, seller.agent, validDelivery);
    await t.ok("POST", `/v1/orders/${created.id}/verdict`, buyer.token, { verdict: "accepted" });
    await t.hive.settle();
    // Still in the inbox, but no push or mail.
    expect((await t.ok("GET", "/v1/notifications", seller.token)).map((n: { kind: string }) => n.kind)).toEqual(["completed", "paid"]);
    expect(push.sent).toEqual([]);
    expect(await (t.hive.mailer as OutboxMailer).list()).toEqual([]);

    // A failure does reach them.
    const second = await t.ok("POST", "/v1/orders", buyer.token, orders[DATA]);
    await t.pay(await t.ok("POST", `/v1/orders/${second.id}/accept-offer`, seller.agent));
    await t.ok("POST", `/v1/orders/${second.id}/check-payment`, buyer.token);
    await t.ok("POST", `/v1/orders/${second.id}/abandon`, seller.agent);
    await t.hive.settle();
    expect(push.sent.map((s) => s.message.title)).toEqual(["订单失败"]);
    expect((await (t.hive.mailer as OutboxMailer).list()).map((m) => m.to)).toEqual(["studio@hive.demo"]);
  });
});

describe("web push", () => {
  it("pushes to every subscribed browser, opens the order, and drops gone subscriptions", async () => {
    const push = new RecordingPush([sub(2).endpoint]);
    const t = await setup({ push });
    const seller = await t.humanSeller("shop", DATA, 500);
    const buyer = await t.account("xiaowang");
    expect(await t.ok("GET", "/v1/push/key", buyer.token)).toEqual({ publicKey: "test-public-key" });
    await t.ok("POST", "/v1/push/subscribe", buyer.token, sub(1));
    await t.ok("POST", "/v1/push/subscribe", buyer.token, sub(2));

    const id = await toDelivered(t, seller, buyer.token);
    await t.hive.settle();
    expect(push.sent.map((s) => [s.endpoint, s.message.title])).toEqual([
      [sub(1).endpoint, "待你付款"],
      [sub(1).endpoint, "已交付，等你验收"],
    ]);
    expect(push.sent[0]!.message.url).toBe(`/orders/${id}`);

    // The 410 removed the second browser; the test button reaches the first only.
    expect(await t.ok("POST", "/v1/push/test", buyer.token)).toEqual({ sent: 1 });
    await t.ok("POST", "/v1/push/unsubscribe", buyer.token, { endpoint: sub(1).endpoint });
    expect((await t.call("POST", "/v1/push/test", buyer.token)).status).toBe(409);
  });

  it("reports push as off when the server has no VAPID keys", async () => {
    const t = await setup();
    const a = await t.account("a");
    expect(await t.ok("GET", "/v1/push/key", a.token)).toEqual({ publicKey: null });
    expect((await t.call("POST", "/v1/push/subscribe", a.token, sub(1))).status).toBe(409);
  });
});

describe("broken channels", () => {
  it("never break or slow an order: every step still lands in the inbox", async () => {
    const mailer: Mailer = {
      name: "broken",
      send: async (_: Mail) => {
        throw new Error("smtp down");
      },
    };
    const push: PushSender = {
      publicKey: "k",
      send: async () => {
        throw Object.assign(new Error("push service down"), { statusCode: 500 });
      },
    };
    const t = await setup({ mailer, push });
    const seller = await t.humanSeller("shop", DATA, 500);
    const buyer = await t.account("xiaowang");
    for (const who of [buyer, seller]) {
      await t.ok("PATCH", "/v1/me", who.token, { email: `${who.id}@hive.demo` });
      await t.ok("POST", "/v1/push/subscribe", who.token, sub(who === buyer ? 1 : 2));
    }
    const id = await toDelivered(t, seller, buyer.token);
    expect((await t.ok("POST", `/v1/orders/${id}/verdict`, buyer.token, { verdict: "accepted" })).status).toBe("COMPLETED");
    await t.hive.settle();
    expect((await t.ok("GET", "/v1/notifications", buyer.token)).map((n: { kind: string }) => n.kind)).toEqual(["delivered", "payment_required"]);
    expect((await t.ok("GET", "/v1/notifications", seller.token)).map((n: { kind: string }) => n.kind)).toEqual(["completed", "paid", "offer"]);
    // A 500 is not a reason to forget the browser.
    expect(await t.hive.db.select().from(pushSubscriptions)).toHaveLength(2);
    await t.ok("POST", "/v1/notifications/read-all", buyer.token);
    expect((await t.ok("GET", "/v1/notifications", buyer.token)).every((n: { readAt: string | null }) => n.readAt)).toBe(true);
  });
});
