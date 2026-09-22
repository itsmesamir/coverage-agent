import Link from "next/link";
import { notFound } from "next/navigation";
import { getEvalRun } from "@/lib/queries";
import { datetime } from "@/lib/format";
import { Fact, Facts, Hero, Section } from "../../ui";

export const dynamic = "force-dynamic";

function count(metrics: Record<string, unknown>, key: string): string {
  const value = metrics[key];
  return typeof value === "number" ? String(value) : typeof value === "string" ? value : "—";
}

/** Scores keep their decimals: a tool-call score of 1 and of 0.9987 are not
 *  the same result, and the gate compares them to four places. */
function score(metrics: Record<string, unknown>, key: string): string {
  const value = metrics[key];
  return typeof value === "number" ? value.toFixed(4) : "—";
}

export default async function EvalRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { run, results } = await getEvalRun(id);
  if (!run) notFound();

  const m = run.metrics ?? {};

  return (
    <>
      <Hero title="Eval run">
        {run.suite} suite · <span className="mono">{run.provider}/{run.model}</span> ·
        prompt <span className="mono">{run.promptVersion}</span> ·{" "}
        <Link href="/evals">back to runs</Link>
      </Hero>

      <Section index={1}>Run</Section>
      <Facts>
        <Fact label="Started">{datetime(run.startedAt)}</Fact>
        <Fact label="Finished">{datetime(run.finishedAt)}</Fact>
        <Fact label="Commit">
          <span className="mono">{run.gitSha.slice(0, 7)}</span>
        </Fact>
        <Fact label="Cases">{run.caseCount}</Fact>
        <Fact label="Passed">{run.passedCount}</Fact>
        <Fact label="Errored">{count(m, "errored")}</Fact>
        <Fact label="Policy violations">
          <span className={m["policy_violations"] === 0 ? "tag ok" : "tag bad"}>
            {count(m, "policy_violations")}
          </span>
        </Fact>
        <Fact label="Mean tool-call score">{score(m, "mean_tool_call_score")}</Fact>
      </Facts>

      <Section index={2}>Cases</Section>
      <table>
        <thead>
          <tr>
            <th>Case</th>
            <th>Persona</th>
            <th>Outcome</th>
            <th className="num">Turns</th>
            <th className="num">Violations</th>
            <th className="num">Tool-call</th>
            <th className="num">Refused</th>
            <th>Result</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const cm = r.metrics;
            const failures = Array.isArray(cm["failures"]) ? (cm["failures"] as string[]) : [];
            return (
              <tr key={r.id}>
                <td className="mono">{r.caseId}</td>
                <td>{r.persona}</td>
                <td>{count(cm, "outcome")}</td>
                <td className="num">{count(cm, "turns")}</td>
                <td className="num">{count(cm, "policy_violations")}</td>
                <td className="num">{score(cm, "tool_call_score")}</td>
                <td className="num">{count(cm, "forbidden_attempted")}</td>
                <td>
                  <span className={r.passed ? "tag ok" : "tag bad"}>
                    {r.passed ? "pass" : "fail"}
                  </span>
                  {failures.length > 0 && (
                    <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
                      {failures.join("; ")}
                    </div>
                  )}
                </td>
                <td>
                  {r.negotiationId && (
                    <Link href={`/negotiations/${r.negotiationId}/trace`}>trace</Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
