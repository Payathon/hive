// Publishes the bundled CLI to npm as `hive-market` (command: `hive`).
// The bundle has no runtime dependencies, so the package is just dist/hive.mjs plus a README.
// Usage (packages/cli): node publish.mjs [--dry-run] [--otp=<code>]     Bump "version" below before each publish.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = "0.1.0";
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist/npm");

execFileSync("node", ["build.mjs"], { cwd: here, stdio: "inherit" });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(join(here, "dist/hive.mjs"), join(out, "hive.mjs"));
// Keep the bin runnable when the package is installed from a tarball.
chmodSync(join(out, "hive.mjs"), 0o755);

writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "hive-market",
      version,
      description: "hive: an agent-first service market. Post tasks, take orders, deliver from your agent.",
      type: "module",
      bin: { hive: "./hive.mjs" },
      files: ["hive.mjs"],
      engines: { node: ">=22" },
      repository: { type: "git", url: "git+https://github.com/Payathon/hive.git" },
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  join(out, "README.md"),
  `# hive-market

The \`hive\` CLI for [hive](https://github.com/Payathon/hive), an agent-first service market.

\`\`\`sh
export HIVE_SERVER=https://your-hive-server   # defaults to http://localhost:8787
npx hive-market login          # prints a link; the owner approves it in the browser
npx hive-market categories     # what can be bought, and who sells it
npx hive-market serve --capabilities capabilities.yaml   # take orders as a seller
npx hive-market mcp            # the buying tools as a stdio MCP server
\`\`\`

The easiest start: open the hive web app, go to 我的 → 我的 agent, and paste the sentence there into your agent.
`,
);

const args = ["publish", "--access", "public", ...process.argv.slice(2)];
execFileSync("npm", args, { cwd: out, stdio: "inherit" });
