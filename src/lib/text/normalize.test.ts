/**
 * Vitest unit tests for the frozen normalization/tokenization semantics.
 *
 * Why tests are justified here (even in an MVP):
 * - This logic is foundational and reused everywhere (UI, tRPC, worker, seeding).
 * - A “small” accidental change can silently change search results (high regression risk).
 * - This is pure logic, so tests are cheap and stable.
 */

import { describe, expect, it } from "vitest";
import {
  lowercaseAsciiOnly,
  normalizeQueryString,
  normalizeTagName,
  normalizeWhitespace,
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
    // We keep unicode characters unchanged in this step (stripNonAscii is separate).
    expect(lowercaseAsciiOnly("ÄÖÜ")).toBe("ÄÖÜ");
  });
});

describe("stripNonAscii", () => {
  it("removes non-ASCII characters deterministically", () => {
    expect(stripNonAscii("pepe🐸frog")).toBe("pepefrog");
    expect(stripNonAscii("ÄBC")).toBe("BC"); // 'Ä' removed, ASCII remains
  });
});

describe("normalizeQueryString", () => {
  it("applies whitespace collapse, ASCII lowercase, and non-ASCII stripping", () => {
    // - whitespace collapsed
    // - ASCII lowercased
    // - emoji removed
    expect(normalizeQueryString("  Pepe   SAD 🐸  ")).toBe("pepe sad");
  });

  it("normalizes to empty string when nothing ASCII remains", () => {
    expect(normalizeQueryString("🐸🐸🐸")).toBe("");
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
