/**
 * PepeFinder — Frozen query/tag normalization & tokenization (PURE MODULE)
 *
 * Why this file exists (architecture, not syntax):
 * - Your “frozen search semantics” are a *contract* that affects:
 *   - query parsing
 *   - tag storage
 *   - deterministic ranking
 * - If this logic is duplicated (UI, tRPC, seed script, worker), you will drift and regress.
 * - So we encode it once, purely, with no I/O, no database, no framework imports.
 *
 * What “pure” means here:
 * - Same input -> same output (deterministic).
 * - No reading env vars, no DB, no Date.now(), no global state.
 * - Easy to unit test and safe to reuse anywhere (server, worker, scripts).
 *
 * Frozen semantics we implement EXACTLY:
 * - split on whitespace
 * - lowercase ASCII only
 * - trim + collapse multiple spaces
 * - no unicode normalization, no stemming/synonyms
 * - stopwords: skipped (intentionally) to avoid hidden semantics in MVP
 */

/**
 * Normalize a string’s whitespace exactly per spec:
 * - trim leading/trailing whitespace
 * - collapse multiple whitespace runs to a single ASCII space (" ")
 *
 * We intentionally treat "whitespace" as JavaScript \s (includes tabs/newlines),
 * because your spec says "split on whitespace" without narrowing.
 */
export function normalizeWhitespace(input: string): string {
  // Replace any run of whitespace characters (space, tab, newline, etc.) with a single " ".
  // This implements “collapse multiple spaces” *and* normalizes other whitespace to spaces.
  const collapsed = input.replace(/\s+/g, " ");

  // Trim at the edges to implement “trim”.
  return collapsed.trim();
}

/**
 * Lowercase ASCII letters only (A-Z -> a-z), leaving everything else unchanged *for now*.
 *
 * Why not use `toLowerCase()`?
 * - `toLowerCase()` is Unicode-aware and can change non-ASCII characters.
 * - Your frozen rules say "lowercase ASCII only" and "no unicode normalization".
 * - So we implement the ASCII transform ourselves to avoid surprising Unicode behavior.
 */
export function lowercaseAsciiOnly(input: string): string {
  // We'll build a new string character-by-character so we can precisely control behavior.
  let out = "";

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);

    // If the character is 'A'..'Z', map it to 'a'..'z' by adding 32.
    if (ch >= 65 /* 'A' */ && ch <= 90 /* 'Z' */) {
      out += String.fromCharCode(ch + 32);
      continue;
    }

    // Otherwise, keep the character unchanged (for now).
    out += input[i];
  }

  return out;
}

/**
 * Enforce "ASCII only" by removing any non-ASCII codepoints.
 *
 * Why removal (instead of replacement)?
 * - Your spec says “lowercase ASCII only” and implies stored tags must be normalized the same way.
 * - If we *keep* non-ASCII, then tags are not “ASCII only” in practice.
 * - If we *replace* with placeholders, we introduce new characters not present in input.
 * - Removal is the simplest deterministic rule: if not ASCII, it doesn’t exist in normalized form.
 *
 * Trade-off:
 * - This can turn some inputs into empty strings (e.g., "🐸").
 * - That’s acceptable: we treat empty tokens as “no token”.
 */
export function stripNonAscii(input: string): string {
  let out = "";

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);

    // ASCII range is 0..127 inclusive.
    if (code >= 0 && code <= 127) {
      out += input[i];
    }
  }

  return out;
}

/**
 * Normalize a raw user query string into the normalized query form.
 *
 * This is primarily useful for:
 * - logging/debugging (what query did we *actually* execute?)
 * - generating stable cache keys (later)
 *
 * Note: Search ranking uses tokens, not the normalized query string,
 * but it’s still valuable to have a canonical query representation.
 */
export function normalizeQueryString(rawQuery: string): string {
  // Step 1: whitespace rules (trim + collapse).
  const spaced = normalizeWhitespace(rawQuery);

  // Step 2: ASCII-only transformation rules:
  // - lowercase ASCII only
  // - remove non-ASCII
  const lower = lowercaseAsciiOnly(spaced);
  const ascii = stripNonAscii(lower);

  // Step 3: whitespace may have been affected by stripping characters,
  // so we normalize whitespace *again* to keep the invariant stable.
  return normalizeWhitespace(ascii);
}

/**
 * Tokenize a query into DISTINCT normalized tokens (order-preserving).
 *
 * Why "distinct" here?
 * - Your ranking definition uses “number of distinct query tokens present”.
 * - If the query is "sad sad pepe", counting duplicates would inflate match_count incorrectly.
 *
 * Why preserve order?
 * - For deterministic behavior and predictable UI display (e.g., showing interpreted tokens).
 * - Order is not required for ranking, but stable outputs reduce debugging pain.
 */
export function tokenizeQuery(rawQuery: string): string[] {
  // Canonicalize the query first so the splitting behavior is frozen and consistent.
  const normalized = normalizeQueryString(rawQuery);

  // If the normalized query is empty, there are no tokens.
  if (normalized.length === 0) return [];

  // Split on ASCII spaces because normalizeWhitespace guarantees we only have single spaces.
  const parts = normalized.split(" ");

  // Deduplicate while preserving first-seen order.
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const p of parts) {
    // Defensive: ignore any empty segments (shouldn’t exist due to normalization).
    if (p.length === 0) continue;

    if (!seen.has(p)) {
      seen.add(p);
      tokens.push(p);
    }
  }

  return tokens;
}

/**
 * Normalize a tag name for storage.
 *
 * Tags are expected to be single tokens in this MVP.
 * This function:
 * - applies the same normalization as query tokens
 * - returns `null` if the result is not a single valid token
 *
 * Why return null instead of throwing?
 * - Pure modules are easiest to use when they’re total functions (no exceptions).
 * - Callers (seed scripts, workers, tRPC) can decide how to handle invalid tags.
 */
export function normalizeTagName(rawTag: string): string | null {
  // Normalize using the same pipeline as query normalization.
  const normalized = normalizeQueryString(rawTag);

  // An empty string is not a valid tag.
  if (normalized.length === 0) return null;

  // Tags in this model must be a single token.
  // If normalization produced spaces, that means the tag contained multiple tokens.
  if (normalized.includes(" ")) return null;

  return normalized;
}
