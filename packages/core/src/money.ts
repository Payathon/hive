// All amounts are integer fen (分). Convert to yuan strings only at the Alipay boundary.
export type Fen = number & { readonly __brand: "Fen" };

export function fen(n: number): Fen {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`invalid fen amount: ${n}`);
  }
  return n as Fen;
}

// "12.5" -> 1250. Rejects more than two decimals rather than rounding.
export function yuanToFen(yuan: string): Fen {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(yuan.trim());
  if (!m) throw new Error(`invalid yuan amount: ${yuan}`);
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  return fen(whole * 100 + frac);
}

// 1250 -> "12.50", the format Alipay expects for total_amount.
export function fenToYuan(amount: Fen): string {
  const whole = Math.floor(amount / 100);
  const frac = String(amount % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}
