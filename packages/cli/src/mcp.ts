import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HiveClient } from "@hive/client/api";
import { createMcpServer as createServer } from "@hive/client/mcp";
import { loadConfig } from "./config.ts";
import { completeLogin, startLogin } from "./login.ts";

// `hive mcp`: the buying tools over stdio, sharing the CLI's login in ~/.hive.
// Config is reloaded on every call so a login finished from the CLI (or by the owner's approval) applies at once.
export function createMcpServer() {
  return createServer({
    client: async () => {
      const config = await completeLogin(await loadConfig());
      return new HiveClient(config.server, config.token);
    },
    login: async () => {
      const config = await completeLogin(await loadConfig());
      if (config.token) return "already logged in; hive_whoami shows the account";
      const { link } = await startLogin(config, process.env.HIVE_AGENT_NAME ?? "mcp agent");
      return `Ask the account owner to open this link and approve this agent:\n\n    ${link}\n\nThen call hive_whoami to confirm.`;
    },
    unauthorizedHint: "Not logged in: call hive_login.",
    readLocalFile: async (path) => new Uint8Array(await readFile(path)),
  });
}

export async function serveMcp() {
  await createMcpServer().connect(new StdioServerTransport());
}
