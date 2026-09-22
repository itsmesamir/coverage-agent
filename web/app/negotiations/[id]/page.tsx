import Link from "next/link";
import { notFound } from "next/navigation";
import { getMessages, getNegotiation, getToolCalls } from "@/lib/queries";
import { bps, datetime, usd } from "@/lib/format";
import { Fact, Facts, Hero, Section, StateTag } from "../../ui";

export const dynamic = "force-dynamic";

/** Where a settled amount sits inside the load's floor..ceiling band. */
function RateBand({
  floor,
  ceiling,
  customer,
  settled,
}: {
  floor: number;
  ceiling: number;
  customer: number;
  settled: number | null;
}) {
  const pct = (c: number) => `${((c / customer) * 100).toFixed(1)}%`;
  return (
    <div style={{ margin: "8px 0 20px" }}>
      <div
        style={{
          position: "relative",
          height: 28,
          background: "var(--panel)",
          border: "1px solid var(--line)",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: pct(floor),
            width: `calc(${pct(ceiling)} - ${pct(floor)})`,
            top: 0,
            bottom: 0,
            background: "rgba(240, 85, 75, 0.09)",
            borderLeft: "1px solid var(--accent-dim)",
            borderRight: "1px solid var(--accent-dim)",
          }}
        />
        {settled != null && (
          <div
            style={{
              position: "absolute",
              left: pct(settled),
              top: -4,
              bottom: -4,
              width: 2,
              background: settled > ceiling ? "var(--accent)" : "var(--ok)",
            }}
          />
        )}
      </div>
      <div className="mono" style={{ color: "var(--fg-muted)", marginTop: 4 }}>
        floor {usd(floor)} · ceiling {usd(ceiling)} · customer rate {usd(customer)}
        {settled != null && ` · settled ${usd(settled)}`}
      </div>
    </div>
  );
}

export default async function NegotiationSummary({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const negotiation = await getNegotiation(id);
  if (!negotiation) notFound();

  const [messages, toolCalls] = await Promise.all([getMessages(id), getToolCalls(id)]);

  const settled = negotiation.bookedTotalCents ?? negotiation.lastOfferTotalCents;
  const marginCents = settled == null ? null : negotiation.customerRateCents - settled;
  const marginBps =
    marginCents == null
      ? null
      : Math.round((marginCents / negotiation.customerRateCents) * 10000);

  const evaluated = toolCalls.filter((t) => t.policyResult !== "not_applicable");
  const rejected = evaluated.filter((t) => t.policyResult === "rejected");

  return (
    <>
      <Hero title={<>{negotiation.origin} → {negotiation.destination}{" "}
        <StateTag state={negotiation.state} /></>}>
        Load {negotiation.loadId} · carrier {negotiation.carrierName} ·{" "}
        <Link href={`/negotiations/${id}/trace`}>view engineer trace</Link>
      </Hero>

      <RateBand
        floor={negotiation.floorCents}
        ceiling={negotiation.maxCarrierPayCents}
        customer={negotiation.customerRateCents}
        settled={settled}
      />

      <Section index={1}>Load</Section>
      <Facts>
        <Fact label="Equipment">{negotiation.equipment}</Fact>
        <Fact label="Weight">{negotiation.weightLbs.toLocaleString("en-US")} lbs</Fact>
        <Fact label="Commodity">{negotiation.commodity}</Fact>
        <Fact label="Pickup">{datetime(negotiation.pickupAt)}</Fact>
        <Fact label="Customer rate">{usd(negotiation.customerRateCents)}</Fact>
        <Fact label="Max carrier pay">{usd(negotiation.maxCarrierPayCents)}</Fact>
        <Fact label="Floor">{usd(negotiation.floorCents)}</Fact>
        <Fact label="Target margin">{bps(negotiation.targetMarginBps)}</Fact>
      </Facts>

      <Section index={2}>Outcome</Section>
      <Facts>
        <Fact label={negotiation.bookedAt ? "Booked rate" : "Last offer"}>
          {usd(settled)}
        </Fact>
        <Fact label="Linehaul">
          {usd(negotiation.bookedLinehaulCents ?? negotiation.lastOfferLinehaulCents)}
        </Fact>
        <Fact label="Accessorials">
          {negotiation.approvedAccessorials.length > 0
            ? negotiation.approvedAccessorials.join(", ")
            : "none"}
        </Fact>
        <Fact label="Realised margin">
          {marginCents == null ? "—" : `${usd(marginCents)} (${bps(marginBps ?? 0)})`}
        </Fact>
        <Fact label="Counters used">
          {negotiation.counterCount} of 3
        </Fact>
        <Fact label="Booked at">{datetime(negotiation.bookedAt)}</Fact>
      </Facts>

      <Section index={3}>Policy checks</Section>
      <Facts>
        <Fact label="Decisions evaluated">{evaluated.length}</Fact>
        <Fact label="Accepted">{evaluated.length - rejected.length}</Fact>
        <Fact label="Rejected">
          <span className={rejected.length > 0 ? "tag warn" : "tag ok"}>
            {rejected.length}
          </span>
        </Fact>
        <Fact label="Carrier authority">
          <span className={negotiation.authorityActive ? "tag ok" : "tag bad"}>
            {negotiation.authorityActive ? "active" : "lapsed"}
          </span>
        </Fact>
      </Facts>
      {rejected.length > 0 && (
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Rejected call</th>
              <th>Code</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {rejected.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.toolName}</td>
                <td className="mono">{t.rejectionCode}</td>
                <td>{t.rejectionReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Section index={4}>Transcript</Section>
      {messages.length === 0 ? (
        <p className="empty">No messages exchanged.</p>
      ) : (
        messages.map((m) => (
          <div key={m.id} className={`msg ${m.direction}`}>
            <div className="meta">
              {m.direction === "outbound" ? "Broker → carrier" : "Carrier → broker"} ·{" "}
              {m.channel} · {datetime(m.createdAt)}
              {m.renderedFromToolCallId && (
                <>
                  {" · rendered from approved call "}
                  <code>{m.renderedFromToolCallId.slice(0, 8)}</code>
                </>
              )}
            </div>
            {m.body}
          </div>
        ))
      )}
    </>
  );
}
