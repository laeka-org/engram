import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recall,
  rerankHybrid,
  detectTemporalIntent,
} from "../tools/recall.js";
import type { MemoryService } from "../services/supabase.js";
import type { AffectService, AffectState } from "../services/affect.js";
import type { ProjectService } from "../services/projects.js";
import type {
  MemorySearchResult,
  CrossSpreadResult,
} from "../types/memory.js";

// ---------------------------------------------------------------------------
// R5 — temporal recency + activation cap + HIGH-2 affect transparency
//   - HIGH-2: response._meta exposes actual_limit_applied / affect_narrowed
//             / affect_state so automated callers don't parse text footers.
//   - MED-2:  recency_weight ∈ [0,1], default 0. Auto-detected to 0.5 when
//             the query carries an FR/EN temporal keyword.
//   - MED-4:  activation_count contribution capped at 20 to break the
//             feedback loop where high-ax memories stay high-ax.
// ---------------------------------------------------------------------------

// ----- detectTemporalIntent regex coverage (FR + EN) --------------------

test("detectTemporalIntent — FR keywords matched", () => {
  for (const q of [
    "Tu te souviens récemment de mon ordi ?",
    "Le dernier deploy hier soir",
    "Aujourd'hui j'ai shippé R2",
    "cette semaine on a fait quoi",
    "la semaine passée j'ai cassé le build",
    "récents bugs",
  ]) {
    assert.ok(detectTemporalIntent(q), `should match FR: "${q}"`);
  }
});

test("detectTemporalIntent — EN keywords matched", () => {
  for (const q of [
    "Anything recent on the Dell server?",
    "what did I do today",
    "yesterday's deploy",
    "issues from past week",
    "last week's incident",
    "Was that recently fixed?",
  ]) {
    assert.ok(detectTemporalIntent(q), `should match EN: "${q}"`);
  }
});

test("detectTemporalIntent — non-temporal queries do NOT match", () => {
  for (const q of [
    "ordi Dell",
    "machine stable",
    "what is happening with auth",
    "Pythagorean theorem",
    "", // empty must not crash
  ]) {
    assert.equal(detectTemporalIntent(q), false, `should NOT match: "${q}"`);
  }
});

// ----- MED-4 — activation cap min(ax, 20) -------------------------------

test("rerankHybrid: ax=200 vs ax=20 produce identical activation boost (cap=20)", () => {
  // Same content + same cosine + same strength → only ax differs. Under
  // pre-R5 behaviour (uncapped log(1+ax)·γ) the ax=200 candidate would
  // outscore ax=20 by log(201)/log(21) − 1 ≈ +75%. Under R5 they tie.
  const high = makeHit({ id: "high-ax", relevance: 0.5, access_count: 200, content: "alpha" });
  const low = makeHit({ id: "low-ax", relevance: 0.5, access_count: 20, content: "alpha" });
  const ranked = rerankHybrid(
    [high, low],
    "alpha",
    /* α */ 0.6,
    /* limit */ 2,
    /* β */ 0.1,
    /* γ */ 0.05
  );
  // Scores must be exactly equal — sort stability preserves insertion order.
  assert.equal(
    ranked[0].effective_score,
    ranked[1].effective_score,
    `ax=200 and ax=20 must score identically; got ${ranked[0].effective_score} vs ${ranked[1].effective_score}`
  );
});

test("rerankHybrid: ax=15 (under cap) still beats ax=5 — cap doesn't flatten everything", () => {
  // The cap kicks in at 20. Below 20, more activation = more boost. Sanity
  // check that we didn't accidentally flatten the whole γ contribution.
  const more = makeHit({ id: "more-ax", relevance: 0.5, access_count: 15, content: "beta" });
  const less = makeHit({ id: "less-ax", relevance: 0.5, access_count: 5, content: "beta" });
  const ranked = rerankHybrid(
    [more, less],
    "beta",
    0.6,
    2,
    0.1,
    0.05
  );
  assert.equal(ranked[0].id, "more-ax", "below the cap, more activation must still rank first");
});

// ----- MED-2 — recency boost --------------------------------------------

test("rerankHybrid: recency_weight=0.5 boosts younger memory over older with same cosine", () => {
  const NOW = new Date("2026-05-03T00:00:00Z").getTime();
  const fresh = makeHit({
    id: "fresh",
    relevance: 0.5,
    content: "report",
    created_at: new Date(NOW - 1 * 86_400_000).toISOString(), // 1d old
  });
  const old = makeHit({
    id: "old",
    relevance: 0.5,
    content: "report",
    created_at: new Date(NOW - 365 * 86_400_000).toISOString(), // 1yr old
  });
  // Without recency: scores tie (same cosine + same str + same ax).
  const tied = rerankHybrid([fresh, old], "report", 0.6, 2, 0.1, 0.05, 0, NOW);
  assert.equal(
    tied[0].effective_score,
    tied[1].effective_score,
    "without recency the two candidates must tie"
  );
  // With recency_weight=0.5: fresh wins by exp(-1/30)·0.5 − exp(-365/30)·0.5
  // ≈ 0.484, well above tie tolerance.
  const ranked = rerankHybrid(
    [fresh, old],
    "report",
    0.6,
    2,
    0.1,
    0.05,
    /* recencyWeight */ 0.5,
    NOW
  );
  assert.equal(ranked[0].id, "fresh", "recency must surface the fresh memory");
  assert.ok(
    ranked[0].effective_score - ranked[1].effective_score > 0.4,
    `recency gap must be ≥ 0.4, got ${ranked[0].effective_score - ranked[1].effective_score}`
  );
});

test("recall: temporal keyword auto-detect sets recency_weight=0.5 and exposes meta", async () => {
  const NOW = Date.now();
  const candidates = [
    makeHit({
      id: "fresh",
      relevance: 0.5,
      content: "Dell EBT2250 install report",
      created_at: new Date(NOW - 1 * 86_400_000).toISOString(),
    }),
    makeHit({
      id: "old",
      relevance: 0.5,
      content: "Dell EBT2250 install report",
      created_at: new Date(NOW - 365 * 86_400_000).toISOString(),
    }),
  ];
  const svc = new FakeMemoryService(candidates);
  const out = await recall(
    svc as unknown as MemoryService,
    fakeAffectNeutral,
    fakeProjects,
    "test",
    {
      query: "Dell hardware aujourd'hui", // FR temporal keyword → auto-detect
      limit: 2,
      vector_weight: 0.6,
      spread: false,
      with_experiences: false,
      ignore_affect: true,
      cite: false,
      format: "snippet",
      recency_weight: 0,
    }
  );

  // The structured meta must carry the auto-detection signal.
  const meta = (out as { _meta: Record<string, unknown> })._meta;
  assert.ok(meta, "_meta must be present");
  assert.deepEqual(
    meta.recency_applied,
    { weight: 0.5, auto_detected: true },
    "auto-detect must set weight=0.5 + auto_detected=true"
  );
  // Fresh memory must surface first.
  const text = (out.content[0] as { text: string }).text;
  const firstId = (text.match(/^\s+id:\s+(\S+)/m) ?? [])[1];
  assert.equal(firstId, "fresh", "auto-detected recency must surface the fresh memory first");
});

test("recall: no temporal keyword + recency_weight=0 → no recency boost (auto_detected=false)", async () => {
  const candidates = [
    makeHit({ id: "a", relevance: 0.6, content: "alpha note" }),
    makeHit({ id: "b", relevance: 0.4, content: "beta note" }),
  ];
  const svc = new FakeMemoryService(candidates);
  const out = await recall(
    svc as unknown as MemoryService,
    fakeAffectNeutral,
    fakeProjects,
    "test",
    {
      query: "alpha or beta", // no temporal keyword
      limit: 2,
      vector_weight: 0.6,
      spread: false,
      with_experiences: false,
      ignore_affect: true,
      cite: false,
      format: "snippet",
      recency_weight: 0,
    }
  );
  const meta = (out as { _meta: Record<string, unknown> })._meta;
  assert.equal(meta.recency_applied, null, "no boost when neither explicit nor auto-detected");
});

test("recall: explicit recency_weight=0.5 honoured even without temporal keyword (auto_detected=false)", async () => {
  const candidates = [
    makeHit({ id: "a", relevance: 0.5, content: "x", created_at: new Date(Date.now() - 1 * 86_400_000).toISOString() }),
    makeHit({ id: "b", relevance: 0.5, content: "x", created_at: new Date(Date.now() - 200 * 86_400_000).toISOString() }),
  ];
  const svc = new FakeMemoryService(candidates);
  const out = await recall(
    svc as unknown as MemoryService,
    fakeAffectNeutral,
    fakeProjects,
    "test",
    {
      query: "x", // no temporal keyword
      limit: 2,
      vector_weight: 0.6,
      spread: false,
      with_experiences: false,
      ignore_affect: true,
      cite: false,
      format: "snippet",
      recency_weight: 0.5, // explicit
    }
  );
  const meta = (out as { _meta: Record<string, unknown> })._meta;
  assert.deepEqual(
    meta.recency_applied,
    { weight: 0.5, auto_detected: false },
    "explicit weight must NOT flag auto_detected"
  );
});

// ----- HIGH-2 — affect transparency -------------------------------------

test("recall: affect-narrowed call exposes structured _meta (HIGH-2)", async () => {
  // High satisfaction → biasFromState pushes k_delta=-2 → effectiveLimit=3.
  // Caller asked for 5; the structured _meta must say so explicitly.
  const candidates = Array.from({ length: 8 }, (_, i) =>
    makeHit({ id: `m${i}`, relevance: 0.9 - i * 0.05, content: `note ${i}` })
  );
  const svc = new FakeMemoryService(candidates);
  const out = await recall(
    svc as unknown as MemoryService,
    fakeAffectSatisfied as unknown as AffectService,
    fakeProjects,
    "test",
    {
      query: "note",
      limit: 5,
      vector_weight: 0.6,
      spread: false,
      with_experiences: false,
      ignore_affect: false, // affect engaged
      cite: false,
      format: "snippet",
      recency_weight: 0,
    }
  );
  const meta = (out as { _meta: Record<string, unknown> })._meta;
  assert.equal(meta.requested_limit, 5);
  assert.equal(meta.actual_limit_applied, 3, "high-satisfaction affect must narrow to 3");
  assert.equal(meta.affect_narrowed, true);
  assert.ok(meta.affect_state, "affect_state must be present when narrowed");
  const af = meta.affect_state as { satisfaction: number; reason: string; k_delta: number };
  assert.equal(af.k_delta, -2);
  assert.match(af.reason, /satisfied/);
});

test("recall: ignore_affect=true → actual_limit_applied equals requested, affect_narrowed=false", async () => {
  const candidates = [makeHit({ id: "x", relevance: 0.9, content: "y" }), makeHit({ id: "y", relevance: 0.4, content: "z" })];
  const svc = new FakeMemoryService(candidates);
  const out = await recall(
    svc as unknown as MemoryService,
    fakeAffectSatisfied as unknown as AffectService,
    fakeProjects,
    "test",
    {
      query: "y",
      limit: 5,
      vector_weight: 0.6,
      spread: false,
      with_experiences: false,
      ignore_affect: true, // skips affect entirely
      cite: false,
      format: "snippet",
      recency_weight: 0,
    }
  );
  const meta = (out as { _meta: Record<string, unknown> })._meta;
  assert.equal(meta.requested_limit, 5);
  assert.equal(meta.actual_limit_applied, 5);
  assert.equal(meta.affect_narrowed, false);
  assert.equal(meta.affect_state, null, "affect_state must be null when ignore_affect=true");
});

// ===========================================================================
// Helpers + fakes
// ===========================================================================

function makeHit(o: {
  id: string;
  content: string;
  relevance: number;
  strength_now?: number;
  access_count?: number;
  created_at?: string;
}): MemorySearchResult {
  const sNow = o.strength_now ?? 1.0;
  const ax = o.access_count ?? 0;
  return {
    id: o.id,
    content: o.content,
    category: "general",
    tags: [],
    metadata: {},
    stage: "episodic",
    strength: 1.0,
    importance: 0.5,
    access_count: ax,
    pinned: false,
    relevance: o.relevance,
    strength_now: sNow,
    salience: 1.0,
    effective_score: o.relevance,
    created_at: o.created_at ?? "2026-04-15T00:00:00Z",
  };
}

class FakeMemoryService implements Partial<MemoryService> {
  constructor(private results: MemorySearchResult[]) {}
  async search(): Promise<MemorySearchResult[]> {
    return this.results;
  }
  async emitRecalled(): Promise<void> {}
  async touch(): Promise<void> {}
  async coactivate(): Promise<void> {}
  async emitUsedInResponse(): Promise<void> {}
  async spreadCross(): Promise<CrossSpreadResult[]> {
    return [];
  }
  async experiencesForMemory(): Promise<
    Array<{
      id: string;
      summary: string;
      outcome: string;
      difficulty: number;
      valence: number;
      weight: number;
      created_at: string;
    }>
  > {
    return [];
  }
}

const neutralState: AffectState = {
  curiosity: 0.5,
  frustration: 0,
  satisfaction: 0.5,
  confidence: 0.5,
  decay_factor: 1,
  updated_at: "2026-04-18T00:00:00Z",
  hours_since: 0,
  last_event: null,
};

const satisfiedState: AffectState = {
  curiosity: 0.5,
  frustration: 0,
  satisfaction: 1.0, // → biasFromState gives k_delta=-2 (narrows)
  confidence: 0.5,
  decay_factor: 1,
  updated_at: "2026-04-18T00:00:00Z",
  hours_since: 0,
  last_event: null,
};

const fakeAffectNeutral = {
  async get(): Promise<AffectState> {
    return neutralState;
  },
} as unknown as AffectService;

const fakeAffectSatisfied = {
  async get(): Promise<AffectState> {
    return satisfiedState;
  },
};

const fakeProjects = {
  async activeProjectId(): Promise<null> {
    return null;
  },
} as unknown as ProjectService;
