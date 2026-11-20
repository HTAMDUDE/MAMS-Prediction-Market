"use client";

import Link from "next/link";
import { useState } from "react";
import { CATEGORIES } from "@/lib/constants";
import { editMarketAction } from "@/server/actions/admin";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

export type EditMarketInitial = {
  id: number; status: string; question: string; description: string; rulesSource: string; rulesOtherwise: string;
  category: string; closesAt: string; liquidity: string; hasTrades: boolean; open: boolean;
  outcomes: { id: number; label: string }[];
};

export function EditMarketForm({ m }: { m: EditMarketInitial }) {
  const [v, setV] = useState({ question: m.question, description: m.description, rules_source: m.rulesSource, rules_otherwise: m.rulesOtherwise, category: m.category, closes_at: m.closesAt, liquidity: m.liquidity });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV((p) => ({ ...p, [k]: e.target.value }));
  const [labels, setLabels] = useState(Object.fromEntries(m.outcomes.map((o) => [o.id, o.label])));
  const [outcomes, setOutcomes] = useState(m.outcomes.map((o) => o.label).join("\n"));
  const locked = m.hasTrades;
  return (
    <Card className="mx-auto max-w-3xl gap-4 p-4 sm:p-5">
      <h1>Edit market</h1>
      {m.status !== "open" && <p className="rounded-lg bg-down/10 p-3 text-down">This market is already {m.status}. Edits only change how it&apos;s displayed.</p>}
      <ActionForm action={editMarketAction} className="space-y-4">
        {({ pending }) => (
          <>
            <input type="hidden" name="market_id" value={m.id} />
            <Field label="Question"><Input name="question" maxLength={200} required value={v.question} onChange={set("question")} /></Field>
            {locked && <p className="text-sm text-muted-foreground">People have already bet, so the written rules are locked. Add a dated clarification on the market page instead.</p>}
            <Field label="Resolves YES if… / how the winner is decided"><Textarea name="description" rows={3} readOnly={locked} value={v.description} onChange={set("description")} /></Field>
            <Field label="Source"><Input name="rules_source" maxLength={300} readOnly={locked} value={v.rules_source} onChange={set("rules_source")} /></Field>
            <Field label="Otherwise / edge cases"><Textarea name="rules_otherwise" rows={2} maxLength={1000} readOnly={locked} value={v.rules_otherwise} onChange={set("rules_otherwise")} /></Field>
            {locked ? (
              <Field label="Outcomes">
                <p className="text-sm text-muted-foreground">People have already bet, so you can rename outcomes but not add or remove them.</p>
                {m.outcomes.map((o, n) => <Input key={o.id} aria-label={`Outcome ${n + 1} name`} name={`label_${o.id}`} maxLength={60} required value={labels[o.id]} onChange={(e) => setLabels((p) => ({ ...p, [o.id]: e.target.value }))} />)}
              </Field>
            ) : (
              <Field label={<>Outcomes <em className="font-normal text-muted-foreground">(one per line, 2–8)</em></>}>
                <Textarea name="outcomes" rows={Math.max(m.outcomes.length, 3)} required value={outcomes} onChange={(e) => setOutcomes(e.target.value)} />
              </Field>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Category"><NativeSelect name="category" value={v.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</NativeSelect></Field>
              <Field label="Betting closes"><Input type="datetime-local" name="closes_at" required value={v.closes_at} onChange={set("closes_at")} /></Field>
              <Field label="Liquidity">
                <NativeSelect name="liquidity" value={v.liquidity} onChange={set("liquidity")} disabled={locked} title={locked ? "Locked once people have bet" : "Higher liquidity = prices move less per bet"}>
                  <option value="low">Low (prices swing fast)</option><option value="medium">Medium</option><option value="high">High (prices steady)</option>
                </NativeSelect>
              </Field>
            </div>
            {m.open && <p className="text-sm text-muted-foreground">Moving the closing time later reopens betting on a market that has already closed.</p>}
            <div className="flex flex-wrap gap-2">
              <Button className="h-10 px-5" disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button>
              <Link href={`/market/${m.id}`} className={buttonVariants({ variant: "outline", className: "h-10 px-5" })}>Cancel</Link>
            </div>
          </>
        )}
      </ActionForm>
    </Card>
  );
}
