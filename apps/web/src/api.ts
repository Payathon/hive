import { ApiError, HiveClient, type Order } from "@hive/client/api";

export { ApiError };

const TOKEN_KEY = "hive.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode: the login lasts for this tab only.
  }
  client = makeClient();
}

// fetch must be called unbound in browsers, so it's wrapped instead of passed as-is.
const makeClient = () => new HiveClient(location.origin, getToken(), (url, init) => fetch(url, init));
let client = makeClient();
export const api = () => client;

export type OrderStatus =
  | "CREATED" | "DISPATCHING" | "OFFERED" | "ACCEPTED" | "AWAITING_PAYMENT"
  | "PAID" | "IN_PROGRESS" | "DELIVERED" | "COMPLETED" | "CANCELLED" | "FAILED";

export type OrderSummary = Omit<Order, "status"> & { status: OrderStatus; createdAt: string };
export interface OrderDetail extends OrderSummary {
  sellerName: string | null;
  events: { type: string; at: string }[];
}

export interface Me {
  id: string;
  name: string;
  actor: "human" | "agent";
  rules: { perOrderCapFen: number | null; dailyCapFen: number | null; paused: boolean };
  humanAccepting: boolean;
}

export interface MarketSeller {
  name: string;
  kind: "agent" | "human";
  priceFen: number;
  online: boolean;
  passRate: number | null;
  completed: number;
}
export interface MarketType {
  type: string;
  title: string;
  workTimeoutMs: number;
  sellers: MarketSeller[];
}

export interface BillEntry {
  orderId: string;
  capabilityType: string;
  priceFen: number | null;
  paidAt: string | null;
  createdByActor: "human" | "agent";
  status: OrderStatus;
}
export interface Bill {
  spentFen: number;
  earnedFen: number;
  spent: BillEntry[];
  earned: BillEntry[];
}

export interface Listing {
  id: string;
  capabilityType: string;
  acceptMode: "auto" | "ask";
  dailyLimit: number;
  active: boolean;
  priceFen: number | null;
  paymentStatus: string;
}

export interface PaymentSetup {
  status: string;
  priceFen: number | null;
  configurationUrl: string | null;
  managementUrl: string | null;
}

const req = <T,>(method: string, path: string, body?: unknown, signal?: AbortSignal) =>
  api().request<T>(method, path, body, signal);

export const hive = {
  signup: (name: string) => req<{ accountId: string; token: string }>("POST", "/v1/accounts", { name }),
  me: () => req<Me>("GET", "/v1/me"),
  market: () => req<MarketType[]>("GET", "/v1/market"),
  orders: (role: "buyer" | "seller") => req<OrderSummary[]>("GET", `/v1/orders?role=${role}`),
  order: (id: string) => req<OrderDetail>("GET", `/v1/orders/${id}`),
  createOrder: (type: string, input: unknown) => req<OrderSummary>("POST", "/v1/orders", { type, input }),
  action: (id: string, action: string, body: unknown = {}) => req<OrderSummary>("POST", `/v1/orders/${id}/${action}`, body),
  bill: () => req<Bill>("GET", "/v1/me/bill"),
  updateRules: (rules: Partial<Me["rules"]>) => req<Me["rules"]>("PATCH", "/v1/me/rules", rules),
  approve: (userCode: string) => req<{ ok: true }>("POST", "/v1/device-logins/approve", { userCode }),
  apiKey: (label: string) => req<{ key: string }>("POST", "/v1/api-keys", { label }),
  listings: () => req<Listing[]>("GET", "/v1/listings"),
  upsertListing: (type: string, dailyLimit: number) =>
    req<Listing>("PUT", `/v1/listings/${type}`, { acceptMode: "ask", dailyLimit }),
  paymentSetup: (type: string) => req<PaymentSetup>("POST", `/v1/listings/${type}/payment-setup`, {}),
  setAccepting: (on: boolean) => req<{ accepting: boolean }>("POST", "/v1/seller/accepting", { on }),
  // Long-poll as the human 接单台 (not as a `hive serve` listener).
  poll: (waitSeconds: number, signal: AbortSignal) =>
    req<{ offers: OrderSummary[]; work: OrderSummary[] }>("GET", `/v1/seller/poll?wait=${waitSeconds}`, undefined, signal),
};

export const errorMessage = (err: unknown) =>
  err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
