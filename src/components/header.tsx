import Link from "next/link";
import { DAILY_BONUS, CURRENCY } from "@/lib/constants";
import { money } from "@/lib/format";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { todayInSchoolTz } from "@/lib/time";
import { buttonVariants } from "@/components/ui/button";
import { BonusButton } from "@/components/bonus-button";
import { LogoutButton } from "@/components/logout-button";
import { NavLinks, type NavItem } from "@/components/nav-links";

export async function Header() {
  const user = await getCurrentUser();
  const pending = user?.isAdmin ? await prisma.proposal.count({ where: { status: "pending" } }) : 0;
  const items: NavItem[] = [
    { href: "/", label: "Markets", match: (p) => p === "/" || p.startsWith("/market/") },
    { href: "/leaderboard", label: "Leaderboard", match: (p) => p === "/leaderboard" },
    { href: "/how-it-works", label: "How it works", match: (p) => p === "/how-it-works" },
  ];
  if (user) {
    items.push({ href: "/portfolio", label: "Portfolio", match: (p) => p === "/portfolio" });
    items.push({ href: "/propose", label: "Propose", match: (p) => p === "/propose" });
    if (user.isAdmin) items.push({ href: "/admin", label: "Admin", match: (p) => p.startsWith("/admin"), badge: pending });
  }
  const canBonus = Boolean(user) && user!.lastBonus !== todayInSchoolTz();
  return (
    <header className="sticky top-0 z-10 border-b bg-card">
      <div className="mx-auto flex min-h-15 max-w-280 flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2">
        <Link href="/" className="flex items-center gap-2.5 text-base">
          <span className="grid size-8 place-items-center rounded-lg bg-primary font-bold text-primary-foreground">M</span>
          <span>MAMS <strong>Prediction Market</strong></span>
        </Link>
        <NavLinks items={items} />
        <div className="flex items-center gap-2">
          {user ? (
            <>
              {canBonus && <BonusButton amount={DAILY_BONUS} />}
              <Link href="/portfolio" title={`Your ${CURRENCY}`} className="flex items-center gap-1 rounded-full border bg-secondary px-3 py-1 text-sm font-semibold">
                <span className="text-gold">Ⓜ</span>{money(user.balance)}
              </Link>
              <LogoutButton username={user.username} />
            </>
          ) : (
            <>
              <Link href="/login" className={buttonVariants({ variant: "ghost", size: "sm" })}>Log in</Link>
              <Link href="/register" className={buttonVariants({ size: "sm" })}>Sign up</Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
