/**
 * Invariant 3: business rules live in code, not prompts.
 *
 * The standing practice in PLAN.md is "grep prompt files for digits
 * periodically". This is that grep, as a test, so it cannot be forgotten.
 */

import { describe, expect, it } from "vitest";

import { PROMPT_VERSION, SYSTEM_PROMPT, TOOL_DECLARATIONS, declaredToolNames } from "../../app/agent/prompt.js";
import { TOOL_NAMES } from "../../app/agent/tools.js";

describe("the system prompt carries no business numbers", () => {
  it("contains no digits at all", () => {
    const digits = SYSTEM_PROMPT.match(/\d/g);
    expect(digits, `system prompt contains digits: ${digits?.join("")}`).toBeNull();
  });

  it("mentions no rate, ceiling, floor or limit value", () => {
    for (const forbidden of ["2040", "2,040", "1700", "1,700", "$"]) {
      expect(SYSTEM_PROMPT).not.toContain(forbidden);
    }
  });

  it("tool descriptions carry no amounts either", () => {
    for (const tool of TOOL_DECLARATIONS) {
      expect(tool.description, `${tool.name} description contains a currency amount`)
        .not.toMatch(/\$\s?\d/);
    }
  });

  it("tells the model limits exist without stating them", () => {
    // The prompt's job is framing: that an engine decides, and that its refusals
    // are not arguable. The values themselves live in policy/rules.ts.
    expect(SYSTEM_PROMPT).toMatch(/pricing engine/i);
    expect(SYSTEM_PROMPT).toMatch(/not arguable|not negotiable/i);
  });
});

describe("declarations match implementations", () => {
  it("declares exactly the tools that exist", () => {
    expect([...declaredToolNames()].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("is versioned, so a prompt change is distinguishable from a code change", () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+$/);
  });
});
