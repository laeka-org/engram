# Engram by Laeka

The cognitive memory engine of the Laeka stack. A hard fork of [mycelium](https://github.com/Dewinator/mycelium) rebuilt around production-grade retrieval, write safety, and scoped destructive operations.

## Why a fork

Mycelium upstream provides a strong foundation: persistent memory layer for LLM agents, served over MCP, Supabase pgvector backend, local-first deployment. We forked because empirical stress-testing on real production data revealed structural design holes that block production usage:

1. **Cosine top-K alone misses vocabulary-divergent matches** — query "ordi" finds nothing while a "serveur Dell" memory exists for the same hardware. Fixed by hybrid BM25 + cosine retrieval.
2. **Cognitive multipliers swamp retrieval scoring** — `(α·cosine + (1−α)·bm25) × strength × salience` collapses to whichever memory accumulated the most activation, regardless of relevance. Refactor to additive log-scale boost in progress.
3. **Concurrent `remember` calls silently lose data** — parallel MCP writes return identical UUIDs, ~50% data loss. Fix in progress.
4. **Near-duplicate writes silently dedup to existing UUIDs** — caller believes success on new content, receives existing memory. Fix in progress.
5. **Destructive tools (`dedup_memories`, `forget_weak_memories`) operate globally with no scoping** — production hazard. Adding `scope_tag`, `scope_project`, `scope_ids`, `dry_run` defaults.
6. **Empty query crashes the recall SQL pipeline** — input validation gap. Fixed via zod schema enforcement.

Documented in `handoffs/2026-05-03-mycelium-stress-test-shipped-code-f2.md` (Laeka-brain repo).

## Lineage and attribution

Engram retains full Git history of Mycelium. The upstream remote (`https://github.com/Dewinator/mycelium.git`) is preserved as `upstream` for selective merging of universal fixes back into Mycelium proper as PRs (good-citizen contribution).

Mycelium core architecture, MCP tool schemas, Supabase migrations, and cognitive layer concepts remain authored by the original Mycelium maintainers. Engram extends and hardens; it does not replace.

## Roadmap

### Phase 1 — Fork foundation (2026-05-03, current)
- [x] Hard fork from mycelium-mcp
- [x] Hybrid BM25 + cosine retrieval (commit `93176c0`)
- [x] Stress-test report (14 findings, 6 HIGH severity)
- [x] Brand identity established
- [ ] Score formula refactor R1 (additive log-scale)
- [ ] Empty query validation R6
- [ ] Scoping params for destructive tools R2

### Phase 2 — Production hardening
- [ ] Concurrent write safety R3 (server-side write queue)
- [ ] Near-dup dedup transparency R4 (`force_new`, `dedup_to_existing` flags)
- [ ] Recall response format param R4 (`metadata` / `snippet` / `full`)
- [ ] Affect-narrowing transparency (HIGH-2 — explicit `actual_limit_applied` field)

### Phase 3 — Public surface
- [ ] Landing at `laeka.ai/engram`
- [ ] npm package `engram-mcp-server` published
- [ ] PR upstream selectively the universal fixes (good citizen)

### Phase 4 — Differentiation
- [ ] Cross-lingual embedding strategy (R3 expanded)
- [ ] Temporal awareness in recall scoring (R5)
- [ ] Memory-level conflict detection (currently trait-only)
- [ ] Activation decay caps (R5 expanded)

## Working directory

Engram lives at `/home/bhairavi/Documents/engram/`. Mycelium upstream clone remains at `/home/bhairavi/Documents/mycelium-mcp/` for reference only — no parallel development.

## Brand

Engram by Laeka. Hosted at `laeka.ai/engram`. Part of the Laeka cognitive stack alongside laeka-mail, OmniQ lenses, and the 5-layer doctrine.

The name *engram* refers to the neuroscientific concept of a memory trace stored in neural substrate (Richard Semon, 1904). Hubbard's later appropriation in Dianetics has no relation to the legitimate scientific term.
