import { test } from "node:test";
import assert from "node:assert/strict";
import { dedup, dedupSchema, forgetWeak, forgetWeakSchema } from "../tools/cognitive.js";
import type { MemoryService } from "../services/supabase.js";
import type { Memory, MemorySearchResult } from "../types/memory.js";

// ---------------------------------------------------------------------------
// R2 — scoping params + dry_run for destructive tools (HIGH-5 + LOW-1)
//
// dedup_memories and forget_weak_memories were globally destructive with no
// preview path (stress-test 2026-05-03 §HIGH-5, §LOW-1). The R2 contract
// adds scope_tag / scope_project / scope_ids, dry_run (default true), and
// requires explicit `all=true` for legacy global behaviour. These tests
// pin the safety invariants.
// ---------------------------------------------------------------------------

function mem(over: Partial<Memory> & { id: string }): Memory {
  return {
    content: "default content",
    category: "general",
    tags: [],
    metadata: {},
    created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), // 30 days old
    updated_at: "2026-04-01T00:00:00Z",
    strength: 1.0,
    importance: 0.5,
    access_count: 0,
    valence: 0,
    arousal: 0,
    stage: "episodic",
    pinned: false,
    decay_tau_days: 30,
    useful_count: 0,
    ...over,
  };
}

class FakeService implements Partial<MemoryService> {
  archived: string[] = [];
  hardDeleted: string[] = [];
  globalDedupCalls: number[] = [];
  globalForgetCalls: Array<{ str: number; age: number }> = [];

  constructor(
    private opts: {
      scoped?: Memory[];
      similarMap?: Map<string, MemorySearchResult[]>;
    } = {}
  ) {}

  async listByScope(): Promise<Memory[]> {
    return this.opts.scoped ?? [];
  }

  async findSimilar(content: string): Promise<MemorySearchResult[]> {
    return this.opts.similarMap?.get(content) ?? [];
  }

  async archive(id: string): Promise<void> {
    this.archived.push(id);
  }

  async delete(id: string): Promise<boolean> {
    this.hardDeleted.push(id);
    return true;
  }

  async dedup(threshold: number): Promise<number> {
    this.globalDedupCalls.push(threshold);
    return 7; // arbitrary pretend-merged count
  }

  async forgetWeak(strength: number, age: number): Promise<number> {
    this.globalForgetCalls.push({ str: strength, age });
    return 4; // arbitrary pretend-archived count
  }
}

// ----- dedup refusal + scoping -----------------------------------------

test("dedup_memories: refuses without scope and without all=true", async () => {
  const svc = new FakeService();
  const input = dedupSchema.parse({}); // all defaults: dry_run=true, all=false, no scope
  await assert.rejects(
    () => dedup(svc as unknown as MemoryService, input),
    /Global dedup unsafe — provide scope_tag, scope_project, scope_ids, or set all=true/,
    "must throw the documented refusal message"
  );
  assert.deepEqual(svc.archived, [], "no archive must run on refusal");
  assert.deepEqual(svc.globalDedupCalls, [], "no global SQL RPC on refusal");
});

test("dedup_memories: scope_tag honored, dry_run=true does NOT archive", async () => {
  // Two memories tagged test_x with similar content; one similarity edge.
  const memA = mem({ id: "aaa", tags: ["test_x"], content: "Le café est bon", strength: 5 });
  const memB = mem({ id: "bbb", tags: ["test_x"], content: "Le café est bon aussi", strength: 1 });
  const memC = mem({ id: "ccc", tags: ["test_x"], content: "complètement différent", strength: 2 });
  const similarMap = new Map<string, MemorySearchResult[]>([
    [
      memA.content,
      [
        { id: "bbb", relevance: 0.96, content: memB.content, category: "general", tags: [], metadata: {}, stage: "episodic", strength: 1, importance: 0.5, access_count: 0, pinned: false, strength_now: 1, salience: 1, effective_score: 0.96, created_at: memB.created_at },
      ],
    ],
    [memB.content, []],
    [memC.content, []],
  ]);
  const svc = new FakeService({ scoped: [memA, memB, memC], similarMap });

  const out = await dedup(
    svc as unknown as MemoryService,
    dedupSchema.parse({ scope_tag: "test_x", similarity_threshold: 0.93 })
  );

  const text = (out.content[0] as { text: string }).text;
  assert.match(text, /\[DRY RUN\]/, "dry_run output must be tagged [DRY RUN]");
  assert.match(text, /1 cluster/, "must report 1 cluster");
  assert.match(text, /keep aaa/, "highest-strength memory aaa should be kept");
  assert.match(text, /archive 1.*bbb/, "bbb should be in the merge list");
  assert.deepEqual(svc.archived, [], "dry_run must not archive anything");
  assert.deepEqual(svc.globalDedupCalls, [], "scoped path must not call global SQL RPC");
});

test("dedup_memories: dry_run=false archives merged_ids in scope", async () => {
  const memA = mem({ id: "aaa", tags: ["test_x"], content: "Le café est bon", strength: 5 });
  const memB = mem({ id: "bbb", tags: ["test_x"], content: "Le café est bon aussi", strength: 1 });
  const similarMap = new Map<string, MemorySearchResult[]>([
    [
      memA.content,
      [
        { id: "bbb", relevance: 0.96, content: memB.content, category: "general", tags: [], metadata: {}, stage: "episodic", strength: 1, importance: 0.5, access_count: 0, pinned: false, strength_now: 1, salience: 1, effective_score: 0.96, created_at: memB.created_at },
      ],
    ],
    [memB.content, []],
  ]);
  const svc = new FakeService({ scoped: [memA, memB], similarMap });

  const out = await dedup(
    svc as unknown as MemoryService,
    dedupSchema.parse({ scope_tag: "test_x", dry_run: false })
  );

  const text = (out.content[0] as { text: string }).text;
  assert.match(text, /Merged 1 cluster/);
  assert.match(text, /archived 1/);
  assert.deepEqual(svc.archived, ["bbb"], "bbb must be archived (lower strength)");
  assert.equal(svc.archived.length, 1, "exactly one archive call");
});

test("dedup_memories: all=true + dry_run=true returns explanation, no execute", async () => {
  const svc = new FakeService();
  const out = await dedup(
    svc as unknown as MemoryService,
    dedupSchema.parse({ all: true, dry_run: true })
  );
  const text = (out.content[0] as { text: string }).text;
  assert.match(text, /dry_run=true is not supported with all=true/);
  assert.deepEqual(svc.globalDedupCalls, [], "must not call global RPC during preview-refusal");
});

test("dedup_memories: all=true + dry_run=false executes legacy global SQL RPC", async () => {
  const svc = new FakeService();
  const out = await dedup(
    svc as unknown as MemoryService,
    dedupSchema.parse({ all: true, dry_run: false, similarity_threshold: 0.95 })
  );
  const text = (out.content[0] as { text: string }).text;
  assert.match(text, /Merged 7 near-duplicate memories/);
  assert.match(text, /all=true global dedup/);
  assert.deepEqual(svc.globalDedupCalls, [0.95], "must call global SQL RPC with the configured threshold");
});

// ----- forget_weak refusal + scoping -----------------------------------

test("forget_weak_memories: refuses without scope and without all=true", async () => {
  const svc = new FakeService();
  await assert.rejects(
    () => forgetWeak(svc as unknown as MemoryService, forgetWeakSchema.parse({})),
    /Global forget_weak unsafe — provide scope_tag, scope_project, scope_ids, or set all=true/
  );
  assert.deepEqual(svc.archived, []);
  assert.deepEqual(svc.globalForgetCalls, []);
});

test("forget_weak_memories: scope_tag, dry_run=true filters by age + strength without archive", async () => {
  const old = mem({
    id: "old-weak",
    tags: ["test_x"],
    strength: 0.02, // ≤ default threshold 0.05
    created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), // 30d ≥ default 7d
  });
  const young = mem({
    id: "young-weak",
    tags: ["test_x"],
    strength: 0.02,
    created_at: new Date(Date.now() - 1 * 86_400_000).toISOString(), // 1d < 7d
  });
  const oldStrong = mem({
    id: "old-strong",
    tags: ["test_x"],
    strength: 0.5, // above threshold
    created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  });
  const svc = new FakeService({ scoped: [old, young, oldStrong] });

  const out = await forgetWeak(
    svc as unknown as MemoryService,
    forgetWeakSchema.parse({ scope_tag: "test_x" })
  );
  const text = (out.content[0] as { text: string }).text;
  assert.match(text, /\[DRY RUN\]/);
  assert.match(text, /1 memorie\(s\) would be archived/);
  assert.match(text, /old-weak/);
  assert.doesNotMatch(text, /young-weak/, "young memory must NOT appear (age filter)");
  assert.doesNotMatch(text, /old-strong/, "strong memory must NOT appear (strength filter)");
  assert.deepEqual(svc.archived, [], "dry_run must not archive");
});

test("forget_weak_memories: dry_run=false archives eligible IDs in scope", async () => {
  const old1 = mem({
    id: "old-1",
    tags: ["test_x"],
    strength: 0.01,
    created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  });
  const old2 = mem({
    id: "old-2",
    tags: ["test_x"],
    strength: 0.04,
    created_at: new Date(Date.now() - 14 * 86_400_000).toISOString(),
  });
  const svc = new FakeService({ scoped: [old1, old2] });

  await forgetWeak(
    svc as unknown as MemoryService,
    forgetWeakSchema.parse({ scope_tag: "test_x", dry_run: false })
  );
  assert.deepEqual(svc.archived.sort(), ["old-1", "old-2"], "both eligible memories archived");
  assert.deepEqual(svc.globalForgetCalls, [], "scoped path must not call global RPC");
});

test("forget_weak_memories: all=true + dry_run=false delegates to legacy global SQL RPC", async () => {
  const svc = new FakeService();
  const out = await forgetWeak(
    svc as unknown as MemoryService,
    forgetWeakSchema.parse({ all: true, dry_run: false, strength_threshold: 0.1, min_age_days: 14 })
  );
  const text = (out.content[0] as { text: string }).text;
  assert.match(text, /Soft-forgot \(archived\) 4 weak memories/);
  assert.match(text, /all=true global forget/);
  assert.deepEqual(svc.globalForgetCalls, [{ str: 0.1, age: 14 }]);
});

// ----- scope_ids honored ------------------------------------------------

test("dedup_memories: scope_ids resolves through listByScope", async () => {
  // FakeService.listByScope ignores its arg and returns whatever opts.scoped
  // contains. We pass scope_ids only to satisfy the schema-level "has scope"
  // check, then verify the candidate path runs (1 candidate, 0 clusters).
  const svc = new FakeService({ scoped: [mem({ id: "x", content: "alone in scope" })] });
  const out = await dedup(
    svc as unknown as MemoryService,
    dedupSchema.parse({ scope_ids: ["x"] })
  );
  const text = (out.content[0] as { text: string }).text;
  assert.match(text, /no near-duplicates above similarity 0\.93/);
  assert.deepEqual(svc.globalDedupCalls, [], "scope_ids path must not call global RPC");
});
