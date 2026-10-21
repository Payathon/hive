import { checkOutput, capabilityTypes, type CapabilityType } from "./capabilities.ts";
import type { Fen } from "./money.ts";

// See docs/design.md §3 for the state diagram and transition table.
export type OrderStatus =
  | "CREATED"
  | "DISPATCHING"
  | "OFFERED"
  | "ACCEPTED"
  | "AWAITING_PAYMENT"
  | "PAID"
  | "IN_PROGRESS"
  | "DELIVERED"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

export const TERMINAL: ReadonlySet<OrderStatus> = new Set(["COMPLETED", "CANCELLED", "FAILED"]);

export type SellerKind = "agent" | "human";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const TIMEOUTS = {
  // `ask` sellers needn't sit at a screen, so they get a long window to approve.
  offer: { agent: 30 * SECOND, human: 30 * MINUTE },
  payment: 15 * MINUTE,
  acceptance: 30 * MINUTE,
} as const;

export type Verdict = "accepted" | "rejected" | "auto_accepted";
export type CancelReason = "no_seller" | "buyer_cancelled" | "payment_expired";
export type FailReason = "work_timeout" | "seller_abandoned" | "heartbeat_lost";

export interface Order {
  id: string;
  capabilityType: CapabilityType;
  buyerAccountId: string;
  input: unknown;
  status: OrderStatus;
  // Deadline of the current stage; the expiry event depends on the status.
  deadline: Date | null;
  // Sellers currently holding the offer, and everyone who already passed.
  offeredTo: string[];
  offerKind: SellerKind | null;
  passedBy: string[];
  sellerAccountId: string | null;
  priceFen: Fen | null;
  // Set on accept from the seller's listing; the work clock uses it once paid.
  workTimeoutMs: number | null;
  purchaseUrl: string | null;
  // Opaque reference to whatever proved payment (e.g. the 即刻收 purchase request number).
  paymentRef: string | null;
  deliveryAttempts: number;
  lastDeliveryError: string | null;
  output: unknown;
  verdict: Verdict | null;
  cancelReason: CancelReason | null;
  failReason: FailReason | null;
  // Refunds aren't implemented yet; we only mark orders that may need one.
  refundEligible: boolean;
}

export type OrderEvent =
  | { type: "dispatch" }
  | { type: "offer"; sellerAccountIds: string[]; kind: SellerKind }
  | { type: "no_candidates" }
  | { type: "seller_accept"; sellerAccountId: string; priceFen: Fen; workTimeoutMs?: number }
  | { type: "seller_decline"; sellerAccountId: string }
  | { type: "offer_expired" }
  | { type: "payment_requested"; purchaseUrl: string }
  | { type: "payment_confirmed"; paymentRef: string }
  | { type: "payment_expired" }
  | { type: "buyer_cancel" }
  | { type: "work_started" }
  | { type: "delivery_submitted"; output: unknown }
  | { type: "work_failed"; reason: FailReason }
  | { type: "buyer_verdict"; verdict: "accepted" | "rejected" }
  | { type: "acceptance_expired" };

export type TransitionResult = { ok: true; order: Order } | { ok: false; error: string };

export function newOrder(params: {
  id: string;
  capabilityType: CapabilityType;
  buyerAccountId: string;
  input: unknown;
}): Order {
  return {
    ...params,
    status: "CREATED",
    deadline: null,
    offeredTo: [],
    offerKind: null,
    passedBy: [],
    sellerAccountId: null,
    priceFen: null,
    workTimeoutMs: null,
    purchaseUrl: null,
    paymentRef: null,
    deliveryAttempts: 0,
    lastDeliveryError: null,
    output: null,
    verdict: null,
    cancelReason: null,
    failReason: null,
    refundEligible: false,
  };
}

const CANCELLABLE_BY_BUYER: ReadonlySet<OrderStatus> = new Set([
  "CREATED",
  "DISPATCHING",
  "OFFERED",
  "ACCEPTED",
  "AWAITING_PAYMENT",
]);

const after = (now: Date, ms: number) => new Date(now.getTime() + ms);

function reject(order: Order, event: OrderEvent): TransitionResult {
  return { ok: false, error: `cannot apply ${event.type} in status ${order.status}` };
}

function backToDispatch(order: Order): Order {
  return {
    ...order,
    status: "DISPATCHING",
    passedBy: [...new Set([...order.passedBy, ...order.offeredTo])],
    offeredTo: [],
    offerKind: null,
    deadline: null,
  };
}

// Pure transition function: callers persist the returned order.
export function transition(order: Order, event: OrderEvent, now: Date): TransitionResult {
  const s = order.status;
  const ok = (next: Order): TransitionResult => ({ ok: true, order: next });

  switch (event.type) {
    case "dispatch":
      if (s !== "CREATED") return reject(order, event);
      return ok({ ...order, status: "DISPATCHING" });

    case "offer":
      if (s !== "DISPATCHING") return reject(order, event);
      if (event.sellerAccountIds.length === 0) return { ok: false, error: "offer needs at least one seller" };
      return ok({
        ...order,
        status: "OFFERED",
        offeredTo: event.sellerAccountIds,
        offerKind: event.kind,
        deadline: after(now, TIMEOUTS.offer[event.kind]),
      });

    case "no_candidates":
      if (s !== "DISPATCHING") return reject(order, event);
      return ok({ ...order, status: "CANCELLED", cancelReason: "no_seller", deadline: null });

    case "seller_accept":
      if (s !== "OFFERED") return reject(order, event);
      // Human offers are broadcast; the first accept wins and later ones land here as errors.
      if (!order.offeredTo.includes(event.sellerAccountId)) {
        return { ok: false, error: "seller does not hold this offer" };
      }
      return ok({
        ...order,
        status: "ACCEPTED",
        sellerAccountId: event.sellerAccountId,
        priceFen: event.priceFen,
        workTimeoutMs: event.workTimeoutMs ?? null,
        offeredTo: [],
        deadline: null,
      });

    case "seller_decline": {
      if (s !== "OFFERED") return reject(order, event);
      if (!order.offeredTo.includes(event.sellerAccountId)) {
        return { ok: false, error: "seller does not hold this offer" };
      }
      const remaining = order.offeredTo.filter((id) => id !== event.sellerAccountId);
      const passedBy = [...order.passedBy, event.sellerAccountId];
      if (remaining.length > 0) return ok({ ...order, offeredTo: remaining, passedBy });
      return ok(backToDispatch({ ...order, passedBy }));
    }

    case "offer_expired":
      if (s !== "OFFERED") return reject(order, event);
      return ok(backToDispatch(order));

    case "payment_requested":
      if (s !== "ACCEPTED") return reject(order, event);
      return ok({
        ...order,
        status: "AWAITING_PAYMENT",
        purchaseUrl: event.purchaseUrl,
        deadline: after(now, TIMEOUTS.payment),
      });

    case "payment_confirmed": {
      if (s !== "AWAITING_PAYMENT") return reject(order, event);
      // The work clock starts at payment, so a seller who never starts still times out.
      const work = order.workTimeoutMs ?? capabilityTypes[order.capabilityType].workTimeoutMs;
      return ok({
        ...order,
        status: "PAID",
        paymentRef: event.paymentRef,
        deadline: after(now, work),
      });
    }

    case "payment_expired":
      if (s !== "AWAITING_PAYMENT") return reject(order, event);
      return ok({ ...order, status: "CANCELLED", cancelReason: "payment_expired", deadline: null });

    case "buyer_cancel":
      // After payment the money already sits with the seller and refunds aren't built yet.
      if (!CANCELLABLE_BY_BUYER.has(s)) return reject(order, event);
      return ok({
        ...order,
        status: "CANCELLED",
        cancelReason: "buyer_cancelled",
        offeredTo: [],
        deadline: null,
      });

    case "work_started":
      if (s !== "PAID") return reject(order, event);
      return ok({ ...order, status: "IN_PROGRESS" });

    case "delivery_submitted": {
      if (s !== "IN_PROGRESS") return reject(order, event);
      const attempts = order.deliveryAttempts + 1;
      const checked = checkOutput(order.capabilityType, event.output);
      // A malformed delivery doesn't fail the order; the seller may resubmit until the deadline.
      if (!checked.ok) {
        return ok({ ...order, deliveryAttempts: attempts, lastDeliveryError: checked.error });
      }
      return ok({
        ...order,
        status: "DELIVERED",
        output: checked.value,
        deliveryAttempts: attempts,
        lastDeliveryError: null,
        deadline: after(now, TIMEOUTS.acceptance),
      });
    }

    case "work_failed":
      if (s !== "PAID" && s !== "IN_PROGRESS") return reject(order, event);
      return ok({
        ...order,
        status: "FAILED",
        failReason: event.reason,
        refundEligible: true,
        deadline: null,
      });

    case "buyer_verdict":
      if (s !== "DELIVERED") return reject(order, event);
      return ok({
        ...order,
        status: "COMPLETED",
        verdict: event.verdict,
        refundEligible: event.verdict === "rejected",
        deadline: null,
      });

    case "acceptance_expired":
      if (s !== "DELIVERED") return reject(order, event);
      return ok({ ...order, status: "COMPLETED", verdict: "auto_accepted", deadline: null });
  }
}

// The event a sweeper should apply once the current stage's deadline has passed.
export function expiryEvent(order: Order, now: Date): OrderEvent | null {
  if (!order.deadline || now < order.deadline) return null;
  switch (order.status) {
    case "OFFERED":
      return { type: "offer_expired" };
    case "AWAITING_PAYMENT":
      return { type: "payment_expired" };
    case "PAID":
    case "IN_PROGRESS":
      return { type: "work_failed", reason: "work_timeout" };
    case "DELIVERED":
      return { type: "acceptance_expired" };
    default:
      return null;
  }
}
