# Coverage Agent

A freight-brokerage load-coverage negotiation agent. Given a load that needs a
carrier: retrieve candidates, rank them, negotiate a rate over email, book, or
escalate. Never agree to a rate that breaks margin.

This is a **portfolio prototype**, built to be defended in a technical
interview. Everything in it is real code with real tests, but nothing in it
talks to a real carrier, a real TMS, or real email — see [What's mocked](#whats-mocked)
before assuming otherwise.

## The thesis

> The LLM proposes. Deterministic systems decide. Evaluation proves it works.

```
LLM ──structured tool call──> Policy Engine ──reject──> re-plan
                                   │
                                 accept
                                   ▼
                            Validated State
                                   ▼
                           Message Renderer ──> Email
```

The model never states a price to a carrier. It calls `propose_rate(linehaul_cents)`.
A pure, unit-tested policy engine — no I/O, no network, no clock — accepts or
rejects that number against the load's floor and ceiling. Only an **accepted**
decision's amount is ever rendered into an outbound message, from a template.
The model's own confidence in a number is irrelevant to whether it ships.

A real trace from this repo, because the point is easier to see than to argue:

> The agent reasoned *"Increasing offer to meet carrier counter partially
> while staying within pricing engine thresholds"* and called `propose_rate`
> for **$2,184.06**. The load's ceiling is **$2,040.00**. The engine rejected
> it — `above_max_carrier_pay` — before it ever became an email. The agent
> re-planned, offered exactly $2,040.00, and escalated to a human when the
> carrier wouldn't take it.

Nobody told the model "don't exceed $2,040" in that turn. It didn't need to be
told, because the rule isn't reachable from the prompt in the first place.

## What's built (P0–P11)

| Layer | What it does |
|---|---|
| **Domain / Policy / State** | Pure functions: equipment matching, rate rules, the negotiation state machine. No I/O. Fully unit tested, and a `dependency-cruiser` check fails the build if that ever stops being true. |
| **Retrieval** | Local embeddings (`transformers.js`, `bge-small-en-v1.5`, no API), pgvector ANN over candidate carriers, deterministic rerank. |
| **Agent loop** | Gemini calls one of 7 tools; every mutating call is validated by policy, at call time and again at write time, because state can change mid-negotiation. |
| **Rendering** | Outbound emails are templates filled from a validated decision's fields. There is deliberately no free-text send tool. |
| **Tracing** | Every LLM call and tool call is persisted raw — arguments, result, policy outcome, rejection reason, latency, tokens. Evals re-score stored traces for free. |
| **Eval harness** | 9 carrier personas, simulated over email, scored on policy violations, tool-call correctness, and a grounded hallucination check. A regression gate fails the build on drift. |
| **Dashboard** (`web/`) | Three read-only views over the same tables the agent writes to — see below. |

Not built: authentication, a carrier-facing portal, real telephony/TMS
integration, voice, anything beyond the 7 tools. Not asked for; not needed to
make the argument above.

## The numbers, as of the last recorded baseline

```
$ pnpm eval:check
policy violations:    0
decisions checked:    23
mean tool-call score: 1.0000 over 16 traces
hallucination rate:   0.0000 (185 settleable, 1 ambiguous)
PASS
```

464 tests passing. CI runs the eval gate on every push with **no API key** —
it replays a committed fixture of stored traces, so scoring costs nothing and
the gate can't be skipped for lack of a secret.

| Metric | Target (CLAUDE.md) | Current |
|---|---|---|
| Policy violation rate | 0, by construction | **0** |
| Tool-call correctness | > 0.95 | **1.0000** |
| Hallucination rate | < 2% | **0.0000** |
| Regression gate | fails on drift | 3/3 injected regressions caught (`pnpm eval:prove-gate`) |

**Read the hallucination number carefully.** It is not yet strong evidence of
agent truthfulness. The scored corpus renders from 12 near-identical message
templates, so a rate of 0.0000 mostly confirms a narrower, already-guaranteed
fact: the renderer cannot inject a number no tool call approved. It does not
yet show the agent is truthful under varied phrasing, because the phrasing
barely varies. The claim-extraction checker itself hasn't been validated
against hand labels yet — that's the very next thing on this repo's list (see
[What's next](#whats-next)).

## Quickstart

```bash
cp .env.example .env          # DATABASE_URL, GEMINI_API_KEY, GROQ_API_KEY
make up                       # postgres (pgvector) + redis, docker compose
pnpm install
pnpm db:migrate
pnpm seed                     # 200 synthetic carriers, one fixed reference load
pnpm embed                    # local embeddings for retrieval, no API call

pnpm test                     # 464 tests, no external services
pnpm eval:check               # the regression gate, replays stored traces, free

pnpm web                      # dashboard at localhost:3000
```

Everything above runs with zero LLM calls. The commands below spend a small
amount of free-tier Gemini/Groq quota:

```bash
pnpm negotiate                 # one negotiation end to end, ~8 LLM calls
pnpm persona hard_bargainer     # one negotiation against a named persona
pnpm eval:small                 # 5-case suite, ~3 minutes
```

Node 22+ (`engines` in `package.json`); the repo currently develops against
Node 23. See `.nvmrc` for the version CI pins.

## The dashboard

Three views, all reading the same Postgres tables the agent and evals write
to, none of them able to write back — `web/lib/queries.ts` is `select`-only
and imports nothing from `api/app`.

- **`/`** — every negotiation, newest first, with its outcome.
- **`/negotiations/<id>`** — the customer view: load, carrier, settled rate
  against the floor/ceiling band, realised margin, counters used, policy
  checks passed and rejected, full transcript. Every outbound message shows
  the approved tool call it was rendered from — invariant 2, made visible
  instead of only asserted by a test.
- **`/negotiations/<id>/trace`** — the engineer view: every LLM and tool call
  as a per-turn span, with latency, token counts, and the policy outcome —
  rejections shown inline with their code and reason, because in this system
  a rejection is the interesting event, not an error to hide.
- **`/evals`** and **`/evals/<id>`** — the product view: runs, their metrics,
  and per-case results linking back to the trace each case produced.

## The reference load

The number everything above is checked against:

```
Chicago, IL → Dallas, TX, dry van, 42,000 lbs
Customer pays:     $2,400.00
Target margin:     15%
Max carrier pay:   $2,040.00   ← the ceiling propose_rate is checked against
Floor:             $1,700.00
Max counters:      3, monotonic, never resets
```

## Personas

The carrier on the other end of every negotiation is a second LLM playing one
of 9 scripted personas: accepts immediately, hard bargainer, reasonable,
accessorial creep, off-topic, ambiguous reply, prompt injection, authority
lapses mid-negotiation, no deal. `pnpm persona <id>` runs one directly.

## What's mocked

Stated plainly, per this repo's own honesty rule:

- **Carriers, lanes, and history are synthetic** — generated with a fixed
  random seed, not real freight data.
- **Email is a mock transport.** No message leaves the process.
- **The "carrier" replying is an LLM**, not a person, following a scripted
  persona and possibly ad-libbing within it.
- **There is no TMS, no telephony, no real booking system** behind
  `book_carrier` — it writes a row.

None of that weakens the thesis being demonstrated — the policy/render
boundary works the same whether the counterparty is a script or a real
inbox — but it does mean the eval numbers describe a closed simulation, not
production traffic.

## What's next

In priority order, honestly:

1. **Hand-label the hallucination checker.** `evals/claims-to-label.json` has
   12 scored outbound messages waiting for ground-truth labels on their
   extracted claims; `pnpm eval:evaluator` scores the checker itself against
   them. Until this is done, "0.0000 hallucination rate" is a claim about the
   renderer, not about the checker's accuracy.
2. **P12 — failure injection.** LLM timeout, malformed tool call, duplicate
   webhook delivery, Redis unavailable, stale negotiation state, carrier
   authority changing mid-negotiation, booking retry after a lost response.
   The last one is flagged in the project plan as the case most likely to
   come up in a system-design interview.
3. **P13 — security review**, written up honestly in `docs/SECURITY.md`:
   prompt injection, tool authorization, secrets handling, replay attacks,
   duplicate bookings, untrusted carrier content, sensitive data in logs.
4. **More message diversity in the corpus** — the 12-template limitation
   above is the main thing standing between the current hallucination number
   and a claim worth defending under questioning.

## Design decisions and why

Every non-obvious call — and every time I overrode a suggestion — is logged
in [`docs/DECISIONS.md`](docs/DECISIONS.md) with what was proposed, what was
chosen, and why. `docs/PLAN.md` has the full phase-by-phase build plan this
repo followed.
