import type { Fen } from "./money.ts";
import type { SellerKind } from "./order.ts";

// A listing's two switches (design §2): who takes the order, and who does the work.
export type AcceptMode = "auto" | "ask";
// `agent`: the listener wakes the seller's agent once paid. `manual`: a person does it and
// delivers from the app or by driving their agent over MCP, so no listener needs to be up.
export type WorkMode = "agent" | "manual";

// Only the fully automatic combination is held to the listener's heartbeat.
export const needsListener = (l: { acceptMode: AcceptMode; workMode: WorkMode }) =>
  l.acceptMode === "auto" && l.workMode === "agent";

// Manual work runs on the seller's own promise; agents get the category's default.
export function workTimeoutMs(categoryDefaultMs: number, workMode: WorkMode, deliveryHours: number | null): number {
  if (workMode === "manual" && deliveryHours !== null) return deliveryHours * 3600_000;
  return categoryDefaultMs;
}

// How a seller works, as the market and buyer agents see it.
export function workStyle(l: { acceptMode: AcceptMode; workMode: WorkMode; deliveryHours: number | null }): string {
  if (needsListener(l)) return "agent 全自动";
  const manual = l.workMode === "manual" ? `人工交付${l.deliveryHours === null ? "" : ` · ${l.deliveryHours} 小时内`}` : "agent 交付";
  return l.acceptMode === "ask" ? `需卖家审批 · ${manual}` : manual;
}

export interface Listing {
  sellerAccountId: string;
  category: string;
  // Free keywords the seller listed; matched against the order's text.
  tags: readonly string[];
  priceFen: Fen;
  acceptMode: AcceptMode;
  workMode: WorkMode;
  // Fully automatic: the listener is polling. Otherwise: the seller is taking orders and was active recently.
  online: boolean;
  dailyLimit: number;
  ordersToday: number;
  // Share of this seller's completed orders the buyer accepted; null when there's no history yet.
  passRate: number | null;
}

// Human offers go to several sellers at once (first accept wins).
export const HUMAN_BROADCAST = 3;

// Sellers without history rank as if they had a decent record, so new sellers still get orders.
const DEFAULT_PASS_RATE = 0.8;

export interface DispatchRequest {
  category: string;
  // The order's brief and input, which the sellers' tags are matched against.
  text: string;
  buyerAccountId: string;
  maxPriceFen: Fen | null;
  passedBy: readonly string[];
}

// `platformAccepts`: an auto listing done by hand has no listener to answer, so hive accepts for the seller.
export type Offer = { sellerAccountIds: string[]; kind: SellerKind; platformAccepts: boolean } | null;

// How many of the seller's tags appear in the order's text.
export function tagScore(tags: readonly string[], text: string): number {
  const haystack = text.toLowerCase();
  return tags.filter((t) => t.trim() && haystack.includes(t.trim().toLowerCase())).length;
}

// Category first, then the sellers whose tags fit the order best, then price and pass rate.
export function rankCandidates(listings: readonly Listing[], req: DispatchRequest): Listing[] {
  const score = new Map(listings.map((l) => [l, tagScore(l.tags, req.text)]));
  return listings
    .filter(
      (l) =>
        l.category === req.category &&
        l.online &&
        l.ordersToday < l.dailyLimit &&
        l.sellerAccountId !== req.buyerAccountId &&
        !req.passedBy.includes(l.sellerAccountId) &&
        (req.maxPriceFen === null || l.priceFen <= req.maxPriceFen),
    )
    .sort(
      (a, b) =>
        score.get(b)! - score.get(a)! ||
        a.priceFen - b.priceFen ||
        (b.passRate ?? DEFAULT_PASS_RATE) - (a.passRate ?? DEFAULT_PASS_RATE),
    );
}

// Auto listings take the order at once, so offer them one at a time. Humans approving are slow,
// so the best-ranked `ask` seller triggers a broadcast to the next few in rank order.
export function nextOffer(listings: readonly Listing[], req: DispatchRequest): Offer {
  const ranked = rankCandidates(listings, req);
  const top = ranked[0];
  if (!top) return null;
  if (top.acceptMode === "auto") {
    return { sellerAccountIds: [top.sellerAccountId], kind: "agent", platformAccepts: top.workMode === "manual" };
  }
  const humans = ranked.filter((l) => l.acceptMode === "ask").slice(0, HUMAN_BROADCAST);
  return { sellerAccountIds: humans.map((l) => l.sellerAccountId), kind: "human", platformAccepts: false };
}
