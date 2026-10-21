import type { CategoryInfo, DeliverySpec, OrderDetail, OrderStatus, OrderSummary } from "./api.ts";

export const yuan = (fen: number | null | undefined) => (fen == null ? "—" : (fen / 100).toFixed(2));

// Categories are data from the server; loaded once at sign-in and refreshed by the market page.
let categories = new Map<string, CategoryInfo>();
export const setCategories = (list: CategoryInfo[]) => {
  categories = new Map(list.map((c) => [c.id, c]));
};
export const allCategories = () => [...categories.values()];
export const category = (id: string) => categories.get(id);

export const typeTitle = (id: string) => categories.get(id)?.title ?? id;

// Short glyph and colour for a category's icon tile.
export const typeIcon = (id: string) => {
  const c = categories.get(id);
  return c ? { label: c.icon, color: c.color } : { label: id.slice(0, 2), color: "#8c8c8c" };
};

const MIME_WORD: Record<string, string> = { "image/*": "图片", "video/*": "视频", "audio/*": "音频" };
export const specText = (spec: DeliverySpec) => {
  switch (spec.kind) {
    case "json":
      return "JSON 数据，按买家给的格式校验";
    case "files":
      return `${spec.accept ? (MIME_WORD[spec.accept] ?? spec.accept) : "文件"}，至少 ${spec.count ?? 1} 个`;
    case "any":
      return "不限格式";
  }
};

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const STATUS_LABEL: Record<OrderStatus, string> = {
  CREATED: "正在派单",
  DISPATCHING: "正在派单",
  OFFERED: "等卖家接单",
  ACCEPTED: "卖家已接单",
  AWAITING_PAYMENT: "等待付款",
  PAID: "已付款",
  IN_PROGRESS: "卖家干活中",
  DELIVERED: "已交付",
  COMPLETED: "交易完成",
  CANCELLED: "已取消",
  FAILED: "订单失败",
};

export type Tone = "wait" | "go" | "ok" | "bad" | "mute";
export function statusTone(s: OrderStatus): Tone {
  if (s === "AWAITING_PAYMENT" || s === "DELIVERED") return "wait";
  if (s === "COMPLETED") return "ok";
  if (s === "FAILED") return "bad";
  if (s === "CANCELLED") return "mute";
  return "go";
}

export const CANCEL_REASON: Record<string, string> = {
  no_seller: "暂时没有卖家接单，没有扣款",
  buyer_cancelled: "订单已取消，没有扣款",
  payment_expired: "超时未付款，订单已取消",
};
export const FAIL_REASON: Record<string, string> = {
  work_timeout: "卖家没有按时交付",
  seller_abandoned: "卖家放弃了这单",
  heartbeat_lost: "卖家的 agent 掉线了",
};
export const VERDICT: Record<string, string> = {
  accepted: "已确认收货",
  rejected: "已拒收，计入卖家通过率",
  auto_accepted: "超时自动确认收货",
};

export const clock = (iso: string | Date) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const dateTime = (iso: string | Date) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${clock(d)}`;
};
export const shortDate = (iso: string | Date) => {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? `今天 ${clock(d)}` : `${d.getMonth() + 1}月${d.getDate()}日 ${clock(d)}`;
};
export const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

// One line per user-visible step, built from the order's transitions.
export interface Step {
  label: string;
  at: string | null;
  state: "done" | "now" | "todo" | "bad";
  note?: string;
}

const AFTER_ACCEPT: OrderStatus[] = ["ACCEPTED", "AWAITING_PAYMENT", "PAID", "IN_PROGRESS", "DELIVERED", "COMPLETED"];

export function timeline(o: OrderDetail, role: "buyer" | "seller"): Step[] {
  const last = (type: string) => [...o.events].reverse().find((e) => e.type === type)?.at ?? null;
  const reached = (statuses: OrderStatus[]) => statuses.includes(o.status);
  const you = role === "buyer";
  const seller = o.sellerName ?? "卖家";
  const raw: Array<{ label: string; at: string | null; done: boolean; now: string }> = [
    {
      label: o.createdByActor === "agent" ? (you ? "你的 agent 下了单" : "买家的 agent 下了单") : you ? "你下了单" : "买家下了单",
      at: o.createdAt,
      done: true,
      now: "",
    },
    {
      label: reached(AFTER_ACCEPT) ? `${seller} 接了单` : "卖家接单",
      at: last("seller_accept"),
      done: reached(AFTER_ACCEPT),
      now: o.offerKind === "human" ? "已派给在线的真人卖家，先抢先得" : "正在找在线卖家，通常几秒钟",
    },
    {
      label: o.paidAt ? (you ? "你已付款" : "买家已付款") : you ? "你在支付宝确认付款" : "买家付款",
      at: o.paidAt,
      done: o.paidAt !== null,
      now: you ? "钱直接付给卖家，hive 不经手" : "等买家在支付宝确认",
    },
    {
      label: you ? `${seller} 开始干活` : "开始干活",
      at: last("work_started"),
      done: reached(["IN_PROGRESS", "DELIVERED", "COMPLETED"]),
      now: you ? "卖家马上开始" : "做完直接在上面交付",
    },
    {
      label: you ? `${seller} 交付了` : "交付",
      at: reached(["DELIVERED", "COMPLETED"]) ? last("delivery_submitted") : null,
      done: reached(["DELIVERED", "COMPLETED"]),
      now: o.lastDeliveryError ? `上次提交没通过格式检查：${o.lastDeliveryError}` : "交付后先检查格式是否符合买家要求",
    },
    {
      label: o.verdict ? VERDICT[o.verdict] ?? "验收" : you ? "你确认收货" : "买家验收",
      at: last("buyer_verdict") ?? last("acceptance_expired"),
      done: o.status === "COMPLETED",
      now: you ? "检查交付内容，没问题就确认收货" : "等买家验收",
    },
  ];
  const ended = o.status === "CANCELLED" || o.status === "FAILED";
  const firstOpen = raw.findIndex((r) => !r.done);
  const steps: Step[] = raw.map((r, i) => {
    if (r.done) return { label: r.label, at: r.at, state: "done" };
    if (i === firstOpen && !ended) return { label: r.label, at: null, state: "now", note: r.now };
    return { label: r.label, at: null, state: "todo" };
  });
  if (ended) {
    const at = o.events[o.events.length - 1]?.at ?? null;
    const label = o.status === "CANCELLED" ? CANCEL_REASON[o.cancelReason ?? ""] ?? "订单已取消" : FAIL_REASON[o.failReason ?? ""] ?? "订单失败";
    steps.splice(firstOpen === -1 ? steps.length : firstOpen, 0, { label, at, state: "bad" });
    return steps.filter((s) => s.state !== "todo");
  }
  return steps;
}

export const isTerminal = (o: OrderSummary) => o.status === "COMPLETED" || o.status === "CANCELLED" || o.status === "FAILED";
