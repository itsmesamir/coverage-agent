/**
 * The text that gets embedded for a carrier.
 *
 * Pure: a carrier plus its lane history in, one string out. Kept separate from
 * embed.ts so it can be unit tested without loading 130MB of model weights, and
 * stored in `carriers.profile_text` so an embedding can be audited or
 * regenerated without reconstructing how it was built.
 *
 * What goes in it is a retrieval decision, not a formatting one. The embedding
 * is asked "which carriers look like a fit for this lane and equipment?", so
 * the profile carries lanes, regions and equipment in natural language.
 *
 * Raw numbers stay out -- embeddings compare poorly on digits, and rates and
 * percentages are handled arithmetically in the reranker. But service quality
 * goes in as a QUALITATIVE BAND, and that distinction was learned by measuring:
 * with reliability omitted entirely, most of the reranker's ideal top ten were
 * carriers with no history on the lane that win on on-time alone, and the
 * first stage had no way to see them. Stage one and stage two were optimising
 * different things, which caps recall structurally. "highly reliable" embeds
 * fine where "96.7%" does not.
 */

import type { Equipment } from "../domain/equipment.js";

export interface ProfileCarrier {
  readonly carrierId: string;
  readonly name: string;
  readonly equipment: readonly Equipment[];
  readonly homeRegion: string;
  readonly fleetSize: number;
  readonly onTimeBps: number;
}

/** Qualitative bands, not digits. The embedding can rank words; it cannot rank numbers. */
export function reliabilityBand(onTimeBps: number): string {
  if (onTimeBps >= 9500) return "highly reliable on-time service";
  if (onTimeBps >= 9000) return "reliable on-time service";
  if (onTimeBps >= 8500) return "mixed service record";
  return "inconsistent service record";
}

export interface ProfileLane {
  readonly origin: string;
  readonly destination: string;
  readonly loadsRun: number;
}

const EQUIPMENT_PHRASE: Record<Equipment, string> = {
  dry_van: "dry van",
  reefer: "refrigerated reefer",
  flatbed: "flatbed open deck",
  specialized: "specialized oversize",
};

/** Lanes named most often first, so the busiest ones dominate a truncated tail. */
export function buildProfileText(
  carrier: ProfileCarrier,
  lanes: readonly ProfileLane[],
  maxLanes = 8,
): string {
  const equipment = carrier.equipment.map((e) => EQUIPMENT_PHRASE[e]).join(" and ");

  const ranked = [...lanes]
    .sort((a, b) => b.loadsRun - a.loadsRun || laneKey(a).localeCompare(laneKey(b)))
    .slice(0, maxLanes);

  // No digit here either, for the same reason reliability is a band: an
  // embedding gains nothing from the exact truck count and the qualitative
  // tier is the part that could plausibly matter for a semantic match.
  const fleet =
    carrier.fleetSize === 1
      ? "owner operator, single truck"
      : carrier.fleetSize < 20
        ? "small fleet"
        : "large fleet";

  const laneText =
    ranked.length === 0
      ? "no recorded lane history"
      : `runs ${ranked.map((l) => `${l.origin} to ${l.destination}`).join("; ")}`;

  return [
    `${carrier.name}, a ${fleet} based in the ${carrier.homeRegion} region.`,
    `Operates ${equipment} equipment.`,
    `${capitalize(reliabilityBand(carrier.onTimeBps))}.`,
    `${capitalize(laneText)}.`,
  ].join(" ");
}

/** The query side of the same vector space: describe the load like a profile. */
export function buildLoadQueryText(load: {
  readonly origin: string;
  readonly destination: string;
  readonly equipment: Equipment;
}): string {
  return (
    `Carrier operating ${EQUIPMENT_PHRASE[load.equipment]} equipment ` +
    `running ${load.origin} to ${load.destination}.`
  );
}

function laneKey(lane: ProfileLane): string {
  return `${lane.origin}>${lane.destination}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
