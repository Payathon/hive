import { describe, expect, it } from "vitest";
import { fen } from "./money.ts";
import { nextOffer, rankCandidates, tagScore, workStyle, workTimeoutMs, type DispatchRequest, type Listing } from "./dispatch.ts";

const listing = (over: Partial<Listing> & { sellerAccountId: string }): Listing => ({
  category: "data",
  tags: [],
  priceFen: fen(500),
  acceptMode: "auto",
  workMode: "agent",
  online: true,
  dailyLimit: 10,
  ordersToday: 0,
  passRate: null,
  ...over,
});

const req: DispatchRequest = {
  category: "data",
  text: "杭州湖滨的奶茶店竞品",
  buyerAccountId: "buyer",
  maxPriceFen: null,
  passedBy: [],
};

describe("rankCandidates", () => {
  it("filters out offline, capped, self, passed, other-category and over-budget sellers", () => {
    const listings = [
      listing({ sellerAccountId: "ok" }),
      listing({ sellerAccountId: "offline", online: false }),
      listing({ sellerAccountId: "capped", ordersToday: 10 }),
      listing({ sellerAccountId: "buyer" }),
      listing({ sellerAccountId: "passed" }),
      listing({ sellerAccountId: "chart", category: "chart" }),
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

  it("puts sellers whose tags match the order first", () => {
    const ranked = rankCandidates(
      [
        listing({ sellerAccountId: "cheap", priceFen: fen(300) }),
        listing({ sellerAccountId: "coffee", priceFen: fen(400), tags: ["咖啡"] }),
        listing({ sellerAccountId: "tea", priceFen: fen(500), tags: ["奶茶", "湖滨"] }),
        listing({ sellerAccountId: "one", priceFen: fen(600), tags: ["杭州"] }),
      ],
      req,
    );
    expect(ranked.map((l) => l.sellerAccountId)).toEqual(["tea", "one", "cheap", "coffee"]);
  });
});

describe("tagScore", () => {
  it("counts tags found in the text, ignoring case and blanks", () => {
    expect(tagScore(["MP4", "字幕", " ", "配乐"], "剪成 mp4，加字幕")).toBe(2);
    expect(tagScore([], "anything")).toBe(0);
  });
});

describe("nextOffer", () => {
  it("offers a single agent seller", () => {
    const offer = nextOffer([listing({ sellerAccountId: "a1" }), listing({ sellerAccountId: "a2" })], req);
    expect(offer).toEqual({ sellerAccountIds: ["a1"], kind: "agent", platformAccepts: false });
  });

  it("broadcasts to up to three humans", () => {
    const humans = ["h1", "h2", "h3", "h4"].map((id) => listing({ sellerAccountId: id, acceptMode: "ask" }));
    expect(nextOffer(humans, req)).toEqual({ sellerAccountIds: ["h1", "h2", "h3"], kind: "human", platformAccepts: false });
  });

  it("has hive accept for an auto listing done by hand", () => {
    const offer = nextOffer([listing({ sellerAccountId: "m1", workMode: "manual" })], req);
    expect(offer).toEqual({ sellerAccountIds: ["m1"], kind: "agent", platformAccepts: true });
  });

  it("returns null when nobody qualifies", () => {
    expect(nextOffer([], req)).toBeNull();
  });
});

describe("work styles", () => {
  it("labels each combination of the two switches", () => {
    expect(workStyle({ acceptMode: "auto", workMode: "agent", deliveryHours: null })).toBe("agent 全自动");
    expect(workStyle({ acceptMode: "ask", workMode: "agent", deliveryHours: null })).toBe("需卖家审批 · agent 交付");
    expect(workStyle({ acceptMode: "auto", workMode: "manual", deliveryHours: 24 })).toBe("人工交付 · 24 小时内");
    expect(workStyle({ acceptMode: "ask", workMode: "manual", deliveryHours: 2 })).toBe("需卖家审批 · 人工交付 · 2 小时内");
  });

  it("times manual work by the seller's promise and agents by the category", () => {
    expect(workTimeoutMs(120 * 60_000, "manual", 3)).toBe(3 * 3600_000);
    expect(workTimeoutMs(120 * 60_000, "agent", 3)).toBe(120 * 60_000);
  });
});
