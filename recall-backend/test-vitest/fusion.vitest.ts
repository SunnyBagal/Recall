import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../services/searchService";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (r: Array<{ id: string }>) => r.map((x) => x.id);

describe("reciprocalRankFusion", () => {
  it("returns an empty list when both arms are empty", () => {
    expect(reciprocalRankFusion([], [])).toEqual([]);
  });

  it("preserves arm order when only one arm has results", () => {
    expect(ids(reciprocalRankFusion(rows("a", "b", "c"), []))).toEqual(["a", "b", "c"]);
    expect(ids(reciprocalRankFusion([], rows("c", "b", "a")))).toEqual(["c", "b", "a"]);
  });

  it("ranks a document found by both arms above one found by a single arm", () => {
    // b: 1/61 + 1/61 beats a: 1/60 and c: 1/60
    expect(ids(reciprocalRankFusion(rows("a", "b"), rows("c", "b")))[0]).toBe("b");
  });

  it("a low rank in both arms can beat rank 1 in one arm", () => {
    const vector = rows("top-v", "x", "y", "z", "both");
    const keyword = rows("top-k", "p", "q", "r", "both");
    // both: 2/64 = 0.03125 beats top-v: 1/60 = 0.01667
    expect(ids(reciprocalRankFusion(vector, keyword))[0]).toBe("both");
  });

  it("breaks exact ties by insertion order, vector arm first", () => {
    expect(ids(reciprocalRankFusion(rows("v"), rows("k")))).toEqual(["v", "k"]);
  });

  it("uses 0-based ranks: the top row scores 1/k, not the textbook 1/(k+1)", () => {
    // k=1 makes the difference visible. With 0-based ranks: a = 1/1 = 1.0 and
    // b = 1/2 + 1/2 = 1.0, a tie that insertion order gives to `a`. With 1-based
    // ranks: a = 1/2 and b = 1/3 + 1/3 = 2/3, which would put b first.
    const result = reciprocalRankFusion(rows("a", "b"), rows("x", "b"), 10, 1);
    expect(ids(result)[0]).toBe("a");
  });

  it("cuts the merged list to the limit, default 10", () => {
    const vector = rows(...Array.from({ length: 10 }, (_, i) => `v${i}`));
    const keyword = rows(...Array.from({ length: 10 }, (_, i) => `k${i}`));
    expect(reciprocalRankFusion(vector, keyword)).toHaveLength(10);
    expect(reciprocalRankFusion(vector, keyword, 3)).toHaveLength(3);
  });

  it("interleaves disjoint arms, so a full keyword arm evicts half the vector arm", () => {
    const vector = rows(...Array.from({ length: 10 }, (_, i) => `v${i}`));
    const keyword = rows(...Array.from({ length: 10 }, (_, i) => `k${i}`));
    expect(ids(reciprocalRankFusion(vector, keyword))).toEqual([
      "v0", "k0", "v1", "k1", "v2", "k2", "v3", "k3", "v4", "k4",
    ]);
  });

  it("keeps the vector arm's copy of a shared row, including similarity", () => {
    const vector = [{ id: "a", similarity: 0.9 }];
    const keyword = [{ id: "a" }];
    expect(reciprocalRankFusion<Record<string, any>>(vector, keyword)[0]!.similarity).toBe(0.9);
  });

  it("does not deduplicate a repeated id within an arm: it scores twice", () => {
    expect(ids(reciprocalRankFusion(rows("x", "a", "a"), []))).toEqual(["a", "x"]);
  });
});
