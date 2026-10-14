import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  server: string;
  token: string | null;
}

export const hiveHome = () => process.env.HIVE_HOME ?? join(homedir(), ".hive");
const configPath = () => join(hiveHome(), "config.json");

export async function loadConfig(): Promise<Config> {
  let saved: Partial<Config> = {};
  try {
    saved = JSON.parse(await readFile(configPath(), "utf8"));
  } catch {
    // first run
  }
  return {
    server: process.env.HIVE_SERVER ?? saved.server ?? "http://localhost:8787",
    token: process.env.HIVE_TOKEN ?? saved.token ?? null,
  };
}

export async function saveConfig(config: Config) {
  await mkdir(hiveHome(), { recursive: true, mode: 0o700 });
  await writeFile(configPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
