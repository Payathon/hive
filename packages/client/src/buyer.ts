import { yuan, type HiveClient, type Order, type OrderRequest } from "./api.ts";

// Buyer flows shared by the CLI and the MCP server. Waits take an absolute deadline
// (Infinity for the CLI's --wait) and return the order as last seen.

const TERMINAL = new Set(["COMPLETED", "CANCELLED", "FAILED"]);
const NEEDS_CALLER = new Set(["AWAITING_PAYMENT", "DELIVERED"]);
const UNANSWERED = new Set(["CREATED", "DISPATCHING", "OFFERED", "ACCEPTED"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Agent sellers answer within seconds; waiting here means the caller gets the payment link immediately.
export async function placeOrder(client: HiveClient, req: OrderRequest, deadline: number) {
  let order = await client.createOrder(req);
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
    `Payment needed: ${yuan(o.priceFen)} for ${o.category}.`,
    "Ask the owner to confirm in Alipay:",
    `  ${o.purchaseUrl}`,
    ...(o.purchaseQrCode ? [`  QR: ${o.purchaseQrCode}`] : []),
  ].join("\n");
}

// Human sellers get a long window to approve, so say when this round of offers runs out.
function offerLine(o: Order) {
  if (o.offerKind !== "human" || !o.deadline) return "offered to a seller, waiting for acceptance";
  const minutes = Math.max(0, Math.ceil((new Date(o.deadline).getTime() - Date.now()) / 60_000));
  return `waiting for a seller to approve, until ${o.deadline} (about ${minutes} min); if nobody does, hive offers the next sellers`;
}

// The delivery as text, with absolute file links (base: the server the files are on).
export function deliveryText(o: Order, base: string): string[] {
  const d = o.output;
  if (!d) return [];
  return [
    ...(d.note ? ["note:", d.note] : []),
    ...(d.data !== null && d.data !== undefined ? ["data:", JSON.stringify(d.data, null, 2)] : []),
    ...(d.files.length ? ["files:", ...d.files.map((f) => `  ${f.name}  ${f.mime}  ${f.size} bytes  ${new URL(f.url, base).href}`)] : []),
  ];
}

export function describe(o: Order, opts: { reviewHint?: string; base: string }): string {
  const reviewHint = opts.reviewHint ?? `review with: hive accept ${o.id}  |  hive reject ${o.id}`;
  const lines = [`${o.id}  ${o.status}  ${o.category}  ${yuan(o.priceFen)}`];
  if (o.status === "OFFERED") lines.push(offerLine(o));
  if (o.status === "AWAITING_PAYMENT") lines.push(paymentPrompt(o));
  if (o.status === "DELIVERED") lines.push("delivery:", ...deliveryText(o, opts.base), reviewHint);
  if (o.status === "COMPLETED") lines.push(...deliveryText(o, opts.base));
  if (o.cancelReason) lines.push(`cancelled: ${o.cancelReason}`);
  if (o.failReason) lines.push(`failed: ${o.failReason}`);
  return lines.join("\n");
}
