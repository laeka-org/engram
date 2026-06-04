/**
 * verdict.ts — the integrity verdict contract v1, soldered into engram.
 *
 * Source of truth (FROZEN spec):
 *   handoffs/2026-06-04-verdict-contract-v1-frozen-R-output.md
 * Soudure plan:
 *   handoffs/2026-06-04-engram-verdict-contract-soudure-plan-palier2-maya.md
 *
 * `verdict(action, context) → IntegrityVerdict` is the single function every
 * memory operation (store / recall / correct / forget) must traverse. It is
 * wired as the mandatory FIRST instruction of each public MemoryService method
 * (services/supabase.ts), which makes the non-contournability invariant (§11.1)
 * structural: every op goes through MemoryService, every MemoryService op goes
 * through verdict() — there is no other path to the memories table.
 *
 * STEP 1 (this commit) is the transparent skeleton: verdict() returns `allow`
 * for every op, so wiring it in changes no behaviour. The five real decisions
 * (block / inject / reconcile / escalate, and richer allow) land in later
 * commits by generalising the substrate that already exists:
 *   - block       ← services/admission-gate.ts
 *   - audit_id    ← services/rem-audit.ts → memory_events type 'verdict'
 *   - reconcile   ← services/lesson-contradiction-gate.ts + supersede_memory RPC
 *   - inject      ← deny-with-content (correction payload)
 *   - escalate    ← non-resolvable path → audit + seat hand-up
 *
 * ORIENTATION (Sid tranche 2026-06-04): verdict() is FAST BY DEFAULT —
 * manifest rules + local contradiction detection only. It calls the Monade
 * core LLM ONLY on escalate / non-resolvable conflict. A verdict() that hit an
 * LLM on every recall would crush throughput (4146 ops/s measured at the gate).
 */

import { randomUUID } from "node:crypto";
import type {
  VerdictAction,
  VerdictContext,
  IntegrityVerdict,
  VerdictDecision,
  RiskLevel,
} from "./wire-types.js";
import { VERDICT_CONTRACT_VERSION } from "./wire-types.js";

/**
 * The Monade core — the living judgement that verdict() escalates to when the
 * fast local path cannot resolve a conflict. Kept as a narrow async interface
 * (NOT a hard dependency) so:
 *   1. the fast path never blocks on it (it is only consulted on escalate),
 *   2. fail-soft (§7) can degrade gracefully when it is unreachable,
 *   3. tests inject a stub instead of standing up a real LLM.
 *
 * `health()` is the cheap liveness probe used by the fail-soft policy; `judge()`
 * is the expensive E/S/A synthesis path, reserved for escalate.
 */
export interface MonadeCore {
  /** Cheap liveness probe — true when the judging core can be reached. */
  health(): Promise<boolean>;
  /**
   * Expensive E/S/A synthesis — only invoked on escalate / non-resolvable
   * conflict. Returns the decision + human-readable rationale. The lens trace
   * itself stays private (moat); only decision + rationale cross back.
   */
  judge?(action: VerdictAction, context: VerdictContext): Promise<{
    decision: VerdictDecision;
    rationale: string;
  }>;
}

/**
 * Side effects verdict() needs to persist its audit trail and apply
 * reconcile. Injected (not imported as singletons) so the pure decision logic
 * stays testable and so MemoryService owns the single DB client. Every field
 * is optional: STEP 1 wires verdict() with no deps at all (pure allow), and
 * later steps fill them in.
 */
export interface VerdictDeps {
  /**
   * Persist one audit row and return its id. Wired in STEP 3 to
   * rem-audit → memory_events (event_type='verdict'). When absent, verdict()
   * synthesises a local uuid so audit_id is ALWAYS present (contract §3:
   * audit_id is non-differable) — the row may be local-only until the audit
   * sink is wired, but the field is never empty.
   */
  persistAudit?: (entry: VerdictAuditEntry) => Promise<string>;
  /** Liveness + judgement core. Consulted only on escalate (fast-path stays local). */
  monade?: MonadeCore;
}

/**
 * The private audit entry — the E/S/A trace + Monade synthesis that NEVER
 * leaves the server (contract §3 moat). Persisted under audit_id; the client
 * only ever sees decision + rationale.
 */
export interface VerdictAuditEntry {
  op: VerdictAction["op"];
  decision: VerdictDecision;
  rationale: string;
  seat_id: string | null;
  trust_class: string | null;
  risk_level: RiskLevel;
  /** True when the verdict was produced in fail-soft degraded mode (§7). */
  degraded: boolean;
  /** Free-form lens / synthesis detail — private, moat-side only. */
  detail?: Record<string, unknown>;
}

/** Risk levels the contract treats as destructive for fail-soft (§7). */
const DESTRUCTIVE_RISK: RiskLevel = "destructive";

/** Ops that are intrinsically destructive regardless of declared riskLevel. */
const DESTRUCTIVE_OPS = new Set<VerdictAction["op"]>(["forget"]);

/**
 * True iff this action is destructive — used by the fail-soft policy (§7:
 * destructive op + core down ⇒ fail-closed block) and by future block rules.
 * `correct` is destructive-soft (the old row gets valid_to, never deleted), so
 * it is NOT auto-destructive here; only `forget` and an explicitly
 * destructive riskLevel qualify.
 */
export function isDestructive(action: VerdictAction, context: VerdictContext): boolean {
  if (DESTRUCTIVE_OPS.has(action.op)) return true;
  return context.riskLevel === DESTRUCTIVE_RISK;
}

/**
 * Build a fully-formed IntegrityVerdict. Centralised so contract_version and
 * the mandatory-field invariant are stamped in exactly one place — every code
 * path that returns a verdict goes through here, so a verdict can never ship
 * without contract_version / decision / rationale / audit_id.
 */
function makeVerdict(
  decision: VerdictDecision,
  rationale: string,
  audit_id: string,
  extra?: Partial<Pick<IntegrityVerdict, "supersedes" | "validity" | "correction">>,
): IntegrityVerdict {
  return {
    contract_version: VERDICT_CONTRACT_VERSION,
    decision,
    rationale,
    audit_id,
    ...extra,
  };
}

/**
 * The verdict gate. STEP 1: transparent — returns `allow` for every op, after
 * persisting an audit row (audit_id is always present per contract §3, even in
 * this skeleton). Later steps branch on manifest rules / contradiction
 * detection / fail-soft before reaching the allow tail.
 *
 * Defaults are deliberately conservative: a caller that omits trustClass /
 * riskLevel is treated as untrusted / low so a thin context never widens
 * authority. The expensive Monade path is NOT touched here — that is reserved
 * for escalate in a later step.
 */
export async function verdict(
  action: VerdictAction,
  context: VerdictContext = {},
  deps: VerdictDeps = {},
): Promise<IntegrityVerdict> {
  const seatId = context.seatId ?? null;
  const trustClass = context.trustClass ?? "untrusted";
  const riskLevel = context.riskLevel ?? "low";

  // STEP 1 transparent skeleton: no rule fires; every op is allowed.
  const decision: VerdictDecision = "allow";
  const rationale = `allow (contract v${VERDICT_CONTRACT_VERSION} skeleton): op=${action.op} passed with no active rule`;

  const audit_id = await recordAudit(deps, {
    op: action.op,
    decision,
    rationale,
    seat_id: seatId,
    trust_class: trustClass,
    risk_level: riskLevel,
    degraded: false,
  });

  return makeVerdict(decision, rationale, audit_id);
}

/**
 * Persist the audit entry and return its id. Falls back to a locally-minted
 * uuid when no audit sink is wired (STEP 1) or when the sink throws — audit_id
 * must ALWAYS be present (contract §3), so a persistence failure degrades to a
 * local id rather than dropping the field. The persistence failure itself is
 * logged, never swallowed silently.
 */
async function recordAudit(deps: VerdictDeps, entry: VerdictAuditEntry): Promise<string> {
  if (!deps.persistAudit) return randomUUID();
  try {
    return await deps.persistAudit(entry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[verdict] persistAudit failed (using local audit_id): ${msg}`);
    return randomUUID();
  }
}

// Re-export the contract types from their canonical home (wire-types) so
// callers can `import { IntegrityVerdict, verdict } from "./verdict.js"` in one
// place without needing to know the types live next door.
export type {
  VerdictAction,
  VerdictContext,
  IntegrityVerdict,
  VerdictDecision,
  MemoryOp,
  TrustClass,
  RiskLevel,
} from "./wire-types.js";
export { VERDICT_CONTRACT_VERSION } from "./wire-types.js";
