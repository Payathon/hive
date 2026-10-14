import { describe, expect, it } from "vitest";
import { fen } from "./money.ts";
import { nextOffer, rankCandidates, type DispatchRequest, type Listing } from "./dispatch.ts";

const listing = (over: Partial<Listing> & { sellerAccountId: string }): Listing => ({
  capabilityType: "market-data.competitors",
  priceFen: fen(500),
  acceptMode: "auto",
  online: true,
  dailyLimit: 10,
  ordersToday: 0,
  passRate: null,
  ...over,
});

const req: DispatchRequest = {
  capabilityType: "market-data.competitors",
  buyerAccountId: "buyer",
  maxPriceFen: null,
  passedBy: [],
};

describe("rankCandidates", () => {
  it("filters out offline, capped, self, passed, wrong-type and over-budget sellers", () => {
    const listings = [
      listing({ sellerAccountId: "ok" }),
      listing({ sellerAccountId: "offline", online: false }),
      listing({ sellerAccountId: "capped", ordersToday: 10 }),
      listing({ sellerAccountId: "buyer" }),
      listing({ sellerAccountId: "passed" }),
      listing({ sellerAccountId: "chart", capabilityType: "chart.compare" }),
      listing({ sellerAccountId: "pricey", priceFen: fen(900) }),
    ];
    const ranked = rankCandidates(listings, { ...req, passedBy: ["passed"], maxPriceFen: fen(800) });
    expect(ranked.map((l) => l.sellerAccountId)).toEqual(["ok"]);
  });

  it("sorts by price, then pass rate", () => {
    const ranked = rankCandidates(
      [
        listing({ sellerAccountId: "cheap-bad", priceFen: fen(300), passRate: 0.5 }),
        listing({ sellerAccountId: "mid-good", priceFen: fen(400), passRate: 0.99 }),
        listing({ sellerAccountId: "cheap-good", priceFen: fen(300), passRate: 0.9 }),
      ],
      req,
    );
    expect(ranked.map((l) => l.sellerAccountId)).toEqual(["cheap-good", "cheap-bad", "mid-good"]);
  });
});

describe("nextOffer", () => {
  it("offers a single agent seller", () => {
    const offer = nextOffer([listing({ sellerAccountId: "a1" }), listing({ sellerAccountId: "a2" })], req);
    expect(offer).toEqual({ sellerAccountIds: ["a1"], kind: "agent" });
  });

  it("broadcasts to up to three humans", () => {
    const humans = ["h1", "h2", "h3", "h4"].map((id) => listing({ sellerAccountId: id, acceptMode: "ask" }));
    expect(nextOffer(humans, req)).toEqual({ sellerAccountIds: ["h1", "h2", "h3"], kind: "human" });
  });

  it("returns null when nobody qualifies", () => {
    expect(nextOffer([], req)).toBeNull();
  });
});
