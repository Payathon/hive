import type { CapabilityType } from "./capabilities.ts";
import type { Fen } from "./money.ts";
import type { SellerKind } from "./order.ts";

export interface Listing {
  sellerAccountId: string;
  capabilityType: CapabilityType;
  priceFen: Fen;
  acceptMode: "auto" | "ask";
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
  capabilityType: CapabilityType;
  buyerAccountId: string;
  maxPriceFen: Fen | null;
  passedBy: readonly string[];
}

export type Offer = { sellerAccountIds: string[]; kind: SellerKind } | null;

export function rankCandidates(listings: readonly Listing[], req: DispatchRequest): Listing[] {
  return listings
    .filter(
      (l) =>
        l.capabilityType === req.capabilityType &&
        l.online &&
        l.ordersToday < l.dailyLimit &&
        l.sellerAccountId !== req.buyerAccountId &&
        !req.passedBy.includes(l.sellerAccountId) &&
        (req.maxPriceFen === null || l.priceFen <= req.maxPriceFen),
    )
    .sort(
      (a, b) =>
        a.priceFen - b.priceFen ||
        (b.passRate ?? DEFAULT_PASS_RATE) - (a.passRate ?? DEFAULT_PASS_RATE),
    );
}

// Agent sellers answer in seconds, so offer them one at a time. Humans are slow,
// so the best-ranked human triggers a broadcast to the next few humans in rank order.
export function nextOffer(listings: readonly Listing[], req: DispatchRequest): Offer {
  const ranked = rankCandidates(listings, req);
  const top = ranked[0];
  if (!top) return null;
  if (top.acceptMode === "auto") return { sellerAccountIds: [top.sellerAccountId], kind: "agent" };
  const humans = ranked.filter((l) => l.acceptMode === "ask").slice(0, HUMAN_BROADCAST);
  return { sellerAccountIds: humans.map((l) => l.sellerAccountId), kind: "human" };
}
