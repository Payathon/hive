// Platform review of a new order (design §3「平台审核」), before it reaches any seller. The buyer's text is
// already on this server, so reviewing it here sends it nowhere new. The reviewer can be talked
// round by a crafted brief like any model, so it is a second line behind `hive serve`'s fences.

export type ReviewVerdict = "allow" | "flag" | "block";

export interface ReviewRequest {
  category: { id: string; title: string; blurb: string };
  brief: string;
  input: unknown;
  deliverySpec: unknown;
}

export interface ReviewDecision {
  verdict: ReviewVerdict;
  // Short Chinese reasons people read: the buyer on a block, sellers on a flag.
  reasons: string[];
  // Whether offered sellers see the input before accepting; otherwise only `inputSummary`.
  discloseInput: boolean;
  // The input's shape with no values ("CSV 约 2000 行，字段：门店名、地址"), or null without input.
  inputSummary: string | null;
}

export interface Reviewer {
  readonly name: string;
  readonly model: string | null;
  review(req: ReviewRequest, signal: AbortSignal): Promise<ReviewDecision>;
}

// What orders.review stores.
export interface OrderReview extends ReviewDecision {
  reviewer: string;
  model: string | null;
  // Why the rules decided instead of the configured reviewer.
  fallback?: string;
  at: string;
}

// The model reviewer gets this long before the rules decide instead.
export const REVIEW_TIMEOUT_MS = 8000;

// Runs `primary` with a timeout; any failure falls back to `rules`, which never disclose input.
export async function runReview(
  primary: Reviewer | null,
  rules: Reviewer,
  req: ReviewRequest,
  now: Date,
  timeoutMs = REVIEW_TIMEOUT_MS,
): Promise<OrderReview> {
  const stamp = (r: Reviewer, d: ReviewDecision, fallback?: string): OrderReview => ({
    ...d,
    reviewer: r.name,
    model: r.model,
    ...(fallback ? { fallback } : {}),
    at: now.toISOString(),
  });
  if (primary) {
    try {
      return stamp(primary, await primary.review(req, AbortSignal.timeout(timeoutMs)));
    } catch (err) {
      const why = err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : (err as Error).message;
      console.warn(`review: ${primary.name} failed (${why}); using rules`);
      return stamp(rules, await rules.review(req, AbortSignal.timeout(timeoutMs)), `${primary.name}: ${why}`.slice(0, 300));
    }
  }
  return stamp(rules, await rules.review(req, AbortSignal.timeout(timeoutMs)));
}

// A description of the input's shape that carries none of its values.
export function describeInput(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "string") {
    const lines = input.split("\n").length;
    return lines > 1 ? `文本，约 ${lines} 行` : `文本，约 ${input.length} 字`;
  }
  if (Array.isArray(input)) {
    const first = input[0];
    const keys = first && typeof first === "object" && !Array.isArray(first) ? Object.keys(first).slice(0, 12) : [];
    return `列表，${input.length} 项${keys.length ? `，字段：${keys.join("、")}` : ""}`;
  }
  if (typeof input === "object") {
    const keys = Object.keys(input as object).slice(0, 12);
    return keys.length ? `对象，字段：${keys.join("、")}` : "空对象";
  }
  return typeof input === "number" ? "一个数字" : typeof input === "boolean" ? "一个布尔值" : "一个值";
}
