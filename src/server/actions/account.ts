"use server";

import { DAILY_BONUS, CURRENCY } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { todayInSchoolTz } from "@/lib/time";
import { TradeError } from "@/server/services/permissions";
import { run, type ActionState } from "./util";

export async function claimBonus(): Promise<ActionState> {
  return run(async () => {
    const user = await requireUser();
    const today = todayInSchoolTz();
    // One atomic statement: only one concurrent claim per day can match the WHERE clause.
    const count = await prisma.$executeRaw`UPDATE "user" SET balance = ROUND((balance + ${DAILY_BONUS}::float8)::numeric, 2)::float8, "lastBonus" = ${today} WHERE id = ${user.id} AND ("lastBonus" IS NULL OR "lastBonus" <> ${today})`;
    if (!count) throw new TradeError("You already claimed today's bonus. Come back tomorrow.");
    return `Claimed your daily ${DAILY_BONUS.toFixed(0)} ${CURRENCY}!`;
  });
}
