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

export const DEFAULT_STOPWORDS = new Set(["a", "an", "the"]);

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
 * STEP CHANGE: Strip punctuation (replace with spaces) while preserving meaningful hyphens.
 *
 * What “punctuation trimming” means in practice:
 * - "sad!"      -> "sad"
 * - "nose,"     -> "nose"
 * - "(angry)"   -> "angry"
 * - "sad,angry" -> "sad angry"  (IMPORTANT: do NOT concatenate into "sadangry")
 * - "film-noir" -> "film-noir"  (keep hyphen when it's an inner connector)
 *
 * Why we replace punctuation with spaces (instead of removing it):
 * - Removing punctuation outright can merge adjacent words:
 *   "sad,angry" would become "sadangry", which is worse than two tokens.
 *
 * Hyphen rule:
 * - Keep "-" only when it connects two alphanumeric characters (a-z, 0-9).
 * - This prevents tokens like "-" or "--sad--" from leaking through.
 */
export function stripPunctuationPreserveInnerHyphens(input: string): string {
  // First pass:
  // - Keep lowercase letters a-z, digits 0-9, spaces, and hyphens.
  // - Replace everything else with a space so it becomes a token boundary.
  let kept = "";

  for (const ch of input) {
    const isAZ = ch >= "a" && ch <= "z";
    const is09 = ch >= "0" && ch <= "9";
    const isSpace = ch === " ";
    const isHyphen = ch === "-";

    if (isAZ || is09 || isSpace || isHyphen) {
      kept += ch;
    } else {
      // Punctuation becomes a space to avoid accidental word concatenation.
      kept += " ";
    }
  }

  // Second pass:
  // Remove hyphens that are not strictly between alphanumeric characters.
  // Examples:
  // - "-sad"     -> " sad"
  // - "sad-"     -> "sad "
  // - "--sad--"  -> "  sad  "
  // - "film-noir" stays "film-noir"
  let out = "";

  for (let i = 0; i < kept.length; i++) {
    const ch = kept[i]!;
    if (ch !== "-") {
      out += ch;
      continue;
    }

    const prev = kept[i - 1];
    const next = kept[i + 1];

    const prevIsAlnum =
      (prev !== undefined && prev >= "a" && prev <= "z") ||
      (prev !== undefined && prev >= "0" && prev <= "9");

    const nextIsAlnum =
      (next !== undefined && next >= "a" && next <= "z") ||
      (next !== undefined && next >= "0" && next <= "9");

    if (prevIsAlnum && nextIsAlnum) {
      out += "-";
    } else {
      // If the hyphen isn't a connector, treat it like punctuation → becomes a space boundary.
      out += " ";
    }
  }

  return out;
}

/**
 * Remove stopwords from an array of normalized tokens.
 *
 * Important invariants:
 * - We remove only *exact token matches* (no substring removal).
 * - We preserve order.
 * - We do NOT dedupe here; caller decides whether/when to dedupe.
 *
 * Why this helper exists:
 * - We need stopword removal in more than one place:
 *   - tokenizeQuery
 *   - model tag post-processing (phrases)
 * - Centralizing it prevents silent drift.
 */
export function removeStopwordsFromTokens(
  tokens: string[],
  stopwords: ReadonlySet<string> = DEFAULT_STOPWORDS,
): string[] {
  const out: string[] = [];

  for (const t of tokens) {
    // Only drop whole-token stopwords (e.g. "a"), not substrings.
    if (stopwords.has(t)) continue;

    out.push(t);
  }

  return out;
}

/**
 * Remove stopwords from a *phrase* (potentially multi-token string).
 *
 * Why this exists:
 * - Your vision model sometimes returns multi-word phrases like "a frog".
 * - We want to reduce those to meaningful primitives ("frog") BEFORE later validation.
 *
 * Design:
 * - This assumes the phrase is already normalized with normalizeQueryString(),
 *   i.e. spaces are canonical and punctuation is already handled.
 */
export function removeStopwordsFromPhrase(
  normalizedPhrase: string,
  stopwords: ReadonlySet<string> = DEFAULT_STOPWORDS,
): string {
  if (normalizedPhrase.length === 0) return "";

  const tokens = normalizedPhrase.split(" ").filter((t) => t.length > 0);

  const filtered = removeStopwordsFromTokens(tokens, stopwords);

  return filtered.join(" ");
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

  // STEP CHANGE:
  // Step 2.5: strip punctuation in a deterministic way that matches how tags should be stored.
  // This ensures:
  // - user queries like "sad!" match stored tags "sad"
  // - we don't create weird tokens like "sadangry" from "sad,angry"
  const noPunct = stripPunctuationPreserveInnerHyphens(ascii);

  // Step 3: whitespace may have been affected by stripping characters,
  // so we normalize whitespace *again* to keep the invariant stable.
  return normalizeWhitespace(noPunct);
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

  // Remove stopwords before dedupe so they never participate in ranking.
  const filtered = removeStopwordsFromTokens(parts, DEFAULT_STOPWORDS);

  // Deduplicate while preserving first-seen order.
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const p of filtered) {
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

  // If the tag *is itself* a stopword, drop it.
  // Example: "the" -> null
  if (DEFAULT_STOPWORDS.has(normalized)) return null;

  // Tags in this model must be a single token.
  // If normalization produced spaces, that means the tag contained multiple tokens.
  if (normalized.includes(" ")) return null;

  return normalized;
}
