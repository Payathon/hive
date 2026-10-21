// One command for the whole demo: API server, web app, demo accounts, and both sellers' listeners.
// Usage (repo root): pnpm demo            Ctrl-C stops everything.
// Links use this machine's LAN address so a phone on the same Wi-Fi can open them; HOST overrides it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lan = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(i.address))?.address;
const host = process.env.HOST ?? lan ?? "localhost";
const api = "http://localhost:8787";
const children = [];

function run(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `[${name}] `;
  const relay = (stream, out) =>
    stream.on("data", (b) => out.write(b.toString().replace(/^(?=.)/gm, prefix)));
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on("exit", (code) => code && console.error(`${prefix}exited with ${code}`));
  children.push(child);
  return child;
}

async function up(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

process.on("SIGINT", () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
});

if (!existsSync(join(root, "packages/cli/dist/hive.mjs"))) {
  spawnSync("node", ["build.mjs"], { cwd: join(root, "packages/cli"), stdio: "inherit" });
}

if (await up(`${api}/healthz`, 1)) {
  console.log(`using the hive server already running on ${api}`);
} else {
  run("server", join(root, "apps/server/node_modules/.bin/tsx"), ["src/main.ts"], {
    cwd: join(root, "apps/server"),
    env: { PUBLIC_URL: `http://${host}:8787`, WEB_URL: `http://${host}:5173` },
  });
  if (!(await up(`${api}/healthz`))) throw new Error("the hive server did not start");
}
if (!(await up("http://localhost:5173", 1))) run("web", join(root, "apps/web/node_modules/.bin/vite"), ["--host"], { cwd: join(root, "apps/web") });

const setup = spawnSync("node", ["seed/demo.mjs"], { cwd: root, encoding: "utf8", env: { ...process.env, HIVE_SERVER: api } });
if (setup.status !== 0) throw new Error(setup.stderr);

const cli = join(root, "packages/cli/dist/hive.mjs");
for (const who of ["studio", "shop"]) {
  run(who, "node", [cli, "serve", "--capabilities", `.demo/${who}/capabilities.yaml`], {
    env: { HIVE_HOME: join(root, ".demo", who), HIVE_SERVER: api },
  });
}

await up("http://localhost:5173");
console.log("\n" + readFileSync(join(root, ".demo/README.md"), "utf8"));
console.log("Everything is running. Ctrl-C stops it. Check all work modes with: node seed/e2e.mjs");
