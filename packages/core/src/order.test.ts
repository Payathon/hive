import { describe, expect, it } from "vitest";
import { fen } from "./money.ts";
import { expiryEvent, newOrder, transition, type Order, type OrderEvent } from "./order.ts";

const t0 = new Date("2026-10-14T10:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

const validOutput = { stores: [{ name: "A", area: "湖滨", address: "x" }], source: "seed" };

function base(): Order {
  return newOrder({
    id: "o1",
    capabilityType: "market-data.competitors",
    buyerAccountId: "buyer",
    input: { city: "杭州", areas: ["湖滨"], category: "奶茶" },
  });
}

function apply(order: Order, ...events: OrderEvent[]): Order {
  return events.reduce((o, e) => {
    const r = transition(o, e, t0);
    if (!r.ok) throw new Error(r.error);
    return r.order;
  }, order);
}

const toOffered = (o = base()) =>
  apply(o, { type: "dispatch" }, { type: "offer", sellerAccountIds: ["s1"], kind: "agent" });
const toPaid = () =>
  apply(
    toOffered(),
    { type: "seller_accept", sellerAccountId: "s1", priceFen: fen(500) },
    { type: "payment_requested", purchaseUrl: "https://pay.example/1" },
    { type: "payment_confirmed", paymentRef: "T1" },
  );

describe("happy path", () => {
  it("runs from CREATED to COMPLETED", () => {
    const o = apply(
      toPaid(),
      { type: "work_started" },
      { type: "delivery_submitted", output: validOutput },
      { type: "buyer_verdict", verdict: "accepted" },
    );
    expect(o.status).toBe("COMPLETED");
    expect(o.verdict).toBe("accepted");
    expect(o.priceFen).toBe(500);
    expect(o.refundEligible).toBe(false);
  });
});

describe("offers", () => {
  it("expires an agent offer after 30s and goes back to dispatching", () => {
    const o = toOffered();
    expect(expiryEvent(o, at(29_000))).toBeNull();
    const e = expiryEvent(o, at(30_000));
    expect(e).toEqual({ type: "offer_expired" });
    const next = apply(o, e!);
    expect(next.status).toBe("DISPATCHING");
    expect(next.passedBy).toEqual(["s1"]);
  });

  it("keeps a human broadcast open until every holder declines", () => {
    let o = apply(base(), { type: "dispatch" }, { type: "offer", sellerAccountIds: ["h1", "h2"], kind: "human" });
    o = apply(o, { type: "seller_decline", sellerAccountId: "h1" });
    expect(o.status).toBe("OFFERED");
    o = apply(o, { type: "seller_decline", sellerAccountId: "h2" });
    expect(o.status).toBe("DISPATCHING");
    expect(o.passedBy).toEqual(["h1", "h2"]);
  });

  it("lets only the first human accept a broadcast", () => {
    let o = apply(base(), { type: "dispatch" }, { type: "offer", sellerAccountIds: ["h1", "h2"], kind: "human" });
    o = apply(o, { type: "seller_accept", sellerAccountId: "h2", priceFen: fen(1500) });
    const late = transition(o, { type: "seller_accept", sellerAccountId: "h1", priceFen: fen(1500) }, t0);
    expect(late.ok).toBe(false);
    expect(o.sellerAccountId).toBe("h2");
  });

  it("rejects an accept from a seller who wasn't offered", () => {
    const r = transition(toOffered(), { type: "seller_accept", sellerAccountId: "x", priceFen: fen(1) }, t0);
    expect(r.ok).toBe(false);
  });

  it("cancels when nobody can take the order", () => {
    const o = apply(base(), { type: "dispatch" }, { type: "no_candidates" });
    expect(o.status).toBe("CANCELLED");
    expect(o.cancelReason).toBe("no_seller");
  });
});

describe("payment", () => {
  it("cancels after 15 minutes without payment", () => {
    const o = apply(
      toOffered(),
      { type: "seller_accept", sellerAccountId: "s1", priceFen: fen(500) },
      { type: "payment_requested", purchaseUrl: "u" },
    );
    const e = expiryEvent(o, at(15 * 60_000));
    expect(e).toEqual({ type: "payment_expired" });
    expect(apply(o, e!).cancelReason).toBe("payment_expired");
  });

  it("allows the buyer to cancel before paying but not after", () => {
    const unpaid = apply(
      toOffered(),
      { type: "seller_accept", sellerAccountId: "s1", priceFen: fen(500) },
      { type: "payment_requested", purchaseUrl: "u" },
    );
    expect(apply(unpaid, { type: "buyer_cancel" }).status).toBe("CANCELLED");
    expect(transition(toPaid(), { type: "buyer_cancel" }, t0).ok).toBe(false);
  });
});

describe("work and delivery", () => {
  it("lets the seller resubmit a malformed delivery", () => {
    let o = apply(toPaid(), { type: "work_started" });
    o = apply(o, { type: "delivery_submitted", output: { nope: true } });
    expect(o.status).toBe("IN_PROGRESS");
    expect(o.deliveryAttempts).toBe(1);
    expect(o.lastDeliveryError).toBeTruthy();
    o = apply(o, { type: "delivery_submitted", output: validOutput });
    expect(o.status).toBe("DELIVERED");
    expect(o.deliveryAttempts).toBe(2);
    expect(o.lastDeliveryError).toBeNull();
  });

  it("fails a paid order whose seller never starts, and marks it refund-eligible", () => {
    const o = toPaid();
    // market-data.competitors has a 10 minute work timeout, counted from payment.
    expect(expiryEvent(o, at(10 * 60_000 - 1))).toBeNull();
    const failed = apply(o, expiryEvent(o, at(10 * 60_000))!);
    expect(failed.status).toBe("FAILED");
    expect(failed.failReason).toBe("work_timeout");
    expect(failed.refundEligible).toBe(true);
  });

  it("fails on lost heartbeat", () => {
    const o = apply(toPaid(), { type: "work_started" }, { type: "work_failed", reason: "heartbeat_lost" });
    expect(o.status).toBe("FAILED");
    expect(o.failReason).toBe("heartbeat_lost");
  });
});

describe("acceptance", () => {
  const delivered = () =>
    apply(toPaid(), { type: "work_started" }, { type: "delivery_submitted", output: validOutput });

  it("records a rejection as a completed, refund-eligible order", () => {
    const o = apply(delivered(), { type: "buyer_verdict", verdict: "rejected" });
    expect(o.status).toBe("COMPLETED");
    expect(o.verdict).toBe("rejected");
    expect(o.refundEligible).toBe(true);
  });

  it("auto-accepts after 30 minutes", () => {
    const o = delivered();
    const done = apply(o, expiryEvent(o, at(30 * 60_000))!);
    expect(done.verdict).toBe("auto_accepted");
  });
});

it("rejects events that don't fit the current status", () => {
  expect(transition(base(), { type: "work_started" }, t0).ok).toBe(false);
  const done = apply(toPaid(), { type: "work_failed", reason: "seller_abandoned" });
  expect(transition(done, { type: "buyer_verdict", verdict: "accepted" }, t0).ok).toBe(false);
  expect(expiryEvent(done, at(10 ** 9))).toBeNull();
});
