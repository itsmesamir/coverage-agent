import Link from "next/link";
import { listEvalRuns } from "@/lib/queries";
import { datetime } from "@/lib/format";
import { Empty, Hero } from "../ui";

export const dynamic = "force-dynamic";

function num(value: unknown, digits = 4): string {
  return typeof value === "number" ? value.toFixed(digits) : "—";
}

export default async function EvalsPage() {
  const runs = await listEvalRuns();

  return (
    <>
      <Hero title="Eval runs">
        Gate: zero policy violations, tool-call score no more than 0.02 below baseline,
        hallucination rate no more than 0.01 above baseline.
      </Hero>

      {runs.length === 0 ? (
        <Empty>
          No eval runs recorded. Run <code>pnpm eval:small</code>.
        </Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Suite</th>
              <th>Model</th>
              <th>Prompt</th>
              <th>Commit</th>
              <th className="num">Cases</th>
              <th className="num">Passed</th>
              <th className="num">Violations</th>
              <th className="num">Tool-call</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const m = r.metrics ?? {};
              const violations = m["policy_violations"];
              return (
                <tr key={r.id}>
                  <td>{datetime(r.startedAt)}</td>
                  <td>{r.suite}</td>
                  <td className="mono">
                    {r.provider}/{r.model}
                  </td>
                  <td className="mono">{r.promptVersion}</td>
                  <td className="mono">{r.gitSha.slice(0, 7)}</td>
                  <td className="num">{r.caseCount}</td>
                  <td className="num">
                    {r.passedCount}/{r.caseCount}
                  </td>
                  <td className="num">
                    <span className={violations === 0 ? "tag ok" : "tag bad"}>
                      {typeof violations === "number" ? violations : "—"}
                    </span>
                  </td>
                  <td className="num">{num(m["mean_tool_call_score"])}</td>
                  <td>
                    <Link href={`/evals/${r.id}`}>cases</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
