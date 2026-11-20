import Link from "next/link";
import { DISPUTE_WINDOW_MS } from "@/lib/constants";
import { getCurrentUser } from "@/lib/session";
import { buttonVariants } from "@/components/ui/button";

export const metadata = { title: "How it works · MAMS Prediction Market" };

export default async function HowItWorks() {
  const user = await getCurrentUser();
  const hours = Math.floor(DISPUTE_WINDOW_MS / 3600000);
  return (
    <article className="mx-auto max-w-3xl space-y-3 rounded-xl border bg-card p-6 sm:p-8 [&_h2]:mt-6 [&_h2]:text-xl [&_li]:ml-5 [&_ol]:list-decimal [&_ol]:space-y-1 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:space-y-1">
      <h1>How MAMS Prediction Market works</h1>
      <p className="text-lg text-muted-foreground">
        A prediction market turns a question about the future into a price. The price is the school&apos;s best guess at how likely it is.
        Everything here uses play money, but the ideas are the same ones real prediction markets use.
      </p>

      <h2>Prices are probabilities</h2>
      <p>Every share pays <b>Ⓜ1</b> if it&apos;s right and <b>Ⓜ0</b> if it&apos;s wrong. So a “Yes” share priced at 30¢ means the market thinks Yes is about <b>30% likely</b>.</p>
      <p>
        The idea behind it is old: lots of people each know a little, and putting money on the line is a good way to pull that knowledge together.
        If you know something the market doesn&apos;t, you can profit by buying, and your buying moves the price toward the truth. People who are often
        wrong lose Bucks and have less influence over time. Talk is free; trades aren&apos;t.
      </p>
      <div className="rounded-lg border-l-4 border-primary bg-secondary p-3 text-sm">
        <b>Example.</b> “Yes” is at 30¢. You spend Ⓜ30 and get about 100 shares. If Yes happens, they pay Ⓜ100 (a Ⓜ70 profit). If not, they&apos;re worth Ⓜ0.
        Buying pushes the price up a little, so your average price is a bit above 30¢.
      </div>

      <h2>Who is on the other side?</h2>
      <p>
        Real markets like Polymarket match buyers with sellers in an order book. That works with millions of traders, but with a school&apos;s worth of
        people there would often be nobody to trade with. Here an <b>automated market maker</b> (called LMSR) always offers a price. It moves the price
        as people buy and sell, and the amount it moves depends on the market&apos;s <i>liquidity</i>:
      </p>
      <ul>
        <li><b>Low liquidity</b>: prices swing fast. A small bet moves the price a lot.</li>
        <li><b>High liquidity</b>: prices are steadier and harder to push around.</li>
      </ul>
      <p>You can sell shares back before betting closes, at the current price.</p>

      <h2>Read the rules, not just the title</h2>
      <p>
        A market called “Will the bill pass?” might really mean “signed into law by December 31” or “passed by the House”. Many arguments come from
        people betting on the title without reading the rules. Every market has a <b>Rules</b> box with:
      </p>
      <ul>
        <li><b>Resolves YES if…</b>: exactly what has to happen.</li>
        <li><b>Source</b>: where the answer will be published.</li>
        <li><b>Otherwise</b>: what happens in edge cases, like a postponement or a tie.</li>
      </ul>
      <p>The written rules are <b>locked once anyone has bet</b>, so nobody can change the deal after the fact. Admins can still add a dated <i>clarification</i>.</p>

      <h2>Yes/No and multiple choice</h2>
      <p>
        Most markets are <b>Yes/No</b>. Some ask “who” or “which”, with several choices. In those, only one choice can be right, so all the prices always
        add up to 100%. Buying one choice makes the others a little cheaper.
      </p>

      <h2>How results are decided</h2>
      <ol>
        <li>Betting closes at the time shown on the market.</li>
        <li>An admin <b>proposes</b> a result once it&apos;s known.</li>
        <li>For <b>{hours} hours</b>, anyone who traded in that market can <b>dispute</b> it and say why.</li>
        <li>If nobody disputes, the result becomes final and winning shares are paid automatically.</li>
        <li>If someone disputes, payment pauses until an admin reviews it. They either confirm the result or change it, which starts a new {hours}-hour window.</li>
      </ol>
      <p>
        The idea is the same as Polymarket&apos;s “optimistic” resolution: assume the proposed answer is right unless someone speaks up. Most results go
        through without any argument.
      </p>

      <h2>Where it can go wrong</h2>
      <ul>
        <li><b>Prices aren&apos;t perfect.</b> In a small market, one big bettor can push the price around. Long shots also tend to trade a bit too high, because cheap lottery tickets are tempting.</li>
        <li>
          <b>Insider information.</b> Rewarding people who know more is the whole point, but it also rewards people who know something they shouldn&apos;t,
          like a result they already heard. Trades by admins and market creators are labelled so everyone can see them, and admins can block someone from a
          market. If you already know the answer, don&apos;t bet.
        </li>
        <li><b>Admins decide in the end.</b> They propose results and settle disputes, so if a result looks wrong, use the dispute button.</li>
      </ul>

      <div className="flex gap-2 pt-3">
        <Link href="/" className={buttonVariants()}>Browse markets</Link>
        {user && <Link href="/propose" className={buttonVariants({ variant: "outline" })}>Propose a market</Link>}
      </div>
    </article>
  );
}
