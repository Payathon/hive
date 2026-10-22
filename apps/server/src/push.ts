import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import webpush from "web-push";

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// What the service worker (apps/web/public/sw.js) shows: a title, a line, and the page a tap opens.
export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

// Rejects with an error carrying the push service's `statusCode`; 404/410 mean the subscription is gone.
export interface PushSender {
  readonly publicKey: string;
  send(target: PushTarget, message: PushMessage): Promise<void>;
}

export class WebPushSender implements PushSender {
  constructor(
    readonly publicKey: string,
    private readonly privateKey: string,
    private readonly subject: string,
  ) {}

  async send(target: PushTarget, message: PushMessage) {
    await webpush.sendNotification(target, JSON.stringify(message), {
      vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey },
      TTL: 3600,
    });
  }
}

// VAPID keys from VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY, or generated once and kept in `file` so
// browsers that already subscribed keep working across restarts.
export function pushFromEnv(file: string, env = process.env): PushSender {
  const subject = env.VAPID_SUBJECT ?? "mailto:noreply@hive.demo";
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return new WebPushSender(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, subject);
  let keys: { publicKey: string; privateKey: string };
  if (existsSync(file)) keys = JSON.parse(readFileSync(file, "utf8"));
  else {
    keys = webpush.generateVAPIDKeys();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  }
  return new WebPushSender(keys.publicKey, keys.privateKey, subject);
}
