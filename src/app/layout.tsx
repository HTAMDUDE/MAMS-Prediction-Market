import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";
import { CURRENCY } from "@/lib/constants";
import { FLASH_COOKIE } from "@/lib/flash";
import { Flash } from "@/components/flash";
import { Header } from "@/components/header";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "MAMS Prediction Market",
  description: "Bet virtual MAMS Bucks on Mass Academy events.",
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%237a1f2b'/><text x='16' y='22' font-size='16' font-family='Arial' font-weight='bold' fill='white' text-anchor='middle'>M</text></svg>",
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const flash = (await cookies()).get(FLASH_COOKIE)?.value ?? null;
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <Header />
          <main className="mx-auto w-full max-w-280 flex-1 px-4 py-5">{children}</main>
          <footer className="mx-auto w-full max-w-280 px-4 py-6 text-sm text-muted-foreground">
            Play money only — {CURRENCY} have no cash value. Prices are the crowd&apos;s estimate of how likely each outcome is.
          </footer>
          <Toaster richColors closeButton />
          <Flash raw={flash} />
        </ThemeProvider>
      </body>
    </html>
  );
}
