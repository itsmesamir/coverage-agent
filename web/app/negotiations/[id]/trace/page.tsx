import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getLlmCalls,
  getMessages,
  getNegotiation,
  getToolCalls,
  type LlmCallRow,
  type ToolCallRow,
} from "@/lib/queries";
import { datetime, millis, usd } from "@/lib/format";
import { Fact, Facts, Hero, Section, StateTag } from "../../../ui";

export const dynamic = "force-dynamic";

type Event =
  | { kind: "llm"; at: Date; latencyMs: number; requestId: string; call: LlmCallRow }
  | { kind: "tool"; at: Date; latencyMs: number; requestId: string; call: ToolCallRow };

function toEvents(llm: LlmCallRow[], tools: ToolCallRow[]): Event[] {
  const events: Event[] = [
    ...llm.map((c): Event => ({
      kind: "llm",
      at: c.createdAt,
      latencyMs: c.latencyMs,
      requestId: c.requestId,
      call: c,
    })),
    ...tools.map((c): Event => ({
      kind: "tool",
      at: c.createdAt,
      latencyMs: c.latencyMs,
      requestId: c.requestId,
      call: c,
    })),
  ];
  return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * A turn is one model decision and whatever it triggered: the LLM call, then
 * every tool call made before the model was asked again. Grouping on request id
 * would not work — the loop keeps one request id for the whole negotiation.
 */
function groupByTurn(events: Event[]): Event[][] {
  const turns: Event[][] = [];
  for (const event of events) {
    const last = turns[turns.length - 1];
    if (event.kind === "llm" || last === undefined) turns.push([event]);
    else last.push(event);
  }
  return turns;
}

function Json({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  return (
    <details className="args">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export default async function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const negotiation = await getNegotiation(id);
  if (!negotiation) notFound();

  const [llm, tools, messages] = await Promise.all([
    getLlmCalls(id),
    getToolCalls(id),
    getMessages(id),
  ]);

  const events = toEvents(llm, tools);
  const turns = groupByTurn(events);
  const slowest = Math.max(1, ...events.map((e) => e.latencyMs));
  const width = (ms: number) => `${Math.max(2, Math.round((ms / slowest) * 240))}px`;

  const inputTokens = llm.reduce((sum, c) => sum + c.inputTokens, 0);
  const outputTokens = llm.reduce((sum, c) => sum + c.outputTokens, 0);
  const wallMs = llm.reduce((sum, c) => sum + c.latencyMs, 0);
  const rejected = tools.filter((t) => t.policyResult === "rejected");
  const renderedFrom = new Set(
    messages.map((m) => m.renderedFromToolCallId).filter((v): v is string => v != null),
  );

  return (
    <>
      <Hero title={<>Trace <StateTag state={negotiation.state} /></>}>
        {negotiation.origin} → {negotiation.destination} · carrier{" "}
        {negotiation.carrierName} ·{" "}
        <Link href={`/negotiations/${id}`}>back to summary</Link>
      </Hero>

      <Facts>
        <Fact label="Turns">{turns.length}</Fact>
        <Fact label="LLM calls">{llm.length}</Fact>
        <Fact label="Tool calls">{tools.length}</Fact>
        <Fact label="Rejected">
          <span className={rejected.length > 0 ? "tag warn" : "tag ok"}>
            {rejected.length}
          </span>
        </Fact>
        <Fact label="Input tokens">{inputTokens.toLocaleString("en-US")}</Fact>
        <Fact label="Output tokens">{outputTokens.toLocaleString("en-US")}</Fact>
        <Fact label="LLM latency">{millis(wallMs)}</Fact>
        <Fact label="Model">
          <span className="mono">{llm[0]?.model ?? "—"}</span>
        </Fact>
        <Fact label="Prompt version">
          <span className="mono">{llm[0]?.promptVersion ?? "—"}</span>
        </Fact>
        <Fact label="Version (optimistic lock)">{negotiation.version}</Fact>
        <Fact label="Request id">
          <span className="mono">{events[0]?.requestId.slice(0, 8) ?? "\u2014"}</span>
        </Fact>
      </Facts>

      {turns.length === 0 && <p className="empty">Nothing traced for this negotiation.</p>}

      {turns.map((turn, i) => (
        <section key={turn[0]?.call.id ?? i}>
          <Section index={i + 1}>Turn</Section>
          <table>
            <thead>
              <tr>
                <th>Span</th>
                <th>Detail</th>
                <th>Policy</th>
                <th className="num">Latency</th>
              </tr>
            </thead>
            <tbody>
              {turn.map((event) =>
                event.kind === "llm" ? (
                  <tr key={event.call.id}>
                    <td className="mono">{event.call.role} · llm</td>
                    <td>
                      <span className="mono">
                        {event.call.provider}/{event.call.model}
                      </span>
                      <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>
                        {event.call.inputTokens} in / {event.call.outputTokens} out
                        {event.call.ttftMs != null && ` · TTFT ${millis(event.call.ttftMs)}`}
                      </div>
                    </td>
                    <td>
                      <span className="tag">n/a</span>
                    </td>
                    <td className="num">
                      <div className="span">
                        <span className="bar llm" style={{ width: width(event.latencyMs) }} />
                        {millis(event.latencyMs)}
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={event.call.id}>
                    <td className="mono">{event.call.toolName}</td>
                    <td>
                      <Json label="arguments" value={event.call.arguments} />
                      <Json label="result" value={event.call.result} />
                      {event.call.idempotencyKey && (
                        <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>
                          idempotency <code>{event.call.idempotencyKey.slice(0, 12)}</code>
                        </div>
                      )}
                      {renderedFrom.has(event.call.id) && (
                        <div style={{ color: "var(--ok)", fontSize: 12 }}>
                          → rendered an outbound message
                        </div>
                      )}
                    </td>
                    <td>
                      <span
                        className={`tag ${
                          event.call.policyResult === "accepted"
                            ? "ok"
                            : event.call.policyResult === "rejected"
                              ? "bad"
                              : ""
                        }`}
                      >
                        {event.call.policyResult}
                      </span>
                      {event.call.rejectionCode && (
                        <div style={{ fontSize: 12, marginTop: 4 }}>
                          <code>{event.call.rejectionCode}</code>
                          <div style={{ color: "var(--fg-muted)" }}>
                            {event.call.rejectionReason}
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="num">
                      <div className="span">
                        <span
                          className={`bar ${
                            event.call.policyResult === "rejected" ? "rejected" : ""
                          }`}
                          style={{ width: width(event.latencyMs) }}
                        />
                        {millis(event.latencyMs)}
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </section>
      ))}

      <Section index={turns.length + 1}>Rate band reference</Section>
      <p className="sub">
        Floor {usd(negotiation.floorCents)} · ceiling {usd(negotiation.maxCarrierPayCents)} ·
        customer rate {usd(negotiation.customerRateCents)} · started{" "}
        {datetime(negotiation.createdAt)}
      </p>
    </>
  );
}
