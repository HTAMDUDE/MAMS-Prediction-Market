/**
 * Logarithmic Market Scoring Rule (LMSR) automated market maker (port of the old lmsr.py).
 *
 * The market maker always quotes a price for every outcome, so traders never need a counterparty. Prices across all
 * outcomes of a market sum to 1, and each price can be read as the crowd's probability for that outcome.
 *
 *   cost(q)  = b * ln( sum_i exp(q_i / b) )
 *   price_i  = exp(q_i / b) / sum_j exp(q_j / b)
 *
 * q_i is the number of shares of outcome i sold so far and b is the "liquidity" parameter: larger b means prices
 * move less per trade. A winning share pays out 1 coin when the market resolves.
 */

function logSumExp(xs: number[]): number {
  const m = Math.max(...xs);
  return m + Math.log(xs.reduce((acc, x) => acc + Math.exp(x - m), 0));
}

export function cost(q: number[], b: number): number {
  return b * logSumExp(q.map((x) => x / b));
}

export function prices(q: number[], b: number): number[] {
  const z = q.map((x) => x / b);
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const total = e.reduce((a, v) => a + v, 0);
  return e.map((v) => v / total);
}

/** How many shares of outcome i can be bought for exactly `amount` coins. */
export function sharesForAmount(q: number[], b: number, i: number, amount: number): number {
  if (amount <= 0) throw new Error("amount must be positive");
  // Solving costForShares(s) = amount gives exp(s/b) = 1 + (exp(amount/b) - 1) / p_i. Evaluated in log space so it
  // stays accurate for tiny amounts and for outcomes priced near 0.
  const x = amount / b;
  const negLogP = (cost(q, b) - q[i]) / b; // = -ln(p_i)
  const a = negLogP + x + Math.log(-Math.expm1(-x));
  return b * (Math.max(a, 0) + Math.log1p(Math.exp(-Math.abs(a)))); // b * ln(1 + e^a)
}

/** Coins needed to buy `shares` of outcome i. */
export function costForShares(q: number[], b: number, i: number, shares: number): number {
  const q2 = [...q];
  q2[i] += shares;
  return cost(q2, b) - cost(q, b);
}

/** Coins received for selling `shares` of outcome i back to the market maker. */
export function sellValue(q: number[], b: number, i: number, shares: number): number {
  const q2 = [...q];
  q2[i] -= shares;
  return cost(q, b) - cost(q2, b);
}

/**
 * Coins received for selling a whole set of holdings (one share count per outcome) at once.
 * This is not the sum of per-outcome sell values: holding s of every outcome is worth exactly s.
 */
export function liquidationValue(q: number[], b: number, holdings: number[]): number {
  return cost(q, b) - cost(q.map((x, k) => x - holdings[k]), b);
}
