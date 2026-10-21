import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "./app.ts";
import { connectPglite, connectPostgres } from "./db/client.ts";
import { DiskFileStore } from "./files.ts";
import { Hive } from "./hive.ts";
import { FakePaymentProvider } from "./payments/fake.ts";
import { NowPayProvider } from "./payments/nowpay.ts";
import type { PaymentProvider } from "./payments/provider.ts";

const port = Number(process.env.PORT ?? 8787);
const baseUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
const TICK_MS = Number(process.env.TICK_MS ?? 5000);

function paymentsFromEnv(): PaymentProvider {
  if (process.env.PAYMENTS !== "nowpay") return new FakePaymentProvider(baseUrl);
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is required when PAYMENTS=nowpay`);
    return v;
  };
  return new NowPayProvider({
    appId: need("ALIPAY_APP_ID"),
    privateKey: need("ALIPAY_PRIVATE_KEY"),
    alipayPublicKey: need("ALIPAY_PUBLIC_KEY"),
    ...(process.env.ALIPAY_GATEWAY ? { gateway: process.env.ALIPAY_GATEWAY } : {}),
    callbackUrl: `${baseUrl}/nowpay/return`,
  });
}

// DATABASE_URL selects Postgres; without it, an in-process PGlite database under .data/.
const db = process.env.DATABASE_URL
  ? await connectPostgres(process.env.DATABASE_URL)
  : await connectPglite(process.env.PGLITE_DIR ?? ".data/pglite");

// Delivered files; FILES_DIR could later be swapped for object storage behind the same interface.
const files = new DiskFileStore(process.env.FILES_DIR ?? ".data/files");
const hive = new Hive({ db, payments: paymentsFromEnv(), files });
// WEB_URL points approval links at the Vite dev server in development; otherwise the API's own origin serves the web app.
const webUrl = process.env.WEB_URL ?? process.env.PUBLIC_URL;
const app = createApp(hive, webUrl ? { webUrl } : {});

// Serves the built web app (apps/web) from the same origin when it has been built.
const webDist = process.env.WEB_DIST ?? "../web/dist";
const site = new Hono().route("/", app);
if (existsSync(webDist)) {
  site.use("*", serveStatic({ root: webDist }));
  // Client-side routes get the app shell; API paths keep their 404s.
  site.get("*", (c, next) =>
    c.req.path.startsWith("/v1/") || c.req.path === "/mcp" ? next() : serveStatic({ root: webDist, path: "index.html" })(c, next),
  );
}

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await hive.tick();
  } catch (err) {
    console.error("tick failed", err);
  } finally {
    ticking = false;
  }
}, TICK_MS);

serve({ fetch: site.fetch, port }, () => {
  console.log(`hive server on ${baseUrl} (payments: ${hive.payments.name})`);
});
