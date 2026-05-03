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

// Hybrid retrieval — blend cosine + BM25 to fix vocab-divergent blind spots
// (query "ordi" vs memory "serveur Dell": same hardware, different words).
// SQL match_memories_cognitive already exposes a vector_weight knob, but its
// FTS branch uses to_tsvector('german', ...) (migration 060), which scores
// near-zero on FR/EN content. We bypass that path by passing vector_weight=1.0
// to SQL (pure cosine relevance, wider candidate pool) and re-rank in TS
// with Okapi BM25 over the candidate content.
const HYBRID_ALPHA_DEFAULT = ((): number => {
  const raw = process.env.MYCELIUM_HYBRID_ALPHA;
  if (raw === undefined) return 0.6;
  const v = parseFloat(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.6;
})();
const CANDIDATE_POOL_MULTIPLIER = 3;
const CANDIDATE_POOL_FLOOR = 30;

function rerankHybrid(
  candidates: MemorySearchResult[],
  query: string,
  alpha: number,
  limit: number
): MemorySearchResult[] {
  if (candidates.length === 0) return candidates;
  // Single-item pool or pure cosine → nothing to re-rank. SQL already
  // returned the cognitive-cosine ordering.
  if (candidates.length <= 1 || alpha >= 1) return candidates.slice(0, limit);

  const bm25 = bm25Score(
    query,
    candidates.map((c) => ({ id: c.id, text: c.content }))
  );
  const bm25Norm = new Map(normalizeScores(bm25).map((s) => [s.id, s.score]));

  // SQL was called with vector_weight=1.0, so `relevance` IS the raw cosine
  // similarity (1 − distance). Min-max within the pool so both signals share
  // scale before blending.
  const cosineNorm = new Map(
    normalizeScores(
      candidates.map((c) => ({ id: c.id, score: c.relevance }))
    ).map((s) => [s.id, s.score])
  );

  // Sort key = hybrid relevance × strength_now × salience. The cognitive
  // multipliers preserve recency/usage/pinned biasing on top of the new
  // keyword+vector blend. We do NOT overwrite `effective_score` on the
  // returned objects — downstream consumers (emitRecalled topScore, the
  // rendered output, telemetry) keep the SQL-supplied cognitive score so
  // existing assertions and dashboards stay stable. The hybrid is purely
  // a re-ranking mechanism.
  const ranked = candidates
    .map((c) => {
      const cn = cosineNorm.get(c.id) ?? 0;
      const bn = bm25Norm.get(c.id) ?? 0;
      const hybridRelevance = alpha * cn + (1 - alpha) * bn;
      return { mem: c, key: hybridRelevance * c.strength_now * c.salience };
    })
    .sort((a, b) => b.key - a.key);

  return ranked.slice(0, limit).map((r) => r.mem);
}

export const recallSchema = z.object({
  query: z.string().describe("What to search for (semantic + keyword)"),
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
      "α — weight of cosine vs BM25 in hybrid relevance (0..1). 1=pure cosine, 0=pure BM25. Default from MYCELIUM_HYBRID_ALPHA env (0.6)."
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
  let effectiveLimit = input.limit;
  let effectiveSpread = input.spread;
  let biasNote = "";
  if (!input.ignore_affect) {
    try {
      const state = await affect.get();
      const bias = AffectService.biasFromState(state);
      effectiveLimit = Math.max(3, Math.min(30, input.limit + bias.k_delta));
      if (bias.spread_wide) effectiveSpread = true;
      if (bias.reason !== "neutral") {
        biasNote = `\n\n[affect] ${bias.reason} → limit ${input.limit}→${effectiveLimit}${effectiveSpread && !input.spread ? ", spread forced on" : ""}`;
      }
    } catch (err) {
      // Affect unreachable → run plain. Don't block the user's query.
      console.error("recall: affect lookup failed (non-fatal):", err);
    }
  }

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
    effectiveLimit
  );

  // ---- Observability: emit a `recalled` memory_event ----------------------
  // The trigger on memory_events fires compute_affect() (migration 062),
  // which reads empty_recalls / low_conf_recalls / zero_hit_ratio from this
  // event stream — see docs/affect-observables.md.
  const topScore = results[0]?.effective_score ?? 0;
  void service.emitRecalled(results.length, topScore, input.query.length, "mcp:recall");

  if (results.length === 0) {
    return { content: [{ type: "text" as const, text: "No matching memories found." }] };
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
  if (input.with_experiences) {
    const overlays = await Promise.all(
      topForOverlay.map((r) => service.experiencesForMemory(r.id, 2))
    );
    topForOverlay.forEach((r, i) => {
      if (overlays[i].length > 0) experiencesByMemory.set(r.id, overlays[i]);
    });
  }

  const formatted = results
    .map((r, i) => {
      const stageMark = r.pinned ? "*" : r.stage === "semantic" ? "S" : "e";
      const head = `${i + 1}. [${r.category}/${stageMark}] score=${r.effective_score.toFixed(3)} (rel=${r.relevance.toFixed(2)} str=${r.strength_now.toFixed(2)} sal=${r.salience.toFixed(2)} ax=${r.access_count})\n   ${r.content}\n   id: ${r.id}${r.tags.length ? " | tags: " + r.tags.join(", ") : ""}`;
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
      .map(
        (n, i) =>
          `${i + 1}. [${n.kind}/${n.category}] link=${n.link_strength.toFixed(2)} ${(n.content ?? "").slice(0, 120)}\n   id: ${n.id}`
      )
      .join("\n\n");
    text += `\n\nAssociated (spreading activation, cross-kind):\n\n${assoc}`;
  }

  const citeNote = citeTrace
    ? `\n\n[cite] emitted used_in_response for ${citedIds.length} memories (trace=${citeTrace.slice(0, 8)}) — CoactivationAgent will pairwise link after 30s debounce.`
    : "";

  return { content: [{ type: "text" as const, text: text + biasNote + citeNote }] };
}
