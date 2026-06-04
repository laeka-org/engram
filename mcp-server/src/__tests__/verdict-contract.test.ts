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
  VERDICT_CONTRACT_VERSION,
} from "../services/verdict.js";
import type {
  VerdictAction,
  VerdictContext,
  IntegrityVerdict,
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

// §11.3 reconcile-never-destroys  — PENDING STEP 4
// §11.4 escalate-never-drops      — PENDING STEP 4/6
// §11.5 fail-closed-destructive   — PENDING STEP 8
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
