import { describe, expect, it } from "vitest";

import { buildLoadQueryText, buildProfileText, reliabilityBand } from "../../app/retrieval/profile.js";

const CARRIER = {
  carrierId: "C-1000",
  name: "Ironwood Logistics 42",
  equipment: ["dry_van"] as const,
  homeRegion: "midwest",
  fleetSize: 6,
  onTimeBps: 9300,
};

describe("reliabilityBand", () => {
  it("maps on-time into qualitative bands, never digits", () => {
    expect(reliabilityBand(9700)).toBe("highly reliable on-time service");
    expect(reliabilityBand(9300)).toBe("reliable on-time service");
    expect(reliabilityBand(8700)).toBe("mixed service record");
    expect(reliabilityBand(7000)).toBe("inconsistent service record");
  });

  it("emits no numerals, because embeddings rank words and not digits", () => {
    for (const bps of [7000, 8600, 9200, 9900]) {
      expect(reliabilityBand(bps)).not.toMatch(/\d/);
    }
  });
});

describe("buildProfileText", () => {
  it("is a pure function of its inputs", () => {
    const lanes = [{ origin: "Chicago, IL", destination: "Dallas, TX", loadsRun: 5 }];
    expect(buildProfileText(CARRIER, lanes)).toBe(buildProfileText(CARRIER, lanes));
  });

  it("orders lanes by depth so the busiest survive truncation", () => {
    const text = buildProfileText(
      CARRIER,
      [
        { origin: "A", destination: "B", loadsRun: 1 },
        { origin: "C", destination: "D", loadsRun: 40 },
      ],
      1,
    );
    expect(text).toContain("C to D");
    expect(text).not.toContain("A to B");
  });

  it("breaks equal-depth ties deterministically", () => {
    const lanes = [
      { origin: "Z", destination: "Y", loadsRun: 3 },
      { origin: "A", destination: "B", loadsRun: 3 },
    ];
    expect(buildProfileText(CARRIER, lanes, 1)).toBe(
      buildProfileText(CARRIER, [...lanes].reverse(), 1),
    );
  });

  it("handles a carrier with no lane history", () => {
    expect(buildProfileText(CARRIER, [])).toMatch(/no recorded lane history/i);
  });

  it("describes an owner operator differently from a fleet", () => {
    expect(buildProfileText({ ...CARRIER, fleetSize: 1 }, [])).toContain("owner operator");
    expect(buildProfileText({ ...CARRIER, fleetSize: 60 }, [])).toContain("large fleet");
  });

  it("carries no digits at all outside the carrier's own name", () => {
    // Fleet size once leaked in as a raw number ("fleet of 60 trucks"),
    // contradicting the file's own stated reason for using bands: an
    // embedding gains nothing from an exact count. Synthetic carrier names
    // legitimately end in a number (an identifier, not a metric), so this
    // strips the name before checking.
    const text = buildProfileText(
      { ...CARRIER, name: "Ironwood Logistics", fleetSize: 60 },
      [{ origin: "Chicago, IL", destination: "Dallas, TX", loadsRun: 9 }],
    );
    expect(text).not.toMatch(/\d/);
  });
});

describe("buildLoadQueryText", () => {
  it("describes the load in the same vocabulary the profiles use", () => {
    const q = buildLoadQueryText({ origin: "Chicago, IL", destination: "Dallas, TX", equipment: "dry_van" });
    expect(q).toContain("dry van");
    expect(q).toContain("Chicago, IL to Dallas, TX");
  });
});
