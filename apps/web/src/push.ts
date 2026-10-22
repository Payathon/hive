import { hive } from "./api.ts";

// Where this browser stands on Web Push, as the 我的 page explains it.
//   unsupported: not a secure context (e.g. a phone on http://192.168.x.x) or no Push API
//   unavailable: the server has no VAPID key
export type PushState = "unsupported" | "unavailable" | "denied" | "off" | "on";

const supported = () =>
  window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export function registerServiceWorker() {
  if (supported()) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
}

function keyBytes(base64url: string) {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const sameKey = (sub: PushSubscription, key: Uint8Array) => {
  const k = sub.options.applicationServerKey;
  return !!k && new Uint8Array(k).every((b, i) => b === key[i]) && k.byteLength === key.length;
};

// Subscribes with the server's current key (replacing a subscription made with an old one) and tells the server.
async function subscribe(publicKey: string) {
  const reg = await registration();
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  await hive.pushSubscribe({ endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } });
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const { publicKey } = await hive.pushKey();
  if (!publicKey) return "unavailable";
  const sub = await (await registration()).pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

export async function enablePush(): Promise<PushState> {
  const { publicKey } = await hive.pushKey();
  if (!publicKey) return "unavailable";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  await subscribe(publicKey);
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const sub = await (await registration()).pushManager.getSubscription();
  if (sub) {
    await hive.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe();
  }
  return "off";
}

// On sign-in: a browser that already has push on re-registers for whoever is signed in now,
// and survives the server's database being reset.
export async function syncPush() {
  try {
    if (!supported() || Notification.permission !== "granted") return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!(await reg?.pushManager.getSubscription())) return;
    const { publicKey } = await hive.pushKey();
    if (publicKey) await subscribe(publicKey);
  } catch {
    // Best effort; the 我的 page shows the real state.
  }
}
