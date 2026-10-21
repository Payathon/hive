import { ApiError, HiveClient } from "@hive/client/api";
import { saveConfig, type Config } from "./config.ts";

// Starts a device login; the owner opens the returned link and approves (or runs `hive approve <code>`).
export async function startLogin(config: Config, label: string) {
  const dl = await new HiveClient(config.server, null).request<{
    id: string;
    userCode: string;
    secret: string;
    verificationUriComplete: string;
  }>(
    "POST",
    "/v1/device-logins",
    { label },
  );
  config.pendingLogin = { id: dl.id, secret: dl.secret };
  await saveConfig(config);
  return { code: dl.userCode, link: dl.verificationUriComplete };
}

// Finishes a pending login if the owner has approved it since.
export async function completeLogin(config: Config): Promise<Config> {
  if (config.token || !config.pendingLogin) return config;
  const anon = new HiveClient(config.server, null);
  const { id, secret } = config.pendingLogin;
  const r: { status: string; token?: string } = await anon
    .request<{ status: string; token?: string }>("POST", `/v1/device-logins/${id}/poll`, { secret })
    .catch((err) => {
      if (err instanceof ApiError && err.status === 404) return { status: "expired" };
      throw err;
    });
  if (r.status === "approved" && r.token) {
    config.token = r.token;
    config.pendingLogin = null;
    await saveConfig(config);
  } else if (r.status === "expired") {
    config.pendingLogin = null;
    await saveConfig(config);
  }
  return config;
}
