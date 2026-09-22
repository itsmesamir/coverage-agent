import { describe, expect, it } from "vitest";

import { precisionAtK, rankCorrelation, recallAtK } from "../../../evals/metrics/retrieval.js";

describe("recallAtK", () => {
  it("is the fraction of relevant items that were retrieved", () => {
    expect(recallAtK(["a", "b", "x", "y"], ["a", "b", "c", "d"])).toBe(0.5);
  });
  it("is 1 when everything relevant was found", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "b"])).toBe(1);
  });
  it("is 0 when nothing relevant was found", () => {
    expect(recallAtK(["x"], ["a", "b"])).toBe(0);
  });
  it("treats an empty relevant set as trivially satisfied", () => {
    expect(recallAtK([], [])).toBe(1);
  });
});

describe("precisionAtK", () => {
  it("counts overlap with the ideal top k", () => {
    expect(precisionAtK(["a", "b", "x"], ["a", "b", "c"], 3)).toBeCloseTo(2 / 3, 10);
  });
  it("ignores order within the top k", () => {
    expect(precisionAtK(["b", "a"], ["a", "b"], 2)).toBe(1);
  });
  it("penalises a short result list", () => {
    expect(precisionAtK(["a"], ["a", "b"], 2)).toBe(0.5);
  });
});

describe("rankCorrelation", () => {
  it("is 1 for identical ordering", () => {
    expect(rankCorrelation(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
  });
  it("is -1 for exactly reversed ordering", () => {
    expect(rankCorrelation(["c", "b", "a"], ["a", "b", "c"])).toBe(-1);
  });
  it("ignores items absent from the ideal list", () => {
    expect(rankCorrelation(["a", "zzz", "b"], ["a", "b"])).toBe(1);
  });
});
