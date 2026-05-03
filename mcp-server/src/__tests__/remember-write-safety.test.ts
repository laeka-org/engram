import { test } from "node:test";
import assert from "node:assert/strict";
import { remember, rememberSchema } from "../tools/remember.js";
import type { MemoryService } from "../services/supabase.js";
import type { ProjectService } from "../services/projects.js";
import type {
  Memory,
  MemorySearchResult,
  CreateMemoryInput,
  CreateMemoryResult,
} from "../types/memory.js";

// ---------------------------------------------------------------------------
// R3 / R4 — HIGH-3 (concurrent parallel write data loss) + HIGH-4 (silent
// near-dup dedup) from stress-test handoff 2026-05-03.
//
// Diagnostic discovered during Phase 0 audit: HIGH-3 as reported was actually
// HIGH-4 manifesting on near-duplicate parallel writes (e.g. "ADOPTED" +
// "REJECTED", cosine >0.95). Two parallel calls with similar content both
// hit the silent dedup path and returned the existing UUID; it looked like
// data loss but it was a transparency failure on near-dup detection.
//
// Once HIGH-4 surfaces dedup explicitly (force_new param + dedup_to_existing
// response field), parallel writes with DISTINCT content are deterministic:
// each goes through findSimilar → no hit → independent insert. No write
// queue is needed for the observed bug class. The remaining race window
// (concurrent insert of similar content) is a separate concern (DB-level
// uniqueness) outside R3 scope — tracked for R3-extended.
// ---------------------------------------------------------------------------

let nextId = 1;
function makeMemory(over: Partial<Memory> = {}): Memory {
  const id = `mem-${nextId++}`;
  return {
    id,
    content: "default content",
    category: "general",
    tags: [],
    metadata: {},
    created_at: "2026-05-03T10:00:00Z",
    updated_at: "2026-05-03T10:00:00Z",
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

class FakeProjectService implements Partial<ProjectService> {
  async resolveScope(_slug: string | null | undefined, _agent: string): Promise<string | null> {
    return null;
  }
}
const fakeProjects = new FakeProjectService() as unknown as ProjectService;

/** Mock MemoryService whose findSimilar response is configurable per content
 *  prefix, so tests can simulate "this content hits a near-dup, that one
 *  doesn't" without touching real embeddings. */
class FakeMemoryService implements Partial<MemoryService> {
  storedMemories: Memory[] = [];
  createCalls: Array<{ input: CreateMemoryInput; opts?: { force_new?: boolean } }> = [];
  /** Map content-prefix → simulated findSimilar hit. Empty map = always miss. */
  dedupMap = new Map<string, { id: string; relevance: number; existing_content: string }>();

  async createWithDedupInfo(
    input: CreateMemoryInput,
    opts?: { force_new?: boolean }
  ): Promise<CreateMemoryResult> {
    this.createCalls.push({ input, opts });

    if (!opts?.force_new) {
      // Look up by content prefix (simulates "near-dup found" in real DB).
      for (const [prefix, hit] of this.dedupMap.entries()) {
        if (input.content.startsWith(prefix)) {
          return {
            memory: makeMemory({ id: hit.id, content: hit.existing_content }),
            deduped: {
              existing_id: hit.id,
              similarity_score: hit.relevance,
              existing_content: hit.existing_content,
            },
          };
        }
      }
    }

    // No near-dup → create a fresh memory with a unique UUID.
    const memory = makeMemory({
      content: input.content,
      category: input.category ?? "general",
      tags: input.tags ?? [],
      importance: input.importance ?? 0.5,
    });
    this.storedMemories.push(memory);
    return { memory };
  }

  async create(input: CreateMemoryInput): Promise<Memory> {
    const result = await this.createWithDedupInfo(input);
    return result.memory;
  }
}

// ----- Schema tests --------------------------------------------------------

test("rememberSchema accepts force_new field with default false (R4 — HIGH-4)", () => {
  const parsed = rememberSchema.parse({ content: "anything" });
  assert.equal(parsed.force_new, false, "force_new defaults to false");
});

test("rememberSchema accepts force_new=true explicit", () => {
  const parsed = rememberSchema.parse({ content: "anything", force_new: true });
  assert.equal(parsed.force_new, true);
});

test("rememberSchema rejects non-boolean force_new value", () => {
  const result = rememberSchema.safeParse({ content: "x", force_new: "yes" });
  assert.equal(result.success, false);
});

// ----- Concurrent / parallel write tests (HIGH-3 disproof) -----------------

test("remember: 3 parallel calls with distinct content → 3 distinct UUIDs (HIGH-3 disproof)", async () => {
  const svc = new FakeMemoryService();
  const calls = await Promise.all([
    remember(svc as unknown as MemoryService, fakeProjects, "test-agent", {
      content: "Le serveur Dell tourne stable",
      category: "general",
      tags: [],
      force_new: false,
    }),
    remember(svc as unknown as MemoryService, fakeProjects, "test-agent", {
      content: "La cuisine du dimanche matin se prépare",
      category: "general",
      tags: [],
      force_new: false,
    }),
    remember(svc as unknown as MemoryService, fakeProjects, "test-agent", {
      content: "Saphi pratique le yoga méditatif quotidien",
      category: "general",
      tags: [],
      force_new: false,
    }),
  ]);

  const ids = calls.map((c) => {
    const text = (c.content[0] as { text: string }).text;
    const match = text.match(/\[id: (mem-\d+)\]/);
    return match ? match[1] : null;
  });
  const distinct = new Set(ids);
  assert.equal(distinct.size, 3, `must produce 3 distinct UUIDs, got: ${ids.join(",")}`);
  assert.ok(ids.every((id) => id !== null), "all IDs must be present (no dedup_to_existing)");
});

test("remember: 5 sequential distinct-content writes → 5 distinct UUIDs persisted", async () => {
  const svc = new FakeMemoryService();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const out = await remember(svc as unknown as MemoryService, fakeProjects, "test-agent", {
      content: `Distinct fact number ${i} with totally different vocabulary ${["alpha", "beta", "gamma", "delta", "epsilon"][i]}`,
      category: "general",
      tags: [],
      force_new: false,
    });
    const text = (out.content[0] as { text: string }).text;
    const match = text.match(/\[id: (mem-\d+)\]/);
    ids.push(match![1]);
  }
  assert.equal(new Set(ids).size, 5, `5 sequential writes must produce 5 distinct UUIDs, got: ${ids.join(",")}`);
  assert.equal(svc.storedMemories.length, 5, "all 5 memories must be persisted");
});

// ----- Near-dup transparency tests (HIGH-4 fix) ----------------------------

test("remember: near-dup detected (default force_new=false) surfaces dedup_to_existing in response (HIGH-4)", async () => {
  const svc = new FakeMemoryService();
  // Pre-load: any content starting with "Le worker Mycelium" → near-dup hit.
  svc.dedupMap.set("Le worker Mycelium", {
    id: "mem-existing-adopted",
    relevance: 0.96,
    existing_content: "Le worker Mycelium phase 2 est ADOPTED en production.",
  });

  const out = await remember(svc as unknown as MemoryService, fakeProjects, "test-agent", {
    content: "Le worker Mycelium phase 2 est REJECTED en production.",
    category: "decisions",
    tags: [],
    force_new: false,
  });

  const block = out.content[0] as {
    text: string;
    dedup_to_existing?: boolean;
    existing_id?: string;
    similarity_score?: number;
  };
  assert.equal(block.dedup_to_existing, true, "dedup_to_existing field must be true on merge");
  assert.equal(block.existing_id, "mem-existing-adopted", "existing_id must point to merged memory");
  assert.equal(block.similarity_score, 0.96, "similarity_score must be exposed");
  assert.match(block.text, /Merged into near-duplicate/, "human-readable text must signal merge");
  assert.match(block.text, /force_new=true to override/, "text must mention escape hatch");
  assert.equal(svc.storedMemories.length, 0, "no new memory persisted on dedup hit");
});

test("remember: force_new=true bypasses near-dup check and creates new memory (HIGH-4 escape hatch)", async () => {
  const svc = new FakeMemoryService();
  svc.dedupMap.set("Le worker Mycelium", {
    id: "mem-existing-adopted",
    relevance: 0.96,
    existing_content: "Le worker Mycelium phase 2 est ADOPTED en production.",
  });

  const out = await remember(svc as unknown as MemoryService, fakeProjects, "test-agent", {
    content: "Le worker Mycelium phase 2 est REJECTED en production.",
    category: "decisions",
    tags: [],
    force_new: true,
  });

  const block = out.content[0] as {
    text: string;
    dedup_to_existing?: boolean;
  };
  assert.notEqual(block.dedup_to_existing, true, "force_new=true must skip dedup signaling");
  assert.match(block.text, /Remembered \(decisions/, "must show normal Remembered text");
  assert.equal(svc.storedMemories.length, 1, "new memory must be created");
  assert.equal(
    svc.storedMemories[0].content,
    "Le worker Mycelium phase 2 est REJECTED en production.",
    "stored content must be the new content, not the existing one"
  );
  // Verify the createWithDedupInfo opts were passed through correctly.
  assert.equal(svc.createCalls[0].opts?.force_new, true, "force_new must propagate to service");
});

test("remember: backward compat — existing service.create() still returns Memory directly", async () => {
  const svc = new FakeMemoryService();
  // Direct call to legacy create() path (used by import.ts, absorb.ts, digest.ts)
  const memory = await svc.create({
    content: "back-compat smoke",
    category: "general",
    tags: [],
  });
  assert.ok(memory.id, "legacy create() must still return a Memory with id");
  assert.equal(memory.content, "back-compat smoke");
});
