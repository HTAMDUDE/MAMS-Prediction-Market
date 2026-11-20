import "server-only";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { ZodError, type ZodType } from "zod";
import type { ActionState } from "@/lib/action-state";
import { FLASH_COOKIE } from "@/lib/flash";
import { firstError, formRecord } from "@/lib/validation";
import { ensureFinalized } from "@/server/finalize";
import { TradeError } from "@/server/services/permissions";

export type { ActionState };

/** A message to show after a redirect. Read (and cleared) by the <Flash/> component. */
export async function setFlash(type: "success" | "error", message: string) {
  (await cookies()).set(FLASH_COOKIE, JSON.stringify({ type, message, id: randomUUID() }), { path: "/", maxAge: 60, sameSite: "lax" });
}

/**
 * Run an action body that returns a success message. Expected failures (TradeError, bad input) become an error
 * state; anything else, including redirects, is rethrown. Pages are revalidated on success.
 */
export async function run(body: () => Promise<string | { message: string; persist?: boolean }>): Promise<ActionState> {
  try {
    await ensureFinalized();
    const result = await body();
    revalidatePath("/", "layout");
    return typeof result === "string" ? { ok: true, message: result } : { ok: true, ...result };
  } catch (e) {
    if (e instanceof TradeError) return { ok: false, message: e.message };
    if (e instanceof ZodError) return { ok: false, message: firstError(e) };
    throw e;
  }
}

/** Parse form data with a zod schema; throws a ZodError that `run` turns into a message. */
export function parseForm<T>(schema: ZodType<T>, fd: FormData | Record<string, unknown>): T {
  return schema.parse(formRecord(fd));
}
