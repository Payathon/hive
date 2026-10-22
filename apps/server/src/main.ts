import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "./app.ts";
import { connectPglite, connectPostgres } from "./db/client.ts";
import { DiskFileStore } from "./files.ts";
import { Hive } from "./hive.ts";
import { mailerFromEnv } from "./mail.ts";
import { FakePaymentProvider } from "./payments/fake.ts";
import { NowPayProvider } from "./payments/nowpay.ts";
import { NowPayDirectProvider, type DirectProduct } from "./payments/nowpay-direct.ts";
import type { PaymentProvider } from "./payments/provider.ts";
import { pushFromEnv } from "./push.ts";

// An empty variable (KEY= in an env file) means unset, so `??` defaults below still apply.
for (const [k, v] of Object.entries(process.env)) if (v === "") delete process.env[k];

const port = Number(process.env.PORT ?? 8787);
const baseUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
const TICK_MS = Number(process.env.TICK_MS ?? 5000);

// PAYMENTS=direct | platform | fake. Unset: direct when its credentials and product are present,
// otherwise fake. Direct mode (即刻收直连) is the default for real money; platform mode is kept for later.
// Key material may be given inline (ALIPAY_PRIVATE_KEY) or as a file (ALIPAY_PRIVATE_KEY_PATH).
const env = (k: string) => process.env[k] || (process.env[`${k}_PATH`] ? readFileSync(process.env[`${k}_PATH`]!, "utf8").trim() : undefined);
const directReady = () => Boolean(env("ALIPAY_APP_ID") && env("ALIPAY_PRIVATE_KEY") && env("ALIPAY_PUBLIC_KEY") && process.env.NOWPAY_DIRECT_PRODUCT_ID);

function paymentsFromEnv(): PaymentProvider {
  const mode = process.env.PAYMENTS === "nowpay" ? "platform" : (process.env.PAYMENTS ?? (directReady() ? "direct" : "fake"));
  if (mode === "fake") return new FakePaymentProvider(baseUrl, undefined, process.env.FAKE_PAY_STATE ?? ".data/fake-pay.json");
  const need = (k: string) => {
    const v = env(k);
    if (!v) throw new Error(`${k} is required when PAYMENTS=${mode}`);
    return v;
  };
  const keys = {
    appId: need("ALIPAY_APP_ID"),
    privateKey: need("ALIPAY_PRIVATE_KEY"),
    alipayPublicKey: need("ALIPAY_PUBLIC_KEY"),
    ...(process.env.ALIPAY_GATEWAY ? { gateway: process.env.ALIPAY_GATEWAY } : {}),
  };
  if (mode === "platform") return new NowPayProvider({ ...keys, callbackUrl: `${baseUrl}/nowpay/return` });
  if (mode !== "direct") throw new Error(`PAYMENTS must be direct, platform or fake, not ${mode}`);
  // NOWPAY_DIRECT_PRODUCTS: optional JSON {"<category>": "<product id>" | {"productId", "skuId"}}.
  const byCategory: Record<string, DirectProduct> = {};
  for (const [cat, v] of Object.entries(JSON.parse(process.env.NOWPAY_DIRECT_PRODUCTS ?? "{}") as Record<string, string | DirectProduct>)) {
    byCategory[cat] = typeof v === "string" ? { productId: v } : v;
  }
  return new NowPayDirectProvider({
    ...keys,
    product: { productId: need("NOWPAY_DIRECT_PRODUCT_ID"), skuId: process.env.NOWPAY_DIRECT_SKU_ID || null },
    byCategory,
    // Buyers land back on hive after paying; ignored unless https (the docs require it).
    callbackUrl: `${process.env.WEB_URL ?? process.env.PUBLIC_URL ?? baseUrl}/orders`,
  });
}

// DATABASE_URL selects Postgres; without it, an in-process PGlite database under .data/.
const db = process.env.DATABASE_URL
  ? await connectPostgres(process.env.DATABASE_URL)
  : await connectPglite(process.env.PGLITE_DIR ?? ".data/pglite");

// Delivered files; FILES_DIR could later be swapped for object storage behind the same interface.
const files = new DiskFileStore(process.env.FILES_DIR ?? ".data/files");
// WEB_URL points approval links at the Vite dev server in development; otherwise the API's own origin serves the web app.
const webUrl = process.env.WEB_URL ?? process.env.PUBLIC_URL;
// Mail goes out only with SMTP configured; otherwise it collects in the dev outbox (/v1/dev/mail).
const mailer = mailerFromEnv(db);
const push = pushFromEnv(process.env.VAPID_FILE ?? ".data/vapid.json");
const payments = paymentsFromEnv();
const hive = new Hive({ db, payments, files, mailer, push, webUrl: webUrl ?? baseUrl });
// The CLI bundle agents download from /hive.mjs. In the repo, build it on first start if it's missing.
const cliBundle = process.env.HIVE_CLI_BUNDLE ?? fileURLToPath(new URL("../../../packages/cli/dist/hive.mjs", import.meta.url));
if (!existsSync(cliBundle) && !process.env.HIVE_CLI_BUNDLE) {
  const cliDir = fileURLToPath(new URL("../../../packages/cli", import.meta.url));
  if (existsSync(`${cliDir}/build.mjs`)) spawnSync(process.execPath, ["build.mjs"], { cwd: cliDir, stdio: "inherit" });
}
const app = createApp(hive, {
  ...(webUrl ? { webUrl } : {}),
  ...(process.env.PUBLIC_URL ? { publicUrl: process.env.PUBLIC_URL } : {}),
  cliBundle,
});

// Serves the built web app (apps/web) from the same origin when it has been built.
const webDist = process.env.WEB_DIST ?? "../web/dist";
const site = new Hono().route("/", app);
if (existsSync(webDist)) {
  site.use("*", serveStatic({ root: webDist }));
  // Client-side routes get the app shell; API paths keep their 404s.
  site.get("*", (c, next) =>
    c.req.path.startsWith("/v1/") || ["/mcp", "/agent.md", "/hive.mjs"].includes(c.req.path) ? next() : serveStatic({ root: webDist, path: "index.html" })(c, next),
  );
}

// Direct mode: show what charge.query says about each configured product, then re-sync listings so
// every listing carries the product's real status and price (e.g. after running on fake payments).
if (payments instanceof NowPayDirectProvider) {
  for (const product of payments.products()) {
    try {
      const s = await payments.queryProduct(product);
      const price = s.priceFen === null ? "no 1-count tier" : `¥${(s.priceFen / 100).toFixed(2)} (sku ${s.skuId})`;
      console.log(`即刻收直连 product ${product.productId}: ${s.status}, ${price}${s.note ? ` — ${s.note}` : ""}`);
    } catch (err) {
      console.error(`即刻收直连 product ${product.productId}: charge.query failed: ${(err as Error).message}`);
    }
  }
  hive
    .syncListingPayments()
    .then((n) => console.log(`即刻收直连: ${n} listing(s) can take payment`))
    .catch((err) => console.error(`即刻收直连: listing payment sync failed, listings keep their old status: ${(err as Error).message}`));
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
  console.log(`hive server on ${baseUrl} (payments: ${hive.payments.name}, mail: ${mailer.name})`);
});
