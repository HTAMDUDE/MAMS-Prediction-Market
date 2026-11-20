"use client";

import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { claimBonus } from "@/server/actions/account";

export function BonusButton({ amount }: { amount: number }) {
  return (
    <ActionForm action={claimBonus}>
      {({ pending }) => (
        <Button size="sm" disabled={pending} title="Claim your free daily MAMS Bucks" className="bg-gold text-black hover:bg-gold/80">
          +{amount} daily
        </Button>
      )}
    </ActionForm>
  );
}
