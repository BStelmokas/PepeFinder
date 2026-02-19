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

## Current State (Post-MVP2, Production-Ready)

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
- Manual Reddit / Pinterest ingestion (archived datasets, 12k+ processed)
- Production health endpoint
- Responsive UI (desktop + mobile refinements)
- Download endpoint with forced attachment streaming
- Per-image flag toggle with DB-backed moderation signal
- Operator moderation script (unlist/delete by flag threshold)
- Clean deployment to Vercel + managed Postgres
- Migration-based schema evolution (generate + migrate workflow)
- Metadata + OpenGraph cleanup (no scaffold artifacts)
- Static `/privacy` and `/takedown` pages
- Robots / sitemap hygiene

Search never calls the model.
Model calls never happen on the request path.
Cost safety is architectural, not optional.

---

# 1) Things I consciously did worse to ship faster

These are deliberate compromises.

## 1.1 Integer `serial` IDs instead of UUIDs

**Decision**
Used `serial` primary keys.

**Trade-off**

- Guessable IDs.
- Not ideal for public multi-tenant APIs.

**Why**

- Simpler joins.
- Faster debugging.
- Lower cognitive overhead early.
- IDs are not a security boundary here.

**When to fix**

- If accounts or public APIs are introduced.

---

## 1.2 Normalization rules live in code, not SQL

**Decision**
All tag normalization and tokenization live in a pure TypeScript module.

**Trade-off**

- The DB does not enforce ASCII / hyphen / punctuation invariants.

**Why**

- Encoding these rules in SQL constraints would be brittle.
- A single pure, tested module prevents semantic drift.
- All ingestion paths share the same logic.

**Extensions added pre-production**

- Stopword removal at token boundaries (`a`, `an`, `the`, `and`)
- Hyphen expansion invariant (`film-noir` → `film` + `noir`)
- Idempotent backfill scripts for historical data

This keeps search deterministic while improving recall.

---

## 1.3 Postgres-backed queue (no Redis, no broker)

**Decision**
Used Postgres (`tag_jobs`) for job queueing.

**Trade-off**

- Not horizontally optimized.
- No advanced retry backoff.
- Single worker by design.

**Why**

- Minimal infra.
- Strong transactional guarantees.
- `FOR UPDATE SKIP LOCKED` is sufficient at this scale.
- Operational simplicity > premature distribution.

---

## 1.4 Cursor pagination instead of offset pagination

**Decision**
Keyset pagination via deterministic cursor tuple:
(match_count, created_at, id)

**Trade-off**

- Cannot jump to arbitrary page numbers.
- Cursor state must be preserved.

**Why**

- Avoids offset scan degradation.
- Ensures stable ordering.
- Aligns with deterministic ranking semantics.

---

## 1.5 Caption tokens indexed as tags

**Decision**
Caption tokens are inserted into the global tag dictionary.

**Trade-off**

- Caption words share namespace with structured tags.
- No separate text-search engine.

**Why**

- Preserves deterministic ranking.
- Avoids introducing a second search subsystem.
- Improves rediscoverability without semantic drift.

---

## 1.6 48 results per page

**Decision**
Return up to 48 results per page.

**Trade-off**

- Fewer results per scroll compared to dense image search engines.
- Slight increase in pagination requests for deep exploration.

**Why**

- Divides cleanly across responsive grid layouts (2 / 3 / 4 columns).
- Users likely already have an image in mind and it should trend toward the top.
- Reduces DOM weight and improves mobile responsiveness.
- Keeps initial payload size modest.

---

## 1.7 Soft moderation via flag counter

**Decision**
`flag_count` integer, toggleable per browser.

**Trade-off**

- No authentication.
- No per-user DB dedupe.

**Why**

- Keeps system small.
- Avoids scope explosion.
- Provides operator signal without user accounts.

---

## 1.8 Minimal contact surface (mailto + static pages)

**Decision**
Shipped `/privacy`, `/takedown`, and footer contact link.

**Trade-off**

- Manual triage.
- No ticket system.

**Why**

- Clear human backstop.
- Production hygiene without product creep.

---

## 1.9 Minor client JS for tag panel layout

**Decision**
Used client-side measurement so tag panel height matches image panel.

**Trade-off**

- Small JS addition.
- Requires careful resize handling.

**Why**

- Pure CSS cannot reliably bind height to intrinsic image aspect ratio.
- Keeps detail page compact and usable.

---

## 1.10 Migration-based DB evolution

**Decision**
Use `drizzle-kit generate` + `drizzle-kit migrate`.

**Trade-off**

- Slower iteration.
- Requires discipline.

**Why**

- Auditable schema history.
- Deterministic deploys.
- Production-grade hygiene.

---

# 2) Things I consciously did right despite extra effort

---

## 2.1 DB-only deterministic search

- No model calls.
- No external services.
- Pure SQL joins + aggregation.
- Fully explainable ranking.

Eligibility:
at least one distinct token match.

Ranking:
match_count DESC
created_at DESC
id DESC

Predictable latency.
Predictable cost.

---

## 2.2 Worker-only model calls (fail-closed)

All AI calls:

- Occur in separate process.
- Enforce pause + daily caps + strict timeout.
- Never block user requests.

If model fails:

- Job fails.
- Image fails.
- Search continues.

Cost safety is structural.

---

## 2.3 SHA-256 dedupe everywhere

- Unique sha256 constraint.
- Deterministic storage keys.
- Idempotent ingestion.

Safe to re-run scripts.
No duplicate tagging jobs.

---

## 2.4 Manual Reddit / Pinterest ingestion (no crawler infra)

- Batch-only ingestion.
- Fixed archives.
- No background scraping.
- Fully reproducible runs.

Small system stays small.

---

## 2.5 Frozen normalization module (with tests)

Rules:

- ASCII-only lowercase
- Strip non-ASCII
- Strip punctuation (preserve inner hyphens)
- Replace punctuation with spaces
- Deduplicate tokens
- Remove stopwords

Pure. Deterministic. Shared everywhere.

Prevents semantic drift.

---

## 2.6 Attachment-based download endpoint

Forces `Content-Disposition: attachment`.

Cross-browser reliable.
Object-storage independent.
Correct UX > theoretical purity.

---

## 2.7 Operator moderation script

CLI-based moderation.

- Unlist
- Delete
- Dry-run preview
- Threshold safety guard

Operational workflow > premature admin UI.

---

## 2.8 Metadata and indexing polish

Cleaned up:

- Scaffold titles/descriptions
- OpenGraph + Twitter metadata
- Favicon/icons
- Robots + sitemap hygiene

Low effort.
High trust signal.

---

# 3) Known Pressure Points at 10× Scale

---

## 3.1 Hot-tag fan-out

Wide joins on popular tags.
`COUNT(DISTINCT)` cost grows.

Future:

- Caching
- Materialized edges
- Precomputed match counts
- External search engine (if needed)

---

## 3.2 Tag drift & ontology management

Currently:

- Flat dictionary.
- No alias groups.
- No model version tracking.

Future:

- Alias table.
- Model-versioned tagging.
- Retagging pipeline.

---

## 3.3 Storage delivery & thumbnails

Currently:

- Direct object URLs.
- No thumbnail pipeline.

Future:

- CDN optimization.
- Thumbnail generation.
- Lifecycle policies.

---

## 3.4 Abuse & cost hardening

Upload is open.

Future:

- Rate limits.
- Quotas.
- Abuse detection.
- Per-IP flag dedupe.

---

# Closing Thought

PepeFinder is meant to be a small, bounded, predictable product. It is a tool that is meant to be useful, rather than look useful.

It demonstrates:

- Controlled AI integration
- Deterministic search
- Idempotent ingestion
- Cost safety
- Explicit trade-offs
- Production-minded discipline

It is a system designed to grow without surprising its operator.
