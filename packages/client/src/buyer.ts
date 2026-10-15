import { yuan, type HiveClient, type Order } from "./api.ts";

// Buyer flows shared by the CLI and the MCP server. Waits take an absolute deadline
// (Infinity for the CLI's --wait) and return the order as last seen.

const TERMINAL = new Set(["COMPLETED", "CANCELLED", "FAILED"]);
const NEEDS_CALLER = new Set(["AWAITING_PAYMENT", "DELIVERED"]);
const UNANSWERED = new Set(["CREATED", "DISPATCHING", "OFFERED", "ACCEPTED"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Agent sellers answer within seconds; waiting here means the caller gets the payment link immediately.
export async function placeOrder(client: HiveClient, type: string, input: unknown, deadline: number) {
  let order = await client.createOrder(type, input);
  while (UNANSWERED.has(order.status) && order.offerKind !== "human" && Date.now() < deadline) {
    await sleep(1000);
    order = await client.order(order.id);
  }
  return order;
}

export async function waitForPayment(client: HiveClient, order: Order, deadline: number) {
  while (order.status === "AWAITING_PAYMENT" && Date.now() < deadline) {
    await sleep(3000);
    order = await client.orderAction(order.id, "check-payment");
  }
  return order;
}

// Stops where the caller has to act: payment to hand to the owner, or a delivery to review.
export async function waitForCaller(client: HiveClient, order: Order, deadline: number) {
  while (!TERMINAL.has(order.status) && !NEEDS_CALLER.has(order.status) && Date.now() < deadline) {
    await sleep(3000);
    order = await client.order(order.id);
  }
  return order;
}

export function paymentPrompt(o: Order) {
  return [
    `Payment needed: ${yuan(o.priceFen)} for ${o.capabilityType}.`,
    "Ask the owner to confirm in Alipay:",
    `  ${o.purchaseUrl}`,
    ...(o.purchaseQrCode ? [`  QR: ${o.purchaseQrCode}`] : []),
  ].join("\n");
}

export function describe(o: Order, reviewHint = `review with: hive accept ${o.id}  |  hive reject ${o.id}`): string {
  const lines = [`${o.id}  ${o.status}  ${o.capabilityType}  ${yuan(o.priceFen)}`];
  if (o.status === "OFFERED") lines.push(`offered to ${o.offerKind} seller(s), waiting for acceptance`);
  if (o.status === "AWAITING_PAYMENT") lines.push(paymentPrompt(o));
  if (o.status === "DELIVERED") lines.push("output:", JSON.stringify(o.output, null, 2), reviewHint);
  if (o.cancelReason) lines.push(`cancelled: ${o.cancelReason}`);
  if (o.failReason) lines.push(`failed: ${o.failReason}`);
  return lines.join("\n");
}
