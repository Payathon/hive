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

// How the buyer wants the work handed in (see @hive/core's deliverySpec).
export type DeliverySpec =
  | { kind: "json"; schema: Record<string, unknown> }
  | { kind: "files"; accept?: string | undefined; count?: number | undefined }
  | { kind: "any" };

export interface DeliveredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  // Relative to the server; see HiveClient.fileUrl.
  url: string;
}

export interface Delivery {
  note: string | null;
  data: unknown;
  files: DeliveredFile[];
}

export interface Order {
  id: string;
  category: string;
  status: string;
  buyerAccountId: string;
  sellerAccountId: string | null;
  createdByActor: "human" | "agent";
  brief: string;
  input: unknown;
  deliverySpec: DeliverySpec;
  output: Delivery | null;
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
  tags: string[];
  intro: string | null;
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

export interface CategoryInfo {
  id: string;
  title: string;
  blurb: string;
  icon: string;
  color: string;
  // Default work time for agents, and for people who don't set their own.
  workTimeoutMs: number;
  manualTimeoutMs: number;
  // Suggested tags for sellers listing here.
  tags: string[];
  sellers: MarketSeller[];
}

export interface OrderRequest {
  category: string;
  brief: string;
  input?: unknown;
  delivery?: DeliverySpec;
}

export interface DeliveryRequest {
  note?: string | null;
  data?: unknown;
  // Ids from uploadFile.
  files?: string[];
}

export interface ListingOptions {
  acceptMode: "auto" | "ask";
  workMode: "agent" | "manual";
  deliveryHours: number | null;
  dailyLimit: number;
  tags?: string[];
  intro?: string | null;
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

  // Uploads raw bytes (a Blob in browsers) as one file of an order's delivery.
  async uploadFile(orderId: string, name: string, mime: string, bytes: Uint8Array | Blob) {
    const res = await this.fetchImpl(new URL(`/v1/orders/${orderId}/files?name=${encodeURIComponent(name)}`, this.server), {
      method: "POST",
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), "content-type": mime || "application/octet-stream" },
      body: bytes as BodyInit,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json?.error ?? "http_error", json?.message ?? res.statusText);
    return json as DeliveredFile;
  }

  // Absolute link for a delivered file.
  fileUrl(f: { url: string }, base = this.server) {
    return new URL(f.url, base).href;
  }

  categories() {
    return this.request<CategoryInfo[]>("GET", "/v1/categories");
  }
  me() {
    return this.request<{ id: string; name: string; actor: string }>("GET", "/v1/me");
  }
  order(id: string) {
    return this.request<Order>("GET", `/v1/orders/${id}`);
  }
  createOrder(req: OrderRequest) {
    return this.request<Order>("POST", "/v1/orders", req);
  }
  deliver(id: string, req: DeliveryRequest) {
    return this.request<Order>("POST", `/v1/orders/${id}/deliver`, req);
  }
  orderAction(id: string, action: string, body?: unknown) {
    return this.request<Order>("POST", `/v1/orders/${id}/${action}`, body ?? {});
  }
  poll(waitSeconds: number, signal?: AbortSignal) {
    return this.request<{ offers: Order[]; work: Order[] }>("GET", `/v1/seller/poll?wait=${waitSeconds}&listener=1`, undefined, signal);
  }
  upsertListing(category: string, opts: ListingOptions) {
    return this.request<{ id: string; priceFen: number | null; paymentStatus: string; deliveryHours: number | null }>(
      "PUT",
      `/v1/listings/${category}`,
      opts,
    );
  }
  paymentSetup(category: string) {
    return this.request<{
      status: string;
      priceFen: number | null;
      configurationUrl: string | null;
      configurationQrCode: string | null;
      managementUrl: string | null;
    }>("POST", `/v1/listings/${category}/payment-setup`, {});
  }
}

export const yuan = (fen: number | null) => (fen === null ? "-" : `¥${(fen / 100).toFixed(2)}`);

// MIME type from a file name, for uploads from disk.
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", svg: "image/svg+xml",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
  pdf: "application/pdf", json: "application/json", csv: "text/csv", txt: "text/plain", md: "text/markdown", html: "text/html",
  zip: "application/zip", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
export const guessMime = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

export function describeDelivery(spec: DeliverySpec): string {
  switch (spec.kind) {
    case "json":
      return "JSON data matching the buyer's JSON Schema";
    case "files":
      return [`at least ${spec.count ?? 1} file(s)`, spec.accept ? `of type ${spec.accept}` : null].filter(Boolean).join(" ");
    case "any":
      return "anything: a note, data or files";
  }
}
