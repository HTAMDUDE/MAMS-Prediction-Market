import { money } from "@/lib/format";
import { getCurrentUser } from "@/lib/session";
import { ensureFinalized } from "@/server/finalize";
import { getLeaderboard } from "@/server/services/portfolio";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Leaderboard · MAMS Prediction Market" };
const MEDALS = ["🥇", "🥈", "🥉"];

export default async function Leaderboard() {
  await ensureFinalized();
  const user = await getCurrentUser();
  const board = await getLeaderboard(user?.id ?? null);
  return (
    <div className="space-y-2">
      <h1>Leaderboard</h1>
      <p className="mb-2 text-muted-foreground">Net worth = cash + what your open bets would sell for right now.</p>
      <Card className="p-2">
        {board.length ? (
          <Table>
            <TableHeader>
              <TableRow><TableHead>#</TableHead><TableHead>Trader</TableHead><TableHead className="text-right">Net worth</TableHead><TableHead className="hidden text-right sm:table-cell">Cash</TableHead><TableHead className="hidden text-right sm:table-cell">Trades</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {board.map((row, i) => (
                <TableRow key={`${row.username}-${i}`} className={row.isMe ? "bg-primary/10" : undefined}>
                  <TableCell className="w-12">{MEDALS[i] ?? i + 1}</TableCell>
                  <TableCell className="max-w-0 truncate"><strong>{row.username}</strong>{row.isMe && <span className="ml-1 text-sm text-muted-foreground">(you)</span>}</TableCell>
                  <TableCell className="text-right">Ⓜ{money(row.worth)}</TableCell>
                  <TableCell className="hidden text-right sm:table-cell">Ⓜ{money(row.balance)}</TableCell>
                  <TableCell className="hidden text-right sm:table-cell">{row.trades}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : <p className="p-4 text-muted-foreground">Nobody has signed up yet. Be the first on the board!</p>}
      </Card>
    </div>
  );
}
