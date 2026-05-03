# Engram retrieval scoring

The recall path scores candidates with an **additive log-scale** formula
that blends semantic similarity, keyword overlap, and bounded cognitive
history boosts. The previous Mycelium formula multiplied cognitive
multipliers, which empirically allowed runaway-multiplier memories
(canonical drift alert with `strength=55, ax=99`) to dominate every
generic query, swamping the BM25 keyword gain on real DBs.

## Formula

```
final = (α · cosine_norm) + ((1 − α) · bm25_norm)
      + log(1 + strength_now)            · β
      + log(1 + min(access_count, 20))   · γ
      + exp(-age_days / 30) · recency_weight
```

- **`cosine_norm`** — pgvector cosine similarity (`1 − distance`),
  min-max normalized within the candidate pool.
- **`bm25_norm`** — Okapi BM25 over the candidate pool, min-max
  normalized. FR + EN stopword filter, Unicode-safe tokenizer
  (preserves accents).
- **`strength_now`** — time-decayed strength from
  `match_memories_cognitive` (Mycelium migration 060).
- **`access_count`** — total recalls since memory creation.
  **Capped at 20** (R5/MED-4) so that very high-activation memories
  don't keep dominating recall via the feedback loop where being
  recalled once raises the chance of being recalled again.
- **`age_days`** — `(now − created_at) / 86_400_000`, lower-bounded at 0.
- **`recency_weight`** — caller-supplied or auto-detected (see below).
  Defaults to 0 (no recency boost). When > 0, fresher memories get a
  bounded `exp(-age_days/30) · weight` bonus.
- **`α, β, γ`** — env-configurable (see below).

The log compression caps cognitive boost: even a memory with
`strength=60, ax=100` contributes at most
`log(61)·0.1 + log(min(100,20)+1)·0.05 ≈ 0.41 + 0.15 = 0.56`, vs the
hybrid term which is `[0, 1]` and dominates ranking. Cognitive
history thus *nudges* ranking but cannot *override* a strong
semantic match.

### Recency auto-detection (R5 / MED-2)

When `recency_weight` is left at its default 0 AND the query carries
an FR or EN temporal keyword, recall sets an implicit `recency_weight = 0.5`
for the call only. Caller-supplied values (any non-zero) always win and
disable auto-detection.

Auto-detected keyword set (single regex, < 1ms per query):

- **FR** — `récemment`, `récent` / `récents` / `récente` / `récentes`,
  `hier`, `aujourd'hui` / `aujourd hui`, `cette semaine`,
  `la semaine passée`.
- **EN** — `recent`, `recently`, `today`, `yesterday`,
  `past week`, `last week`.

The structured `_meta.recency_applied` field on the recall response
exposes both the effective weight and whether it was auto-detected
(`{ weight: 0.5, auto_detected: true }`), so automated callers can
audit the behaviour without parsing text.

## Env vars

| Variable                   | Default | Range          | Effect                                                                                  |
|----------------------------|---------|----------------|-----------------------------------------------------------------------------------------|
| `ENGRAM_HYBRID_ALPHA`      | `0.6`   | `[0.0, 1.0]`   | α — cosine vs BM25 weight. `1.0` = pure cosine, `0.0` = pure BM25.                      |
| `ENGRAM_STRENGTH_BETA`     | `0.1`   | `[0.0, ∞)`     | β — coefficient on `log(1+strength_now)`. `0` disables the strength boost entirely.     |
| `ENGRAM_ACTIVATION_GAMMA`  | `0.05`  | `[0.0, ∞)`     | γ — coefficient on `log(1+access_count)`. `0` disables the activation boost entirely.   |
| `MYCELIUM_HYBRID_ALPHA`    | —       | `[0.0, 1.0]`   | Legacy alias; honored only when `ENGRAM_HYBRID_ALPHA` is unset.                          |

## Re-rank pipeline

1. SQL `match_memories_cognitive(query_embedding, query_text, ...)` is
   called with `vector_weight=1.0`. This bypasses the SQL FTS branch
   (which uses `to_tsvector('german', ...)` and scores ≈ 0 for FR/EN
   content per migration 060) and returns a candidate pool of
   `max(limit × 3, 30)` rows ordered by pure cosine relevance.
2. The candidate pool is re-ranked in TypeScript with the formula above.
3. The top-`limit` rows are returned, with `effective_score` overwritten
   to the additive value so rendered output and `emitRecalled` telemetry
   reflect the new ranking score.

Single-item candidate pools short-circuit the re-rank entirely and
preserve SQL's `effective_score` — there is no re-ranking signal to
extract from a one-row pool.

## Why this fixes HIGH-1

Stress-test 2026-05-03 (handoff
`2026-05-03-mycelium-stress-test-shipped-code-f2.md` in the laeka-brain
repo) observed:

- `recall(query="ordi Dell", limit=3)` on real Mycelium DB: Dell memory
  absent from top-3 even with the hybrid BM25 fix. Top hits were old
  handoffs with high `strength × access_count` product.
- The previous formula `hybrid × strength_now × salience` allowed
  `strength=55, ax=99` to multiply the hybrid term by orders of
  magnitude, drowning the BM25 keyword bonus that should have surfaced
  the Dell memory.

Switching `× strength` → `+ log(1+strength)·β` and removing the
multiplicative `salience` gate compresses cognitive history into a
bounded additive contribution. A keyword-perfect match wins on the
hybrid term; cognitive history only breaks ties.

## Tuning notes

- **`β = 0`** removes the strength contribution. Useful when running
  fresh databases where activation history is unstable.
- **`α = 1, β > 0, γ > 0`** is "cognitive cosine" — pure semantic match
  with bounded recency / usage nudge. Closest to the legacy multiplicative
  shape, but additive.
- **`α = 0`** is pure BM25 with cognitive boosts — useful for keyword-
  dominant workloads (file paths, code identifiers, exact names).
- Increasing `β, γ` past their defaults amplifies cognitive history; do
  not exceed `~0.3` each unless the deployment has a specific recency
  bias rationale, since over-amplification reintroduces the swamp.

## See also

- `mcp-server/src/tools/recall.ts` — header comment derives the formula
  inline next to the implementation.
- `mcp-server/src/services/bm25.ts` — Vanilla TS Okapi BM25, FR+EN
  stopwords, Unicode-safe tokenizer.
- `mcp-server/src/__tests__/additive-scoring.test.ts` — empirical
  proofs that additive log-scale defangs runaway-multiplier memories.
