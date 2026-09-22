/**
 * Plain data shapes emitted by the generators.
 *
 * These are synthetic-data records, not domain entities or the policy
 * engine's branded Cents type -- db/schema.ts is what these map onto;
 * policy/types.ts is a different vocabulary the agent reasons in. Keeping
 * them separate means the generators cannot quietly become the domain model
 * by accident.
 *
 * Money is plain integer cents (invariant 8, enforced by convention here,
 * not by a branded type). Percentages are integer basis points (9250 =
 * 92.50%), so no float ever has to be compared for equality in a test.
 */

import type { Equipment } from "../api/app/domain/equipment.js";

export interface CarrierRecord {
  readonly carrierId: string;
  readonly name: string;
  readonly mcNumber: string;
  readonly dotNumber: string;
  readonly authorityActive: boolean;
  readonly equipment: readonly Equipment[];
  readonly fleetSize: number;
  readonly onTimeBps: number;
  readonly homeRegion: string;
}

/** One carrier's history on one directional lane. */
export interface CarrierLaneRecord {
  readonly carrierId: string;
  readonly origin: string;
  readonly destination: string;
  readonly equipment: Equipment;
  readonly loadsRun: number;
  readonly lastRateCents: number;
  readonly lastRunDaysAgo: number;
}

export interface LoadRecord {
  readonly loadId: string;
  readonly origin: string;
  readonly destination: string;
  readonly equipment: Equipment;
  readonly weightLbs: number;
  readonly commodity: string;
  readonly pickupAt: Date;
  readonly customerRateCents: number;
  readonly targetMarginBps: number;
  readonly maxCarrierPayCents: number;
  readonly floorCents: number;
}

export interface Dataset {
  readonly carriers: readonly CarrierRecord[];
  readonly lanes: readonly CarrierLaneRecord[];
  readonly loads: readonly LoadRecord[];
}
