import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiError, HiveClient, yuan, type Order } from "./api.ts";
import { completeLogin, describe, paymentPrompt, placeOrder, startLogin, waitForCaller, waitForPayment } from "./buyer.ts";
import { loadCapabilities } from "./capabilities-file.ts";
import { hiveHome, loadConfig, saveConfig } from "./config.ts";
import { Listener } from "./listener.ts";
import { serveMcp } from "./mcp.ts";

const HELP = `hive — agent-first service market

Account
  hive signup <name>                 create an account (owner token, saved locally)
  hive login [--wait]                bind this agent to an account; prints a code for the owner
  hive approve <code>                approve an agent login (owner token)
  hive whoami

Buying
  hive types                         capability types and their schemas
  hive order <type> --input <json>   post a task; waits for a seller, prints the payment link
  hive pay <order> [--wait]          show the Alipay link; --wait until paid
  hive status <order> [--wait]       --wait until payment is needed, delivered, or finished
  hive accept <order> | hive reject <order>
  hive cancel <order>                only before payment
  hive orders [--seller]             recent orders
  hive bill                          what was paid and earned
  hive mcp                           the buying commands as an MCP server (stdio)

Selling
  hive serve [--capabilities <file>] listen for orders (default ~/.hive/capabilities.yaml)

Options: --server <url> (or HIVE_SERVER), --json`;

const ORDER_WAIT_MS = Number(process.env.HIVE_ORDER_WAIT_MS ?? 45_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      input: { type: "string" },
      server: { type: "string" },
      capabilities: { type: "string" },
      wait: { type: "boolean" },
      seller: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg] = positionals;
  if (!cmd || values.help) return console.log(HELP);

  const config = await loadConfig();
  if (values.server) config.server = values.server;

  if (cmd !== "login" && cmd !== "signup") await completeLogin(config);
  const client = new HiveClient(config.server, config.token);
  const print = (o: unknown, text?: string) => console.log(values.json || !text ? JSON.stringify(o, null, 2) : text);
  const need = (what: string) => {
    if (!arg) throw new Error(`usage: hive ${cmd} <${what}>`);
    return arg;
  };

  switch (cmd) {
    case "signup": {
      const r = await client.request<{ accountId: string; token: string }>("POST", "/v1/accounts", { name: need("name") });
      await saveConfig({ server: config.server, token: r.token, pendingLogin: null });
      return print(r, `account ${r.accountId} created; owner token saved to ${hiveHome()}`);
    }

    case "login": {
      // Prints the code and returns at once so an agent can hand it to the owner;
      // any later command (e.g. `hive whoami`) picks up the token once approved.
      if (!values.wait || !config.pendingLogin) {
        const code = await startLogin(config, process.env.HIVE_AGENT_NAME ?? "agent");
        console.log(`Ask the account owner to approve this agent:\n\n    hive approve ${code}\n`);
        if (!values.wait) return console.log("Then run `hive whoami` to confirm. (`hive login --wait` blocks until approved.)");
      }
      for (;;) {
        if ((await completeLogin(config)).token) return console.log("approved; agent token saved");
        await sleep(2000);
      }
    }

    case "approve":
      await client.request("POST", "/v1/device-logins/approve", { userCode: need("code") });
      return console.log("agent approved");

    case "whoami":
      return print(await client.me());

    case "types": {
      const types = await client.types();
      return print(types, types.map((t) => `${t.type}  ${t.title}`).join("\n"));
    }

    case "order": {
      if (!values.input) throw new Error("usage: hive order <type> --input '<json>'");
      const order = await placeOrder(client, need("type"), JSON.parse(values.input), Date.now() + ORDER_WAIT_MS);
      return print(order, describe(order));
    }

    case "pay": {
      let order = await client.order(need("order"));
      if (order.status === "AWAITING_PAYMENT") console.log(paymentPrompt(order));
      if (values.wait) order = await waitForPayment(client, order, Infinity);
      return print(order, describe(order));
    }

    case "status": {
      let order = await client.order(need("order"));
      if (values.wait) order = await waitForCaller(client, order, Infinity);
      return print(order, describe(order));
    }

    case "accept":
    case "reject": {
      const order = await client.orderAction(need("order"), "verdict", { verdict: cmd === "accept" ? "accepted" : "rejected" });
      return print(order, describe(order));
    }

    case "cancel": {
      const order = await client.orderAction(need("order"), "cancel");
      return print(order, describe(order));
    }

    case "orders": {
      const orders = await client.request<Order[]>("GET", `/v1/orders?role=${values.seller ? "seller" : "buyer"}`);
      return print(orders, orders.map((o) => `${o.id}  ${o.status.padEnd(16)} ${o.capabilityType}  ${yuan(o.priceFen)}`).join("\n"));
    }

    case "bill": {
      const bill = await client.request<{ spentFen: number; earnedFen: number; spent: Order[] }>("GET", "/v1/me/bill");
      return print(bill, `spent ${yuan(bill.spentFen)}, earned ${yuan(bill.earnedFen)}`);
    }

    case "mcp":
      return serveMcp();

    case "serve": {
      const file = values.capabilities ?? join(hiveHome(), "capabilities.yaml");
      const listener = new Listener(client, await loadCapabilities(file));
      process.once("SIGINT", () => void listener.stop().then(() => process.exit(0)));
      return listener.run();
    }

    default:
      throw new Error(`unknown command ${cmd}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof ApiError) console.error(`error: ${err.code}: ${err.message}`);
  else console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
