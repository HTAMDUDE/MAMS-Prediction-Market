import { describe, expect, it } from "vitest";
import { readMarketForm, registerSchema, safeNext, parseOutcomeLines, tradeSchema } from "@/lib/validation";
import { isBinary } from "@/server/services/markets";
import { parseSchoolLocal, SCHOOL_TZ, todayInSchoolTz, toSchoolLocal } from "@/lib/time";
import { RULES } from "./helpers";

const base = { question: "Q?", description: RULES, closes_at: "2999-01-01T12:00", category: "Events" };

describe("market form", () => {
  it("handles Yes/No vs multiple choice and required rules", () => {
    let r = readMarketForm({ ...base, kind: "yesno", outcomes: "ignored\nme" });
    expect(r.ok && r.value.labels).toEqual(["Yes", "No"]);
    expect(r.ok && r.value.b).toBe(300);
    r = readMarketForm({ ...base, kind: "multi", outcomes: "A\nB\nC" });
    expect(r.ok && r.value.labels).toEqual(["A", "B", "C"]);
    r = readMarketForm({ ...base, kind: "multi", outcomes: "Only" });
    expect(!r.ok && r.error).toContain("2–8");
    r = readMarketForm({ ...base, kind: "yesno", description: "too short" });
    expect(!r.ok && r.error).toContain("decided");
    r = readMarketForm({ ...base, kind: "yesno", rules_source: "Results page", rules_otherwise: "Postponed means NO." });
    expect(r.ok && [r.value.rulesSource, r.value.rulesOtherwise]).toEqual(["Results page", "Postponed means NO."]);
    r = readMarketForm({ ...base, kind: "yesno", closes_at: "2000-01-01T12:00" });
    expect(!r.ok && r.error).toContain("future");
    expect(isBinary(["Yes", "No"])).toBe(true);
    expect(isBinary(["Yes", "No", "Maybe"])).toBe(false);
  });

  it("scales liquidity with the number of outcomes", () => {
    const r = readMarketForm({ ...base, kind: "multi", outcomes: [..."abcdefgh"].join("\n"), liquidity: "medium" });
    expect(r.ok && r.value.b).toBeCloseTo(900);
  });

  it("parses outcome lines (trim, dedupe case-insensitively, 60 chars)", () => {
    expect(parseOutcomeLines(" A \n\na\nB\n" + "x".repeat(80))).toEqual(["A", "B", "x".repeat(60)]);
  });
});

describe("other schemas", () => {
  it("validates trades without treating empty input as 0", () => {
    expect(tradeSchema.safeParse({ outcome_id: "3", value: "12.5", action: "buy" }).success).toBe(true);
    expect(tradeSchema.safeParse({ outcome_id: "3", value: "", action: "buy" }).success).toBe(false);
    expect(tradeSchema.safeParse({ outcome_id: "3", value: "Infinity", action: "buy" }).success).toBe(false);
    expect(tradeSchema.safeParse({ outcome_id: "3", value: "1", action: "steal" }).success).toBe(false);
  });

  it("validates registration", () => {
    const ok = { username: "ok_name", email: "ok@example.com", password: "secret1", confirm: "secret1" };
    expect(registerSchema.safeParse(ok).success).toBe(true);
    expect(registerSchema.safeParse({ ...ok, email: "  Ok@Example.COM " }).data?.email).toBe("ok@example.com"); // trimmed + lowercased
    expect(registerSchema.safeParse({ ...ok, username: "no" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...ok, username: "bad name" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...ok, email: "not-an-email" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...ok, email: "" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...ok, password: "short", confirm: "short" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...ok, confirm: "secret2" }).success).toBe(false);
  });

  it("only allows same-site redirects", () => {
    expect(safeNext("/market/3")).toBe("/market/3");
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
});

describe("school time", () => {
  it("uses the school timezone", () => {
    expect(SCHOOL_TZ).toBe("America/New_York");
    // 3pm New York on a winter date is 20:00 UTC; in summer 19:00 UTC
    expect(parseSchoolLocal("2026-01-15T15:00")!.toISOString()).toBe("2026-01-15T20:00:00.000Z");
    expect(parseSchoolLocal("2026-07-15T15:00")!.toISOString()).toBe("2026-07-15T19:00:00.000Z");
    expect(toSchoolLocal(new Date("2026-01-15T20:00:00Z"))).toBe("2026-01-15T15:00");
    expect(todayInSchoolTz(new Date("2026-01-16T03:30:00Z"))).toBe("2026-01-15"); // still "yesterday" in New York
    expect(parseSchoolLocal("garbage")).toBeNull();
  });
});
