/**
 * monade-core.test.ts — the living Monade judge implementation, offline.
 *
 * Two layers, ZERO live LLM (isolation invariant — same discipline as
 * verdict-integration.test.ts):
 *
 *   GROUP A — MonadeJudge mapping/throw via an INJECTED runner. Proves the TS
 *     contract: a usable decision is surfaced; every unusable shim outcome
 *     (error exit, unknown decision, unparseable stdout, nonzero exit) THROWS,
 *     because verdict()'s escalate catch turns a throw into the safe local
 *     escalate (safe-swap invariant — a judge that cannot decide never clears
 *     a destructive op).
 *
 *   GROUP B — the REAL python shim, end-to-end, against a FAKE judge client in
 *     a temp dir (ENGRAM_JUDGE_CLIENT_DIR). No vendor call. Proves the
 *     security-critical decision map lives where we think it does:
 *       PASS→allow, WARN→escalate, INJECT→inject, BLOCK→block, SKIP→throw.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MonadeJudge, buildMonadeCore } from "../services/monade-core.js";
import type { ShimRunner } from "../services/monade-core.js";
import type { VerdictAction, VerdictContext } from "../services/wire-types.js";

const ACT: VerdictAction = { op: "forget", target: "mem-x" } as VerdictAction;
const CTX: VerdictContext = { trustClass: "seat", riskLevel: "high", seatId: "maya" };

function runnerReturning(code: number, stdout: string, stderr = ""): ShimRunner {
  return async () => ({ code, stdout, stderr });
}

// ---------------------------------------------------------------------------
// GROUP A — mapping / throw via injected runner
// ---------------------------------------------------------------------------

test("(A1) judge: shim allow → { allow } surfaced", async () => {
  const j = new MonadeJudge({ runner: runnerReturning(0, '{"decision":"allow","rationale":"clear"}') });
  const out = await j.judge(ACT, CTX);
  assert.equal(out.decision, "allow");
  assert.equal(out.rationale, "clear");
});

test("(A2) judge: shim block → { block } surfaced", async () => {
  const j = new MonadeJudge({ runner: runnerReturning(0, '{"decision":"block","rationale":"refused"}') });
  const out = await j.judge(ACT, CTX);
  assert.equal(out.decision, "block");
});

test("(A3) judge: shim escalate (mapped WARN) → { escalate } surfaced", async () => {
  const j = new MonadeJudge({ runner: runnerReturning(0, '{"decision":"escalate","rationale":"advisory"}') });
  const out = await j.judge(ACT, CTX);
  assert.equal(out.decision, "escalate");
});

test("(A4) judge: shim inject → { inject } surfaced", async () => {
  const j = new MonadeJudge({ runner: runnerReturning(0, '{"decision":"inject","rationale":"sub"}') });
  const out = await j.judge(ACT, CTX);
  assert.equal(out.decision, "inject");
});

test("(A5) judge: shim error exit 3 → THROWS (→ escalate-local), never a decision", async () => {
  const j = new MonadeJudge({ runner: runnerReturning(3, '{"error":"no-usable-decision","vendor":"deepseek-direct"}') });
  await assert.rejects(() => j.judge(ACT, CTX), /unreachable|no-usable-decision/);
});

test("(A6) judge: unknown decision → THROWS (safe), never surfaced as allow", async () => {
  const j = new MonadeJudge({ runner: runnerReturning(0, '{"decision":"frobnicate"}') });
  await assert.rejects(() => j.judge(ACT, CTX), /unknown decision/);
});

test("(A7) judge: unparseable stdout → THROWS", async () => {
  const j = new MonadeJudge({ runner: runnerReturning(0, "not json at all") });
  await assert.rejects(() => j.judge(ACT, CTX), /unparseable/);
});

test("(A8) judge: nonzero exit with stderr → THROWS", async () => {
  const j = new MonadeJudge({ runner: runnerReturning(1, "", "boom") });
  await assert.rejects(() => j.judge(ACT, CTX), /unreachable|boom/);
});

test("(A9) judge: runner itself rejects (timeout/spawn error) → THROWS", async () => {
  const j = new MonadeJudge({ runner: async () => { throw new Error("timeout after 15000ms"); } });
  await assert.rejects(() => j.judge(ACT, CTX), /timeout/);
});

test("(A10) health: runner code 0 → true; code 1 → false; throw → false", async () => {
  assert.equal(await new MonadeJudge({ runner: runnerReturning(0, "") }).health(), true);
  assert.equal(await new MonadeJudge({ runner: runnerReturning(1, "") }).health(), false);
  assert.equal(await new MonadeJudge({ runner: async () => { throw new Error("x"); } }).health(), false);
});

test("(A11) buildMonadeCore: ENGRAM_MONADE_JUDGE_DISABLE=1 → undefined (one-env rollback)", () => {
  const prev = process.env.ENGRAM_MONADE_JUDGE_DISABLE;
  try {
    process.env.ENGRAM_MONADE_JUDGE_DISABLE = "1";
    assert.equal(buildMonadeCore(), undefined);
    delete process.env.ENGRAM_MONADE_JUDGE_DISABLE;
    assert.notEqual(buildMonadeCore(), undefined);
  } finally {
    if (prev === undefined) delete process.env.ENGRAM_MONADE_JUDGE_DISABLE;
    else process.env.ENGRAM_MONADE_JUDGE_DISABLE = prev;
  }
});

// ---------------------------------------------------------------------------
// GROUP B — the REAL shim, end-to-end, against a FAKE judge client (no vendor)
// ---------------------------------------------------------------------------

// The real monade_judge.py lives next to dist/ at scripts/monade_judge.py.
const SHIM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "monade_judge.py");

/** Write a temp dir holding a fake laeka_llm_judge_client.py whose judge_call
 *  returns `content` (the raw vendor string) with a canned vendor telemetry.
 *  This exercises the shim's real stdin→prompt→map→stdout path with no LLM. */
function fakeClientDir(judgeBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-judge-"));
  writeFileSync(
    join(dir, "laeka_llm_judge_client.py"),
    `def judge_call(user_prompt, *, system_prompt=None, max_tokens=256):\n${judgeBody}\n`,
  );
  return dir;
}

async function spawnRealShim(clientDir: string, emission: VerdictAction, ctx: VerdictContext, withKey = true) {
  const prevDir = process.env.ENGRAM_JUDGE_CLIENT_DIR;
  const prevKey = process.env.DEEPSEEK_API_KEY;
  process.env.ENGRAM_JUDGE_CLIENT_DIR = clientDir;
  if (withKey) process.env.DEEPSEEK_API_KEY = "dummy-for-health-only";
  try {
    const j = new MonadeJudge({ shimPath: SHIM });
    return await j.judge(emission, ctx);
  } finally {
    if (prevDir === undefined) delete process.env.ENGRAM_JUDGE_CLIENT_DIR;
    else process.env.ENGRAM_JUDGE_CLIENT_DIR = prevDir;
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevKey;
  }
}

test("(B1) real shim: judge returns PASS → mapped to allow", async () => {
  const dir = fakeClientDir('    return \'{"decision":"PASS","rationale":"legit"}\', {"vendor":"fake"}');
  try {
    const out = await spawnRealShim(dir, ACT, CTX);
    assert.equal(out.decision, "allow");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(B2) real shim: judge returns WARN → mapped to escalate (never auto-allow destructive)", async () => {
  const dir = fakeClientDir('    return \'{"decision":"WARN","rationale":"unsure"}\', {"vendor":"fake"}');
  try {
    const out = await spawnRealShim(dir, ACT, CTX);
    assert.equal(out.decision, "escalate");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(B3) real shim: judge returns BLOCK → mapped to block", async () => {
  const dir = fakeClientDir('    return \'{"decision":"BLOCK","rationale":"no"}\', {"vendor":"fake"}');
  try {
    const out = await spawnRealShim(dir, ACT, CTX);
    assert.equal(out.decision, "block");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(B4) real shim: judge returns INJECT → mapped to inject", async () => {
  const dir = fakeClientDir('    return \'{"decision":"INJECT","rationale":"fix"}\', {"vendor":"fake"}');
  try {
    const out = await spawnRealShim(dir, ACT, CTX);
    assert.equal(out.decision, "inject");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(B5) real shim: vendor SKIP sentinel → exit 3 → MonadeJudge THROWS (escalate-local)", async () => {
  const dir = fakeClientDir('    return "SKIP-NO-VENDOR", {"vendor":"skip-no-vendor"}');
  try {
    await assert.rejects(() => spawnRealShim(dir, ACT, CTX), /unreachable|no-usable-decision|skip/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(B6) real shim: judge raises → exit 3 → THROWS, never a silent decision", async () => {
  const dir = fakeClientDir('    raise RuntimeError("vendor exploded")');
  try {
    await assert.rejects(() => spawnRealShim(dir, ACT, CTX), /unreachable|judge-call-failed/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
