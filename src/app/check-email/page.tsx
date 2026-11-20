import { z } from "zod";
import { CheckEmail } from "@/components/check-email";

export const metadata = { title: "Check your email · MAMS Prediction Market" };

export default async function CheckEmailPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const parsed = z.email().safeParse((await searchParams).email);
  return <CheckEmail email={parsed.success ? parsed.data : null} />;
}
