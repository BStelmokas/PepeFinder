# PepeFinder — Engineering Trade-offs (Living Document)

PepeFinder is an AI-tagged meme search engine built as a **small, production-minded system**.

It is intentionally simple, intentionally constrained, and intentionally opinionated.

This document exists to:

- Make shortcuts explicit (never accidental)
- Preserve architectural intent
- Capture what I would change at 10× scale
- Show that decisions were deliberate, not incidental

This file evolves with the system.

---

## Current State (Post-MVP2, Pre-Production Polish)

PepeFinder is no longer a toy MVP. It now includes:

- Deterministic DB-only search
- Frozen, tested tokenization rules
- Cursor-based keyset pagination
- Upload pipeline with SHA-256 dedupe
- S3-compatible object storage (Cloudflare R2 compatible)
- Async tagging worker (Postgres-backed queue)
- Real vision model integration (caption + structured tags)
- Caption storage + caption-as-tag indexing
- Cost caps + kill switch + strict model timeouts
- Manual Reddit ingestion (archived datasets, 6k+ processed)
- Production health endpoint
- Responsive UI (desktop + mobile refinements)
- Download endpoint with forced attachment streaming
- Per-image flag toggle with DB-backed moderation signal
- Operator moderation script (unlist/delete by flag threshold)
- Clean deployment to Vercel + managed Postgres

**New production hygiene (polish step):**

- Global footer with Contact / Privacy / Takedown links (consistent on every page)
- Static `/privacy` page (clear, honest MVP privacy policy)
- Static `/takedown` page (explicit removal flow for rights-holders and platform sanity)

Search never calls the model.
Model calls never happen on the request path.
Cost safety is architectural, not optional.

**Newest UI polish (pre-production):**

- Tag list is now **height-capped to the image panel** and becomes scrollable when long
- This behavior applies **on all devices**, including one-column layouts, to prevent “infinite pages”
- The image panel stays natural-size (never stretched); the tags panel adapts (stretches or scrolls)

This is intentionally “small polish” that improves the browsing experience without changing any product semantics.

**Newest data-quality / searchability improvements (late MVP2 → pre-prod):**

- Stopword filtering is now a first-class, shared invariant:
  - stopwords are removed from queries _and_ from model-produced tag phrases
  - this prevents noise tags like `a`, `an`, `the`, `and` from polluting the global tag dictionary
- Hyphenated-tag expansion is now enforced as a storage invariant:
  - if an image has `film-noir`, it also gets `film` and `noir` (original tag preserved)
  - same for tags like `red-shirt` → `red` + `shirt`
  - a one-off backfill script makes existing tagged data comply (idempotent + safe to re-run)

This keeps “tag overlap search” predictable while improving recall for natural queries like “film noir”.

**Newest operational shift (pre-prod hardening):**

- Moved away from `drizzle-kit push` toward **migration-based schema changes**:
  - `drizzle-kit generate` to produce reviewable, committed SQL migrations
  - `drizzle-kit migrate` to apply migrations deterministically in each environment
- This is a real production hygiene step:
  - schema changes become auditable artifacts in Git
  - deploys stop depending on “whatever the schema is today”
  - it prevents accidental destructive diffs from silently landing in production

This change doesn’t alter product behavior — it changes the _safety envelope_ around database evolution.

---

# 1) Things I consciously did worse to ship faster

These are deliberate compromises.

---

## 1.1 Integer `serial` IDs instead of UUIDs

**Decision**
Used `serial` primary keys.

**Trade-off**

- Guessable IDs.
- Not ideal for public multi-tenant APIs.

**Why**

- Simpler joins.
- Faster debugging.
- Lower cognitive overhead during early design.
- IDs are not a security boundary here.

**When to fix**

- If accounts or public APIs are introduced.

---

## 1.2 Normalization rules live in code, not enforced in SQL

**Decision**
All tag normalization and query tokenization live in a pure TypeScript module.

**Trade-off**

- The DB will not block malformed tags if someone bypasses the module.

**Why**

- Encoding ASCII + punctuation + hyphen rules in SQL constraints would be brittle.
- A single tested pure module is easier to reason about.
- All ingestion paths (worker, scripts, upload) share the same logic.

**New note (post-polish)**
I doubled down on “code-level invariants” by adding:

- stopword filtering at token boundaries
- hyphen-expansion enforcement at write-time + a backfill script for existing data

This does not make SQL constraints unnecessary — it just keeps the MVP small and the behavior centralized.

**When to fix**

- If third-party ingestion pipelines are introduced.
- If tags become user-generated.

---

## 1.3 Simple Postgres job queue (no Redis, no broker)

**Decision**
Used Postgres (`tag_jobs`) as the only queue mechanism.

**Trade-off**

- Not horizontally optimized for massive throughput.
- No retry backoff sophistication.
- Worker is single-process by design.

**Why**

- Minimal moving parts.
- Strong transactional guarantees.
- `FOR UPDATE SKIP LOCKED` is enough at this scale.
- Operational simplicity beats theoretical scalability.

**When to fix**

- If worker throughput becomes the bottleneck.
- If heterogeneous workers or distributed tagging is required.

---

## 1.4 Cursor pagination instead of offset pagination

**Decision**
Implemented keyset pagination using deterministic cursor tuples:
(match_count, created_at, id)

**Trade-off**

- Cannot jump to arbitrary page numbers.
- Requires cursor state encoded in URL.

**Why**

- Offset pagination becomes slow at scale.
- Cursor pagination maintains stable ordering.
- Deterministic tie-breaking guarantees consistency.
- Fully aligned with frozen ranking semantics.

**When to fix**

- If UX requires arbitrary page jumps.
- If a separate search service is introduced.

---

## 1.5 Caption tokens indexed as tags (no separate text search)

**Decision**
Caption tokens are normalized and inserted into the global tag dictionary.

**Trade-off**

- Caption words and tags share the same namespace.
- No full-text search engine.
- Caption precision depends on model output quality.

**Why**

- Preserves deterministic ranking.
- Avoids introducing a separate search system.
- Users can rediscover memes by remembered phrases.
- Keeps the ranking rule simple and explainable.

**When to fix**

- If semantic search or fuzzy search becomes required.
- If captions need to be weighted differently from tags.

---

## 1.6 96 Results Per Page (Dense Visual Search)

**Decision**
Search returns up to 96 results per page.

**Trade-off**

- Slightly heavier DOM rendering on mobile.
- Larger initial result payload.

**Why**

- Meme search is exploratory.
- Users expect scroll depth similar to image search engines.
- 96 divides cleanly across 2 / 3 / 4 column grids.
- Still cheap for Postgres and network (JSON only; images load lazily).

**When to fix**

- If mobile performance metrics show degradation.
- If analytics show users rarely scroll beyond first screen.

---

## 1.7 Soft-moderation via flag counter (no accounts)

**Decision**
Implemented per-image flagging with a simple integer `flag_count`, toggleable per browser.

**Trade-off**

- No authentication.
- No per-user dedupe at DB level.
- Flagging is a soft signal, not a secure moderation boundary.

**Why**

- Keeps the system small and anonymous.
- Avoids introducing accounts, sessions, or rate-limiting infra.
- Provides an operational signal without expanding scope.

**When to fix**

- If abuse becomes common.
- If real moderation workflows are required.
- If user accounts are introduced.

---

## 1.8 Minimal “contact surface” (mailto + static pages, no ticketing)

**Decision**
Shipped a global footer with a direct email link and two static pages:
`/privacy` and `/takedown`.

**Trade-off**

- No contact form.
- No support queue or ticket tracking.
- Manual triage.

**Why**

- MVP needs a human, dependable way for people (and platforms) to reach the operator.
- A mailto link is the simplest possible “operational backpressure valve.”
- Static policy pages are enough for trust and basic compliance without inventing new product scope.

**When to fix**

- If inbound volume grows (support becomes a real workflow).
- If the project becomes multi-tenant or commercialized (stronger policies + audit trail).
- If abuse/takedowns require structured intake and tracking.

---

## 1.9 Client-side layout measurement for scrollable tags (minor JS for major UX)

**Decision**
Used a small client-side layout measurement (DOM height syncing) so the tags panel matches the image panel height and scrolls internally.

**Trade-off**

- Adds a tiny amount of client JavaScript on the image detail page.
- Requires careful handling of resize/image-load to avoid UI “jump.”

**Why**

- Pure CSS can’t reliably say “sidebar height equals image’s rendered height” when that height depends on intrinsic aspect ratio and responsive width.
- Keeps the page compact even with 30–40 tags.
- Improves the browsing loop on mobile: no “scroll forever” tag lists.

**When to fix**

- If the UI evolves into a more complex layout system (component library, virtualization).
- If a full “panel layout” system is introduced (not needed now).

---

## 1.10 Migration workflow adds overhead (but it’s worth it)

**Decision**
Stopped using `drizzle-kit push` in “real environments” and moved to:

- `drizzle-kit generate` → commit migrations
- `drizzle-kit migrate` → apply them per environment

**Trade-off**

- Slightly slower iteration: every schema change becomes a migration you review.
- You can no longer “just edit schema and push” without thinking.
- A broken migration can block deploys (which is also the point).

**Why**

- In production, DB evolution must be auditable and reviewable.
- Migration files become the paper trail for how the schema changed.
- It prevents accidental destructive diffs from silently landing.
- It makes deploys deterministic across dev/staging/prod.

**When to fix / improve**

- If schema changes become frequent, add a lightweight migration review checklist.
- If multiple contributors join, enforce migration review in CI.

---

# 2) Things I consciously did right despite extra effort

These are architectural decisions that cost time but reduce risk.

---

## 2.1 DB-only deterministic search

Search:

- Never calls the model
- Never calls external services
- Uses only joins and aggregations
- Is fully explainable

Eligibility:
at least one distinct query token matches a tag

Ranking:
match_count DESC
created_at DESC
id DESC

Why this matters:

- Predictable latency
- Predictable cost
- Debuggable ranking
- Search remains functional if AI is paused or broken

---

## 2.2 Worker-only model calls (fail-closed)

All AI calls:

- Happen in a separate worker process
- Enforce:
  - `TAGGING_PAUSED`
  - `TAGGING_DAILY_CAP`
  - strict timeout
- Are isolated from user request path

If the model fails:

- Job = failed
- Image = failed
- System continues operating

This makes cost safety structural.

---

## 2.3 SHA-256 dedupe across all ingestion paths

Every image is:

- Hashed before insertion
- Stored under deterministic key (`images/<sha>.ext`)
- Upserted by unique sha256 constraint

This guarantees:

- No duplicate storage
- No duplicate tagging jobs
- Idempotent ingestion scripts

This applies to:

- Uploads
- Manual seeding
- Reddit archive ingestion (6k+ images processed idempotently)

---

## 2.4 Manual Reddit ingestion (batch-only, no crawler infra)

Instead of building a crawler:

- Ingestion is manual.
- Fixed datasets are processed.
- Only direct image URLs are accepted.
- Deduplication is enforced.
- Tag jobs are enqueued deterministically.

This keeps:

- No always-on infra
- No scraping daemons
- No operational creep
- Full reproducibility of ingestion runs

The system remains small and understandable.

---

## 2.5 Frozen normalization rules (with tests)

Normalization rules:

- Lowercase ASCII only
- Strip non-ASCII
- Strip punctuation
- Preserve inner hyphens (e.g. `film-noir`)
- Replace punctuation with spaces (avoid word merging)
- Deduplicate tokens

This module is:

- Pure
- Deterministic
- Tested
- Shared by query parsing, worker tagging, ingestion scripts

This prevents silent semantic drift.

**New extension (still within “frozen semantics”)**
Two quality improvements were added without changing ranking rules:

- Stopword removal at token boundaries (`a`, `an`, `the`, `and`)
  - removed from query tokens and from model-produced tag phrases
- Hyphen expansion as a storage invariant
  - `film-noir` implies `film` + `noir` on the same image
  - improves recall for natural queries without introducing synonyms or fuzzy search

---

## 2.6 Attachment-based download endpoint

**Decision**
Implemented a server-side download route that streams image bytes with `Content-Disposition: attachment`.

**Why this matters**

- HTML `download` attribute is unreliable cross-origin.
- Object storage URLs may open in-browser instead of downloading.
- Forcing attachment at the application layer guarantees consistent behavior.

**Trade-off**

- Server briefly proxies image bytes.
- Slight additional bandwidth on the app layer.

**Why it’s acceptable**

- Meme images are small.
- Download is user-initiated and infrequent.
- Correct UX matters more than theoretical purity.

---

## 2.7 Operator moderation script

**Decision**
Built a CLI script to unlist or delete images exceeding a configurable flag threshold.

**Why**

- Moderation is an operational concern, not a product feature.
- Keeps the UI simple.
- Avoids building an admin dashboard prematurely.
- Enables dry-run previews before destructive actions.

**Trade-off**

- Manual process.
- No automated moderation pipeline.

**Why this is intentional**

- System remains small.
- Moderation remains explicit.
- No hidden automation or background processes.

---

## 2.8 Shipping “trust hooks” early (privacy + takedown)

**Decision**
Shipped basic trust + ops surfaces as static pages and a global footer before “perfect polish.”

**Why**

- Uploads + third-party sources means you need a clear takedown path.
- It’s a small change that signals seriousness and reduces risk.
- It creates an obvious interface for humans, which is often more valuable than more features.

**Trade-off**

- Adds non-product routes.
- Slightly increases scope beyond “just the core loop.”

**Why it’s worth it**
If you deploy publicly, a working contact/takedown path is the difference between
“cool demo” and “responsible service.”

---

## 2.9 Search UX stays small and fast even as metadata grows

**Decision**
Even after adding captions, caption-as-tag indexing, and long tag lists, the UI remains “lean”:

- Search grid stays minimal (thumbnail + name + match_count)
- Image detail stays readable (caption, image, scrollable tags)
- No admin dashboards, no complex settings, no user accounts

**Why**

- The portfolio goal is clarity: the system is understandable end-to-end.
- The product goal is speed: the user gets results instantly.
- The engineering goal is separation: UI polish doesn’t rewrite core semantics.

---

## 2.10 Post-processing model output into strict search primitives

**Decision**
Model output is treated as _suggestions_, not ground truth. Before persistence:

- tag phrases are normalized and tokenized using the same frozen rules as user queries
- stopwords are removed
- multi-word phrases become multiple atomic tags
- hyphenated tags are expanded into additional atomic tags (`red-shirt` → `red` + `shirt`)
- the original hyphenated tag is preserved

**Why**

- It keeps “tag overlap search” coherent.
- It increases recall without introducing fuzzy matching or synonyms.
- It prevents the global tag dictionary from filling with junk.

**Trade-off**

- Slightly more bookkeeping in the worker + backfill scripts.
- Confidence becomes “best effort” when a phrase splits into multiple tokens.

**Why it’s worth it**
The search engine stays deterministic, but behaves more like users expect when they type natural phrases.

---

## 2.11 Migration-based DB evolution (generate + migrate)

**Decision**
Database changes are now made via committed SQL migrations:

- generate migrations from schema changes
- apply migrations deterministically per environment

**Why**

- It is the difference between “it worked on my machine” and “we can deploy this repeatedly.”
- You can review a migration like code.
- If something goes wrong, you can bisect history and see exactly when and how the schema changed.

**Trade-off**

- Slightly slower iteration.
- Requires discipline (migrations are part of the PR, not an afterthought).

**Why it’s worth it**
This project is meant to be production-adjacent and portfolio-quality. Migrations are part of that story.

---

# 3) Known pressure points at 10× scale

These are not surprises. They are expected future work.

---

## 3.1 Hot-tag fan-out

At scale:

- Popular tags cause wide joins.
- `COUNT(DISTINCT tag_id)` becomes expensive.

Likely improvements:

- Materialized tag → image edges
- Caching hot queries
- Precomputed match counts
- External search engine if needed

---

## 3.2 Tag drift & ontology management

Currently:

- Flat tag dictionary
- No aliasing
- No versioning by model

At scale:

- Tags drift across model upgrades.
- Duplicate semantics appear.

Future direction:

- Alias table (synonym groups)
- Model-version tracking
- Re-tagging pipeline

---

## 3.3 Storage delivery & image optimization

Currently:

- Direct object URLs or signed URLs
- No thumbnail generation

At scale:

- Thumbnail pipeline
- Aggressive CDN caching
- Lifecycle policies
- Object tiering

---

## 3.4 Abuse & cost hardening

Upload is currently open.

Future hardening:

- Rate limits
- Upload quotas
- Budget ledger table
- Abuse detection signals
- Per-IP flag deduplication

---

## 3.5 Policy, compliance, and operational workflow

Today:

- `/privacy` and `/takedown` are static and intentionally minimal.
- Requests are handled manually via email.

At 10×:

- More formal Terms + Privacy language (especially if monetized)
- Structured takedown intake (tracking, timestamps, audit trail)
- Dedicated abuse reporting flows (rate-limits, enforcement, moderation queues)

This is expected growth, not a surprise.

---

## 3.6 Multi-environment migration discipline

At scale (or with a team):

- schema changes happen more often
- multiple environments (dev/staging/prod) drift if not managed carefully

Future improvements:

- CI check that migrations exist for schema changes
- “migrate on deploy” step (or a dedicated release job)
- a simple migration checklist (review SQL, verify rollback plan, sanity-check indexes)

This is boring work — which is exactly why it matters.

---

# Closing Thought

PepeFinder is intentionally not clever.

It is small.
It is bounded.
It is predictable.

The architecture ensures:

- AI failure does not break search
- Cost spikes are contained
- Search logic is explainable
- Scaling paths are visible
- Moderation remains explicit and operator-controlled

This is not “AI sprinkled on a database.”

It is a constrained system designed to grow without surprising its operator.
