import { describe, expect, it } from "vitest";
import { mrrAt, ndcgAt, percentile, recallAt } from "../eval/metrics";

const rel = (...ids: string[]) => new Map(ids.map((id) => [id, 1]));

describe("eval metrics (values worked out by hand)", () => {
  it("nDCG is 1 for an ideal ranking and 0 when nothing relevant is retrieved", () => {
    expect(ndcgAt(["a", "b", "x"], rel("a", "b"), 10)).toBeCloseTo(1, 10);
    expect(ndcgAt(["x", "y"], rel("a"), 10)).toBe(0);
    expect(ndcgAt([], rel("a"), 10)).toBe(0);
  });

  it("nDCG discounts by log2(rank + 1)", () => {
    // one relevant doc at rank 3: (1/log2(4)) / (1/log2(2)) = 0.5
    expect(ndcgAt(["x", "y", "a"], rel("a"), 10)).toBeCloseTo(0.5, 10);
    // two relevant, at ranks 1 and 3: (1 + 0.5) / (1 + 1/log2(3))
    expect(ndcgAt(["a", "x", "b"], rel("a", "b"), 10)).toBeCloseTo(1.5 / (1 + 1 / Math.log2(3)), 10);
  });

  it("nDCG ignores results past k, and its ideal is capped at k", () => {
    expect(ndcgAt(["x", "a"], rel("a"), 1)).toBe(0);
    expect(ndcgAt(["a"], rel("a", "b", "c"), 1)).toBeCloseTo(1, 10);
  });

  it("recall is the fraction of relevant docs found within k", () => {
    expect(recallAt(["a", "x"], rel("a", "b"), 10)).toBe(0.5);
    expect(recallAt(["x", "a"], rel("a"), 1)).toBe(0);
    expect(recallAt([], rel("a"), 10)).toBe(0);
  });

  it("MRR is the reciprocal rank of the first relevant doc within k", () => {
    expect(mrrAt(["x", "a", "b"], rel("a", "b"), 10)).toBe(0.5);
    expect(mrrAt(["x", "a"], rel("a"), 1)).toBe(0);
    expect(mrrAt([], rel("a"), 10)).toBe(0);
  });

  it("percentile uses nearest rank", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([3, 1, 2], 50)).toBe(2);
  });
});
