import { test } from "node:test";
import assert from "node:assert/strict";
import { recall, recallSchema } from "../tools/recall.js";
import type { MemoryService } from "../services/supabase.js";
import type { AffectService } from "../services/affect.js";
import type { ProjectService } from "../services/projects.js";
import type { MemorySearchResult, CrossSpreadResult } from "../types/memory.js";

// ---------------------------------------------------------------------------
// R6 (HIGH-6) — empty query crashes SQL pipeline (stress-test handoff
// 2026-05-03). Validation must happen BEFORE the SQL function lookup.
//
// R4 partial (MED-5) — recall always returned full memory body, single
// limit=10 call could yield 50-83KB payload that blew caller context budget.
// Three modes now: metadata (id/score/tags/ts only), snippet (default,
// 200-char cap + ellipsis), full (legacy opt-in).
// ---------------------------------------------------------------------------

// ----- Helpers (mirror hybrid-retrieval.test.ts) -----------------------

function makeHit(o: {
  id: string;
  content: string;
  relevance: number;
  strength_now?: number;
  salience?: number;
  pinned?: boolean;
}): MemorySearchResult {
  const sNow = o.strength_now ?? 1.0;
  const sal = o.salience ?? 1.0;
  return {
    id: o.id,
    content: o.content,
    category: "general",
    tags: [],
    metadata: {},
    stage: "episodic",
    strength: 1.0,
    importance: 0.5,
    access_count: 0,
    pinned: o.pinned ?? false,
    relevance: o.relevance,
    strength_now: sNow,
    salience: sal,
    effective_score: o.relevance * sNow * sal,
    created_at: "2026-05-02T00:00:00Z",
  };
}

class FakeMemoryService implements Partial<MemoryService> {
  experienceCalls = 0;
  constructor(private results: MemorySearchResult[]) {}
  async search(
    _q: string,
    _cat: string | undefined,
    _limit: number,
    _vw: number
  ): Promise<MemorySearchResult[]> {
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
    this.experienceCalls += 1;
    return [];
  }
}

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

// ----- R6: empty query validation --------------------------------------

test("recallSchema: empty query rejected with friendly message (R6)", () => {
  const result = recallSchema.safeParse({ query: "" });
  assert.equal(result.success, false, "empty query must fail validation");
  if (!result.success) {
    const issues = result.error.issues;
    const queryIssue = issues.find((i) => i.path[0] === "query");
    assert.ok(queryIssue, "must have an issue on the query field");
    assert.equal(queryIssue!.message, "Query cannot be empty");
  }
});

test("recallSchema: query >2000 chars rejected with friendly message (R6)", () => {
  const long = "x".repeat(2001);
  const result = recallSchema.safeParse({ query: long });
  assert.equal(result.success, false);
  if (!result.success) {
    const queryIssue = result.error.issues.find((i) => i.path[0] === "query");
    assert.ok(queryIssue);
    assert.equal(queryIssue!.message, "Query too long, max 2000 chars");
  }
});

test("recallSchema: valid query passes validation", () => {
  const result = recallSchema.safeParse({ query: "valid query content" });
  assert.equal(result.success, true);
  if (result.success) {
    // Default format applied
    assert.equal(result.data.format, "snippet");
  }
});

// ----- R4 partial: format param branches -------------------------------

const LONG_CONTENT = "ABCDEFGHIJ".repeat(50); // 500 chars
const SHORT_CONTENT = "Short body under 200 chars."; // 27 chars

test("recall format=metadata: no body content in output, no experiences fetched (MED-5)", async () => {
  const candidates = [
    makeHit({ id: "mem-1", content: LONG_CONTENT, relevance: 0.9 }),
  ];
  const svc = new FakeMemoryService(candidates);
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
      with_experiences: true, // even with experiences requested, metadata mode skips fetch
      ignore_affect: true,
      cite: false,
      format: "metadata",
      recency_weight: 0,
    }
  );
  const text = (out.content[0] as { text: string }).text;
  assert.ok(
    !text.includes(LONG_CONTENT),
    "metadata format must not embed body content"
  );
  assert.ok(
    !text.includes("ABCDEFGHIJ"),
    "metadata format must not include any body fragment"
  );
  assert.ok(text.includes("id: mem-1"), "metadata still surfaces id");
  assert.ok(
    text.includes("created: 2026-05-02T00:00:00Z"),
    "metadata surfaces created_at timestamp"
  );
  assert.ok(text.includes("score="), "metadata surfaces score");
  assert.equal(
    svc.experienceCalls,
    0,
    "metadata format must skip experiencesForMemory fetch"
  );
});

test("recall format=snippet: content truncated to 200 chars + ellipsis (default)", async () => {
  const candidates = [
    makeHit({ id: "mem-long", content: LONG_CONTENT, relevance: 0.9 }),
    makeHit({ id: "mem-short", content: SHORT_CONTENT, relevance: 0.8 }),
  ];
  const svc = new FakeMemoryService(candidates);
  const out = await recall(
    svc as unknown as MemoryService,
    fakeAffect,
    fakeProjects,
    "test-agent",
    {
      query: "anything",
      limit: 5,
      vector_weight: 0.6,
      spread: false,
      with_experiences: false,
      ignore_affect: true,
      cite: false,
      format: "snippet",
      recency_weight: 0,
    }
  );
  const text = (out.content[0] as { text: string }).text;
  // Long content: must contain first 200 chars + "..." but NOT char 201.
  const expectedTruncated = LONG_CONTENT.slice(0, 200) + "...";
  assert.ok(
    text.includes(expectedTruncated),
    `snippet must contain truncated body (first 200 chars + ellipsis)`
  );
  assert.ok(
    !text.includes(LONG_CONTENT),
    "snippet must NOT contain the full long body"
  );
  // Short content (under 200 chars): NOT truncated, no ellipsis suffix.
  assert.ok(
    text.includes(SHORT_CONTENT),
    "snippet preserves short content untouched"
  );
  assert.ok(
    !text.includes(SHORT_CONTENT + "..."),
    "snippet does not append ellipsis to short content"
  );
});

test("recall format=full: full content preserved (back-compat with legacy callers)", async () => {
  const candidates = [
    makeHit({ id: "mem-long", content: LONG_CONTENT, relevance: 0.9 }),
  ];
  const svc = new FakeMemoryService(candidates);
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
      format: "full",
      recency_weight: 0,
    }
  );
  const text = (out.content[0] as { text: string }).text;
  assert.ok(
    text.includes(LONG_CONTENT),
    "full format must preserve the entire body verbatim"
  );
  assert.ok(
    !text.includes(LONG_CONTENT.slice(0, 200) + "..."),
    "full format does not truncate"
  );
});

test("recallSchema: invalid format value rejected", () => {
  const result = recallSchema.safeParse({ query: "X", format: "verbose" });
  assert.equal(result.success, false, "unknown format value must be rejected");
});
