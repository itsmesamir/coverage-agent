import type { ReactNode } from "react";
import Link from "next/link";
import { Funnel_Display, IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";

// Self-hosted at build time, so there is no runtime request to Google and no
// swap flash on first paint.
const display = Funnel_Display({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-display",
});
const sans = Inter({ subsets: ["latin"], variable: "--font-sans" });
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata = {
  title: "Coverage Agent",
  description: "Load-coverage negotiation agent dashboard",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      {/* Extensions such as Grammarly add attributes to <body> before React
          hydrates, which reads as a mismatch. This suppresses the warning for
          this element's own attributes only -- the subtree is still checked. */}
      <body suppressHydrationWarning>
        <header className="top">
          <span className="brand">Coverage Agent</span>
          <nav>
            <Link href="/">Negotiations</Link>
            <Link href="/evals">Evals</Link>
          </nav>
          <span className="thesis">
            LLM proposes · policy decides · evals prove
          </span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
