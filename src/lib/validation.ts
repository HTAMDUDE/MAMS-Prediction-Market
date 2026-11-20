import { z } from "zod";
import { CATEGORIES, MIN_RULES_LENGTH, USERNAME_RE, marketB } from "./constants";
import { parseSchoolLocal } from "./time";

/** Turn FormData (or a plain record) into a record of strings, ignoring files. */
export function formRecord(data: FormData | Record<string, unknown>): Record<string, string> {
  const entries = data instanceof FormData ? [...data.entries()] : Object.entries(data);
  return Object.fromEntries(entries.filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

const text = z.string().default("");
const trimmed = text.transform((s) => s.trim());
/** A required numeric form field: empty or non-numeric input is rejected rather than treated as 0. */
const numberField = z.string().trim().min(1).transform(Number).refine(Number.isFinite);

/** One outcome per line, trimmed to 60 characters, duplicates (case-insensitive) dropped. */
export function parseOutcomeLines(input: string): string[] {
  const labels: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    const label = line.trim().slice(0, 60);
    if (label && !labels.some((x) => x.toLowerCase() === label.toLowerCase())) labels.push(label);
  }
  return labels;
}

// ------------------------------------------------------------------ market forms

const marketFormSchema = z.object({
  kind: text, // "yesno" or "multi"
  question: trimmed,
  description: trimmed,
  rules_source: trimmed,
  rules_otherwise: trimmed,
  outcomes: text,
  category: text,
  closes_at: text,
  liquidity: text,
});

export type MarketFields = {
  question: string;
  description: string;
  rulesSource: string;
  rulesOtherwise: string;
  category: string;
  closesAt: Date;
  labels: string[];
  b: number;
};
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate a create / propose / review form. Messages are shown to the user as typed. */
export function readMarketForm(data: FormData | Record<string, unknown>, now = new Date()): Parsed<MarketFields> {
  const f = marketFormSchema.parse(formRecord(data));
  // "yesno" is the standard market; anything else takes the outcome list as typed.
  const labels = f.kind === "yesno" ? ["Yes", "No"] : parseOutcomeLines(f.outcomes);
  const closesAt = parseSchoolLocal(f.closes_at);
  if (!f.question || f.question.length > 200) return { ok: false, error: "Question is required (max 200 characters)." };
  if (labels.length < 2 || labels.length > 8) return { ok: false, error: "Give 2–8 distinct outcomes, one per line." };
  if (f.description.length < MIN_RULES_LENGTH) {
    return { ok: false, error: `Say exactly how the result will be decided (at least ${MIN_RULES_LENGTH} characters in the first rules box).` };
  }
  if (!closesAt || closesAt <= now) return { ok: false, error: "Pick a closing time in the future." };
  return {
    ok: true,
    value: {
      question: f.question,
      description: f.description.slice(0, 2000),
      rulesSource: f.rules_source.slice(0, 300),
      rulesOtherwise: f.rules_otherwise.slice(0, 1000),
      category: (CATEGORIES as readonly string[]).includes(f.category) ? f.category : "Other",
      closesAt,
      labels,
      b: marketB(f.liquidity, labels.length),
    },
  };
}

const editFormSchema = z.object({
  question: trimmed,
  description: text,
  rules_source: text,
  rules_otherwise: text,
  outcomes: text,
  category: text,
  closes_at: text,
  liquidity: text,
});

export type EditFields = {
  question: string;
  category: string;
  closesAt: Date;
  description: string;
  rulesSource: string;
  rulesOtherwise: string;
  liquidity: string | null;
  labels: string[];
  renames: Record<number, string>;
};

export function readEditForm(data: FormData | Record<string, unknown>): Parsed<EditFields> {
  const raw = formRecord(data);
  const f = editFormSchema.parse(raw);
  const closesAt = parseSchoolLocal(f.closes_at);
  if (!f.question || f.question.length > 200) return { ok: false, error: "Question is required (max 200 characters)." };
  if (!closesAt) return { ok: false, error: "Pick a valid closing time." };
  const renames: Record<number, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const m = /^label_(\d+)$/.exec(k);
    if (m) renames[Number(m[1])] = v.trim().slice(0, 60);
  }
  return {
    ok: true,
    value: {
      question: f.question,
      category: (CATEGORIES as readonly string[]).includes(f.category) ? f.category : "Other",
      closesAt,
      description: f.description.trim(),
      rulesSource: f.rules_source.trim(),
      rulesOtherwise: f.rules_otherwise.trim(),
      liquidity: f.liquidity || null,
      labels: parseOutcomeLines(f.outcomes),
      renames,
    },
  };
}

// ------------------------------------------------------------------ trading and people

export const tradeSchema = z.object({
  outcome_id: z.string().regex(/^\d+$/).transform(Number),
  value: numberField,
  action: z.enum(["buy", "sell"]),
});

export const quoteSchema = z.object({
  market: z.string().regex(/^\d+$/).transform(Number),
  outcome: z.string().regex(/^\d+$/).transform(Number),
  value: numberField.refine((v) => v > 0),
  action: z.enum(["buy", "sell"]),
});

export const commentSchema = z.object({ body: trimmed });
export const disputeSchema = z.object({ reason: trimmed });
export const clarifySchema = z.object({ body: trimmed });
export const amountSchema = z.object({ amount: numberField });
export const idSchema = z.string().regex(/^\d+$/).transform(Number);

export const usernameSchema = z
  .string()
  .trim()
  .regex(USERNAME_RE, "Username must be 3–20 characters: letters, numbers, _ . -");

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address."));

export const registerSchema = z
  .object({
    username: usernameSchema,
    email: emailSchema,
    password: z.string().min(6, "Password must be at least 6 characters."),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: "Passwords don't match.", path: ["confirm"] });

export const loginSchema = z.object({ username: z.string().trim().min(1, "Enter your username."), password: z.string().min(1, "Enter your password.") });

export const changePasswordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password."),
    next: z.string().min(6, "Password must be at least 6 characters."),
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, { message: "Passwords don't match.", path: ["confirm"] });

/** Only same-site relative paths are allowed as a post-login redirect. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function firstError(e: z.ZodError): string {
  return e.issues[0]?.message ?? "Invalid input.";
}
