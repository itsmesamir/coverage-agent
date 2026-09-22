/**
 * Every query the dashboard runs. Kept in one file so the read surface against
 * the negotiation tables is auditable at a glance.
 */

import "server-only";
import { sql } from "./db";

export interface NegotiationRow {
  id: string;
  state: string;
  counterCount: number;
  lastOfferTotalCents: number | null;
  createdAt: Date;
  loadId: string;
  origin: string;
  destination: string;
  equipment: string;
  carrierId: string;
  carrierName: string;
  bookedTotalCents: number | null;
}

export async function listNegotiations(limit = 100): Promise<NegotiationRow[]> {
  return sql()<NegotiationRow[]>`
    select n.id,
           n.state,
           n.counter_count            as "counterCount",
           n.last_offer_total_cents   as "lastOfferTotalCents",
           n.created_at               as "createdAt",
           l.load_id                  as "loadId",
           l.origin, l.destination, l.equipment,
           c.carrier_id               as "carrierId",
           c.name                     as "carrierName",
           b.total_consideration_cents as "bookedTotalCents"
      from negotiations n
      join loads    l on l.load_id    = n.load_id
      join carriers c on c.carrier_id = n.carrier_id
      left join bookings b on b.negotiation_id = n.id
     order by n.created_at desc
     limit ${limit}`;
}

export interface NegotiationDetail extends NegotiationRow {
  version: number;
  approvedAccessorials: string[];
  lastOfferLinehaulCents: number | null;
  weightLbs: number;
  commodity: string;
  pickupAt: Date;
  customerRateCents: number;
  targetMarginBps: number;
  maxCarrierPayCents: number;
  floorCents: number;
  mcNumber: string;
  authorityActive: boolean;
  onTimeBps: number;
  fleetSize: number;
  bookedLinehaulCents: number | null;
  bookedAccessorials: { code: string; amountCents: number }[] | null;
  bookedAt: Date | null;
}

export async function getNegotiation(id: string): Promise<NegotiationDetail | undefined> {
  const rows = await sql()<NegotiationDetail[]>`
    select n.id,
           n.state,
           n.counter_count              as "counterCount",
           n.last_offer_total_cents     as "lastOfferTotalCents",
           n.last_offer_linehaul_cents  as "lastOfferLinehaulCents",
           n.approved_accessorials      as "approvedAccessorials",
           n.version,
           n.created_at                 as "createdAt",
           l.load_id                    as "loadId",
           l.origin, l.destination, l.equipment, l.commodity,
           l.weight_lbs                 as "weightLbs",
           l.pickup_at                  as "pickupAt",
           l.customer_rate_cents        as "customerRateCents",
           l.target_margin_bps          as "targetMarginBps",
           l.max_carrier_pay_cents      as "maxCarrierPayCents",
           l.floor_cents                as "floorCents",
           c.carrier_id                 as "carrierId",
           c.name                       as "carrierName",
           c.mc_number                  as "mcNumber",
           c.authority_active           as "authorityActive",
           c.on_time_bps                as "onTimeBps",
           c.fleet_size                 as "fleetSize",
           b.linehaul_cents             as "bookedLinehaulCents",
           b.accessorials               as "bookedAccessorials",
           b.total_consideration_cents  as "bookedTotalCents",
           b.booked_at                  as "bookedAt"
      from negotiations n
      join loads    l on l.load_id    = n.load_id
      join carriers c on c.carrier_id = n.carrier_id
      left join bookings b on b.negotiation_id = n.id
     where n.id = ${id}`;
  return rows[0];
}

export interface MessageRow {
  id: string;
  direction: "inbound" | "outbound";
  channel: string;
  body: string;
  renderedFromToolCallId: string | null;
  createdAt: Date;
}

export async function getMessages(negotiationId: string): Promise<MessageRow[]> {
  return sql()<MessageRow[]>`
    select id, direction, channel, body,
           rendered_from_tool_call_id as "renderedFromToolCallId",
           created_at                 as "createdAt"
      from messages
     where negotiation_id = ${negotiationId}
     order by created_at asc`;
}

export interface ToolCallRow {
  id: string;
  requestId: string;
  toolName: string;
  idempotencyKey: string | null;
  arguments: Record<string, unknown>;
  result: unknown;
  policyResult: "accepted" | "rejected" | "not_applicable";
  rejectionCode: string | null;
  rejectionReason: string | null;
  latencyMs: number;
  createdAt: Date;
}

export async function getToolCalls(negotiationId: string): Promise<ToolCallRow[]> {
  return sql()<ToolCallRow[]>`
    select id, request_id as "requestId", tool_name as "toolName",
           idempotency_key as "idempotencyKey",
           arguments, result,
           policy_result    as "policyResult",
           rejection_code   as "rejectionCode",
           rejection_reason as "rejectionReason",
           latency_ms       as "latencyMs",
           created_at       as "createdAt"
      from tool_calls
     where negotiation_id = ${negotiationId}
     order by created_at asc`;
}

export interface LlmCallRow {
  id: string;
  requestId: string;
  role: string;
  provider: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  ttftMs: number | null;
  createdAt: Date;
}

export async function getLlmCalls(negotiationId: string): Promise<LlmCallRow[]> {
  return sql()<LlmCallRow[]>`
    select id, request_id as "requestId", role, provider, model,
           prompt_version as "promptVersion",
           input_tokens   as "inputTokens",
           output_tokens  as "outputTokens",
           latency_ms     as "latencyMs",
           ttft_ms        as "ttftMs",
           created_at     as "createdAt"
      from llm_calls
     where negotiation_id = ${negotiationId}
     order by created_at asc`;
}

export interface EvalRunRow {
  id: string;
  gitSha: string;
  suite: string;
  provider: string;
  model: string;
  promptVersion: string;
  metrics: Record<string, unknown> | null;
  startedAt: Date;
  finishedAt: Date | null;
  caseCount: number;
  passedCount: number;
}

export async function listEvalRuns(limit = 50): Promise<EvalRunRow[]> {
  return sql()<EvalRunRow[]>`
    select r.id,
           r.git_sha        as "gitSha",
           r.suite, r.provider, r.model,
           r.prompt_version as "promptVersion",
           r.metrics,
           r.started_at     as "startedAt",
           r.finished_at    as "finishedAt",
           count(er.id)::int                              as "caseCount",
           count(er.id) filter (where er.passed)::int     as "passedCount"
      from eval_runs r
      left join eval_results er on er.run_id = r.id
     group by r.id
     order by r.started_at desc
     limit ${limit}`;
}

export interface EvalResultRow {
  id: string;
  caseId: string;
  caseName: string;
  persona: string;
  passed: boolean;
  metrics: Record<string, unknown>;
  negotiationId: string | null;
}

export async function getEvalRun(
  id: string,
): Promise<{ run: EvalRunRow | undefined; results: EvalResultRow[] }> {
  const [runs, results] = await Promise.all([
    sql()<EvalRunRow[]>`
      select r.id,
             r.git_sha        as "gitSha",
             r.suite, r.provider, r.model,
             r.prompt_version as "promptVersion",
             r.metrics,
             r.started_at     as "startedAt",
             r.finished_at    as "finishedAt",
             count(er.id)::int                          as "caseCount",
             count(er.id) filter (where er.passed)::int as "passedCount"
        from eval_runs r
        left join eval_results er on er.run_id = r.id
       where r.id = ${id}
       group by r.id`,
    sql()<EvalResultRow[]>`
      select er.id, er.case_id as "caseId", er.passed, er.metrics,
             er.negotiation_id as "negotiationId",
             c.name as "caseName", c.persona
        from eval_results er
        join eval_cases c on c.case_id = er.case_id
       where er.run_id = ${id}
       order by er.case_id asc`,
  ]);
  return { run: runs[0], results };
}
