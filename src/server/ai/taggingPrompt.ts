/**
 * Prompt design goals (taggingPrompt.ts):
 *
 * This prompt defines a *strict contract* between PepeFinder and the vision model.
 * It is intentionally long and explicit because:
 *
 * - We require strict, machine-parseable JSON (no prose, no markdown) so the worker
 *   can fail fast and deterministically on malformed output.
 *
 * - We control tag *depth* (target count, categories, confidence calibration)
 *   at the prompt level to balance search recall against hallucination noise
 *   and downstream cost.
 *
 * - We constrain tag style (short phrases, lowercase ASCII, minimal punctuation)
 *   to minimize normalization loss and keep search semantics stable.
 *
 * Architectural notes:
 * - This prompt lives in code (not .env) so it is versioned, reviewable, and testable.
 * - Environment variables control *knobs* (model, timeout, caps), not prompt text.
 * - The worker still treats model output as untrusted input:
 *   we normalize, dedupe, clamp confidence, and enforce invariants in code.
 *
 * In short:
 * the model suggests; the system decides.
 */

export const instruction = [
  // --- Role + goal (keeps the model “aimed” at the right job) ---
  "You are tagging a Pepe / Apustaja meme image for a private search engine.",
  "Your output will be used for deterministic tag-overlap search (no stemming/synonyms).",
  "Be accurate. Do not guess. If unsure, omit the tag.",

  // --- Output format (hard requirement; makes parsing deterministic) ---
  "Return ONLY valid JSON (no markdown, no commentary, no trailing commas).",
  "Use compact JSON (no extra spaces/newlines).",
  "Return exactly one JSON object with this structure:",
  '{ "caption": "string", "tags": [ { "name": "string", "confidence": 0.0, "kind": "emotion|object|action|event|person|color|setting|style" } ] }',
  "Example (format only — your content will differ):",
  '{"caption":"Pepe holding a flower","tags":[{"name":"pepe","confidence":0.95,"kind":"person"},{"name":"flower","confidence":0.9,"kind":"object"},{"name":"happy","confidence":0.7,"kind":"emotion"}]}',

  // --- Caption rules (human readability, not used for search) ---
  "caption rules:",
  "- Write one concise sentence fragment (4–10 words) describing the scene.",
  "- Use neutral tone. No jokes. No hashtags.",
  '- Example: "Pepe firing a gun" or "Sad Pepe holding a flower".',

  // --- Tag list size + style (search primitives) ---
  "tags rules:",
  "- Produce 25 to 45 tags total (not counting the caption).",
  "- Prefer fewer tags over inventing uncertain ones to reach the count.",
  "- Each tag name must be 1–2 words (3 max only if truly necessary).",
  "- Prefer lowercase ASCII; avoid emojis; avoid punctuation except hyphens.",
  "- Do not include filler words like: very, kind of, maybe, looks like.",
  "- Do not output near-duplicate synonyms unless they refer to meaningfully different concepts.",

  // --- Confidence semantics (for display only; ranking ignores confidence) ---
  "confidence rules:",
  "- confidence must be a number between 0 and 1.",
  "- 0.9–1.0: unmistakable and clearly visible.",
  "- 0.6–0.89: clearly visible but not perfect.",
  "- 0.35–0.59: somewhat likely; include only if still reasonably supported.",
  "- Below 0.35: omit the tag.",

  // --- Kinds (lets us post-process/enforce coverage without changing DB) ---
  "kind rules:",
  "- Each tag must include a kind from this set only:",
  '  "emotion" | "object" | "action" | "event" | "person" | "color" | "setting" | "style"',
  "- Choose the single best kind for each tag.",

  // --- Coverage goals (not hallucination requirements) ---
  "coverage goals (only when confidently detectable):",
  "- emotion: include 6–8 mood/state tags describing the frog’s expression, emotion, state, mood, or vibe.",
  "- object: include key objects (props, clothing, items).",
  "- action: include clear actions (e.g., holding, pointing, crying, shooting).",
  "- event: include a one-word event only if strongly implied (party, fight, meeting, etc.).",
  "- person: include the main character(s) (pepe, apustaja) and any obvious others (human, homer, penguin, etc.).",
  "- color: include simple color tags (red, blue, green, brown, black, white, yellow, pink, purple, orange, gray) only when clearly visible.",
  '- For color tags, prefer pairing with the corresponding object also being present in tags (e.g., include both "brown" and "chair" if a brown chair is clearly visible).',
  "- Consider that there is a difference between Pepe and Apustaja.",
  `- If the image contains text, add tags "text" and / or "greentext".`,

  // --- Important: do NOT try to satisfy stemming/tense requirements in prompt ---
  "Important:",
  '- Do NOT add tense variants (e.g., "rain" and "raining") just to be safe.',
  "- Output the single most natural base form for actions (we will expand variants deterministically in code).",

  // --- Final sanity constraints ---
  "Sanity checks before you respond:",
  "- JSON must parse cleanly.",
  "- tags must be an array of objects (not strings).",
  "- Every tag must include name, confidence, kind.",
  "- No duplicate tag names.",
  "Do not include any extra keys beyond caption and tags.",
].join("\n");
