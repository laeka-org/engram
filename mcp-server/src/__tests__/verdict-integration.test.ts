/**
 * verdict-integration.test.ts — the WIRED verdict path under adversarial traffic.
 *
 * WHY A SEPARATE FILE (concern distinct from verdict-contract.test.ts):
 *   verdict-contract.test.ts proves the PURE function verdict() in isolation —
 *   it injects stubs straight into verdict(action, context, deps) and asserts the
 *   five decisions. That suite is 67/67 green and is NOT duplicated here.
 *
 *   The gap it leaves open: nothing exercises the CABLED path
 *       MemoryService.<op>() → this.gate() → verdict() → audit sink
 *   on adversarial traffic. The unit suite cannot catch a regression where the
 *   service wires the gate with the wrong op literal, swallows the
 *   VerdictBlockedError, or touches the DB before the gate halts a destructive op.
 *   This file closes that — it drives the public MemoryService methods (delete /
 *   archive / search / createWithDedupInfo) and asserts, per adversarial case:
 *     (1) the decision the contract imposes (via VerdictBlockedError or completion),
 *     (2) the audit row written to the injected sink (decision + op correct),
 *     (3) op HALTED (no DB mutation) vs EXECUTED, observed on the fake db client.
 *
 * ISOLATION (hard invariant, doctrine "no test data in prod"):
 *   - The MonadeCore is an injected stub (health/judge), never a live LLM.
 *   - The audit sink is an in-memory array injected via verdictDeps.persistAudit,
 *     never persistVerdictAudit → memory_events → the prod DB.
 *   - this.db is replaced with a FakeDb that records calls in memory and returns
 *     canned data — it never opens a socket. The constructor URL is a deliberately
 *     unroutable sentinel so an accidental real call would fail loudly, not hit
 *     127.0.0.1:54322. On the escalate/block cases the db is never reached anyway
 *     (the gate throws first); the FakeDb proves exactly that.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryService, VerdictBlockedError } from "../services/supabase.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { MonadeCore, VerdictAuditEntry } from "../services/verdict.js";
import type { VerdictDecision } from "../services/wire-types.js";

// ---------------------------------------------------------------------------
// Test doubles — all in-memory, zero network, zero prod.
// ---------------------------------------------------------------------------

/** Deterministic embedder — content-independent constant vector. The reconcile
 *  path is exercised in the unit suite (detectReconcile); here we only need a
 *  provider that resolves so store can reach the gate without an Ollama call. */
const fakeEmbeddings: EmbeddingProvider = {
  dimensions: 3,
  async embed(_text: string): Promise<number[]> {
    return [0.1, 0.2, 0.3];
  },
};

/**
 * A FakeDb mimicking the slice of @supabase/postgrest-js that MemoryService
 * touches on an ALLOW path. It records every mutating call so a test can assert
 * "the DB was (not) touched". Read RPCs return empty so dedup / neighbour /
 * reconcile-candidate lookups resolve to "nothing found" without I/O.
 */
class FakeDb {
  /** Records of mutating table ops: { table, kind }. Empty ⇒ op was HALTED. */
  readonly mutations: Array<{ table: string; kind: "insert" | "update" | "delete" }> = [];
  /** Records of rpc names called (telemetry / reconcile fetch / etc.). */
  readonly rpcs: string[] = [];

  from(table: string) {
    const mutations = this.mutations;
    // A chainable builder. select/order/limit/eq/... return `this`; the terminal
    // shapes (.single(), awaiting the builder) resolve to { data, error }.
    const builder: any = {
      _table: table,
      select() { return builder; },
      order() { return builder; },
      limit() { return builder; },
      eq() { return builder; },
      neq() { return builder; },
      in() { return builder; },
      is() { return builder; },
      contains() { return builder; },
      insert() { mutations.push({ table, kind: "insert" }); return builder; },
      update() { mutations.push({ table, kind: "update" }); return builder; },
      delete() { mutations.push({ table, kind: "delete" }); return builder; },
      single() { return Promise.resolve({ data: null, error: null }); },
      // Awaiting the builder (no .single()) resolves to an empty result set.
      then(resolve: (v: { data: unknown[]; error: null }) => void) {
        resolve({ data: [], error: null });
      },
    };
    return builder;
  }

  rpc(name: string, _args?: unknown) {
    this.rpcs.push(name);
    // log_memory_event must return a row id (string); everything else empty.
    if (name === "log_memory_event") return Promise.resolve({ data: "fake-event-id", error: null });
    return Promise.resolve({ data: [], error: null });
  }
}

interface Harness {
  svc: MemoryService;
  db: FakeDb;
  audit: VerdictAuditEntry[];
  judgeCalls: number;
}

/**
 * Build a MemoryService wired with: injected audit sink (in-memory), optional
 * Monade stub, and a FakeDb swapped over the real PostgrestClient. The
 * constructor URL is an unroutable sentinel — if the FakeDb swap ever regressed,
 * a real call would throw DNS/connection, never reach prod.
 */
function makeHarness(opts: {
  monade?: MonadeCore;
} = {}): Harness {
  const audit: VerdictAuditEntry[] = [];
  const h: Harness = { svc: null as unknown as MemoryService, db: null as unknown as FakeDb, audit, judgeCalls: 0 };

  const svc = new MemoryService(
    "http://verdict-integration-test.invalid", // unroutable sentinel, never contacted
    "", // no key
    fakeEmbeddings,
    {
      persistAudit: async (entry) => {
        audit.push(entry);
        return `audit-${audit.length}`;
      },
      ...(opts.monade ? { monade: opts.monade } : {}),
    },
  );

  const db = new FakeDb();
  // Swap the real PostgrestClient for the in-memory fake. The field is private;
  // the test reaches in deliberately — this harness is the ONLY place that does,
  // and it is what keeps the integration off the network/prod.
  (svc as unknown as { db: FakeDb }).db = db;

  h.svc = svc;
  h.db = db;
  return h;
}

/** Assert an awaited op halts with a VerdictBlockedError of the given decision. */
async function expectBlocked(
  p: Promise<unknown>,
  decision: VerdictDecision,
): Promise<VerdictBlockedError> {
  try {
    await p;
    assert.fail(`expected VerdictBlockedError(decision=${decision}), op completed instead`);
  } catch (err) {
    assert.ok(err instanceof VerdictBlockedError, `expected VerdictBlockedError, got ${String(err)}`);
    assert.equal(err.verdict.decision, decision, `expected decision=${decision}`);
    return err;
  }
}

/** The last audit row written to the sink. */
function lastAudit(audit: VerdictAuditEntry[]): VerdictAuditEntry {
  assert.ok(audit.length > 0, "audit sink must have received at least one row");
  return audit[audit.length - 1];
}

// ===========================================================================
// (A) ADVERSARIAL INTEGRATION — the cabled path MemoryService → verdict → audit
// ===========================================================================

// --- A1 — forget destructive HIGH-risk from a TRUSTED seat → escalate ----------
// The block layer passes (seat is trusted), so the op reaches the escalate layer:
// a high-risk destructive forget is too consequential to silently allow. Expect
// decision=escalate, op HALTED (no DB delete), audit row decision=escalate.
test("(A1) wired: forget high-risk from a TRUSTED seat → escalate, op halted, audited", async () => {
  const { svc, db, audit } = makeHarness();
  const err = await expectBlocked(
    svc.delete("mem-trusted-1", { trustClass: "seat", riskLevel: "high", seatId: "maya" }),
    "escalate",
  );
  assert.match(err.verdict.rationale, /escalate|handed up|halted/, "escalate rationale present");
  // Op HALTED: no delete reached the db.
  assert.equal(
    db.mutations.filter((m) => m.kind === "delete").length,
    0,
    "escalate must HALT the forget — no DB delete",
  );
  // Audited: exactly the escalate hand-up row.
  const row = lastAudit(audit);
  assert.equal(row.decision, "escalate", "audit row decision=escalate");
  assert.equal(row.op, "forget", "audit row op=forget");
  assert.equal(row.trust_class, "seat");
});

// --- A2 — forget high-risk from an UNTRUSTED seat → block (contract ordering) ---
// The contract orders block (§4 floor) BEFORE escalate. An untrusted destructive
// forget is refused at the block layer; it never reaches escalate. Assert block.
test("(A2) wired: forget high-risk from an UNTRUSTED seat → block (block precedes escalate)", async () => {
  const { svc, db, audit } = makeHarness();
  const err = await expectBlocked(
    svc.delete("mem-untrusted-1", { trustClass: "untrusted", riskLevel: "high", seatId: "tenant-x" }),
    "block",
  );
  assert.match(err.verdict.rationale, /destructive op requires a trusted seat/, "block-authority rationale");
  assert.equal(
    db.mutations.filter((m) => m.kind === "delete").length,
    0,
    "block must HALT the forget — no DB delete",
  );
  const row = lastAudit(audit);
  assert.equal(row.decision, "block", "audit row decision=block");
  assert.equal(row.op, "forget");
});

// --- A3 — JUDGE THROWS → escalate-LOCAL, never allow (safe-swap invariant #4) ---
// THE most important case. A Monade judge configured to throw must NOT cause a
// silent allow of a high-risk destructive forget. The contract falls through to
// a LOCAL escalate (hand-up). Proven on the wired path: op halted, audited.
test("(A3) wired: judge THROWS on escalate → escalate-local, NEVER silent-allow, op halted", async () => {
  let judgeCalls = 0;
  const monade: MonadeCore = {
    health: async () => true,
    judge: async () => {
      judgeCalls++;
      throw new Error("monade judge crashed (synthetic)");
    },
  };
  const { svc, db, audit } = makeHarness({ monade });
  const err = await expectBlocked(
    svc.delete("mem-judge-throw", { trustClass: "seat", riskLevel: "high", seatId: "sophia" }),
    "escalate",
  );
  assert.equal(judgeCalls, 1, "judge consulted exactly once before it threw");
  assert.notEqual(err.verdict.decision, "allow", "CRITICAL: a thrown judge must NEVER yield allow");
  assert.equal(
    db.mutations.filter((m) => m.kind === "delete").length,
    0,
    "thrown-judge forget must HALT — no DB delete (degrade-safe)",
  );
  const row = lastAudit(audit);
  assert.equal(row.decision, "escalate", "thrown judge → escalate audit row (hand-up, zero drop)");
});

// --- A4 — JUDGE PRESENT returns block → honored on the wired path --------------
test("(A4) wired: judge present returns block → honored, op halted, audited as block", async () => {
  let judgeCalls = 0;
  const monade: MonadeCore = {
    health: async () => true,
    judge: async () => {
      judgeCalls++;
      return { decision: "block", rationale: "monade judge: refuse this destruction" };
    },
  };
  const { svc, db, audit } = makeHarness({ monade });
  const err = await expectBlocked(
    svc.delete("mem-judge-block", { trustClass: "seat", riskLevel: "high", seatId: "lea" }),
    "block",
  );
  assert.equal(judgeCalls, 1, "judge consulted exactly once on escalate");
  assert.match(err.verdict.rationale, /monade judge/, "honored judge rationale surfaced");
  assert.equal(
    db.mutations.filter((m) => m.kind === "delete").length,
    0,
    "judge-block must HALT — no DB delete",
  );
  const row = lastAudit(audit);
  assert.equal(row.decision, "block", "audit row reflects the honored judge decision");
});

// --- A5 — JUDGE PRESENT returns allow → op EXECUTES on the wired path -----------
// Completes the safe-swap matrix: a live judge that allows lets the op proceed.
// Proves the wired path actually executes the DB op when the verdict allows
// (not just halts) — so the gate is transparent on a judge-allow.
test("(A5) wired: judge present returns allow → op EXECUTES (DB delete reached)", async () => {
  let judgeCalls = 0;
  const monade: MonadeCore = {
    health: async () => true,
    judge: async () => {
      judgeCalls++;
      return { decision: "allow", rationale: "monade judge: authorised destruction" };
    },
  };
  const { svc, db, audit } = makeHarness({ monade });
  const ok = await svc.delete("mem-judge-allow", { trustClass: "seat", riskLevel: "high", seatId: "anya" });
  assert.equal(ok, true, "judge-allow lets the forget complete");
  assert.equal(judgeCalls, 1, "judge consulted exactly once");
  assert.equal(
    db.mutations.filter((m) => m.kind === "delete").length,
    1,
    "judge-allow → the forget EXECUTES (one DB delete)",
  );
  const row = lastAudit(audit);
  assert.equal(row.decision, "allow", "audit row reflects the honored judge allow");
});

// --- A6 — core DOWN + destructive → block (fail-closed §7) on the wired path ----
test("(A6) wired: core DOWN + destructive forget → block (fail-closed), op halted", async () => {
  const monade: MonadeCore = { health: async () => false };
  const { svc, db, audit } = makeHarness({ monade });
  const err = await expectBlocked(
    svc.delete("mem-coredown", { trustClass: "seat", seatId: "maya" }),
    "block",
  );
  assert.match(err.verdict.rationale, /fail-closed|unreachable/, "fail-closed rationale");
  assert.equal(
    db.mutations.filter((m) => m.kind === "delete").length,
    0,
    "fail-closed must HALT — no DB delete with the core down",
  );
  const row = lastAudit(audit);
  assert.equal(row.decision, "block");
  assert.equal(row.degraded, true, "fail-soft audit row flags degraded");
});

// --- A7 — core DOWN + NON-destructive recall → allow-degraded, op EXECUTES ------
test("(A7) wired: core DOWN + non-destructive recall → allow-degraded, op executes", async () => {
  const monade: MonadeCore = { health: async () => false };
  const { svc, audit } = makeHarness({ monade });
  // search reaches _search → db.rpc(match_memories_cognitive) which the FakeDb
  // resolves to []. The point: it does NOT throw (allow-degraded, not block).
  const results = await svc.search("any query");
  assert.ok(Array.isArray(results), "degraded recall returns a result set (op executed)");
  const row = lastAudit(audit);
  assert.equal(row.decision, "allow", "non-destructive recall → allow-degraded");
  assert.equal(row.degraded, true, "audit row flags degraded");
});

// --- A8 — untrusted high-risk DESTRUCTIVE store via the store op ----------------
// A store is not intrinsically destructive; with an explicit destructive
// riskLevel + a custom forbidden-content style the contract floor still allows a
// plain store (the §4 floor only blocks destructive-without-authority on
// forget/destructive-risk and forbidden-content). This pins the wired store
// behaviour so a future over-eager floor regression is caught: an ordinary
// untrusted store EXECUTES (reaches the DB insert), audited as allow.
test("(A8) wired: ordinary untrusted store → allow, op EXECUTES (no over-block)", async () => {
  const { svc, db, audit } = makeHarness();
  const result = await svc.createWithDedupInfo(
    { content: "a benign fact from an external caller" },
    { force_new: true },
    { trustClass: "external", seatId: "tenant-y" },
  );
  assert.ok(result, "store completes");
  assert.equal(
    db.mutations.filter((m) => m.kind === "insert" && m.table === "memories").length,
    1,
    "allow → the store EXECUTES (one memories insert)",
  );
  const storeAudit = audit.find((a) => a.op === "store");
  assert.ok(storeAudit, "a store verdict was audited");
  assert.equal(storeAudit!.decision, "allow");
});

// ===========================================================================
// (A-struct) The audit sink is the injected in-memory one — NOT prod.
// A guard that the integration never wrote a verdict event to a real DB: the
// only rpc the FakeDb sees must be the read/telemetry path, and every verdict
// audit landed in the in-memory array, never via persistVerdictAudit → db.
// ===========================================================================

test("(A-iso) isolation: every verdict audit went to the injected sink, never the db", async () => {
  const { svc, db, audit } = makeHarness();
  await expectBlocked(
    svc.delete("x", { trustClass: "seat", riskLevel: "high" }),
    "escalate",
  );
  assert.ok(audit.length >= 1, "verdict audit captured in the injected in-memory sink");
  // The FakeDb must NOT have been asked to log_memory_event for the verdict —
  // the injected persistAudit short-circuits before persistVerdictAudit.
  assert.equal(
    db.rpcs.filter((r) => r === "log_memory_event").length,
    0,
    "no verdict audit was routed through the db (injected sink owns it)",
  );
});
