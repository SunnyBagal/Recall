import { describe, expect, it } from "vitest";
import { FTS_WEIGHT, RRF_K, VECTOR_WEIGHT, reciprocalRankFusion } from "../services/searchService";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (r: Array<{ id: string }>) => r.map((x) => x.id);
// The textbook setup, for the tests about how RRF itself behaves.
const EQUAL = { vectorWeight: 1, ftsWeight: 1, k: 60 };

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
    expect(ids(reciprocalRankFusion(rows("a", "b"), rows("c", "b"), EQUAL))[0]).toBe("b");
  });

  it("a low rank in both arms can beat rank 1 in one arm", () => {
    const vector = rows("top-v", "x", "y", "z", "both");
    const keyword = rows("top-k", "p", "q", "r", "both");
    // both: 2/64 = 0.03125 beats top-v: 1/60 = 0.01667
    expect(ids(reciprocalRankFusion(vector, keyword, EQUAL))[0]).toBe("both");
  });

  it("breaks exact ties by insertion order, vector arm first", () => {
    expect(ids(reciprocalRankFusion(rows("v"), rows("k")))).toEqual(["v", "k"]);
  });

  it("uses 0-based ranks: the top row scores 1/k, not the textbook 1/(k+1)", () => {
    // k=1 makes the difference visible. With 0-based ranks: a = 1/1 = 1.0 and
    // b = 1/2 + 1/2 = 1.0, a tie that insertion order gives to `a`. With 1-based
    // ranks: a = 1/2 and b = 1/3 + 1/3 = 2/3, which would put b first.
    const result = reciprocalRankFusion(rows("a", "b"), rows("x", "b"), { ...EQUAL, k: 1 });
    expect(ids(result)[0]).toBe("a");
  });

  it("cuts the merged list to the limit, default 10", () => {
    const vector = rows(...Array.from({ length: 10 }, (_, i) => `v${i}`));
    const keyword = rows(...Array.from({ length: 10 }, (_, i) => `k${i}`));
    expect(reciprocalRankFusion(vector, keyword)).toHaveLength(10);
    expect(reciprocalRankFusion(vector, keyword, { limit: 3 })).toHaveLength(3);
  });

  it("interleaves disjoint arms, so a full keyword arm evicts half the vector arm", () => {
    const vector = rows(...Array.from({ length: 10 }, (_, i) => `v${i}`));
    const keyword = rows(...Array.from({ length: 10 }, (_, i) => `k${i}`));
    expect(ids(reciprocalRankFusion(vector, keyword, EQUAL))).toEqual([
      "v0", "k0", "v1", "k1", "v2", "k2", "v3", "k3", "v4", "k4",
    ]);
  });

  it("keeps the vector arm's copy of a shared row, including similarity", () => {
    const vector = [{ id: "a", similarity: 0.9 }];
    const keyword = [{ id: "a" }];
    expect(reciprocalRankFusion<Record<string, any>>(vector, keyword)[0]!.similarity).toBe(0.9);
  });

  describe("weights and k", () => {
    const weights = (vectorWeight: number, ftsWeight: number, k = 60) => ({ vectorWeight, ftsWeight, k });

    it("defaults come from the exported constants", () => {
      const a = reciprocalRankFusion(rows("a", "b"), rows("c", "b"));
      const b = reciprocalRankFusion(rows("a", "b"), rows("c", "b"), weights(VECTOR_WEIGHT, FTS_WEIGHT, RRF_K));
      expect(ids(a)).toEqual(ids(b));
    });

    it("the tuned defaults let a row in both arms climb, without letting FTS take over", () => {
      // v0: 1/3 = 0.333; both: 1/5 + 0.3/3 = 0.3; v1: 1/4 = 0.25.
      expect(ids(reciprocalRankFusion(rows("v0", "v1", "both"), rows("both")))).toEqual(["v0", "both", "v1"]);
      // An FTS-only top row scores 0.3/3 = 0.1, above the last vector rows (v9: 1/12).
      const vector = rows(...Array.from({ length: 10 }, (_, i) => `v${i}`));
      expect(ids(reciprocalRankFusion(vector, rows("f")))).toContain("f");
    });

    it("a heavier FTS weight puts the FTS top row first", () => {
      expect(ids(reciprocalRankFusion(rows("v"), rows("f"), weights(1, 2)))).toEqual(["f", "v"]);
    });

    it("a lighter FTS weight keeps a row out of the top until its weighted score earns it", () => {
      const vector = rows("v0", "v1", "v2");
      // f: 0.5/60 = 0.00833; v2: 1/62 = 0.01613
      expect(ids(reciprocalRankFusion(vector, rows("f"), weights(1, 0.5)))).toEqual(["v0", "v1", "v2", "f"]);
    });

    it("a light FTS weight can still promote a row that both arms found", () => {
      const vector = rows("v0", "v1", "both");
      // both: 1/62 + 0.5/60 = 0.02446 beats v0: 1/60 = 0.01667
      expect(ids(reciprocalRankFusion(vector, rows("both"), weights(1, 0.5)))[0]).toBe("both");
    });

    it("a zero FTS weight never reorders the vector arm", () => {
      const vector = rows("a", "b", "c");
      expect(ids(reciprocalRankFusion(vector, rows("c", "b"), weights(1, 0)))).toEqual(["a", "b", "c"]);
    });

    it("k changes how far a lower rank in both arms can climb", () => {
      const vector = rows("top", "x", "both");
      const keyword = rows("y", "z", "both");
      // k=1: both = 2/3, top = 1, so top stays first. k=60: both = 2/62, top = 1/60.
      expect(ids(reciprocalRankFusion(vector, keyword, weights(1, 1, 1)))[0]).toBe("top");
      expect(ids(reciprocalRankFusion(vector, keyword, weights(1, 1, 60)))[0]).toBe("both");
    });
  });

  it("does not deduplicate a repeated id within an arm: it scores twice", () => {
    expect(ids(reciprocalRankFusion(rows("x", "a", "a"), []))).toEqual(["a", "x"]);
  });
});
