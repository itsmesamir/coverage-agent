import type { ReactNode } from "react";

const TONE: Record<string, string> = {
  BOOKED: "ok",
  AGREED: "ok",
  FAILED: "bad",
  ESCALATED: "warn",
};

export function StateTag({ state }: { state: string }) {
  return <span className={`tag ${TONE[state] ?? ""}`}>{state}</span>;
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  return <dl className="facts">{children}</dl>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** Section heading with an editorial index: `[01] OUTCOME`. */
export function Section({ index, children }: { index: number; children: ReactNode }) {
  return (
    <h2>
      <span className="idx">[{String(index).padStart(2, "0")}]</span>
      {children}
    </h2>
  );
}

/** Full-bleed maroon title band, one per page. */
export function Hero({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="hero">
      <h1>{title}</h1>
      {children ? <p className="sub">{children}</p> : null}
    </div>
  );
}
