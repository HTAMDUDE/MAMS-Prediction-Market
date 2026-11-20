import { describe, expect, it } from "vitest";
import * as lmsr from "@/lib/lmsr";

describe("LMSR math", () => {
  it("prices sum to one and start equal", () => {
    const ps = lmsr.prices([0, 0, 0], 100);
    expect(ps.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(ps[0]).toBeCloseTo(1 / 3);
  });

  it("sharesForAmount inverts cost", () => {
    const q = [10, -5, 3], b = 100;
    const s = lmsr.sharesForAmount(q, b, 1, 42);
    expect(lmsr.costForShares(q, b, 1, s)).toBeCloseTo(42);
  });

  it("buy then sell round-trips", () => {
    const q = [0, 0], b = 100;
    const s = lmsr.sharesForAmount(q, b, 0, 50);
    q[0] += s;
    expect(lmsr.sellValue(q, b, 0, s)).toBeCloseTo(50);
  });

  it("buying raises the price", () => {
    const s = lmsr.sharesForAmount([0, 0], 100, 0, 100);
    expect(lmsr.prices([s, 0], 100)[0]).toBeGreaterThan(0.5);
  });

  describe.each([50, 150, 600])("b=%d", (b) => {
    describe.each([2, 8])("n=%d", (n) => {
      it.each([1e-12, 1, 1e5])("sharesForAmount inverts cost at extremes (amount=%d)", (amount) => {
        const q = new Array<number>(n).fill(0);
        q[0] = 40 * b; // outcome 1 is priced near e^-40
        const s = lmsr.sharesForAmount(q, b, 1, amount);
        expect(s).toBeGreaterThanOrEqual(0);
        const spent = lmsr.costForShares(q, b, 1, s);
        expect(Math.abs(spent - amount)).toBeLessThanOrEqual(1e-9 + 1e-6 * Math.abs(amount));
      });
    });
  });
});
