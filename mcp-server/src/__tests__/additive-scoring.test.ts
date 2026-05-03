import { test } from "node:test";
import assert from "node:assert/strict";
import { rerankHybrid } from "../tools/recall.js";
import type { MemorySearchResult } from "../types/memory.js";

// ---------------------------------------------------------------------------
// R1 additive log-scale scoring — proofs that the new formula
//   final = (α·cosine_norm + (1−α)·bm25_norm)
//         + log(1 + strength_now) · β
//         + log(1 + access_count) · γ
// fixes HIGH-1 from stress-test 2026-05-03 (multiplier swamp on real DB).
//
// Three cases:
//   1. high-strength low-hybrid does NOT dominate low-strength high-hybrid
//      (proof vs old multiplicative `hybrid × strength × salience`)
//   2. β=0 + γ=0 collapses to pure hybrid (cognitive boosts disabled)
//   3. defaults β=0.1 + γ=0.05 produce equilibrated ranking on a synthetic
//      Saphi-bug dataset (Dell memory in top-3 against decayed ordi memories)
// ---------------------------------------------------------------------------

function makeHit(o: {
  id: string;
  content: string;
  relevance: number;
  strength_now?: number;
  salience?: number;
  access_count?: number;
}): MemorySearchResult {
  const sNow = o.strength_now ?? 1.0;
  const sal = o.salience ?? 1.0;
  const ax = o.access_count ?? 0;
  return {
    id: o.id,
    content: o.content,
    category: "general",
    tags: [],
    metadata: {},
    stage: "episodic",
    strength: sNow,
    importance: 0.5,
    access_count: ax,
    pinned: false,
    relevance: o.relevance,
    strength_now: sNow,
    salience: sal,
    effective_score: o.relevance * sNow * sal,
    created_at: "2026-05-02T00:00:00Z",
  };
}

// ----- Case 1 — additive defangs the multiplier swamp -------------------

test("additive: high-strength low-hybrid does NOT swamp low-strength high-hybrid", () => {
  // Old multiplicative formula `hybrid × strength × salience`:
  //   swamper hybrid=0.21 × strength=60 × sal=1 = 12.6  (would rank #1)
  //   underdog hybrid=1.0 × strength=1 × sal=1 = 1.0
  // Old formula: swamper wins by 12.6×.
  //
  // New additive log-scale (β=0.1, γ=0.05):
  //   swamper = 0.21 + log(61)·0.1 + log(100)·0.05 ≈ 0.21 + 0.41 + 0.23 = 0.85
  //   underdog = 1.0 + log(2)·0.1 + log(1)·0.05  ≈ 1.0  + 0.07 + 0    = 1.07
  // New formula: underdog wins by ~0.22.
  const candidates = [
    // Noise pin to provide normalization range; has no keyword overlap
    makeHit({ id: "noise", content: "completely unrelated content here", relevance: 0.10, strength_now: 1, access_count: 0 }),
    // The swamper — high cognitive multipliers, weak hybrid match
    makeHit({
      id: "swamper",
      content: "old generic note from months ago",
      relevance: 0.40,
      strength_now: 60,
      access_count: 99,
    }),
    // The underdog — fresh memory with perfect keyword match
    makeHit({
      id: "underdog",
      content: "Dell EBT2250 server installed today, brand new",
      relevance: 0.95,
      strength_now: 1,
      access_count: 0,
    }),
  ];

  const ranked = rerankHybrid(candidates, "Dell EBT2250", 0.6, 3);
  assert.equal(ranked[0].id, "underdog", `additive must surface high-hybrid underdog, got ${ranked[0].id}`);
  // The swamper should NOT be #1 — that is exactly what HIGH-1 was.
  assert.notEqual(ranked[0].id, "swamper", "swamper must NOT dominate under additive");
});

// ----- Case 2 — β=0, γ=0 collapses to pure hybrid -----------------------

test("additive: β=0 + γ=0 collapses to pure hybrid (cosine + bm25 only)", () => {
  // With β=γ=0 the cognitive boosts vanish; ranking is determined entirely
  // by α·cosine_norm + (1−α)·bm25_norm. To prove this we use candidates
  // where strength/access_count would heavily reorder under defaults but
  // cannot under β=γ=0.
  const candidates = [
    makeHit({ id: "swamper", content: "irrelevant content", relevance: 0.40, strength_now: 60, access_count: 99 }),
    makeHit({ id: "match",   content: "Dell EBT2250 exact match here", relevance: 0.95, strength_now: 1, access_count: 0 }),
    makeHit({ id: "noise",   content: "yet more random",              relevance: 0.10, strength_now: 1, access_count: 0 }),
  ];

  // Cas A — defaults β=0.1, γ=0.05: swamper boost helps, but match still
  // wins on hybrid term (sanity check that defaults work at all).
  const withDefaults = rerankHybrid(candidates, "Dell EBT2250", 0.6, 3);
  assert.equal(withDefaults[0].id, "match", "defaults should still surface match");

  // Cas B — β=0, γ=0: ranking is purely hybrid; effective_score equals the
  // hybrid term only (no cognitive nudge).
  const pureHybrid = rerankHybrid(candidates, "Dell EBT2250", 0.6, 3, /* β */ 0, /* γ */ 0);
  assert.equal(pureHybrid[0].id, "match", "β=γ=0 should still rank match first");

  // The match's effective_score with β=γ=0 should equal exactly the hybrid
  // term (no log() additions). Hybrid for match: α·1.0 + (1−α)·1.0 = 1.0.
  assert.ok(
    Math.abs(pureHybrid[0].effective_score - 1.0) < 1e-9,
    `β=γ=0 effective_score must equal pure hybrid (1.0), got ${pureHybrid[0].effective_score}`
  );

  // The swamper under β=γ=0: hybrid only, no cognitive boost → score should
  // be MUCH lower than under defaults (no +0.41 strength or +0.23 ax bonus).
  const swamperPure = pureHybrid.find((c) => c.id === "swamper")!;
  const swamperDefault = withDefaults.find((c) => c.id === "swamper")!;
  assert.ok(
    swamperDefault.effective_score - swamperPure.effective_score > 0.5,
    `default vs β=γ=0 must differ by ≥0.5 for high-cognitive swamper, got Δ=${swamperDefault.effective_score - swamperPure.effective_score}`
  );
});

// ----- Case 3 — Saphi-bug realistic dataset under defaults --------------

test("additive: Saphi-bug realistic dataset surfaces Dell in top-3 under defaults", () => {
  // Reproduces the production HIGH-1 finding setup empirically:
  //   - 3 old "ordi" handoffs with accumulated strength + activations
  //   - 1 fresh "Dell" memory with no history
  //   - 2 noise items
  // Query "machine stable serveur Dell" hits 3 BM25 keywords on the Dell
  // doc and zero on the ordi docs. Cosine also favours Dell. The challenge
  // for additive is to NOT let log(51)·0.1 + log(11)·0.05 ≈ 0.51 swamp the
  // hybrid advantage of Dell over ordi.
  const candidates = [
    makeHit({ id: "ordi-1", content: "Yvon a acheté un ordi en mars 2025", relevance: 0.55, strength_now: 50, access_count: 10 }),
    makeHit({ id: "ordi-2", content: "ordi acheté pour le bureau",         relevance: 0.50, strength_now: 50, access_count: 10 }),
    makeHit({ id: "ordi-3", content: "ordi portable acheté chez Best Buy", relevance: 0.48, strength_now: 50, access_count: 10 }),
    makeHit({
      id: "dell",
      content: "Serveur Dell Tower Plus EBT2250 installé tourne stable",
      relevance: 0.85,
      strength_now: 1,
      access_count: 0,
    }),
    makeHit({ id: "noise-1", content: "rien à voir avec hardware", relevance: 0.30, strength_now: 20, access_count: 5 }),
    makeHit({ id: "noise-2", content: "autre note random",         relevance: 0.25, strength_now: 20, access_count: 5 }),
  ];

  const ranked = rerankHybrid(candidates, "machine stable serveur Dell", 0.6, 3);
  const ids = ranked.map((r) => r.id);
  assert.ok(ids.includes("dell"), `Dell must be in top-3 under additive defaults, got: ${ids.join(",")}`);
  // Stronger claim: Dell should be #1 here because hybrid term is far ahead
  // and the cognitive boost differential is bounded by log compression.
  assert.equal(ranked[0].id, "dell", `Dell should rank #1, got ${ranked[0].id}`);

  // Sanity: effective_score of #1 must be greater than #2.
  assert.ok(ranked[0].effective_score > ranked[1].effective_score);
});

// ----- Case 4 — multiplicative reference (sanity baseline) --------------
//
// Not strictly required by the brief, but documents the contrast: under the
// OLD multiplicative formula the swamper memory in Case 1 wins; under the
// NEW additive formula the underdog wins. We compute the multiplicative
// version inline for direct comparison without needing the old code path.

test("additive: contrast vs old multiplicative — same data, opposite winner", () => {
  const swamperHybrid = 0.21; // α=0.6 * cosNorm=0.353 + 0 (no BM25 match)
  const underdogHybrid = 1.0; // α=0.6 * 1.0 + 0.4 * 1.0 (cosine + BM25)

  // OLD: hybrid × strength × salience (salience=1)
  const oldSwamper = swamperHybrid * 60 * 1; // 12.6
  const oldUnderdog = underdogHybrid * 1 * 1; // 1.0
  assert.ok(oldSwamper > oldUnderdog, "old multiplicative — swamper would win");

  // NEW: hybrid + log(1+strength)·β + log(1+ax)·γ, β=0.1, γ=0.05
  const newSwamper =
    swamperHybrid + Math.log(61) * 0.1 + Math.log(100) * 0.05; // ~0.85
  const newUnderdog =
    underdogHybrid + Math.log(2) * 0.1 + Math.log(1) * 0.05;   // ~1.07
  assert.ok(newUnderdog > newSwamper, "new additive — underdog wins");
});
