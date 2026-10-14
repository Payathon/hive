import { Hono, type Context } from "hono";
import { z } from "zod";
import { capabilityTypes } from "@hive/core";
import { Hive, HiveError, type Principal } from "./hive.ts";
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

export function createApp(hive: Hive) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HiveError) return c.json({ error: err.code, message: err.message }, err.status);
    console.error(err);
    return c.json({ error: "internal", message: "internal error" }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true, payments: hive.payments.name }));

  // ---- public -----------------------------------------------------------

  app.get("/v1/types", (c) =>
    c.json(
      Object.entries(capabilityTypes).map(([type, t]) => ({
        type,
        title: t.title,
        workTimeoutMs: t.workTimeoutMs,
        input: z.toJSONSchema(t.input),
        output: z.toJSONSchema(t.output),
      })),
    ),
  );

  // Sign-up stays API-only until there is a web front end.
  app.post("/v1/accounts", async (c) => {
    const { name } = await body(c, z.object({ name: z.string().min(1).max(64) }));
    return c.json(await hive.createAccount(name), 201);
  });

  app.post("/v1/device-logins", async (c) => {
    const { label } = await body(c, z.object({ label: z.string().max(64).optional() }));
    const dl = await hive.startDeviceLogin(label ?? null);
    return c.json({ ...dl, approveHint: `POST /v1/device-logins/approve {"userCode":"${dl.userCode}"}` }, 201);
  });

  app.post("/v1/device-logins/:id/poll", async (c) => {
    const { secret } = await body(c, z.object({ secret: z.string() }));
    return c.json(await hive.pollDeviceLogin(c.req.param("id"), secret));
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

  authed.post("/device-logins/approve", async (c) => {
    const { userCode } = await body(c, z.object({ userCode: z.string() }));
    await hive.approveDeviceLogin(me(c), userCode);
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
    });
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

  authed.put("/listings/:type", async (c) => {
    const opts = await body(
      c,
      z.object({
        acceptMode: z.enum(["auto", "ask"]),
        dailyLimit: z.number().int().positive().max(10_000),
        active: z.boolean().optional(),
      }),
    );
    const { active, ...rest } = opts;
    return c.json(await hive.upsertListing(me(c), c.req.param("type"), active === undefined ? rest : { ...rest, active }));
  });

  authed.post("/listings/:type/payment-setup", async (c) =>
    c.json(await hive.setupListingPayment(me(c), c.req.param("type"))),
  );

  authed.post("/seller/accepting", async (c) => {
    const { on } = await body(c, z.object({ on: z.boolean() }));
    await hive.setHumanAccepting(me(c), on);
    return c.json({ accepting: on });
  });

  authed.get("/seller/poll", async (c) => {
    const wait = Math.min(Number(c.req.query("wait") ?? 0) * 1000 || 0, MAX_POLL_MS);
    return c.json(await hive.pollSeller(me(c), wait));
  });

  authed.post("/orders", async (c) => {
    const { type, input } = await body(c, z.object({ type: z.string(), input: z.unknown() }));
    return c.json(await hive.createOrder(me(c), type, input), 201);
  });

  authed.get("/orders", async (c) => {
    const role = c.req.query("role") === "seller" ? "seller" : "buyer";
    return c.json(await hive.listOrders(me(c), role));
  });

  authed.get("/orders/:id", async (c) => c.json(await hive.getOrder(me(c), c.req.param("id"))));
  authed.post("/orders/:id/cancel", async (c) => c.json(await hive.cancelOrder(me(c), c.req.param("id"))));
  authed.post("/orders/:id/check-payment", async (c) => c.json(await hive.checkPayment(me(c), c.req.param("id"))));
  authed.post("/orders/:id/accept-offer", async (c) => c.json(await hive.acceptOffer(me(c), c.req.param("id"))));
  authed.post("/orders/:id/decline-offer", async (c) => {
    await hive.declineOffer(me(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  authed.post("/orders/:id/start", async (c) => c.json(await hive.startWork(me(c), c.req.param("id"))));
  authed.post("/orders/:id/abandon", async (c) => c.json(await hive.abandon(me(c), c.req.param("id"))));
  authed.post("/orders/:id/deliver", async (c) => {
    const { output } = await body(c, z.object({ output: z.unknown() }));
    return c.json(await hive.deliver(me(c), c.req.param("id"), output));
  });
  authed.post("/orders/:id/verdict", async (c) => {
    const { verdict } = await body(c, z.object({ verdict: z.enum(["accepted", "rejected"]) }));
    return c.json(await hive.verdict(me(c), c.req.param("id"), verdict));
  });

  authed.get("/notifications", async (c) =>
    c.json(await hive.listNotifications(me(c), Number(c.req.query("after") ?? 0) || 0)),
  );
  authed.post("/notifications/:id/read", async (c) => {
    await hive.markNotificationRead(me(c), Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  // ---- dev: simulate the buyer confirming in Alipay ---------------------
  // Registered before the authed routes so the /v1 auth middleware doesn't catch them.

  if (hive.payments instanceof FakePaymentProvider) {
    const fake = hive.payments;
    const pay = (c: Context) => {
      const ok = fake.completePurchase(decodeURIComponent(c.req.param("requestNo") ?? ""));
      if (!ok) throw new HiveError(404, "purchase_not_found", "unknown purchase");
      return c.json({ paid: true });
    };
    app.get("/v1/dev/fake-pay/:requestNo", pay);
    app.post("/v1/dev/fake-pay/:requestNo", pay);
  }

  app.route("/v1", authed);

  return app;
}
