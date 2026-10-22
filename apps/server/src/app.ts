import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { HiveClient } from "@hive/client/api";
import { createMcpServer } from "@hive/client/mcp";
import { Hive, HiveError, MAX_FILE_BYTES, type Principal } from "./hive.ts";
import { OutboxMailer } from "./mail.ts";
import { FakePaymentProvider } from "./payments/fake.ts";

type Env = { Variables: { principal: Principal } };

// Long-polls hold for at most this long; clients just poll again.
export const MAX_POLL_MS = 25_000;

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const json = await c.req.json().catch(() => {
    throw new HiveError(400, "invalid_json", "request body must be JSON");
  });
  const r = schema.safeParse(json);
  if (!r.success) throw new HiveError(400, "invalid_request", z.prettifyError(r.error));
  return r.data;
}

const fenAmount = z.number().int().nonnegative();

export interface AppOptions {
  // Where the web app lives, for links sent to people. Defaults to the origin the request came in on.
  webUrl?: string;
}

export function createApp(hive: Hive, opts: AppOptions = {}) {
  const app = new Hono<Env>();
  const webUrl = (c: Context) => (opts.webUrl ?? new URL(c.req.url).origin).replace(/\/$/, "");

  app.onError((err, c) => {
    if (err instanceof HiveError) return c.json({ error: err.code, message: err.message }, err.status);
    console.error(err);
    return c.json({ error: "internal", message: "internal error" }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true, payments: hive.payments.name }));

  // ---- public -----------------------------------------------------------

  // Categories plus who sells in each and how they work, so a buyer (or their agent) can choose before ordering.
  app.get("/v1/categories", async (c) => c.json(await hive.market()));

  // Delivered files. The unguessable id is the key, so links work in <img> and for agents without a token.
  // Sandboxed so an uploaded HTML or SVG can't run as the web app.
  app.get("/v1/files/:id", async (c) => {
    const { meta, bytes } = await hive.readFile(c.req.param("id"));
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "content-type": meta.mime,
      "content-length": String(meta.size),
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=31536000, immutable",
    });
  });

  // Sign-up takes only a name; the token it returns is the owner's login.
  app.post("/v1/accounts", async (c) => {
    const { name } = await body(c, z.object({ name: z.string().min(1).max(64) }));
    return c.json(await hive.createAccount(name), 201);
  });

  app.post("/v1/device-logins", async (c) => {
    const { label } = await body(c, z.object({ label: z.string().max(64).optional() }));
    const dl = await hive.startDeviceLogin(label ?? null);
    // RFC 8628's verification_uri(_complete): the owner opens the link and taps approve.
    const verificationUri = `${webUrl(c)}/approve`;
    return c.json({ ...dl, verificationUri, verificationUriComplete: `${verificationUri}?code=${dl.userCode}` }, 201);
  });

  app.post("/v1/device-logins/:id/poll", async (c) => {
    const { secret } = await body(c, z.object({ secret: z.string() }));
    return c.json(await hive.pollDeviceLogin(c.req.param("id"), secret));
  });

  // ---- remote MCP -------------------------------------------------------
  // The buying tools over Streamable HTTP, keyed by an agent token (`hive api-key`).
  // Stateless: each request gets its own server, and tools call this app in-process with the caller's key.

  app.all("/mcp", async (c) => {
    const key = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const principal = key ? await hive.authenticate(key) : null;
    if (!principal) throw new HiveError(401, "unauthorized", "send an API key from `hive api-key` as a Bearer token");
    if (principal.actor !== "agent") throw new HiveError(403, "agents_only", "use an API key from `hive api-key`, not the owner token");
    const client = new HiveClient("http://hive.internal", key!, (url, init) => Promise.resolve(app.fetch(new Request(url, init))));
    const server = createMcpServer({
      client: async () => client,
      publicUrl: new URL(c.req.url).origin,
      unauthorizedHint: "The API key was revoked; ask the owner for a new one.",
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  // ---- authenticated ----------------------------------------------------

  const authed = new Hono<Env>();
  authed.use(async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const principal = token ? await hive.authenticate(token) : null;
    if (!principal) throw new HiveError(401, "unauthorized", "missing or invalid token");
    c.set("principal", principal);
    await next();
  });
  const me = (c: Context<Env>) => c.get("principal");

  authed.get("/device-logins/:code", async (c) => c.json(await hive.describeDeviceLogin(me(c), c.req.param("code"))));

  authed.post("/device-logins/approve", async (c) => {
    const { userCode } = await body(c, z.object({ userCode: z.string() }));
    await hive.approveDeviceLogin(me(c), userCode);
    return c.json({ ok: true });
  });

  authed.post("/api-keys", async (c) => {
    const { label } = await body(c, z.object({ label: z.string().max(64).optional() }));
    return c.json(await hive.createApiKey(me(c), label ?? null), 201);
  });

  authed.get("/agents", async (c) => c.json(await hive.listAgents(me(c))));
  authed.post("/agents/:id/revoke", async (c) => {
    await hive.revokeAgent(me(c), c.req.param("id"));
    return c.json({ ok: true });
  });

  authed.get("/me", async (c) => {
    const a = await hive.getAccount(me(c).accountId);
    return c.json({
      id: a.id,
      name: a.name,
      actor: me(c).actor,
      rules: { perOrderCapFen: a.perOrderCapFen, dailyCapFen: a.dailyCapFen, paused: a.paused },
      humanAccepting: a.humanAccepting,
      email: a.email,
    });
  });

  // Account settings the owner edits on 我的; for now only where notifications are mailed.
  authed.patch("/me", async (c) => {
    const { email } = await body(c, z.object({ email: z.email().max(254).nullable() }));
    const a = await hive.setEmail(me(c), email);
    return c.json({ email: a.email });
  });

  authed.patch("/me/rules", async (c) => {
    const rules = await body(
      c,
      z.object({
        perOrderCapFen: fenAmount.nullable().optional(),
        dailyCapFen: fenAmount.nullable().optional(),
        paused: z.boolean().optional(),
      }),
    );
    const a = await hive.updateRules(me(c), Object.fromEntries(Object.entries(rules).filter(([, v]) => v !== undefined)));
    return c.json({ perOrderCapFen: a.perOrderCapFen, dailyCapFen: a.dailyCapFen, paused: a.paused });
  });

  authed.get("/me/bill", async (c) => c.json(await hive.bill(me(c))));

  authed.get("/listings", async (c) => c.json(await hive.myListings(me(c).accountId)));

  authed.put("/listings/:category", async (c) => {
    const opts = await body(
      c,
      z.object({
        acceptMode: z.enum(["auto", "ask"]),
        workMode: z.enum(["agent", "manual"]).optional(),
        deliveryHours: z.number().int().positive().max(24 * 30).nullable().optional(),
        dailyLimit: z.number().int().positive().max(10_000),
        tags: z.array(z.string().max(20)).max(10).optional(),
        intro: z.string().max(200).nullable().optional(),
        active: z.boolean().optional(),
      }),
    );
    return c.json(await hive.upsertListing(me(c), c.req.param("category"), opts));
  });

  authed.post("/listings/:category/payment-setup", async (c) =>
    c.json(await hive.setupListingPayment(me(c), c.req.param("category"))),
  );

  authed.post("/seller/accepting", async (c) => {
    const { on } = await body(c, z.object({ on: z.boolean() }));
    await hive.setHumanAccepting(me(c), on);
    return c.json({ accepting: on });
  });

  authed.get("/seller/poll", async (c) => {
    const wait = Math.min(Number(c.req.query("wait") ?? 0) * 1000 || 0, MAX_POLL_MS);
    const listener = c.req.query("listener");
    return c.json(await hive.pollSeller(me(c), wait, listener === undefined ? undefined : listener === "1"));
  });

  authed.post("/orders", async (c) => {
    const req = await body(
      c,
      z.object({
        category: z.string(),
        brief: z.string().trim().min(1).max(4000),
        input: z.unknown().optional(),
        // Validated in full by the service; see checkDeliverySpec.
        delivery: z.unknown().default({ kind: "any" }),
      }),
    );
    return c.json(await hive.createOrder(me(c), req), 201);
  });

  authed.get("/orders", async (c) => {
    const role = c.req.query("role") === "seller" ? "seller" : "buyer";
    return c.json(await hive.listOrders(me(c), role));
  });

  authed.get("/orders/:id", async (c) => c.json(await hive.orderDetail(me(c), c.req.param("id"))));
  authed.post("/orders/:id/cancel", async (c) => c.json(await hive.cancelOrder(me(c), c.req.param("id"))));
  authed.post("/orders/:id/check-payment", async (c) => c.json(await hive.checkPayment(me(c), c.req.param("id"))));
  authed.post("/orders/:id/accept-offer", async (c) => c.json(await hive.acceptOffer(me(c), c.req.param("id"))));
  authed.post("/orders/:id/decline-offer", async (c) => {
    await hive.declineOffer(me(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  authed.post("/orders/:id/start", async (c) => c.json(await hive.startWork(me(c), c.req.param("id"))));
  authed.post("/orders/:id/abandon", async (c) => c.json(await hive.abandon(me(c), c.req.param("id"))));
  // Raw upload: the body is the file, its type is the content-type, its name the `name` query.
  authed.post("/orders/:id/files", async (c) => {
    const size = Number(c.req.header("content-length") ?? 0);
    if (size > MAX_FILE_BYTES) throw new HiveError(400, "file_too_large", `files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const file = { name: c.req.query("name") ?? "file", mime: c.req.header("content-type") ?? "application/octet-stream", bytes };
    return c.json(await hive.uploadFile(me(c), c.req.param("id"), file), 201);
  });

  authed.post("/orders/:id/deliver", async (c) => {
    const req = await body(
      c,
      z.object({
        note: z.string().max(10_000).nullable().optional(),
        data: z.unknown().optional(),
        files: z.array(z.string()).max(50).optional(),
      }),
    );
    return c.json(await hive.deliver(me(c), c.req.param("id"), req));
  });
  authed.post("/orders/:id/verdict", async (c) => {
    const { verdict } = await body(c, z.object({ verdict: z.enum(["accepted", "rejected"]) }));
    return c.json(await hive.verdict(me(c), c.req.param("id"), verdict));
  });

  authed.get("/notifications", async (c) =>
    c.json(await hive.listNotifications(me(c), Number(c.req.query("after") ?? 0) || 0)),
  );
  authed.post("/notifications/read-all", async (c) => {
    await hive.markAllNotificationsRead(me(c));
    return c.json({ ok: true });
  });
  authed.post("/notifications/:id/read", async (c) => {
    await hive.markNotificationRead(me(c), Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  // Web Push: the browser subscribes with this server's VAPID key, then gets notifications with the tab closed.
  authed.get("/push/key", (c) => c.json({ publicKey: hive.push?.publicKey ?? null }));
  authed.post("/push/subscribe", async (c) => {
    const target = await body(
      c,
      z.object({ endpoint: z.url().max(2048), keys: z.object({ p256dh: z.string().max(256), auth: z.string().max(256) }) }),
    );
    await hive.subscribePush(me(c), target);
    return c.json({ ok: true });
  });
  authed.post("/push/unsubscribe", async (c) => {
    const { endpoint } = await body(c, z.object({ endpoint: z.string() }));
    await hive.unsubscribePush(me(c), endpoint);
    return c.json({ ok: true });
  });
  authed.post("/push/test", async (c) => c.json(await hive.testPush(me(c))));

  // ---- dev: simulate the buyer confirming in Alipay ---------------------
  // Registered before the authed routes so the /v1 auth middleware doesn't catch them.

  if (hive.payments instanceof FakePaymentProvider) {
    const fake = hive.payments;
    const pay = (c: Context) => {
      const ok = fake.completePurchase(decodeURIComponent(c.req.param("requestNo") ?? ""));
      if (!ok) throw new HiveError(404, "purchase_not_found", "unknown purchase");
      return c.json({ paid: true });
    };
    // Opening the link shows a stand-in for the Alipay confirm screen; only the tap (POST) pays,
    // so link previews and prefetches never pay by accident.
    app.get("/v1/dev/fake-pay/:requestNo", (c) => {
      const requestNo = c.req.param("requestNo");
      const order = requestNo.replace(/^purchase_/, "");
      return c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>模拟支付宝付款</title><style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f5f5f5;color:#222}
.top{background:#1677ff;color:#fff;padding:18px 16px;font-size:17px;font-weight:600}.card{background:#fff;margin:16px;border-radius:12px;padding:24px 16px;text-align:center}
.tip{color:#999;font-size:13px;margin-top:8px}button{width:100%;margin-top:24px;padding:14px;border:0;border-radius:10px;background:#1677ff;color:#fff;font-size:17px}
button:disabled{opacity:.5}#done{display:none;color:#00b578;font-size:18px;margin-top:20px}</style></head><body>
<div class="top">支付宝 · 测试环境</div><div class="card"><div>hive 订单</div><div class="tip">${order.replace(/[^\w-]/g, "")}</div>
<div class="tip">这是假支付：点确认就等于你在支付宝里付了款</div><button id="b">确认付款</button><div id="done">付款成功，回到你的 agent 或 hive 订单页</div></div>
<script>b.onclick=async()=>{b.disabled=true;const r=await fetch(location.pathname,{method:"POST"});if(r.ok){b.style.display="none";done.style.display="block"}else{b.disabled=false;b.textContent="付款失败，再试一次"}}</script>
</body></html>`);
    });
    app.post("/v1/dev/fake-pay/:requestNo", pay);

    // The dev outbox: mail hive would have sent, newest first, like a mailcatcher. Refreshes itself.
    const outbox = hive.mailer;
    if (outbox instanceof OutboxMailer) {
      app.get("/v1/dev/mail", async (c) => {
        const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
        const linked = (s: string) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
        const mails = await outbox.list();
        const items = mails
          .map(
            (m) => `<div class="m"><div class="h"><b>${esc(m.subject)}</b><span>${m.createdAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span></div>
<div class="to">收件人：${esc(m.to)}</div><pre>${linked(m.text)}</pre></div>`,
          )
          .join("\n");
        return c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>hive 邮件（测试收件箱）</title><style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f5f5f5;color:#222}
.top{background:#1677ff;color:#fff;padding:16px;font-size:17px;font-weight:600}.top small{display:block;font-weight:400;font-size:12px;opacity:.85;margin-top:4px}
.m{background:#fff;margin:12px;border-radius:10px;padding:14px}.h{display:flex;justify-content:space-between;gap:12px}.h span,.to{color:#8c8c8c;font-size:12px}
pre{white-space:pre-wrap;font:inherit;font-size:14px;margin:10px 0 0}a{color:#1677ff}.empty{text-align:center;color:#8c8c8c;padding:40px}</style></head><body>
<div class="top">hive 邮件 · 测试收件箱<small>没有配置 SMTP，邮件不会真的发出，都在这里。每 5 秒刷新</small></div>
${items || '<div class="empty">还没有邮件。在「我的」里填上邮箱，订单要你处理时会出现在这里</div>'}
</body></html>`);
      });
    }
  }

  app.route("/v1", authed);

  return app;
}
