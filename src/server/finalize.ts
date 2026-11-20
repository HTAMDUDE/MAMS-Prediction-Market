import "server-only";
import { cache } from "react";
import { finalizeDue } from "./services/resolution";

/**
 * Pay out any markets whose challenge window has ended. Awaited at the top of every page and action (once per
 * request thanks to cache()), so results settle on time without a background job. A daily cron is a backup.
 */
export const ensureFinalized = cache(async () => {
  try {
    await finalizeDue();
  } catch (e) {
    console.error("finalizeDue failed", e);
  }
});
