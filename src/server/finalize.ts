import "server-only";
import { cache } from "react";
import { finalizeDueWithNext } from "./services/resolution";

/** Longest a warm instance trusts "nothing is due": bounds staleness (e.g. a dispute handled on another instance). */
const MAX_SKIP_MS = 60_000;
let nextCheckAt = 0; // per server instance

async function check() {
  try {
    const { next } = await finalizeDueWithNext();
    const now = Date.now();
    nextCheckAt = Math.min(next ? next.getTime() : Infinity, now + MAX_SKIP_MS);
  } catch (e) {
    nextCheckAt = 0; // retry on the next request
    console.error("finalizeDue failed", e);
  }
}

const checkOncePerRequest = cache(check);

/**
 * Pay out any markets whose challenge window has ended. Pages call it without options: it is once per request
 * (cache()) and skipped entirely while no window can have ended (the next one is known). Actions, the quote route
 * and the cron pass `force: true` so money paths always see settled results.
 */
export async function ensureFinalized(opts: { force?: boolean } = {}) {
  if (opts.force) return check();
  if (Date.now() < nextCheckAt) return;
  return checkOncePerRequest();
}
