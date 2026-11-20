import type { AuditAction } from "@/lib/audit-actions";
import { prisma } from "@/lib/db";
import { assertAdmin, type Actor } from "./permissions";

export type AuditTarget = {
  targetType?: "user" | "market" | "comment" | "proposal" | "site";
  targetId?: string | number | null;
  targetLabel?: string | null;
  detail?: string;
};

/**
 * Record an admin action. Call it AFTER the action's own transaction has committed: an audit failure is logged but never
 * undoes or fails the action itself (and must not run inside a transaction, where a failed insert would abort it).
 */
export async function logAudit(actor: Actor, action: AuditAction, t: AuditTarget = {}): Promise<void> {
  try {
    const a = await prisma.user.findUnique({ where: { id: actor.id }, select: { displayUsername: true, username: true, name: true } });
    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        actorName: a?.displayUsername ?? a?.username ?? a?.name ?? "unknown",
        action,
        targetType: t.targetType ?? null,
        targetId: t.targetId === undefined || t.targetId === null ? null : String(t.targetId),
        targetLabel: t.targetLabel?.slice(0, 200) ?? null,
        detail: (t.detail ?? "").slice(0, 500),
      },
    });
  } catch (e) {
    console.error("Could not write the audit log", e);
  }
}

/** A user's display name for log entries (falls back to the id if the account is gone). */
export async function userLabel(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { displayUsername: true, username: true, name: true } });
  return u?.displayUsername ?? u?.username ?? u?.name ?? userId;
}

export const AUDIT_PAGE_SIZE = 50;

/** Newest first. `q` matches the actor, action, target and detail (case-insensitive). */
export async function listAudit(actor: Actor, opts: { q?: string; page?: number } = {}) {
  assertAdmin(actor);
  const q = opts.q?.trim();
  const where = q
    ? {
        OR: [
          { actorName: { contains: q, mode: "insensitive" as const } },
          { action: { contains: q, mode: "insensitive" as const } },
          { targetLabel: { contains: q, mode: "insensitive" as const } },
          { detail: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { id: "desc" }, skip: (page - 1) * AUDIT_PAGE_SIZE, take: AUDIT_PAGE_SIZE }),
    prisma.auditLog.count({ where }),
  ]);
  return { rows, total, page, pages: Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)) };
}
