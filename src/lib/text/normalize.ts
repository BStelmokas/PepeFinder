/**
 * Frozen query/tag normalization & tokenization (pure module)
 *
 * Architecture:
 * - Frozen search semantics are a *contract* that affects:
 *   - query parsing
 *   - tag storage
 *   - deterministic ranking
 * - If this logic is duplicated (UI, tRPC, seed script, worker), it will drift and regress.
 * - So it is encoded once, purely, with no I/O, no database, no framework imports.
 *
 * Frozen semantics implemented:
 * - split on whitespace
 * - lowercase ASCII only
 * - trim + collapse multiple spaces
 * - no unicode normalization, no stemming/synonyms
 * - stopwords removed
 */

export const DEFAULT_STOPWORDS = new Set(["a", "an", "the", "s", "re"]);

// Normalize a string’s whitespace.
export function normalizeWhitespace(input: string): string {
  // Collapse multiple spaces
  const collapsed = input.replace(/\s+/g, " ");

  return collapsed.trim();
}

// Lowercase ASCII
export function lowercaseAsciiOnly(input: string): string {
  let out = "";

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);

    // If the character is 'A'..'Z', map it to 'a'..'z' by adding 32.
    if (ch >= 65 && ch <= 90) {
      // 65 = 'A', 90 = 'Z'
      out += String.fromCharCode(ch + 32);
      continue;
    }

    out += input[i];
  }

  return out;
}

// ASCII only
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
 * Strip punctuation (replace with spaces) while preserving meaningful hyphens.
 *
 * - "sad!"      -> "sad"
 * - "nose,"     -> "nose"
 * - "(angry)"   -> "angry"
 * - "sad,angry" -> "sad angry"
 * - "film-noir" -> "film-noir" (keep hyphen when it's an inner connector)
 *
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
      // Punctuation becomes a space to separate two tags
      kept += " ";
    }
  }

  // Second pass:
  // Remove hyphens that are not strictly between alphanumeric characters. ("-sad", "--sad--", not "film-noir")
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
      // If the hyphen isn't a connector, treat it like punctuation so it becomes a space boundary.
      out += " ";
    }
  }

  return out;
}

// Remove stopwords from an array of normalized tokens.
export function removeStopwordsFromTokens(
  tokens: string[],
  stopwords: ReadonlySet<string> = DEFAULT_STOPWORDS,
): string[] {
  const out: string[] = [];

  for (const t of tokens) {
    if (stopwords.has(t)) continue;

    out.push(t);
  }

  return out;
}

// Normalize a raw user query string into the normalized query form.
export function normalizeQueryString(rawQuery: string): string {
  // Step 1: whitespace rules (trim + collapse).
  const spaced = normalizeWhitespace(rawQuery);

  // Step 2: ASCII-only transformation rules
  // Lowercase ASCII only
  const lower = lowercaseAsciiOnly(spaced);
  // Remove non-ASCII
  const ascii = stripNonAscii(lower);

  // Step 3: strip punctuation in a deterministic way that matches how tags should be stored.
  const noPunct = stripPunctuationPreserveInnerHyphens(ascii);

  // Step 4: whitespace may have been affected by stripping characters,
  // so normalize whitespace *again* to keep the invariant stable.
  return normalizeWhitespace(noPunct);
}

// Tokenize a query into distinct normalized tokens (order-preserving)
export function tokenizeQuery(rawQuery: string): string[] {
  // Canonicalize the query first so the splitting behavior is frozen and consistent.
  const normalized = normalizeQueryString(rawQuery);

  // If the normalized query is empty, there are no tokens.
  if (normalized.length === 0) return [];

  // Split on ASCII spaces because normalizeWhitespace guarantees it can only have spaces.
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

// Normalize a tag name for storage.
export function normalizeTagName(rawTag: string): string | null {
  // Normalize using the same pipeline as query normalization.
  const normalized = normalizeQueryString(rawTag);

  // An empty string is not a valid tag.
  if (normalized.length === 0) return null;

  // If the tag is a stopword, drop it.
  if (DEFAULT_STOPWORDS.has(normalized)) return null;

  // Tags in this model must be a single token.
  // If normalization produced spaces, that means the tag contained multiple tokens.
  if (normalized.includes(" ")) return null;

  return normalized;
}

/**
 * Expand a hyphenated token into itself + its hyphen-split components.
 * "film-noir" => "film-noir", "film", "noir"
 */
export function expandHyphenatedToken(normalizedSingleToken: string): string[] {
  // Most tokens aren’t hyphenated.
  if (!normalizedSingleToken.includes("-")) return [normalizedSingleToken];

  // Split into candidate parts.
  const rawParts = normalizedSingleToken.split("-").filter((p) => p.length > 0);

  // If splitting produces nothing useful, keep just the original.
  if (rawParts.length < 2) return [normalizedSingleToken];

  const out: string[] = [normalizedSingleToken];

  for (const p of rawParts) {
    // Validate each part against the same storage rules.
    const normalizedPart = normalizeTagName(p);
    if (!normalizedPart) continue;

    // Avoid duplicates if something weird happens.
    if (!out.includes(normalizedPart)) out.push(normalizedPart);
  }

  return out;
}
