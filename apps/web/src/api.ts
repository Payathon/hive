import { ApiError, HiveClient, type CategoryInfo, type DeliveredFile, type DeliveryRequest, type Order, type OrderRequest } from "@hive/client/api";

export { ApiError };
export type { CategoryInfo, DeliveredFile, DeliverySpec, MarketSeller } from "@hive/client/api";

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
  sellerWorkMode: "agent" | "manual" | null;
  events: { type: string; at: string }[];
}

export interface Me {
  id: string;
  name: string;
  actor: "human" | "agent";
  rules: { perOrderCapFen: number | null; dailyCapFen: number | null; paused: boolean };
  humanAccepting: boolean;
}

export interface PendingLogin {
  userCode: string;
  label: string | null;
  expiresAt: string;
  approved: boolean;
}

// A live agent credential: a `hive login` approval or an API key.
export interface AgentGrant {
  id: string;
  label: string | null;
  source: "login" | "api_key" | null;
  createdAt: string;
  lastOrderAt: string | null;
}

export interface BillEntry {
  orderId: string;
  category: string;
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
  category: string;
  tags: string[];
  intro: string | null;
  acceptMode: "auto" | "ask";
  workMode: "agent" | "manual";
  deliveryHours: number | null;
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
  categories: () => req<CategoryInfo[]>("GET", "/v1/categories"),
  orders: (role: "buyer" | "seller") => req<OrderSummary[]>("GET", `/v1/orders?role=${role}`),
  order: (id: string) => req<OrderDetail>("GET", `/v1/orders/${id}`),
  createOrder: (order: OrderRequest) => req<OrderSummary>("POST", "/v1/orders", order),
  upload: (orderId: string, file: File) => api().uploadFile(orderId, file.name, file.type, file) as Promise<DeliveredFile>,
  deliver: (orderId: string, delivery: DeliveryRequest) => req<OrderSummary>("POST", `/v1/orders/${orderId}/deliver`, delivery),
  action: (id: string, action: string, body: unknown = {}) => req<OrderSummary>("POST", `/v1/orders/${id}/${action}`, body),
  bill: () => req<Bill>("GET", "/v1/me/bill"),
  updateRules: (rules: Partial<Me["rules"]>) => req<Me["rules"]>("PATCH", "/v1/me/rules", rules),
  pendingLogin: (userCode: string) => req<PendingLogin>("GET", `/v1/device-logins/${encodeURIComponent(userCode)}`),
  approve: (userCode: string) => req<{ ok: true }>("POST", "/v1/device-logins/approve", { userCode }),
  agents: () => req<AgentGrant[]>("GET", "/v1/agents"),
  revokeAgent: (id: string) => req<{ ok: true }>("POST", `/v1/agents/${id}/revoke`, {}),
  apiKey: (label: string) => req<{ key: string }>("POST", "/v1/api-keys", { label }),
  listings: () => req<Listing[]>("GET", "/v1/listings"),
  // Listed from the app, the work is always done by a person.
  upsertListing: (
    category: string,
    opts: { acceptMode: "auto" | "ask"; deliveryHours: number; dailyLimit: number; tags: string[]; intro: string | null },
  ) => req<Listing>("PUT", `/v1/listings/${category}`, { ...opts, workMode: "manual" }),
  paymentSetup: (category: string) => req<PaymentSetup>("POST", `/v1/listings/${category}/payment-setup`, {}),
  setAccepting: (on: boolean) => req<{ accepting: boolean }>("POST", "/v1/seller/accepting", { on }),
  // Long-poll as the human 接单台 (not as a `hive serve` listener).
  poll: (waitSeconds: number, signal: AbortSignal) =>
    req<{ offers: OrderSummary[]; work: OrderSummary[] }>("GET", `/v1/seller/poll?wait=${waitSeconds}`, undefined, signal),
};

export const errorMessage = (err: unknown) =>
  err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
