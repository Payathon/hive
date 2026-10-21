// Thin client for the hive HTTP API.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Order {
  id: string;
  capabilityType: string;
  status: string;
  buyerAccountId: string;
  sellerAccountId: string | null;
  createdByActor: "human" | "agent";
  input: unknown;
  output: unknown;
  priceFen: number | null;
  deadline: string | null;
  offerKind: "agent" | "human" | null;
  purchaseUrl: string | null;
  purchaseQrCode: string | null;
  paidAt: string | null;
  deliveryAttempts: number;
  lastDeliveryError: string | null;
  verdict: string | null;
  cancelReason: string | null;
  failReason: string | null;
  refundEligible: boolean;
}

// A seller as the market shows them: price, presence and how they work.
export interface MarketSeller {
  name: string;
  acceptMode: "auto" | "ask";
  workMode: "agent" | "manual";
  // e.g. "agent 全自动", "需卖家审批 · 人工交付 · 2 小时内"
  workStyle: string;
  workTimeoutMs: number;
  priceFen: number;
  online: boolean;
  passRate: number | null;
  completed: number;
}

export interface CapabilityTypeInfo {
  type: string;
  title: string;
  workTimeoutMs: number;
  input: unknown;
  output: unknown;
  sellers: MarketSeller[];
}

export class HiveClient {
  constructor(
    readonly server: string,
    private readonly token: string | null,
    // The server passes its own app here to serve MCP tools without a network hop.
    private readonly fetchImpl: (url: URL, init: RequestInit) => Promise<Response> = fetch,
  ) {}

  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(new URL(path, this.server), {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json?.error ?? "http_error", json?.message ?? res.statusText);
    return json as T;
  }

  types() {
    return this.request<CapabilityTypeInfo[]>("GET", "/v1/types");
  }
  me() {
    return this.request<{ id: string; name: string; actor: string }>("GET", "/v1/me");
  }
  order(id: string) {
    return this.request<Order>("GET", `/v1/orders/${id}`);
  }
  createOrder(type: string, input: unknown) {
    return this.request<Order>("POST", "/v1/orders", { type, input });
  }
  orderAction(id: string, action: string, body?: unknown) {
    return this.request<Order>("POST", `/v1/orders/${id}/${action}`, body ?? {});
  }
  poll(waitSeconds: number, signal?: AbortSignal) {
    return this.request<{ offers: Order[]; work: Order[] }>("GET", `/v1/seller/poll?wait=${waitSeconds}&listener=1`, undefined, signal);
  }
  upsertListing(
    type: string,
    opts: { acceptMode: "auto" | "ask"; workMode: "agent" | "manual"; deliveryHours: number | null; dailyLimit: number },
  ) {
    return this.request<{ id: string; priceFen: number | null; paymentStatus: string }>("PUT", `/v1/listings/${type}`, opts);
  }
  paymentSetup(type: string) {
    return this.request<{
      status: string;
      priceFen: number | null;
      configurationUrl: string | null;
      configurationQrCode: string | null;
      managementUrl: string | null;
    }>("POST", `/v1/listings/${type}/payment-setup`, {});
  }
}

export const yuan = (fen: number | null) => (fen === null ? "-" : `¥${(fen / 100).toFixed(2)}`);
