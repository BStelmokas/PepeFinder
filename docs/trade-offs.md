# PepeFinder — Engineering Trade-offs (Living Document)

This document records **conscious trade-offs** made while building PepeFinder.
It exists to:

- make shortcuts explicit (not accidental),
- preserve architectural intent,
- and show how this MVP could evolve into a serious system.

This file is created **early by design** and updated whenever I cut corners or make a hard call.

---

## 1. Things I Consciously Did _Worse_ to Ship Faster

These are not mistakes — they are **intentional compromises** made to reduce scope, complexity, or time-to-market.

### 1.1 Use `serial` integer IDs instead of UUIDs

**What I did**

- All core tables (`images`, `tags`, `image_tags`) use auto-incrementing integer primary keys.

**Why this is “worse”**

- IDs are guessable.
- Harder to safely expose raw IDs in public APIs at scale.
- UUIDs are more robust for distributed systems and sharding.

**Why I did it anyway**

- Simpler schema and joins.
- Faster iteration and debugging.
- No need for Postgres extensions or extra config.
- IDs are not user-visible in MVP0.

**When to fix**

- Before public uploads or untrusted clients.
- Before cross-region replication or external APIs.

---

### 1.2 No DB-level enforcement of tag normalization rules

**What I did**

- `tags.name` is unique, but the DB does _not_ enforce:
  - lowercase only
  - ASCII only
  - whitespace rules

**Why this is “worse”**

- The database alone cannot guarantee semantic correctness.
- A bug in the app layer _could_ insert malformed tags.

**Why I did it anyway**

- Normalization rules are deliberately frozen and implemented as a **pure app module**.
- Encoding text normalization logic in SQL CHECK constraints is brittle and hard to evolve.
- App-level validation is easier to test and reason about.

**When to fix**

- If multiple ingestion paths appear (external APIs, admin tools).
- If tags become user-generated and adversarial.

---

### 1.3 No migrations history in MVP0 (using `drizzle-kit push`)

**What I did**

- I rely on `drizzle-kit push` instead of versioned migrations.

**Why this is “worse”**

- No historical schema evolution trail.
- Harder to rollback or diff schema changes over time.

**Why I did it anyway**

- MVP0 schema is small and unstable.
- Push is faster and safer during early iteration.
- Reduces cognitive overhead while the domain is still fluid.

**When to fix**

- As soon as schema changes need to be reviewed or deployed incrementally.
- Before collaborating with other engineers.

---

## 2. Things I Consciously Did _Right_ Despite the Cost

These decisions add upfront complexity but dramatically reduce long-term risk.

### 2.1 DB-only search on the request path (no model calls)

**What I did**

- Search ranking is **pure SQL**:
  - deterministic token overlap
  - `COUNT(DISTINCT tag_id)` ranking
  - stable tie-breakers

**Why this is expensive up front**

- Requires careful schema and index design.
- Forces us to think in relational terms early.
- Limits “cool AI tricks” during MVP.

**Why this is correct**

- Search latency is predictable and cheap.
- Zero per-request AI cost.
- Behavior is testable, explainable, and debuggable.
- Search continues working even if AI tagging is disabled.

**Long-term payoff**

- Scales linearly with DB capacity.
- Easy to cache.
- Easy to reason about failures.

---

### 2.2 Worker-only model calls with fail-closed cost caps

**What I did**

- All paid vision/LLM calls:
  - happen only in a background worker
  - are gated by explicit caps and a kill switch
- The request path never calls models.

**Why this is more work**

- Requires async job modeling.
- Forces explicit state handling (`pending / indexed / failed`).
- Adds operational complexity early.

**Why this is correct**

- Cost safety by design, not by policy.
- A broken or expensive model cannot take down search.
- System degrades gracefully under budget pressure.

**Long-term payoff**

- Makes spending auditable and enforceable.
- Enables batch processing and back-pressure.
- Aligns with real production AI systems.

---

### 2.3 Strict tRPC boundary as the only application API

**What I did**

- All application logic lives in tRPC procedures.
- Route handlers are infra-only (auth, health checks, webhooks).
- Server Components call the tRPC server-side caller instead of raw DB access.

**Why this is “slower” initially**

- More boilerplate than calling the DB directly.
- Requires discipline about where logic lives.

**Why this is correct**

- One authoritative API surface.
- Consistent validation, auth, and middleware.
- Clear separation between infrastructure and domain logic.

**Long-term payoff**

- Easier refactors.
- Easier testing of business logic.
- Cleaner mental model for the system.

---

## 3. Things to Fix or Rethink at ~10× Scale

These are **known future pressure points**, not surprises.

### 3.1 Search query shape and indexing strategy

**Current**

- Token → tag → image join with `GROUP BY image_id`.

**At 10× scale**

- Large `IN (...)` clauses for tag IDs may become slow.
- Popular tags could fan out to many images.

**Likely fixes**

- Pre-computed search tables (materialized views).
- Partial indexes on `image_tags` for `status = indexed`.
- Query planner tuning or denormalized counters.

---

### 3.2 Image storage and delivery

**Current**

- `storage_key` is abstract (URL or object key).
- Delivery is out of scope for MVP0.

**At 10× scale**

- Hot images need CDN caching.
- Cold images should move to cheaper storage tiers.

**Likely fixes**

- Explicit storage abstraction (origin vs CDN URL).
- Signed URLs with expiration.
- Tiered storage policies.

---

### 3.3 Tag quality and ontology drift

**Current**

- Flat tags, no hierarchy.
- Confidence stored but not used for ranking.

**At 10× scale**

- Tag explosion and near-duplicates.
- Semantic drift across models or datasets.
- Harder to reason about recall vs precision.

**Likely fixes**

- Canonical tag sets or aliases.
- Tag versioning or model-version awareness.
- Confidence-weighted or hybrid ranking strategies.

---

## Closing Note

Every system ships with compromises.

What matters is not avoiding them, but:

- **making them explicit**, and
- **knowing exactly when and why to undo them**.

This document exists to prove that PepeFinder’s architecture is intentional —
not accidental, not cargo-culted, and not naïve.
