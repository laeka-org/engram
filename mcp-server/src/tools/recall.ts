import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { MemoryService } from "../services/supabase.js";
import { AffectService } from "../services/affect.js";
import type { ProjectService } from "../services/projects.js";
import type { MemorySearchResult } from "../types/memory.js";
import { bm25Score, normalizeScores } from "../services/bm25.js";

// Layer-0 (Bedrock) + Layer-1 (per-role) recall — opt-in via env flag.
// When MYCELIUM_PRIVATE_BY_DEFAULT=1, recall scopes results to the agent's
// active project, with pinned memories (Bedrock) still surfacing globally.
// Without the flag, behaviour is unchanged: every memory is visible.
const PRIVATE_BY_DEFAULT = process.env.MYCELIUM_PRIVATE_BY_DEFAULT === "1";

// Hybrid retrieval (R1 additive log-scale) — blend cosine + BM25 to fix
// vocab-divergent blind spots (query "ordi" vs memory "serveur Dell": same
// hardware, different words). SQL match_memories_cognitive already exposes
// a vector_weight knob, but its FTS branch uses to_tsvector('german', ...)
// (migration 060), which scores near-zero on FR/EN content. We bypass that
// path by passing vector_weight=1.0 to SQL (pure cosine relevance, wider
// candidate pool) and re-rank in TS with Okapi BM25 over the candidate
// content.
//
// Score formula (post-stress-test 2026-05-03 HIGH-1 fix):
//   final = (α·cosine_norm + (1−α)·bm25_norm)
//         + log(1 + strength_now)  · β
//         + log(1 + access_count)  · γ
//
// Why additive log-scale instead of multiplicative cognitive multipliers:
// the previous `hybrid × strength_now × salience` allowed runaway-multiplier
// memories (e.g. canonical drift alert with strength=55, ax=99) to dominate
// every generic query — the BM25 keyword gain was swamped on real DBs. Log
// compression caps the boost (log(61)·0.1 ≈ 0.41, log(101)·0.05 ≈ 0.23) so
// cognitive history nudges ranking but cannot override semantic match.
//
// Env-configurable parameters:
//   ENGRAM_HYBRID_ALPHA      — α, cosine vs BM25 weight in [0,1]   (default 0.6)
//                              (also accepts MYCELIUM_HYBRID_ALPHA for back-compat)
//   ENGRAM_STRENGTH_BETA     — β, log(1+strength_now) coefficient  (default 0.1)
//   ENGRAM_ACTIVATION_GAMMA  — γ, log(1+access_count) coefficient  (default 0.05)
function readEnvFloat(name: string, fallback: number, min = 0, max = Infinity): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v < min || v > max) return fallback;
  return v;
}

const HYBRID_ALPHA_DEFAULT = ((): number => {
  // ENGRAM_HYBRID_ALPHA wins; MYCELIUM_HYBRID_ALPHA accepted as legacy alias.
  const raw =
    process.env.ENGRAM_HYBRID_ALPHA ?? process.env.MYCELIUM_HYBRID_ALPHA;
  if (raw === undefined) return 0.6;
  const v = parseFloat(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.6;
})();
const STRENGTH_BETA_DEFAULT = readEnvFloat("ENGRAM_STRENGTH_BETA", 0.1, 0);
const ACTIVATION_GAMMA_DEFAULT = readEnvFloat("ENGRAM_ACTIVATION_GAMMA", 0.05, 0);
const CANDIDATE_POOL_MULTIPLIER = 3;
const CANDIDATE_POOL_FLOOR = 30;

// R5 — temporal recency boost + activation cap (MED-2 + MED-4).
// Recency uses an exponential half-life of ~30 days (RECENCY_TAU_DAYS),
// so a 30-day-old memory contributes exp(-1) ≈ 0.37 of its weight, a
// 90-day-old one ≈ 0.05. Activation contribution is capped at 20: past
// that point further accesses no longer boost the score, breaking the
// feedback loop where high-activation memories stay high-activation
// because they keep getting recalled (stress-test §MED-4).
const RECENCY_TAU_DAYS = 30;
const ACTIVATION_CAP = 20;

// Auto-detect "the user is asking about recent stuff" — single regex,
// case-insensitive, FR + EN. Performance budget per brief: < 1ms.
const TEMPORAL_INTENT_RE =
  /\b(récemment|récent[es]?|hier|aujourd['’ ]?hui|cette\s+semaine|la\s+semaine\s+passée|recent(ly)?|today|yesterday|past\s+week|last\s+week)\b/iu;

export function detectTemporalIntent(query: string): boolean {
  return TEMPORAL_INTENT_RE.test(query);
}

function ageDays(createdAt: string, nowMs: number): number {
  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs)) return 0;
  return Math.max(0, (nowMs - createdMs) / 86_400_000);
}

export function rerankHybrid(
  candidates: MemorySearchResult[],
  query: string,
  alpha: number,
  limit: number,
  beta: number = STRENGTH_BETA_DEFAULT,
  gamma: number = ACTIVATION_GAMMA_DEFAULT,
  recencyWeight: number = 0,
  nowMs: number = Date.now()
): MemorySearchResult[] {
  if (candidates.length === 0) return candidates;
  // Single-item pool — nothing to re-rank. Preserve SQL's effective_score
  // and ordering for downstream telemetry / pre-existing test assertions.
  if (candidates.length <= 1) return candidates.slice(0, limit);

  // BM25 only matters when α < 1; skip the work when caller asked for pure
  // cosine to save tokenisation + IDF computation on every hit.
  const bm25Norm =
    alpha < 1
      ? new Map(
          normalizeScores(
            bm25Score(
              query,
              candidates.map((c) => ({ id: c.id, text: c.content }))
            )
          ).map((s) => [s.id, s.score])
        )
      : new Map<string, number>();

  // SQL was called with vector_weight=1.0, so `relevance` IS the raw cosine
  // similarity (1 − distance). Min-max within the pool so both signals share
  // scale before blending.
  const cosineNorm = new Map(
    normalizeScores(
      candidates.map((c) => ({ id: c.id, score: c.relevance }))
    ).map((s) => [s.id, s.score])
  );

  // Additive sort key — see header comment for derivation.
  // Activation contribution is capped at 20 (R5/MED-4) to break the feedback
  // loop where high-ax memories stay high-ax because they keep getting picked.
  // Recency adds an optional exp(-age_days/τ)·recencyWeight term (R5/MED-2).
  const ranked = candidates
    .map((c) => {
      const cn = cosineNorm.get(c.id) ?? 0;
      const bn = bm25Norm.get(c.id) ?? 0;
      const hybrid = alpha * cn + (1 - alpha) * bn;
      const strengthBoost = Math.log(1 + Math.max(c.strength_now, 0)) * beta;
      const cappedAx = Math.min(Math.max(c.access_count, 0), ACTIVATION_CAP);
      const activationBoost = Math.log(1 + cappedAx) * gamma;
      const recencyBoost =
        recencyWeight > 0
          ? Math.exp(-ageDays(c.created_at, nowMs) / RECENCY_TAU_DAYS) *
            recencyWeight
          : 0;
      const score = hybrid + strengthBoost + activationBoost + recencyBoost;
      // Overwrite effective_score so rendered output + emitRecalled topScore
      // reflect the new ranking value. The old multiplicative score is gone
      // by design; pre-existing tests asserting that specific value have
      // been updated to the additive equivalent.
      return { mem: { ...c, effective_score: score }, key: score };
    })
    .sort((a, b) => b.key - a.key);

  return ranked.slice(0, limit).map((r) => r.mem);
}

export const recallSchema = z.object({
  query: z
    .string()
    .min(1, "Query cannot be empty")
    .max(2000, "Query too long, max 2000 chars")
    .describe("What to search for (semantic + keyword)"),
  category: z
    .enum(["general", "people", "projects", "topics", "decisions"])
    .optional()
    .describe("Filter by category"),
  limit: z.number().optional().default(10).describe("Max results to return"),
  vector_weight: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(HYBRID_ALPHA_DEFAULT)
    .describe(
      "α — weight of cosine vs BM25 in hybrid relevance (0..1). 1=pure cosine, 0=pure BM25. Default from ENGRAM_HYBRID_ALPHA env (0.6). Cognitive boosts log(1+strength_now)·β + log(1+access_count)·γ are added on top — see recall.ts header for the additive log-scale formula."
    ),
  spread: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include associated memories via spreading activation"),
  with_experiences: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "For each top hit, also surface up to 2 linked past experiences (lived knowledge: 'how did it go last time?')"
    ),
  ignore_affect: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Disable affective biasing (dev/eval mode). Normally recall is modulated by agent_affect — high frustration widens search, high satisfaction narrows it."
    ),
  cite: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Set true when the retrieved memories will actually inform the response. Emits one `used_in_response` event per top-5 hit with a shared trace_id — the CoactivationAgent then Hebbian-links them pairwise. Opt-in to keep signal quality: purely exploratory recalls should leave this off."
    ),
  format: z
    .enum(["metadata", "snippet", "full"])
    .optional()
    .default("snippet")
    .describe(
      "Output verbosity. metadata: id/score/category/tags/created_at/strength/ax only — no content body, lowest tokens, also skips experiences fetch. snippet (default): content truncated to 200 chars + ellipsis if longer. full: complete content (legacy behavior, opt-in for high-detail recalls — large memories may exceed caller context budget)."
    ),
  recency_weight: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0)
    .describe(
      "R5/MED-2 — temporal recency boost coefficient (0..1, default 0). When > 0, adds exp(-age_days/30)·recency_weight to each candidate's score, surfacing fresh memories. If left at 0, recall auto-detects temporal intent in the query (FR: récemment/hier/aujourd'hui/cette semaine; EN: recent/recently/today/yesterday/past week) and applies an implicit weight of 0.5. Set explicitly to override either way."
    ),
});

export async function recall(
  service: MemoryService,
  affect: AffectService,
  projects: ProjectService,
  agentLabel: string,
  input: z.infer<typeof recallSchema>
) {
  // ---- Scope resolution ---------------------------------------------------
  // Behind MYCELIUM_PRIVATE_BY_DEFAULT, restrict recall to the agent's L1 +
  // global Bedrock (pinned). Without the flag, scope is null = global = old
  // behaviour. Lookup is non-fatal: if the agent has no active project, we
  // fall back to global recall and the agent sees everything.
  let scope: { projectId: string | null; includePinnedGlobal?: boolean } | undefined;
  if (PRIVATE_BY_DEFAULT) {
    try {
      const projectId = await projects.activeProjectId(agentLabel);
      if (projectId) scope = { projectId, includePinnedGlobal: true };
    } catch (err) {
      console.error("recall: scope lookup failed (non-fatal, falling back to global):", err);
    }
  }

  // ---- Affective biasing --------------------------------------------------
  // Pull the current state and translate it into small deltas on k and
  // spread behaviour. Failure to read affect is non-fatal (returns null).
  // R5 / HIGH-2 — capture affectMeta so the response can expose the actual
  // limit applied + structured affect_state alongside the human-readable
  // footer. Automated callers should read response._meta, not parse text.
  let effectiveLimit = input.limit;
  let effectiveSpread = input.spread;
  let biasNote = "";
  let affectMeta:
    | {
        satisfaction: number;
        reason: string;
        k_delta: number;
        score_threshold: number | null;
        spread_wide: boolean;
      }
    | null = null;
  if (!input.ignore_affect) {
    try {
      const state = await affect.get();
      const bias = AffectService.biasFromState(state);
      effectiveLimit = Math.max(3, Math.min(30, input.limit + bias.k_delta));
      if (bias.spread_wide) effectiveSpread = true;
      if (bias.reason !== "neutral") {
        biasNote = `\n\n[affect] ${bias.reason} → limit ${input.limit}→${effectiveLimit}${effectiveSpread && !input.spread ? ", spread forced on" : ""}`;
        affectMeta = {
          satisfaction: state.satisfaction,
          reason: bias.reason,
          k_delta: bias.k_delta,
          score_threshold: bias.score_threshold,
          spread_wide: bias.spread_wide,
        };
      }
    } catch (err) {
      // Affect unreachable → run plain. Don't block the user's query.
      console.error("recall: affect lookup failed (non-fatal):", err);
    }
  }

  // ---- Temporal recency (R5 / MED-2) -------------------------------------
  // recency_weight=0 (default) + temporal-keyword query → implicit 0.5.
  // Caller can force recency_weight=0 explicitly by setting it; we only
  // auto-detect when the value is exactly the schema default.
  const recencyAutoDetected =
    input.recency_weight === 0 && detectTemporalIntent(input.query);
  const recencyWeight = recencyAutoDetected ? 0.5 : input.recency_weight;

  // Pull a wider candidate pool with pure-cosine relevance (vector_weight=1.0
  // bypasses migration 060's german-FTS branch), then re-rank in TS with BM25.
  const poolSize = Math.max(
    effectiveLimit * CANDIDATE_POOL_MULTIPLIER,
    CANDIDATE_POOL_FLOOR
  );
  const candidates = await service.search(
    input.query,
    input.category,
    poolSize,
    1.0,
    scope
  );
  const results = rerankHybrid(
    candidates,
    input.query,
    input.vector_weight,
    effectiveLimit,
    /* beta */ undefined,
    /* gamma */ undefined,
    recencyWeight
  );

  // ---- Observability: emit a `recalled` memory_event ----------------------
  // The trigger on memory_events fires compute_affect() (migration 062),
  // which reads empty_recalls / low_conf_recalls / zero_hit_ratio from this
  // event stream — see docs/affect-observables.md.
  const topScore = results[0]?.effective_score ?? 0;
  void service.emitRecalled(results.length, topScore, input.query.length, "mcp:recall");

  // ---- R5 / HIGH-2 — structured response metadata ------------------------
  // _meta surfaces what affect actually did + what recency was applied so
  // automated callers don't have to parse the human footer. Always present
  // (even on empty results, so downstream code can rely on the shape).
  const _meta = {
    requested_limit: input.limit,
    actual_limit_applied: effectiveLimit,
    affect_narrowed: effectiveLimit < input.limit,
    affect_state: affectMeta,
    recency_applied:
      recencyWeight > 0
        ? { weight: recencyWeight, auto_detected: recencyAutoDetected }
        : null,
  };

  if (results.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No matching memories found." }],
      _meta,
    };
  }

  // Rehearsal (testing effect) + Hebbian co-activation of the top results.
  const topIds = results.map((r) => r.id);
  const citedIds = topIds.slice(0, Math.min(5, topIds.length));
  const citeTrace = input.cite && citedIds.length >= 2 ? randomUUID() : null;
  await Promise.all([
    service.touch(topIds),
    service.coactivate(citedIds),
    citeTrace ? service.emitUsedInResponse(citedIds, citeTrace) : Promise.resolve(),
  ]);

  // Spreading activation: surface neighbors that weren't in the direct hits.
  // Phase 3: cross-kind spread walks memory_links AND experience_memory_links
  // so experiences linked to top hits surface as typed neighbors. Seed is
  // the top hit (single seed = canonical entry into the cross-graph;
  // multi-seed merge would need separate aggregation later).
  const crossNeighbors = effectiveSpread && topIds.length > 0
    ? await service.spreadCross("memory", topIds[0], 5)
    : [];

  // Cross-layer lived-knowledge overlay: pull linked experiences for the
  // top results in parallel. Non-fatal if migration 016 isn't applied.
  const topForOverlay = results.slice(0, Math.min(5, results.length));
  const experiencesByMemory = new Map<string, Array<{
    id: string; summary: string; outcome: string;
    difficulty: number; valence: number; weight: number; created_at: string;
  }>>();
  // Skip experiences fetch in metadata mode — they're not rendered, no point
  // paying the network cost.
  if (input.with_experiences && input.format !== "metadata") {
    const overlays = await Promise.all(
      topForOverlay.map((r) => service.experiencesForMemory(r.id, 2))
    );
    topForOverlay.forEach((r, i) => {
      if (overlays[i].length > 0) experiencesByMemory.set(r.id, overlays[i]);
    });
  }

  // Output verbosity branches (R4 partial — MED-5 from stress-test handoff
  // 2026-05-03). metadata = id/score/tags/timestamp only; snippet (default) =
  // 200-char body cap + ellipsis; full = legacy behavior, opt-in for callers
  // that genuinely need full memory content.
  const SNIPPET_MAX = 200;
  const formatted = results
    .map((r, i) => {
      const stageMark = r.pinned ? "*" : r.stage === "semantic" ? "S" : "e";
      const stats = `[${r.category}/${stageMark}] score=${r.effective_score.toFixed(3)} (rel=${r.relevance.toFixed(2)} str=${r.strength_now.toFixed(2)} sal=${r.salience.toFixed(2)} ax=${r.access_count})`;
      const tagSuffix = r.tags.length ? " | tags: " + r.tags.join(", ") : "";

      if (input.format === "metadata") {
        return `${i + 1}. ${stats}\n   id: ${r.id} | created: ${r.created_at}${tagSuffix}`;
      }

      const body =
        input.format === "full" || r.content.length <= SNIPPET_MAX
          ? r.content
          : r.content.slice(0, SNIPPET_MAX) + "...";
      const head = `${i + 1}. ${stats}\n   ${body}\n   id: ${r.id}${tagSuffix}`;

      const exps = experiencesByMemory.get(r.id);
      if (!exps || exps.length === 0) return head;
      const lived = exps
        .map(
          (e) =>
            `     ↳ [${e.outcome}] val=${e.valence.toFixed(2)} diff=${e.difficulty.toFixed(2)}: ${e.summary.slice(0, 140)}`
        )
        .join("\n");
      return `${head}\n   lived experience:\n${lived}`;
    })
    .join("\n\n");

  let text = `Found ${results.length} memories:\n\n${formatted}`;

  if (crossNeighbors.length > 0) {
    const assoc = crossNeighbors
      .map((n, i) => {
        const head = `${i + 1}. [${n.kind}/${n.category}] link=${n.link_strength.toFixed(2)}`;
        if (input.format === "metadata") {
          return `${head}\n   id: ${n.id}`;
        }
        return `${head} ${(n.content ?? "").slice(0, 120)}\n   id: ${n.id}`;
      })
      .join("\n\n");
    text += `\n\nAssociated (spreading activation, cross-kind):\n\n${assoc}`;
  }

  const citeNote = citeTrace
    ? `\n\n[cite] emitted used_in_response for ${citedIds.length} memories (trace=${citeTrace.slice(0, 8)}) — CoactivationAgent will pairwise link after 30s debounce.`
    : "";

  return {
    content: [{ type: "text" as const, text: text + biasNote + citeNote }],
    _meta,
  };
}
