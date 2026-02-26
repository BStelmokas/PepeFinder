/**
 * Vitest unit tests for the frozen normalization/tokenization semantics.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOPWORDS,
  lowercaseAsciiOnly,
  normalizeQueryString,
  normalizeTagName,
  normalizeWhitespace,
  removeStopwordsFromTokens,
  stripNonAscii,
  tokenizeQuery,
} from "./normalize";

describe("normalizeWhitespace", () => {
  it("trims and collapses whitespace runs to a single space", () => {
    expect(normalizeWhitespace("   hello   world   ")).toBe("hello world");
    expect(normalizeWhitespace("\n\t hello \t\n world \n")).toBe("hello world");
  });

  it("returns empty string for all-whitespace input", () => {
    expect(normalizeWhitespace("   \n\t  ")).toBe("");
  });
});

describe("lowercaseAsciiOnly", () => {
  it("lowercases ASCII A-Z only", () => {
    expect(lowercaseAsciiOnly("ABC xyz")).toBe("abc xyz");
  });

  it("does not change non-ASCII characters (no unicode normalization)", () => {
    expect(lowercaseAsciiOnly("ÄÖÜ")).toBe("ÄÖÜ");
  });
});

describe("stripNonAscii", () => {
  it("removes non-ASCII characters deterministically", () => {
    expect(stripNonAscii("pepe🐸frog")).toBe("pepefrog");
    expect(stripNonAscii("ÄBC")).toBe("BC");
  });
});

describe("normalizeQueryString", () => {
  it("applies whitespace collapse, ASCII lowercase, and non-ASCII stripping", () => {
    expect(normalizeQueryString("  Pepe   SAD 🐸  ")).toBe("pepe sad");
  });

  it("normalizes to empty string when nothing ASCII remains", () => {
    expect(normalizeQueryString("🐸🐸🐸")).toBe("");
  });
});

describe("stopwords helpers", () => {
  it("DEFAULT_STOPWORDS contains the tiny conservative set", () => {
    // Makes stopword list changes explicit (no silent semantics changes).
    expect(Array.from(DEFAULT_STOPWORDS)).toEqual([
      "a",
      "an",
      "the",
      "s",
      "re",
    ]);
  });

  it("removeStopwordsFromTokens removes only whole-token stopwords", () => {
    expect(removeStopwordsFromTokens(["a", "frog", "the", "sad"])).toEqual([
      "frog",
      "sad",
    ]);
    expect(
      removeStopwordsFromTokens(["theory", "apple", "the", "anthropology"]),
    ).toEqual(["theory", "apple", "anthropology"]);
  });
});

describe("tokenizeQuery", () => {
  it("splits on whitespace after normalization", () => {
    expect(tokenizeQuery("  hello   world  ")).toEqual(["hello", "world"]);
  });

  it("returns distinct tokens (order-preserving)", () => {
    expect(tokenizeQuery("sad sad pepe sad")).toEqual(["sad", "pepe"]);
  });

  it("drops tokens that become empty after non-ASCII stripping", () => {
    expect(tokenizeQuery("pepe 🐸 frog")).toEqual(["pepe", "frog"]);
  });

  it("returns empty array for empty/whitespace-only input", () => {
    expect(tokenizeQuery("   \n\t  ")).toEqual([]);
  });
});

describe("normalizeTagName", () => {
  it("normalizes a single tag token", () => {
    expect(normalizeTagName("  Pepe ")).toBe("pepe");
  });

  it("returns null for empty/invalid tags", () => {
    expect(normalizeTagName("   ")).toBeNull();
    expect(normalizeTagName("🐸")).toBeNull();
  });

  it("returns null if the tag contains multiple tokens after normalization", () => {
    expect(normalizeTagName("sad pepe")).toBeNull();
    expect(normalizeTagName("  sad   pepe  ")).toBeNull();
  });
});

describe("punctuation stripping (preserve inner hyphens)", () => {
  it("trims punctuation in queries so tags can match", () => {
    expect(tokenizeQuery("nose, sad!")).toEqual(["nose", "sad"]);
  });

  it("does not merge words when punctuation is between them", () => {
    expect(tokenizeQuery("sad,angry")).toEqual(["sad", "angry"]);
  });

  it("does not merge words when punctuation is between them", () => {
    expect(tokenizeQuery("it, was! a (film-noir)")).toEqual([
      "it",
      "was",
      "film-noir",
    ]);
    expect(normalizeTagName("film-noir")).toBe("film-noir");
  });

  it("removes non-connector hyphens", () => {
    expect(tokenizeQuery("--sad--")).toEqual(["sad"]);
    expect(tokenizeQuery("-sad sad-")).toEqual(["sad"]);
  });

  it("still enforces tag single-token rule after punctuation stripping", () => {
    expect(normalizeTagName("sad!")).toBe("sad");
    expect(normalizeTagName("sad, angry")).toBeNull(); // becomes "sad angry" = not a single token
  });

  it("normalizeQueryString stays deterministic and whitespace-normalized", () => {
    expect(normalizeQueryString("  (SAD!)   frog\t\n")).toBe("sad frog");
  });
});
