import { describe, expect, it } from "vitest";
import {
  CAPACITY_LBS,
  EQUIPMENT_TYPES,
  isTypePermitted,
  isWithinCapacity,
  matchQuality,
} from "../../app/domain/equipment.js";

describe("equipment compatibility", () => {
  it("exact match scores highest", () => {
    for (const e of EQUIPMENT_TYPES) {
      expect(matchQuality(e, e)).toBe("exact");
    }
  });

  it("a reefer on dry freight is wasteful but legal", () => {
    expect(matchQuality("dry_van", "reefer")).toBe("substitute");
    expect(isTypePermitted("dry_van", "reefer")).toBe(true);
  });

  it("a dry van on temperature-controlled freight is blocked", () => {
    expect(matchQuality("reefer", "dry_van")).toBe("blocked");
    expect(isTypePermitted("reefer", "dry_van")).toBe(false);
  });

  it("a flatbed on enclosed freight is blocked", () => {
    expect(isTypePermitted("dry_van", "flatbed")).toBe(false);
    expect(isTypePermitted("reefer", "flatbed")).toBe(false);
  });

  it("capacity is independent of type compatibility", () => {
    // A reefer may haul dry freight (type: permitted) and still be refused
    // for weight (capacity: exceeded). One rule passing tells you nothing
    // about the other, which is why they are separate named functions.
    const weight = 44_000;
    expect(isTypePermitted("dry_van", "reefer")).toBe(true);
    expect(isWithinCapacity("reefer", weight)).toBe(false);
    expect(isWithinCapacity("dry_van", weight)).toBe(true);
  });

  it("the reference load weight fits a dry van", () => {
    expect(isWithinCapacity("dry_van", 42_000)).toBe(true);
  });

  it("every equipment type has a capacity", () => {
    expect(Object.keys(CAPACITY_LBS).sort()).toEqual([...EQUIPMENT_TYPES].sort());
  });
});
