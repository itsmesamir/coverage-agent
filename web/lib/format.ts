/** Presentation helpers. Integer cents in, strings out — never floats in state. */

export function usd(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toString();
  const remainder = (abs % 100).toString().padStart(2, "0");
  const grouped = dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${remainder}`;
}

export function bps(value: number): string {
  return `${(value / 100).toFixed(1)}%`;
}

/** Fixed to UTC so a screenshot means the same thing in any timezone. */
export function datetime(value: Date | string | null | undefined): string {
  if (value == null) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function millis(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
