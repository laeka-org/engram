import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, bm25Score, normalizeScores } from "../services/bm25.js";
import { recall } from "../tools/recall.js";
import type { MemoryService } from "../services/supabase.js";
import type { AffectService } from "../services/affect.js";
import type { ProjectService } from "../services/projects.js";
import type { MemorySearchResult, CrossSpreadResult } from "../types/memory.js";

// ---------------------------------------------------------------------------
// Hybrid retrieval (cosine + BM25) — added to fix vocab-divergent blind spot
// observed empirically by Saphi 2026-05-03: a query mentioning "ordi" failed
// to surface a "serveur Dell" memory because cosine alone was dominated by
// matching-keyword neighbours that were less relevant in fact.
//
// We test the BM25 primitives in isolation (tokenize / bm25Score / normalize)
// and then exercise the hybrid path through recall() with a fake service.
// ---------------------------------------------------------------------------

// ----- BM25 primitives --------------------------------------------------

test("tokenize: lowercase, strip punct, drop stopwords, keep accents", () => {
  const toks = tokenize("Le serveur Dell, modèle EBT2250 !");
  // "le" is a FR stopword; punctuation is stripped; accents survive.
  assert.deepEqual(
    [...toks].sort(),
    ["dell", "ebt2250", "modèle", "serveur"].sort()
  );
});

test("tokenize: empty / whitespace only yields empty array", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("    "), []);
  assert.deepEqual(tokenize("the and or of"), []); // all stopwords → empty
});

test("bm25: exact-keyword doc outscores cousin docs lacking the term", () => {
  const docs = [
    { id: "old1", text: "Yvon a acheté un ordi en mars 2025" },
    { id: "old2", text: "ordi acheté pour le bureau" },
    { id: "new",  text: "Serveur Dell Tower Plus EBT2250 installé 2026-05-02" },
  ];
  const scored = bm25Score("Dell EBT2250", docs);
  const byId = Object.fromEntries(scored.map((s) => [s.id, s.score]));
  assert.ok(byId.new > byId.old1, "Dell doc must outscore non-Dell doc 1");
  assert.ok(byId.new > byId.old2, "Dell doc must outscore non-Dell doc 2");
});

test("bm25: query with no overlap → all zero scores", () => {
  const docs = [
    { id: "a", text: "completely unrelated content here" },
    { id: "b", text: "another unrelated document with words" },
  ];
  const scored = bm25Score("xenon synthesizer protocol", docs);
  for (const s of scored) assert.equal(s.score, 0);
});

test("normalizeScores: edge cases (empty, all-equal, all-zero)", () => {
  assert.deepEqual(normalizeScores([]), []);
  assert.deepEqual(
    normalizeScores([{ id: "a", score: 5 }, { id: "b", score: 5 }]),
    [{ id: "a", score: 0 }, { id: "b", score: 0 }]
  );
  const norm = normalizeScores([
    { id: "a", score: 0 },
    { id: "b", score: 5 },
    { id: "c", score: 10 },
  ]);
  const m = Object.fromEntries(norm.map((n) => [n.id, n.score]));
  assert.equal(m.a, 0);
  assert.equal(m.b, 0.5);
  assert.equal(m.c, 1);
});

// ----- recall() hybrid integration --------------------------------------

function makeHit(o: {
  id: string;
  content: string;
  relevance: number;
  strength_now?: number;
  salience?: number;
  access_count?: number;
  pinned?: boolean;
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
    strength: 1.0,
    importance: 0.5,
    access_count: ax,
    pinned: o.pinned ?? false,
    relevance: o.relevance,
    strength_now: sNow,
    salience: sal,
    effective_score: o.relevance * sNow * sal,
    created_at: "2026-05-02T00:00:00Z",
  };
}

class FakeMemoryService implements Partial<MemoryService> {
  searchCalls: Array<{ query: string; limit: number; vw: number }> = [];
  constructor(private results: MemorySearchResult[]) {}
  async search(
    query: string,
    _cat: string | undefined,
    limit: number,
    vw: number
  ): Promise<MemorySearchResult[]> {
    this.searchCalls.push({ query, limit, vw });
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

// affect.get throws → recall falls back to plain (non-fatal). projects only
// matters when MYCELIUM_PRIVATE_BY_DEFAULT=1, which is off in tests.
class FakeAffectService implements Partial<AffectService> {
  async get(): Promise<never> {
    throw new Error("affect unreachable");
  }
}
class FakeProjectService implements Partial<ProjectService> {
  async activeProjectId(): Promise<null> {
    return null;
  }
}
const fakeAffect = new FakeAffectService() as unknown as AffectService;
const fakeProjects = new FakeProjectService() as unknown as ProjectService;

// Extract IDs from the rendered "id: <uuid>" lines, in display order.
function idsFromOutput(text: string): string[] {
  const matches = [...text.matchAll(/^\s+id:\s+(\S+)/gm)];
  return matches.map((m) => m[1]);
}

test("recall hybrid: Dell memory surfaces in top-3 under additive scoring (Saphi bug 2026-05-03 + R1 fix)", async () => {
  // Production-like scenario after R1 additive log-scale refactor:
  //   - 3 old "ordi" handoffs with high cognitive history (strength=50, ax=10)
  //   - 1 fresh "serveur Dell" memory (strength=1, ax=0)
  // Query "machine stable serveur Dell" hits multiple BM25 keywords on the
  // Dell content (serveur, stable, dell) and none on the ordi handoffs;
  // the Dell semantic match also dominates cosine. Old multiplicative
  // formula `hybrid × strength × salience` would have let str=50 swamp the
  // BM25 win; additive `hybrid + log(1+str)·β + log(1+ax)·γ` lets the
  // hybrid term dominate so Dell ranks first.
  const candidates = [
    makeHit({
      id: "ordi-1",
      content: "Yvon a acheté un ordi en mars 2025",
      relevance: 0.55,
      strength_now: 50,
      access_count: 10,
    }),
    makeHit({
      id: "ordi-2",
      content: "ordi acheté pour le bureau",
      relevance: 0.50,
      strength_now: 50,
      access_count: 10,
    }),
    makeHit({
      id: "ordi-3",
      content: "ordi portable acheté chez Best Buy",
      relevance: 0.48,
      strength_now: 50,
      access_count: 10,
    }),
    makeHit({
      id: "dell",
      content: "Serveur Dell Tower Plus EBT2250 installé tourne stable",
      relevance: 0.85,
      strength_now: 1,
      access_count: 0,
    }),
    makeHit({ id: "noise-1", content: "rien à voir avec hardware", relevance: 0.30, strength_now: 20, access_count: 5 }),
    makeHit({ id: "noise-2", content: "autre note random", relevance: 0.25, strength_now: 20, access_count: 5 }),
  ];
  const svc = new FakeMemoryService(candidates);

  const out = await recall(
    svc as unknown as MemoryService,
    fakeAffect,
    fakeProjects,
    "test-agent",
    {
      query: "machine stable serveur Dell",
      limit: 3,
      vector_weight: 0.6,
      spread: false,
      with_experiences: false,
      ignore_affect: true,
      cite: false,
      format: "snippet",
    }
  );

  const text = (out.content[0] as { text: string }).text;
  const top = idsFromOutput(text).slice(0, 3);
  assert.ok(top.includes("dell"), `Dell memory must be in top-3, got: ${top.join(",")}`);

  // Bushido: confirm SQL was called with vector_weight=1.0 (pure-cosine pool)
  // and pool size ≥ 30 (CANDIDATE_POOL_FLOOR).
  assert.equal(svc.searchCalls[0].vw, 1.0, "SQL must be called with vector_weight=1.0");
  assert.ok(svc.searchCalls[0].limit >= 30, `pool size must be ≥30, got ${svc.searchCalls[0].limit}`);
});

test("recall hybrid: α=1.0 ranks exactly like pure cosine", async () => {
  // BM25 would prefer "b" (3× "Dell"), but α=1 means pure cosine, so "a" wins.
  const candidates = [
    makeHit({ id: "a", content: "cosine wins this one no keyword", relevance: 0.95 }),
    makeHit({ id: "b", content: "Dell Dell Dell exact match", relevance: 0.30 }),
    makeHit({ id: "c", content: "noise content here", relevance: 0.10 }),
  ];
  const svc = new FakeMemoryService(candidates);
  const out = await recall(
    svc as unknown as MemoryService,
    fakeAffect,
    fakeProjects,
    "test-agent",
    {
      query: "Dell",
      limit: 3,
      vector_weight: 1.0,
      spread: false,
      with_experiences: false,
      ignore_affect: true,
      cite: false,
      format: "snippet",
    }
  );
  const top = idsFromOutput((out.content[0] as { text: string }).text);
  assert.equal(top[0], "a", "α=1 must surface highest cosine first");
});

test("recall hybrid: α=0.0 ranks exactly like pure BM25", async () => {
  // Cosine champion "a" has no keyword overlap; BM25 champion "b" wins under α=0.
  const candidates = [
    makeHit({ id: "a", content: "cosine wins this one no keyword", relevance: 0.95 }),
    makeHit({ id: "b", content: "Dell Dell Dell exact match", relevance: 0.30 }),
    makeHit({ id: "c", content: "noise content here", relevance: 0.10 }),
  ];
  const svc = new FakeMemoryService(candidates);
  const out = await recall(
    svc as unknown as MemoryService,
    fakeAffect,
    fakeProjects,
    "test-agent",
    {
      query: "Dell",
      limit: 3,
      vector_weight: 0.0,
      spread: false,
      with_experiences: false,
      ignore_affect: true,
      cite: false,
      format: "snippet",
    }
  );
  const top = idsFromOutput((out.content[0] as { text: string }).text);
  assert.equal(top[0], "b", "α=0 must surface highest BM25 first");
});

test("recall hybrid: empty candidate pool → 'No matching memories found'", async () => {
  const svc = new FakeMemoryService([]);
  const out = await recall(
    svc as unknown as MemoryService,
    fakeAffect,
    fakeProjects,
    "test-agent",
    {
      query: "anything",
      limit: 3,
      vector_weight: 0.6,
      spread: false,
      with_experiences: false,
      ignore_affect: true,
      cite: false,
      format: "snippet",
    }
  );
  const text = (out.content[0] as { text: string }).text;
  assert.match(text, /No matching memories found/);
});
