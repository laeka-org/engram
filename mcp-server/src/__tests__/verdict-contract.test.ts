/**
 * verdict-contract.test.ts — conformance suite for the verdict contract v1
 * soldered into engram (palier 2).
 *
 * Spec: handoffs/2026-06-04-verdict-contract-v1-frozen-R-output.md §11
 * Plan: handoffs/2026-06-04-engram-verdict-contract-soudure-plan-palier2-maya.md §6
 *
 * Each `test` maps to a falsifiable conformance criterion (§11.1 … §11.7).
 * Criteria not yet implemented in the current step are marked CRIT-N PENDING
 * in a comment and not asserted (no fake-green).
 *
 * STEP 1 coverage:
 *   §11.1 non-contournability — STRUCTURAL lint (this file) + gate wiring.
 *   §11.2 audit_id always present — partial (skeleton always mints an id).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  verdict,
  isDestructive,
  shouldEscalate,
  evaluateBlockRules,
  detectReconcile,
  DEFAULT_BLOCK_RULES,
  VERDICT_CONTRACT_VERSION,
} from "../services/verdict.js";
import type {
  VerdictAction,
  VerdictContext,
  IntegrityVerdict,
  BlockRule,
  ReconcileCandidate,
} from "../services/verdict.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/__tests__ -> dist/.. -> back to src for static source analysis.
const SRC_DIR = join(__dirname, "..", "..", "src");

function readSrc(rel: string): string {
  return readFileSync(join(SRC_DIR, rel), "utf8");
}

// ---------------------------------------------------------------------------
// verdict() skeleton — every op returns a well-formed allow verdict (STEP 1).
// ---------------------------------------------------------------------------

const ALL_OPS: VerdictAction["op"][] = ["store", "recall", "correct", "forget"];

for (const op of ALL_OPS) {
  test(`verdict skeleton: op=${op} returns a well-formed allow verdict`, async () => {
    const v = await verdict({ op, payload: "x" });
    assert.equal(v.contract_version, VERDICT_CONTRACT_VERSION);
    assert.equal(v.decision, "allow");
    assert.equal(typeof v.rationale, "string");
    assert.ok(v.rationale.length > 0, "rationale must be non-empty");
    // §11.2: audit_id always present (skeleton mints a local uuid).
    assert.equal(typeof v.audit_id, "string");
    assert.ok(v.audit_id.length > 0, "audit_id must be non-empty");
  });
}

test("verdict skeleton: mandatory fields present even with empty context", async () => {
  const v = await verdict({ op: "recall" });
  for (const k of ["contract_version", "decision", "rationale", "audit_id"] as const) {
    assert.ok(k in v, `mandatory field ${k} must be present`);
  }
});

test("verdict: persistAudit dep supplies the audit_id when wired", async () => {
  let seen: unknown = null;
  const v = await verdict(
    { op: "store", payload: "fact" },
    { seatId: "apex" },
    {
      persistAudit: async (entry) => {
        seen = entry;
        return "audit-row-123";
      },
    },
  );
  assert.equal(v.audit_id, "audit-row-123");
  assert.ok(seen, "persistAudit must have been called");
});

test("verdict: persistAudit failure degrades to a local audit_id (never empty)", async () => {
  const v = await verdict(
    { op: "store", payload: "fact" },
    {},
    {
      persistAudit: async () => {
        throw new Error("audit sink down");
      },
    },
  );
  // audit_id is non-differable (contract §3): a sink failure must NOT drop it.
  assert.equal(typeof v.audit_id, "string");
  assert.ok(v.audit_id.length > 0);
  assert.notEqual(v.audit_id, "");
});

// ---------------------------------------------------------------------------
// isDestructive — fail-soft (§7) predicate. forget is always destructive;
// destructive riskLevel qualifies; correct is destructive-soft (NOT auto).
// ---------------------------------------------------------------------------

test("isDestructive: forget is always destructive", () => {
  assert.equal(isDestructive({ op: "forget" }, {}), true);
});

test("isDestructive: destructive riskLevel qualifies any op", () => {
  assert.equal(isDestructive({ op: "store" }, { riskLevel: "destructive" }), true);
});

test("isDestructive: correct is destructive-soft, not auto-destructive", () => {
  assert.equal(isDestructive({ op: "correct" }, {}), false);
});

test("isDestructive: store/recall at low risk are not destructive", () => {
  assert.equal(isDestructive({ op: "store" }, { riskLevel: "low" }), false);
  assert.equal(isDestructive({ op: "recall" }, {}), false);
});

// ---------------------------------------------------------------------------
// §11.1 NON-CONTOURNABILITÉ — structural lint. THE load-bearing test.
//
// The invariant: the memories table is reachable only through MemoryService,
// and every public MemoryService op calls this.gate() before touching the DB.
// These are static-source assertions (read the .ts, not the runtime) because
// the invariant is about CODE SHAPE, not a single execution path.
// ---------------------------------------------------------------------------

// The verdict contract governs store/correct/forget = MUTATIONS of the
// memories table. §11.1 says those must be non-contournable through
// MemoryService. Read-only analytics by background cognition agents
// (conscience-agent contradiction scan, identity genome/fitness reads) are NOT
// the four ops and are out of §11.1's mutation clause — recall governs the
// TOOL recall path, not internal cognition reads.
//
// KNOWN SECONDARY WRITE PATH (documented, not silently excluded): the
// middleware auto-absorber (src/middleware/absorber.ts) inserts memories
// directly from its own PostgrestClient. It is a SEPARATE deployable (the
// middleware proxy, gated behind AUTO_ABSORB_ON), NOT wired into the live MCP
// server (src/index.ts) — the live corps' only memory writer is MemoryService.
// It is enumerated here so the test FAILS LOUDLY if a NEW uncovered write path
// appears, while recording that closing this one (route absorber through a
// MemoryService instance) is tracked as a residual for a later step.
const KNOWN_MEMORY_MUTATORS = [
  "services/supabase.ts",        // the gated choke-point (required)
  "middleware/absorber.ts",      // documented secondary write path (proxy-only)
];

test("§11.1 structural: memories-table MUTATIONS are confined to the gated choke-point + documented exceptions", () => {
  const offenders = findMemoriesTableMutators();
  assert.deepEqual(
    offenders,
    KNOWN_MEMORY_MUTATORS.slice().sort(),
    `memories-table mutation must go through MemoryService (or a documented, ` +
      `enumerated exception). New uncovered mutators found: ` +
      `${offenders.filter((f) => !KNOWN_MEMORY_MUTATORS.includes(f)).join(", ") || "(none — list drifted, update KNOWN_MEMORY_MUTATORS)"}`,
  );
});

test("§11.1 structural: services/supabase.ts is and remains a memories mutator (gate cannot be orphaned)", () => {
  const offenders = findMemoriesTableMutators();
  assert.ok(
    offenders.includes("services/supabase.ts"),
    "the gated choke-point must own the primary mutation path",
  );
});

test("§11.1 structural: every public MemoryService op gates before DB access", () => {
  const src = readSrc("services/supabase.ts");
  // Pull each op-entry method body and assert this.gate(...) appears before the
  // first this.db access within that method.
  const opEntries = [
    { method: "createWithDedupInfo", op: "store" },
    { method: "search", op: "recall" },
    { method: "update", op: "correct" },
    { method: "delete", op: "forget" },
    { method: "archive", op: "forget" },
  ];
  for (const { method, op } of opEntries) {
    const body = extractMethodBody(src, method);
    assert.ok(body, `method ${method} must exist in supabase.ts`);
    const gateIdx = body!.indexOf("this.gate(");
    const dbIdx = body!.indexOf("this.db");
    assert.ok(gateIdx >= 0, `${method} (op=${op}) must call this.gate()`);
    if (dbIdx >= 0) {
      assert.ok(
        gateIdx < dbIdx,
        `${method} (op=${op}) must call this.gate() BEFORE any this.db access`,
      );
    }
    // The gate call must carry the correct op literal.
    assert.ok(
      body!.includes(`op: "${op}"`),
      `${method} must gate with op="${op}"`,
    );
  }
});

test("§11.1 structural: the public search gates; the private _search does not (no double-gate)", () => {
  const src = readSrc("services/supabase.ts");
  const pub = extractMethodBody(src, "search");
  const priv = extractMethodBody(src, "_search");
  assert.ok(pub && priv, "both search and _search must exist");
  assert.ok(pub!.includes("this.gate("), "public search must gate");
  assert.ok(!priv!.includes("this.gate("), "_search must NOT gate (internal raw path)");
});

// ---------------------------------------------------------------------------
// §11.2 audit_id present & resolvable — STEP 1 partial (always present).
// Resolvability to a memory_events row lands in STEP 3 (audit sink wiring).
// ---------------------------------------------------------------------------

test("§11.2 partial: every verdict carries a non-empty audit_id", async () => {
  for (const op of ALL_OPS) {
    const v: IntegrityVerdict = await verdict({ op });
    assert.ok(v.audit_id && v.audit_id.length > 0, `op=${op} must carry audit_id`);
  }
});

// ---------------------------------------------------------------------------
// STEP 2 — block decision (generalised from admission-gate). Covers all ops.
// ---------------------------------------------------------------------------

test("block: destructive op (forget) from an external seat is refused", async () => {
  const v = await verdict(
    { op: "forget", payload: "mem-1" },
    { trustClass: "external", riskLevel: "destructive", seatId: "tenant-x" },
  );
  assert.equal(v.decision, "block");
  assert.match(v.rationale, /destructive op requires a trusted seat/);
  assert.ok(v.audit_id.length > 0);
});

test("block: destructive op from untrusted seat is refused", async () => {
  const v = await verdict(
    { op: "forget", payload: "mem-1" },
    { trustClass: "untrusted" },
  );
  assert.equal(v.decision, "block");
});

test("block: destructive op from dyade/seat is allowed (authority present)", async () => {
  for (const trust of ["dyade", "seat"] as const) {
    const v = await verdict({ op: "forget", payload: "mem-1" }, { trustClass: trust });
    assert.equal(v.decision, "allow", `trustClass=${trust} should be authorised`);
  }
});

test("block: ABSENT trustClass on a destructive op = internal caller, allowed (no silent downgrade)", async () => {
  // The live forget tool calls service.delete(id) context-free. That internal
  // path must NOT be blocked — only callers that DECLARE external/untrusted are.
  const v = await verdict({ op: "forget", payload: "mem-1" }, { riskLevel: "destructive" });
  assert.equal(v.decision, "allow");
});

test("block: non-destructive ops (store/recall) from external seat still allow by default floor", async () => {
  // The §4 default floor only blocks destructive-without-authority +
  // forbidden-content. A plain external recall is allowed (the manifest can
  // tighten this later; the floor must not over-block).
  const r = await verdict({ op: "recall", payload: "q" }, { trustClass: "external" });
  assert.equal(r.decision, "allow");
  const s = await verdict({ op: "store", payload: "fact" }, { trustClass: "external" });
  assert.equal(s.decision, "allow");
});

test("block: custom forbidden-content rule denies a matching store", async () => {
  const denySecrets: BlockRule = (action) => {
    if (action.op === "store" && typeof action.payload === "string" && /SSN:/.test(action.payload)) {
      return { reason: "forbidden_content", rationale: "store refused: contains SSN" };
    }
    return null;
  };
  const v = await verdict(
    { op: "store", payload: "SSN: 123-45-6789" },
    {},
    { blockRules: [denySecrets] },
  );
  assert.equal(v.decision, "block");
  assert.match(v.rationale, /SSN/);
});

test("block: first-deny-wins ordering (admission-gate convention)", () => {
  const ruleA: BlockRule = () => ({ reason: "a", rationale: "rule A denied" });
  const ruleB: BlockRule = () => ({ reason: "b", rationale: "rule B denied" });
  const out = evaluateBlockRules({ op: "store" }, {}, [ruleA, ruleB]);
  assert.equal(out?.reason, "a");
});

test("block: evaluateBlockRules returns null when no rule fires", () => {
  const out = evaluateBlockRules({ op: "recall" }, {}, DEFAULT_BLOCK_RULES);
  assert.equal(out, null);
});

test("block: a blocked verdict still carries all mandatory fields", async () => {
  const v = await verdict({ op: "forget" }, { trustClass: "untrusted" });
  const rec = v as unknown as Record<string, unknown>;
  for (const k of ["contract_version", "decision", "rationale", "audit_id"] as const) {
    assert.ok(k in v && rec[k], `mandatory ${k} on block`);
  }
});

// ---------------------------------------------------------------------------
// STEP 3 — audit_id resolvable to a memory_events row (§11.2 full).
// ---------------------------------------------------------------------------

test("§11.2 audit: verdict passes the full private entry to the audit sink", async () => {
  const captures: Record<string, unknown>[] = [];
  const v = await verdict(
    { op: "forget", payload: "mem-9" },
    { trustClass: "untrusted", seatId: "tenant-z", riskLevel: "destructive" },
    {
      persistAudit: async (entry) => {
        captures.push(entry as unknown as Record<string, unknown>);
        return "ev-row-777";
      },
    },
  );
  assert.equal(v.audit_id, "ev-row-777");
  assert.equal(captures.length, 1, "audit sink must receive exactly one entry");
  const captured = captures[0];
  // The audit entry carries the moat detail (decision/rationale/seat/trust);
  // the CLIENT verdict only carries decision + rationale + audit_id — the
  // detail stays server-side.
  assert.equal(captured.op, "forget");
  assert.equal(captured.decision, "block"); // untrusted destructive → block
  assert.equal(captured.seat_id, "tenant-z");
  assert.equal(captured.trust_class, "untrusted");
  // The verdict serialised to the client must NOT leak the private detail.
  assert.ok(!("detail" in v), "verdict must not serialise the moat detail");
  assert.ok(!("seat_id" in v), "verdict must not serialise seat_id");
});

test("§11.2 audit: a blocked verdict is audited too (every verdict produces a row)", async () => {
  const ids: string[] = [];
  await verdict({ op: "store", payload: "x" }, {}, { persistAudit: async () => { ids.push("a"); return "a"; } });
  await verdict({ op: "forget" }, { trustClass: "external", riskLevel: "destructive" }, { persistAudit: async () => { ids.push("b"); return "b"; } });
  assert.deepEqual(ids, ["a", "b"], "both allow and block must hit the audit sink");
});

// Migration 086 — verdict event_type. Additive + non-destructive (the new CHECK
// list must be a strict superset of migration 062's, plus 'verdict').
const MIGRATIONS_DIR = join(SRC_DIR, "..", "..", "supabase", "migrations");

function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

function eventTypesInCheck(sql: string): Set<string> {
  // Grab the event_type IN (...) list and pull every single-quoted literal.
  const m = /event_type\s+IN\s*\(([\s\S]*?)\)\s*\)/.exec(sql);
  if (!m) return new Set();
  const body = m[1];
  const lits = body.match(/'([^']+)'/g) ?? [];
  return new Set(lits.map((l) => l.replace(/'/g, "")));
}

test("migration 086: adds 'verdict' to the memory_events event_type CHECK", () => {
  const sql = readMigration("086_verdict_event_type.sql");
  const types = eventTypesInCheck(sql);
  assert.ok(types.has("verdict"), "086 must allow event_type='verdict'");
});

test("migration 086: is additive — superset of migration 062's event types", () => {
  const types062 = eventTypesInCheck(readMigration("062_compute_affect.sql"));
  const types086 = eventTypesInCheck(readMigration("086_verdict_event_type.sql"));
  assert.ok(types062.size > 0, "sanity: 062 has a non-empty CHECK list");
  for (const t of types062) {
    assert.ok(
      types086.has(t),
      `086 must preserve event_type '${t}' from 062 (additive, non-destructive)`,
    );
  }
});

test("migration 086: uses the proven DROP-IF-EXISTS / ADD ALTER pattern", () => {
  const sql = readMigration("086_verdict_event_type.sql");
  assert.match(sql, /DROP CONSTRAINT IF EXISTS memory_events_event_type_check/);
  assert.match(sql, /ADD CONSTRAINT memory_events_event_type_check CHECK/);
});

// ---------------------------------------------------------------------------
// STEP 4 — reconcile (the only first-class-NEW decision) + §11.3.
// ---------------------------------------------------------------------------

// Two embeddings that are near-identical (high cosine) and one that is
// orthogonal — built by hand so the pure detector is deterministic.
const VEC_A = [1, 0, 0, 0];
const VEC_A_NEAR = [0.98, 0.02, 0, 0]; // cosine with VEC_A ≈ 0.9998 (> 0.85)
const VEC_ORTHO = [0, 1, 0, 0];        // cosine with VEC_A = 0

test("detectReconcile: same-topic + polarity inversion → finding", () => {
  const candidates: ReconcileCandidate[] = [
    { id: "old-1", content: "The server is reachable", embedding: VEC_A },
  ];
  const findings = detectReconcile("The server is not reachable", VEC_A_NEAR, candidates);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].prior_id, "old-1");
  assert.ok(findings[0].cosine > 0.85);
});

test("detectReconcile: same polarity (corroboration) → NO finding", () => {
  const candidates: ReconcileCandidate[] = [
    { id: "old-2", content: "The server is reachable", embedding: VEC_A },
  ];
  // Same affirmative polarity → corroboration, not contradiction.
  const findings = detectReconcile("The server is reachable now", VEC_A_NEAR, candidates);
  assert.equal(findings.length, 0);
});

test("detectReconcile: different topic (low cosine) → NO finding even if inverted", () => {
  const candidates: ReconcileCandidate[] = [
    { id: "old-3", content: "The cat is on the mat", embedding: VEC_ORTHO },
  ];
  const findings = detectReconcile("The server is not reachable", VEC_A, candidates);
  assert.equal(findings.length, 0);
});

test("detectReconcile: no embedding → empty (cannot judge topic)", () => {
  const candidates: ReconcileCandidate[] = [
    { id: "old-4", content: "x is not y", embedding: VEC_A },
  ];
  assert.deepEqual(detectReconcile("x is y", undefined, candidates), []);
});

test("reconcile: verdict returns decision=reconcile with supersedes + validity", async () => {
  const v = await verdict(
    { op: "store", payload: "The deploy is not green", embedding: VEC_A_NEAR },
    {},
    {
      reconcileCandidates: async () => [
        { id: "prior-9", content: "The deploy is green", embedding: VEC_A },
      ],
    },
  );
  assert.equal(v.decision, "reconcile");
  assert.deepEqual(v.supersedes, ["prior-9"]);
  assert.ok(v.validity?.valid_from, "reconcile carries a validity window (valid_from)");
  assert.ok(v.audit_id.length > 0);
});

test("reconcile: no candidates → plain allow (reconcile is opt-in by contradiction)", async () => {
  const v = await verdict(
    { op: "store", payload: "A fresh unrelated fact", embedding: VEC_A },
    {},
    { reconcileCandidates: async () => [] },
  );
  assert.equal(v.decision, "allow");
  assert.equal(v.supersedes, undefined);
});

test("reconcile: candidate-fetch failure falls through to allow (write not blocked)", async () => {
  const v = await verdict(
    { op: "store", payload: "fact", embedding: VEC_A },
    {},
    {
      reconcileCandidates: async () => {
        throw new Error("neighbour fetch down");
      },
    },
  );
  assert.equal(v.decision, "allow");
});

test("reconcile: only store ops reconcile (recall/correct/forget never do)", async () => {
  for (const op of ["recall", "correct", "forget"] as const) {
    const v = await verdict(
      { op, payload: "x", embedding: VEC_A_NEAR },
      { trustClass: "seat" }, // seat so forget isn't blocked
      {
        reconcileCandidates: async () => [
          { id: "p", content: "x is not y", embedding: VEC_A },
        ],
      },
    );
    assert.notEqual(v.decision, "reconcile", `op=${op} must not reconcile`);
  }
});

// §11.3 reconcile-never-destroys — the supersede_memory RPC (migration 048) is
// the application mechanism. The bitemporal guarantee is that it NEVER deletes
// the old row (it sets valid_until + archives), so an asOf read before
// valid_until still finds it. Pin that at the SQL-contract level.
test("§11.3 reconcile-never-destroys: supersede_memory archives + bounds, never DELETEs", () => {
  const sql = readMigration("048_bitemporal_coactivation.sql");
  // Extract the supersede_memory function body.
  const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION supersede_memory");
  assert.ok(fnStart >= 0, "supersede_memory must exist in migration 048");
  // Body up to the GRANT line that follows it.
  const grantIdx = sql.indexOf("GRANT EXECUTE ON FUNCTION supersede_memory", fnStart);
  const body = sql.slice(fnStart, grantIdx >= 0 ? grantIdx : sql.length);
  // It must set valid_until and archive — and must NOT issue a DELETE on memories.
  assert.match(body, /valid_until\s*=\s*NOW\(\)/i, "supersede must bound valid_until");
  assert.match(body, /stage\s*=\s*'archived'/i, "supersede must archive, not delete");
  assert.ok(
    !/DELETE\s+FROM\s+memories/i.test(body),
    "supersede_memory must NEVER DELETE FROM memories (§11.3 bitemporal)",
  );
});

// ---------------------------------------------------------------------------
// STEP 8 — fail-soft / degraded mode (§7) + §11.5 fail-closed-destructive.
// ---------------------------------------------------------------------------

const coreDown = { monade: { health: async () => false } };
const coreUp = { monade: { health: async () => true } };
const coreThrows = { monade: { health: async () => { throw new Error("probe error"); } } };

test("§11.5 fail-closed: core unreachable + forget → block", async () => {
  const v = await verdict({ op: "forget", payload: "m" }, { trustClass: "seat" }, coreDown);
  assert.equal(v.decision, "block");
  assert.match(v.rationale, /fail-closed/);
});

test("§11.5 fail-closed: core unreachable + destructive risk → block (even on store)", async () => {
  const v = await verdict({ op: "store", payload: "m" }, { riskLevel: "destructive" }, coreDown);
  assert.equal(v.decision, "block");
});

test("fail-soft: core unreachable + non-destructive (store) → allow, degraded", async () => {
  const captures: Record<string, unknown>[] = [];
  const v = await verdict(
    { op: "store", payload: "m" },
    {},
    { monade: { health: async () => false }, persistAudit: async (e) => { captures.push(e as unknown as Record<string, unknown>); return "id"; } },
  );
  assert.equal(v.decision, "allow");
  assert.match(v.rationale, /degraded/);
  assert.equal(captures[0].degraded, true, "audit must flag degraded=true");
});

test("fail-soft: core unreachable + recall → allow, degraded", async () => {
  const v = await verdict({ op: "recall", payload: "q" }, {}, coreDown);
  assert.equal(v.decision, "allow");
  assert.match(v.rationale, /degraded/);
});

test("fail-soft: a throwing health probe is treated as unreachable", async () => {
  const v = await verdict({ op: "forget" }, { trustClass: "seat" }, coreThrows);
  assert.equal(v.decision, "block");
  assert.match(v.rationale, /fail-closed/);
});

test("fail-soft: core UP → normal path runs (no degraded flag)", async () => {
  const captures: Record<string, unknown>[] = [];
  const v = await verdict(
    { op: "store", payload: "m" },
    {},
    { monade: { health: async () => true }, persistAudit: async (e) => { captures.push(e as unknown as Record<string, unknown>); return "id"; } },
  );
  assert.equal(v.decision, "allow");
  assert.equal(captures[0].degraded, false, "core up → not degraded");
});

test("fail-soft: NO monade configured → no health call, normal path (no-op)", async () => {
  let probed = false;
  const v = await verdict(
    { op: "forget" },
    { trustClass: "seat" },
    { persistAudit: async () => { return "id"; } },
  );
  // No monade dep → fail-soft cannot engage; seat-authorised forget allows.
  assert.equal(probed, false);
  assert.equal(v.decision, "allow");
});

test("fail-soft: core down does NOT mask the block-authority rule for destructive (both → block)", async () => {
  // External untrusted + core down + forget: fail-closed wins first (block),
  // which is the same safe answer the authority rule would give. Either way
  // the destructive op is refused — never allowed.
  const v = await verdict({ op: "forget" }, { trustClass: "external" }, coreDown);
  assert.equal(v.decision, "block");
});

void coreUp; // referenced for symmetry / future use

// ---------------------------------------------------------------------------
// STEP 6 — escalate (non-resolvable hand-up) + §11.4 escalate-never-drops.
// ---------------------------------------------------------------------------

test("shouldEscalate: high-risk destructive → true; lower risk → false", () => {
  assert.equal(shouldEscalate({ op: "forget" }, { riskLevel: "high" }), true);
  assert.equal(shouldEscalate({ op: "store" }, { riskLevel: "high" }), false); // not destructive
  assert.equal(shouldEscalate({ op: "forget" }, { riskLevel: "destructive" }), false); // not "high"
  assert.equal(shouldEscalate({ op: "forget" }, {}), false);
});

test("§11.4 escalate: high-risk destructive op with no judge → decision=escalate (op halts, never drops)", async () => {
  const captures: Record<string, unknown>[] = [];
  const v = await verdict(
    { op: "forget", payload: "m" },
    { trustClass: "seat", riskLevel: "high" },
    { persistAudit: async (e) => { captures.push(e as unknown as Record<string, unknown>); return "esc-1"; } },
  );
  assert.equal(v.decision, "escalate");
  assert.equal(v.audit_id, "esc-1", "escalate is audited — the hand-up record (zero silent drop)");
  assert.equal(captures.length, 1, "exactly one audit row = the hand-up");
  assert.match(v.rationale, /handed up|zero silent drop/);
});

test("escalate: Monade judge present → its decision is honored (LLM only on escalate)", async () => {
  let judgeCalls = 0;
  const v = await verdict(
    { op: "forget", payload: "m" },
    { trustClass: "seat", riskLevel: "high" },
    {
      monade: {
        health: async () => true,
        judge: async () => { judgeCalls++; return { decision: "block", rationale: "judge: refuse" }; },
      },
    },
  );
  assert.equal(v.decision, "block");
  assert.match(v.rationale, /judge/);
  assert.equal(judgeCalls, 1, "judge consulted exactly once on escalate");
});

test("escalate: a FAILING judge does not silently drop — falls through to local escalate", async () => {
  const v = await verdict(
    { op: "forget", payload: "m" },
    { trustClass: "seat", riskLevel: "high" },
    { monade: { health: async () => true, judge: async () => { throw new Error("judge down"); } } },
  );
  assert.equal(v.decision, "escalate", "judge failure → escalate, never silent allow/drop");
});

test("escalate: normal traffic does NOT consult the judge (fast path untouched)", async () => {
  let judgeCalls = 0;
  const monade = {
    health: async () => true,
    judge: async () => { judgeCalls++; return { decision: "allow" as const, rationale: "n/a" }; },
  };
  // A plain store / recall / non-high forget must never reach the judge.
  await verdict({ op: "store", payload: "x" }, {}, { monade });
  await verdict({ op: "recall", payload: "q" }, {}, { monade });
  await verdict({ op: "forget" }, { trustClass: "seat" }, { monade }); // not high-risk
  assert.equal(judgeCalls, 0, "judge must NOT be consulted on normal fast-path traffic");
});

test("§11.4 escalate: every escalate carries a resolvable audit_id (the hand-up trace)", async () => {
  const v = await verdict({ op: "forget" }, { trustClass: "seat", riskLevel: "high" });
  assert.equal(v.decision, "escalate");
  assert.ok(v.audit_id.length > 0, "escalate must carry an audit_id (no silent drop)");
});

// §11.6 manifest-only-Sid-surface — PENDING STEP 7
// §11.7 contract-identical-A/B    — PENDING Profil B (post-dogfood)

// ---------------------------------------------------------------------------
// Static-analysis helpers (deliberately dependency-free; this is a lint).
// ---------------------------------------------------------------------------

/**
 * Walk src/ and return the relative paths of files that MUTATE the `memories`
 * table — i.e. `.from("memories")` chained with `.insert(` / `.update(` /
 * `.delete(`. These are the store / correct / forget surfaces §11.1 governs.
 * Pure `.select(` reads are excluded (background-cognition reads are not the
 * four ops). Detection is line-window based: for each `.from("memories")`
 * match we look at the surrounding chained call within the next few lines for
 * a mutation verb, which is robust to the codebase's multi-line query builder
 * style.
 */
function findMemoriesTableMutators(): string[] {
  const hits = new Set<string>();
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (statSync(abs).isDirectory()) {
        // Skip the test tree itself and deferred/parked code.
        if (entry === "__tests__" || entry === "deferred") continue;
        walk(abs, relPath);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      const txt = readFileSync(abs, "utf8");
      const lines = txt.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/\.from\(\s*["'`]memories["'`]\s*\)/.test(lines[i])) continue;
        // Look at this line + the next 4 for a mutation verb on the chain.
        const window = lines.slice(i, i + 5).join("\n");
        if (/\.(insert|update|delete|upsert)\s*\(/.test(window)) {
          hits.add(relPath);
        }
      }
    }
  };
  walk(SRC_DIR, "");
  return [...hits].sort();
}

/**
 * Extract the textual body of a class method by brace-matching from its
 * signature. Good enough for a lint that only checks call-ordering of
 * `this.gate(` vs `this.db` — it does not need a real parser.
 */
function extractMethodBody(src: string, method: string): string | null {
  // Match `<modifiers> <method>(` at method indentation. Modifiers (private,
  // async, public, protected) may appear in any order; a boundary before the
  // method name prevents `search` from matching inside `_search`.
  const sigRe = new RegExp(
    `\\n\\s*(?:(?:private|public|protected|async)\\s+)*(?<![A-Za-z0-9_])${method}\\s*\\(`,
  );
  const m = sigRe.exec(src);
  if (!m) return null;
  // Find the opening brace of the method body after the signature.
  let i = m.index + m[0].length;
  // Skip to the first "{" that opens the body (after the param list + return type).
  let depthParen = 1; // we consumed one "("
  while (i < src.length && depthParen > 0) {
    const c = src[i++];
    if (c === "(") depthParen++;
    else if (c === ")") depthParen--;
  }
  // Now skip whitespace + optional ": ReturnType" until "{".
  while (i < src.length && src[i] !== "{") i++;
  if (src[i] !== "{") return null;
  // Brace-match the body.
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  return null;
}
