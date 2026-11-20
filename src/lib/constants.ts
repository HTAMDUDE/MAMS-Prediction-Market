export const STARTING_BALANCE = 1000;
export const DAILY_BONUS = 100;
export const MIN_BET = 1;
export const CURRENCY = "MAMS Bucks";
export const MIN_RULES_LENGTH = 20;
export const DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000; // how long traders can challenge a proposed result
export const MAX_PENDING_PROPOSALS = 5;
export const EPS = 1e-9;
export const CATEGORIES = ["Academics", "Competitions", "Sports", "Events", "Campus Life", "Weather", "Other"] as const;
export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;

/** Liquidity presets are for a yes/no market; markets with more outcomes scale up (see marketB). */
export const LIQUIDITY = { low: 150, medium: 300, high: 600 } as const;
export type LiquidityPreset = keyof typeof LIQUIDITY;

export function isPreset(x: unknown): x is LiquidityPreset {
  return typeof x === "string" && x in LIQUIDITY;
}

/** A bet moves an 8-way market about as much as it moves a 2-way one. */
export function marketB(preset: string | null | undefined, nOutcomes: number): number {
  const base = isPreset(preset) ? LIQUIDITY[preset] : LIQUIDITY.medium;
  return base * Math.log2(Math.max(nOutcomes, 2));
}

/** The preset whose scaled liquidity is closest to a market's stored b (old markets may not match exactly). */
export function presetFor(b: number, nOutcomes: number): LiquidityPreset {
  const keys = Object.keys(LIQUIDITY) as LiquidityPreset[];
  return keys.reduce((best, k) => (Math.abs(marketB(k, nOutcomes) - b) < Math.abs(marketB(best, nOutcomes) - b) ? k : best));
}

/** Username of the site owner. Empty string means "the first account to register". */
export function ownerUsername(): string {
  return (process.env.MAMS_OWNER ?? "Kaushik").trim().toLowerCase();
}

export function adminUsernames(): Set<string> {
  return new Set(
    (process.env.MAMS_ADMINS ?? "")
      .split(",")
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const cents = (x: number) => Math.round((x + 0) * 100) / 100;
