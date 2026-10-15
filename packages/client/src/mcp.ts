import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, yuan, type HiveClient, type Order } from "./api.ts";
import { describe, placeOrder, waitForCaller, waitForPayment } from "./buyer.ts";

// hive's buying tools over MCP, served locally by `hive mcp` (stdio) and remotely by the server's /mcp.
// Selling stays on `hive serve`. There is no approve tool: an agent must never approve its own login.

export interface McpOptions {
  // The client to act with, resolved per call.
  client: () => Promise<HiveClient>;
  // Local only: starts a login and returns what to show the owner. Remote callers already hold an API key.
  login?: () => Promise<string>;
  // Appended to 401 errors.
  unauthorizedHint: string;
}

// MCP clients time out long tool calls, so waits are capped and the agent calls again.
const WAIT_MS = Number(process.env.HIVE_MCP_WAIT_MS ?? 50_000);

const LOGIN_RULE = `- Not logged in: call hive_login, show the owner the \`hive approve <code>\` line, end your turn, and continue once they say they ran it.
`;
const INSTRUCTIONS = `hive is a market where agents and people buy and sell services. You do everything except pay: every payment is confirmed by your owner in Alipay.
- Never approve your own login or pay on the owner's behalf.
- Buy with hive_types → hive_order → (owner pays) → hive_status → hive_accept or hive_reject. Only buy a type whose output you actually need.
- Payment always needs the owner: show them the price and payment link exactly as returned. Nothing reaches them unless you show it.
- If an order is CANCELLED with no_seller, or the owner's rules block it (account_paused, daily_cap_reached), tell the owner and stop; don't retry in a loop.`;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));
const reviewHint = (o: Order) => `review with hive_accept or hive_reject (order ${o.id})`;
const orderText = (o: Order, extra?: string) => text([describe(o, reviewHint(o)), ...(extra ? [extra] : [])].join("\n"));

const orderId = { order_id: z.string().describe("Order id returned by hive_order") };

export function createMcpServer(opts: McpOptions) {
  const { login } = opts;
  const client = async () => ({ client: await opts.client() });
  const tool =
    <A>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (err) {
        let msg = err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message;
        if (err instanceof ApiError && err.status === 401) msg += `\n${opts.unauthorizedHint}`;
        return { ...text(`error: ${msg}`), isError: true };
      }
    };

  const server = new McpServer(
    { name: "hive", version: "0.0.0" },
    { instructions: INSTRUCTIONS.replace("\n", `\n${login ? LOGIN_RULE : ""}`) },
  );

  if (login) {
    server.registerTool(
      "hive_login",
      {
        description:
          "Bind this agent to the owner's hive account. Returns a `hive approve <code>` line: show it to the owner, end your turn, and ask them to tell you once they've run it. Then hive_whoami confirms.",
      },
      tool(async () => text(await login())),
    );
  }

  server.registerTool(
    "hive_whoami",
    { description: "The account this agent acts for.", annotations: { readOnlyHint: true } },
    tool(async () => json(await (await client()).client.me())),
  );

  server.registerTool(
    "hive_types",
    {
      description: "Capability types on the market, with their input and output JSON Schemas. Check here before ordering.",
      annotations: { readOnlyHint: true },
    },
    tool(async () => json(await (await client()).client.types())),
  );

  server.registerTool(
    "hive_order",
    {
      description: `Post a task. Waits for an agent seller to accept (up to ~${Math.round(WAIT_MS / 1000)}s).
- AWAITING_PAYMENT: show the owner the price and payment link exactly as returned, ask them to confirm in Alipay, then call hive_pay with wait=true.
- OFFERED: a human seller is deciding (up to 3 minutes); call hive_status with wait=true.
- CANCELLED with no_seller: nobody can take it now (or it exceeds the owner's price cap). Tell the owner; don't retry in a loop.`,
      inputSchema: {
        type: z.string().describe("Capability type from hive_types, e.g. market-data.competitors"),
        input: z.record(z.string(), z.unknown()).describe("Task input matching the type's input schema"),
      },
    },
    tool(async ({ type, input }) => orderText(await placeOrder((await client()).client, type, input, Date.now() + WAIT_MS))),
  );

  server.registerTool(
    "hive_pay",
    {
      description:
        "Check whether the owner has paid. With wait=true, keeps checking for a while; call again if it is still AWAITING_PAYMENT. Payment requests expire after 15 minutes. You cannot pay; only the owner can, in Alipay.",
      inputSchema: { ...orderId, wait: z.boolean().optional().describe("Keep checking until paid or the call's time limit") },
    },
    tool(async ({ order_id, wait }) => {
      const c = (await client()).client;
      let order = await c.order(order_id);
      if (order.status === "AWAITING_PAYMENT") order = await c.orderAction(order.id, "check-payment");
      if (wait) order = await waitForPayment(c, order, Date.now() + WAIT_MS);
      return orderText(order, order.status === "AWAITING_PAYMENT" && wait ? "Still unpaid; call hive_pay again." : undefined);
    }),
  );

  server.registerTool(
    "hive_status",
    {
      description:
        "Order status. With wait=true, waits until payment is needed, the delivery arrives, or the order ends; call again if it hasn't. On DELIVERED, check the output against what you needed and call hive_accept or hive_reject (auto-accepts after 30 minutes).",
      inputSchema: { ...orderId, wait: z.boolean().optional().describe("Wait until the caller needs to act") },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ order_id, wait }) => {
      const c = (await client()).client;
      let order = await c.order(order_id);
      if (wait) order = await waitForCaller(c, order, Date.now() + WAIT_MS);
      return orderText(order);
    }),
  );

  server.registerTool(
    "hive_accept",
    { description: "Accept a DELIVERED order whose output fits what you needed.", inputSchema: orderId },
    tool(async ({ order_id }) => orderText(await (await client()).client.orderAction(order_id, "verdict", { verdict: "accepted" }))),
  );

  server.registerTool(
    "hive_reject",
    {
      description:
        "Reject a DELIVERED order whose output is wrong or useless. It doesn't refund the payment; it lowers the seller's reputation. Tell the owner why.",
      inputSchema: orderId,
    },
    tool(async ({ order_id }) => orderText(await (await client()).client.orderAction(order_id, "verdict", { verdict: "rejected" }))),
  );

  server.registerTool(
    "hive_cancel",
    { description: "Cancel an order. Only works before payment; a paid order can't be cancelled.", inputSchema: orderId },
    tool(async ({ order_id }) => orderText(await (await client()).client.orderAction(order_id, "cancel"))),
  );

  server.registerTool(
    "hive_orders",
    { description: "Recent orders this account placed.", annotations: { readOnlyHint: true } },
    tool(async () => {
      const orders = await (await client()).client.request<Order[]>("GET", "/v1/orders?role=buyer");
      return text(orders.map((o) => `${o.id}  ${o.status}  ${o.capabilityType}  ${yuan(o.priceFen)}`).join("\n") || "no orders");
    }),
  );

  server.registerTool(
    "hive_bill",
    { description: "What the owner paid and earned; orders you placed are marked as agent-initiated.", annotations: { readOnlyHint: true } },
    tool(async () => json(await (await client()).client.request("GET", "/v1/me/bill"))),
  );

  return server;
}
