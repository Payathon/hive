import { eq } from "drizzle-orm";
import { isCapabilityType, type Fen, type Order, type OrderEvent, type OrderStatus } from "@hive/core";
import type { Db } from "./db/client.ts";
import { orderEvents, orders } from "./db/schema.ts";

export type OrderRow = typeof orders.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function rowToOrder(row: OrderRow): Order {
  if (!isCapabilityType(row.capabilityType)) throw new Error(`unknown capability type ${row.capabilityType}`);
  return {
    id: row.id,
    capabilityType: row.capabilityType,
    buyerAccountId: row.buyerAccountId,
    input: row.input,
    status: row.status as OrderStatus,
    deadline: row.deadline,
    offeredTo: row.offeredTo,
    offerKind: row.offerKind,
    passedBy: row.passedBy,
    sellerAccountId: row.sellerAccountId,
    priceFen: row.priceFen as Fen | null,
    workTimeoutMs: row.workTimeoutMs,
    purchaseUrl: row.purchaseUrl,
    paymentRef: row.paymentRef,
    deliveryAttempts: row.deliveryAttempts,
    lastDeliveryError: row.lastDeliveryError,
    output: row.output,
    verdict: row.verdict,
    cancelReason: row.cancelReason as Order["cancelReason"],
    failReason: row.failReason as Order["failReason"],
    refundEligible: row.refundEligible,
  };
}

// The columns the state machine owns; everything else on the row is set by the service.
export function orderColumns(o: Order) {
  return {
    status: o.status,
    deadline: o.deadline,
    offeredTo: o.offeredTo,
    offerKind: o.offerKind,
    passedBy: o.passedBy,
    sellerAccountId: o.sellerAccountId,
    priceFen: o.priceFen,
    workTimeoutMs: o.workTimeoutMs,
    purchaseUrl: o.purchaseUrl,
    paymentRef: o.paymentRef,
    deliveryAttempts: o.deliveryAttempts,
    lastDeliveryError: o.lastDeliveryError,
    output: o.output,
    verdict: o.verdict,
    cancelReason: o.cancelReason,
    failReason: o.failReason,
    refundEligible: o.refundEligible,
  };
}

export async function lockOrder(tx: Tx, id: string): Promise<OrderRow | undefined> {
  const [row] = await tx.select().from(orders).where(eq(orders.id, id)).for("update");
  return row;
}

export async function saveTransition(
  tx: Tx,
  row: OrderRow,
  next: Order,
  event: OrderEvent,
  now: Date,
  extra: Partial<OrderRow> = {},
): Promise<OrderRow> {
  const [saved] = await tx
    .update(orders)
    .set({ ...orderColumns(next), ...extra, version: row.version + 1, updatedAt: now })
    .where(eq(orders.id, row.id))
    .returning();
  // Delivery outputs can be large; the order row keeps them, the audit log doesn't need to.
  const payload = event.type === "delivery_submitted" ? { attempts: next.deliveryAttempts } : event;
  await tx.insert(orderEvents).values({ orderId: row.id, type: event.type, payload, at: now });
  return saved!;
}
