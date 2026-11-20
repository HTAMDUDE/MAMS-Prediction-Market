import { LoginForm } from "@/components/auth-forms";

export const metadata = { title: "Log in · MAMS Prediction Market" };

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  return <LoginForm next={(await searchParams).next} />;
}
