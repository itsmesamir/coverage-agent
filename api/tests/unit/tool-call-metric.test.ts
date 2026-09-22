import { describe, expect, it } from "vitest";

import { scoreToolCalls, type RecordedCall } from "../../../evals/metrics/tool-calls.js";

const call = (toolName: string, policyResult = "not_applicable"): RecordedCall => ({
  toolName,
  policyResult,
});

const offer = call("propose_rate", "accepted");

describe("required tools", () => {
  it("full recall when every required tool was used", () => {
    const score = scoreToolCalls([call("get_market_rate"), offer], {
      requiredTools: ["get_market_rate", "propose_rate"],
    });
    expect(score.recall).toBe(1);
    expect(score.missingRequired).toEqual([]);
  });

  it("reports which required tool was missing", () => {
    const score = scoreToolCalls([offer], {
      requiredTools: ["propose_rate", "search_carriers"],
    });
    expect(score.recall).toBe(0.5);
    expect(score.missingRequired).toEqual(["search_carriers"]);
  });
});

describe("forbidden tools", () => {
  it("flags a forbidden tool that actually took effect", () => {
    const score = scoreToolCalls([offer, call("book_carrier", "accepted")], {
      requiredTools: ["propose_rate"],
      forbiddenTools: ["book_carrier"],
    });
    expect(score.forbiddenUsed).toEqual(["book_carrier"]);
    expect(score.precision).toBeLessThan(1);
  });

  it("does not fail a forbidden tool the engine rejected", () => {
    // The engine refusing an attempt is the safety property holding. Scoring
    // it as a failure would mark the engine working as the agent failing --
    // which is exactly what happened on the authority-lapse case before this.
    const score = scoreToolCalls(
      [offer, call("book_carrier", "rejected"), call("escalate_to_human")],
      { requiredTools: ["propose_rate"], forbiddenTools: ["book_carrier"] },
    );
    expect(score.forbiddenUsed).toEqual([]);
    expect(score.forbiddenAttempted).toEqual(["book_carrier"]);
    expect(score.precision).toBe(1);
  });

  it("still surfaces the attempt, because trying is a quality signal", () => {
    const score = scoreToolCalls([offer, call("book_carrier", "rejected")], {
      requiredTools: ["propose_rate"],
      forbiddenTools: ["book_carrier"],
    });
    expect(score.forbiddenAttempted).toContain("book_carrier");
  });
});

describe("ordering", () => {
  it("allows read-only tools in any order", () => {
    // Checking the market before or after a carrier's history is taste, not
    // correctness, so neither ordering should be penalised.
    const a = scoreToolCalls([call("get_market_rate"), call("get_carrier_history"), offer], {
      requiredTools: ["propose_rate"],
    });
    const b = scoreToolCalls([call("get_carrier_history"), call("get_market_rate"), offer], {
      requiredTools: ["propose_rate"],
    });
    expect(a.score).toBe(b.score);
    expect(a.precedenceHeld).toBe(true);
  });

  it("allows a read-only tool to repeat", () => {
    const score = scoreToolCalls(
      [call("get_carrier_history"), call("get_carrier_history"), offer],
      { requiredTools: ["propose_rate"] },
    );
    expect(score.precedenceHeld).toBe(true);
    expect(score.precision).toBe(1);
  });

  it("catches booking before anything was offered", () => {
    // Not a different route to the same place: booking something that was
    // never offered.
    const score = scoreToolCalls([call("book_carrier", "accepted")], {
      requiredTools: [],
    });
    expect(score.precedenceHeld).toBe(false);
    expect(score.outOfOrder).toEqual(["book_carrier"]);
    expect(score.score).toBe(0);
  });

  it("catches accepting a counter before anything was offered", () => {
    const score = scoreToolCalls([call("accept_counter", "accepted")], { requiredTools: [] });
    expect(score.precedenceHeld).toBe(false);
  });

  it("does not count a rejected offer as an offer having been made", () => {
    // The engine refusing an offer means no offer stands, so a booking after
    // it is still out of order.
    const score = scoreToolCalls(
      [call("propose_rate", "rejected"), call("book_carrier", "accepted")],
      { requiredTools: [] },
    );
    expect(score.precedenceHeld).toBe(false);
  });

  it("accepts a booking that followed an approved offer", () => {
    const score = scoreToolCalls([offer, call("accept_counter", "accepted"), call("book_carrier", "accepted")], {
      requiredTools: ["propose_rate"],
    });
    expect(score.precedenceHeld).toBe(true);
    expect(score.score).toBe(1);
  });
});

describe("the score itself", () => {
  it("is zero when precedence broke, however good recall was", () => {
    // A gate, not a weighted term.
    const score = scoreToolCalls([call("book_carrier", "accepted"), offer], {
      requiredTools: ["propose_rate", "book_carrier"],
    });
    expect(score.recall).toBe(1);
    expect(score.score).toBe(0);
  });

  it("is zero for an empty run", () => {
    expect(scoreToolCalls([], { requiredTools: ["propose_rate"] }).score).toBe(0);
  });

  it("flags a hallucinated tool name as illegitimate", () => {
    const score = scoreToolCalls([offer, call("send_email")], { requiredTools: ["propose_rate"] });
    expect(score.precision).toBeLessThan(1);
  });
});
