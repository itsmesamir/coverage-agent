import Link from "next/link";
import { listNegotiations } from "@/lib/queries";
import { usd, datetime } from "@/lib/format";
import { Empty, Hero, StateTag } from "./ui";

export const dynamic = "force-dynamic";

export default async function NegotiationsPage() {
  const rows = await listNegotiations();

  return (
    <>
      <Hero title="Negotiations">
        Every negotiation the agent has run, newest first. {rows.length} total.
      </Hero>

      {rows.length === 0 ? (
        <Empty>
          No negotiations yet. Run <code>pnpm negotiate:one</code> or{" "}
          <code>pnpm eval:small</code> to generate some.
        </Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Lane</th>
              <th>Equip</th>
              <th>Carrier</th>
              <th>State</th>
              <th className="num">Counters</th>
              <th className="num">Last offer</th>
              <th className="num">Booked</th>
              <th>Started</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id}>
                <td>
                  {n.origin} → {n.destination}
                </td>
                <td>{n.equipment}</td>
                <td>{n.carrierName}</td>
                <td>
                  <StateTag state={n.state} />
                </td>
                <td className="num">{n.counterCount}</td>
                <td className="num">{usd(n.lastOfferTotalCents)}</td>
                <td className="num">{usd(n.bookedTotalCents)}</td>
                <td>{datetime(n.createdAt)}</td>
                <td>
                  <Link href={`/negotiations/${n.id}`}>summary</Link>
                  {" · "}
                  <Link href={`/negotiations/${n.id}/trace`}>trace</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
