import { prisma } from "@/lib/db";
import { logAudit } from "./audit";
import { assertAdmin, TradeError, type Actor } from "./permissions";

export const ANNOUNCEMENT_KEY = "announcement";
export const ANNOUNCEMENT_MAX = 300;

/** The banner text shown on every page, or null when there is none. */
export async function getAnnouncement(): Promise<string | null> {
  const s = await prisma.siteSetting.findUnique({ where: { key: ANNOUNCEMENT_KEY } });
  return s?.value || null;
}

/** Set the site-wide announcement banner. An empty text clears it. */
export async function setAnnouncement(actor: Actor, text: string) {
  assertAdmin(actor);
  const value = text.trim();
  if (value.length > ANNOUNCEMENT_MAX) throw new TradeError(`Keep the announcement under ${ANNOUNCEMENT_MAX} characters.`);
  if (value) {
    await prisma.siteSetting.upsert({ where: { key: ANNOUNCEMENT_KEY }, create: { key: ANNOUNCEMENT_KEY, value }, update: { value } });
  } else {
    await prisma.siteSetting.deleteMany({ where: { key: ANNOUNCEMENT_KEY } });
  }
  await logAudit(actor, "site.announcement", { targetType: "site", detail: value || "(cleared)" });
  return value || null;
}
