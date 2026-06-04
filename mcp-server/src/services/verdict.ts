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
import {
  cosineSimilarity,
  classifyPolarity,
  polarityInverted,
  COSINE_TOPIC_THRESHOLD,
} from "./lesson-contradiction-gate.js";

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
  /**
   * Policy surface — the block rules verdict() consults on the fast path.
   * Manifest-fed in STEP 7 (invariants.yaml signed by Sid). When absent,
   * verdict() uses DEFAULT_BLOCK_RULES (the contract §4 floor). Generalises the
   * allow/block shape of services/admission-gate.ts from lessons to all ops
   * ("ajuster avant ajouter").
   */
  blockRules?: BlockRule[];
  /**
   * Reconcile candidate fetcher (STEP 4). For a `store` action, returns the
   * existing memories semantically near the incoming payload, so verdict() can
   * detect a polarity-inverted contradiction and decide `reconcile`. Injected
   * (MemoryService supplies it from its own neighbour search) so verdict()
   * never owns a DB client. Absent ⇒ reconcile detection is skipped (allow).
   *
   * The fast-path orientation (Sid 2026-06-04) holds: this is a LOCAL cosine +
   * polarity check (no LLM), reusing lesson-contradiction-gate's heuristics.
   */
  reconcileCandidates?: (
    action: VerdictAction,
  ) => Promise<ReconcileCandidate[]>;
}

/** A memory row offered as a reconcile candidate (the minimal shape needed). */
export interface ReconcileCandidate {
  id: string;
  content: string;
  embedding: number[];
}

/**
 * A detected memory-level contradiction — the new fact polarity-inverts an
 * existing one on the same topic. This is the reconcile signal: the incoming
 * store should proceed AND supersede the contradicted prior (never delete it).
 */
export interface ReconcileFinding {
  prior_id: string;
  cosine: number;
  rationale: string;
}

/**
 * Detect reconcile-worthy contradictions between an incoming fact and existing
 * memories. Pure: reuses cosineSimilarity + classifyPolarity + polarityInverted
 * from lesson-contradiction-gate (generalised lesson→memory, "ajuster avant
 * ajouter"). Returns one finding per contradicted prior, strongest cosine first.
 *
 * Threshold is COSINE_TOPIC_THRESHOLD (§10.3, 0.85) — same bar the swarm gate
 * uses, so "same topic + inverted polarity = contradiction" is one definition
 * across the codebase.
 */
export function detectReconcile(
  incomingContent: string,
  incomingEmbedding: number[] | undefined,
  candidates: ReconcileCandidate[],
): ReconcileFinding[] {
  if (!incomingEmbedding || incomingEmbedding.length === 0) return [];
  const incomingPolarity = classifyPolarity(incomingContent);
  const findings: ReconcileFinding[] = [];
  for (const c of candidates) {
    if (!c.embedding || c.embedding.length === 0) continue;
    const cos = cosineSimilarity(incomingEmbedding, c.embedding);
    if (!(cos > COSINE_TOPIC_THRESHOLD)) continue;
    const priorPolarity = classifyPolarity(c.content);
    if (!polarityInverted(incomingPolarity, priorPolarity)) continue;
    findings.push({
      prior_id: c.id,
      cosine: cos,
      rationale:
        `reconcile: incoming fact polarity-inverts memory ${c.id.slice(0, 8)} ` +
        `at cosine=${cos.toFixed(3)} (${incomingPolarity} vs ${priorPolarity})`,
    });
  }
  return findings.sort((a, b) => b.cosine - a.cosine);
}

/**
 * A pure block rule — the generalised form of admission-gate's
 * AdmissionResult, lifted from lessons-only to any memory op. Returns a
 * BlockOutcome to deny, or null to abstain (rule does not apply). Pure: no
 * I/O, trivially testable, exactly the admission-gate discipline.
 */
export type BlockRule = (
  action: VerdictAction,
  context: VerdictContext,
) => BlockOutcome | null;

export interface BlockOutcome {
  /** Machine-readable reason tag (admission-gate convention). */
  reason: string;
  /** Human-readable rationale surfaced to the caller. */
  rationale: string;
}

/**
 * Forbidden-content denylist (contract §4: "ne jamais stocker <catégorie de
 * donnée sensible>"). STEP 2 floor — the manifest (STEP 7) replaces this with
 * the Sid-signed invariant list. Matches case-insensitively as a defensive
 * minimum; the real policy is plain-language business rules at the manifest.
 *
 * Empty by default for the live skeleton (a too-eager floor would block real
 * memories); the mechanism is what STEP 2 ships, the content is manifest-fed.
 */
export const DEFAULT_FORBIDDEN_PATTERNS: RegExp[] = [];

/**
 * The contract §4 block floor, generalised from admission-gate:
 *   1. forbidden-content — a store whose payload matches the denylist.
 *   2. destructive-without-authority — a forget/destructive op from an
 *      untrusted seat is refused (the §4 "forget/correct destructif sans
 *      autorité → refusé" clause). dyade/seat are trusted; external/untrusted
 *      are not.
 *
 * These are conservative and additive: the manifest can widen them, never
 * silently narrow the destructive-authority floor (that is a re-signature, §6).
 */
export const DEFAULT_BLOCK_RULES: BlockRule[] = [
  function forbiddenContent(action): BlockOutcome | null {
    if (action.op !== "store") return null;
    const text = typeof action.payload === "string" ? action.payload : "";
    for (const pat of DEFAULT_FORBIDDEN_PATTERNS) {
      pat.lastIndex = 0;
      if (pat.test(text)) {
        return {
          reason: "forbidden_content",
          rationale: `store refused: payload matches a manifest forbidden-content invariant`,
        };
      }
    }
    return null;
  },
  function destructiveWithoutAuthority(action, context): BlockOutcome | null {
    if (!isDestructive(action, context)) return null;
    // Authority semantics (contract §4): a destructive op is refused only when
    // the caller DECLARES an untrusted/external trust class. An ABSENT
    // trustClass = an internal MCP-server-side caller (the engram corps acting
    // on its own store) and is authorised — we never silently downgrade an
    // internal forget to "untrusted". External callers MUST declare their
    // trust class (Profil B connector / tenant), and external/untrusted ones
    // are refused destructive ops.
    const trust = context.trustClass;
    if (trust === undefined || trust === "dyade" || trust === "seat") return null;
    return {
      reason: "destructive_without_authority",
      rationale:
        `${action.op} refused: destructive op requires a trusted seat ` +
        `(dyade/seat); caller trustClass=${trust}`,
    };
  },
];

/**
 * Run the block rules in order; first deny wins (admission-gate convention:
 * "the first failure wins so telemetry counters are unambiguous"). Returns the
 * BlockOutcome to deny, or null to allow through to the next decision layer.
 */
export function evaluateBlockRules(
  action: VerdictAction,
  context: VerdictContext,
  rules: BlockRule[],
): BlockOutcome | null {
  for (const rule of rules) {
    const out = rule(action, context);
    if (out) return out;
  }
  return null;
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
 * Local escalate trigger (contract §4). A destructive op flagged `riskLevel:
 * "high"` that the block layer let through (trusted seat) is too consequential
 * to silently allow — it is handed up for living judgement. Deliberately narrow
 * so the fast path is untouched on normal traffic (orientation Sid). The
 * manifest (STEP 7) can widen the escalate surface; this is the §4 floor.
 */
export function shouldEscalate(action: VerdictAction, context: VerdictContext): boolean {
  return isDestructive(action, context) && context.riskLevel === "high";
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

  // STEP 8 — fail-soft / degraded mode (contract §7). Only engages when a
  // Monade core is configured (deps.monade) AND its liveness probe reports it
  // unreachable. Policy:
  //   - destructive op (forget / destructive risk) + core unreachable →
  //     fail-CLOSED (block). We never destroy without a living judgement.
  //   - non-destructive op (store / recall) + core unreachable →
  //     allow-WITH-LOG (proceed, flag degraded in the audit). Continuity is
  //     preserved, traceability maintained.
  // When no core is configured (the STEP-1..7 fast-path-only build), this is a
  // no-op — fail-soft has nothing to fail soft on.
  if (deps.monade) {
    let coreLive = true;
    try {
      coreLive = await deps.monade.health();
    } catch {
      coreLive = false; // a throwing probe = unreachable, fail-soft engages.
    }
    if (!coreLive) {
      const destructive = isDestructive(action, context);
      const decision: VerdictDecision = destructive ? "block" : "allow";
      const rationale = destructive
        ? `block (fail-closed §7): Monade core unreachable, destructive op=${action.op} refused — no destruction without living judgement`
        : `allow (degraded §7): Monade core unreachable, non-destructive op=${action.op} proceeds with degraded flag`;
      const audit_id = await recordAudit(deps, {
        op: action.op,
        decision,
        rationale,
        seat_id: seatId,
        trust_class: trustClass,
        risk_level: riskLevel,
        degraded: true,
      });
      return makeVerdict(decision, rationale, audit_id);
    }
  }

  // STEP 2 — block layer (generalised from admission-gate). Fast, pure, local.
  // First deny wins. Manifest-fed rules (STEP 7) override the §4 floor.
  const rules = deps.blockRules ?? DEFAULT_BLOCK_RULES;
  const blocked = evaluateBlockRules(action, context, rules);
  if (blocked) {
    const audit_id = await recordAudit(deps, {
      op: action.op,
      decision: "block",
      rationale: blocked.rationale,
      seat_id: seatId,
      trust_class: trustClass,
      risk_level: riskLevel,
      degraded: false,
      detail: { reason: blocked.reason },
    });
    return makeVerdict("block", blocked.rationale, audit_id);
  }

  // STEP 4 — reconcile layer (store only). Local cosine + polarity inversion
  // (reuses lesson-contradiction-gate, no LLM). When the incoming fact
  // polarity-inverts an existing memory on the same topic, the op proceeds AND
  // supersedes the contradicted prior (valid_to set, never deleted — §11.3).
  if (action.op === "store" && deps.reconcileCandidates) {
    let candidates: ReconcileCandidate[] = [];
    try {
      candidates = await deps.reconcileCandidates(action);
    } catch (err) {
      // Non-fatal: a candidate-fetch failure must not block a legitimate store.
      // We fall through to allow and log — reconcile is an enhancement, not a
      // correctness gate for the write itself.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[verdict] reconcileCandidates failed (falling through to allow): ${msg}`);
    }
    const content = typeof action.payload === "string" ? action.payload : "";
    const findings = detectReconcile(content, action.embedding, candidates);
    if (findings.length > 0) {
      const supersedes = findings.map((f) => f.prior_id);
      const rationale =
        `reconcile (contract v${VERDICT_CONTRACT_VERSION}): store proceeds and ` +
        `supersedes ${supersedes.length} contradicted memor${supersedes.length === 1 ? "y" : "ies"}; ` +
        findings[0].rationale;
      const audit_id = await recordAudit(deps, {
        op: action.op,
        decision: "reconcile",
        rationale,
        seat_id: seatId,
        trust_class: trustClass,
        risk_level: riskLevel,
        degraded: false,
        detail: { findings },
      });
      return makeVerdict("reconcile", rationale, audit_id, {
        supersedes,
        validity: { valid_from: new Date().toISOString() },
      });
    }
  }

  // STEP 6 — escalate layer (contract §4: "le contrat ne peut trancher dans la
  // politique → remonte à Sid/orchestrateur ; JAMAIS de drop silencieux").
  //
  // Local trigger (bounded, falsifiable): a HIGH-risk destructive op that the
  // block layer let through (trusted seat) is too consequential to silently
  // allow — it deserves a living judgement. This is the ONLY place the Monade
  // LLM is consulted (orientation Sid: LLM only on escalate/conflit), so the
  // 4146 ops/s fast path is never touched on normal traffic.
  //   - Monade judge present → consult it; honor its decision (allow/block/
  //     inject/escalate). The judge's lens trace stays private (moat); only
  //     decision + rationale come back.
  //   - No judge → decision=escalate: the op HALTS and is handed up. The audit
  //     row is the hand-up record — zero silent drop (§11.4).
  if (shouldEscalate(action, context)) {
    if (deps.monade?.judge) {
      let judged: { decision: VerdictDecision; rationale: string } | null = null;
      try {
        judged = await deps.monade.judge(action, context);
      } catch (err) {
        // A judge failure must NOT silently drop the op. Fall through to a
        // local escalate (hand-up) rather than a silent allow.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[verdict] monade.judge failed (escalating locally): ${msg}`);
      }
      if (judged) {
        const audit_id = await recordAudit(deps, {
          op: action.op,
          decision: judged.decision,
          rationale: judged.rationale,
          seat_id: seatId,
          trust_class: trustClass,
          risk_level: riskLevel,
          degraded: false,
          detail: { source: "monade.judge" },
        });
        return makeVerdict(judged.decision, judged.rationale, audit_id);
      }
    }
    const rationale =
      `escalate (contract v${VERDICT_CONTRACT_VERSION}): high-risk destructive op=${action.op} ` +
      `cannot be resolved by the fast path — handed up to seat/Sid, op halted (zero silent drop)`;
    const audit_id = await recordAudit(deps, {
      op: action.op,
      decision: "escalate",
      rationale,
      seat_id: seatId,
      trust_class: trustClass,
      risk_level: riskLevel,
      degraded: false,
      detail: { reason: "high_risk_destructive_unresolvable" },
    });
    return makeVerdict("escalate", rationale, audit_id);
  }

  // No rule fired → allow. (inject decision layer lands in a later step between
  // escalate and this allow tail.)
  const decision: VerdictDecision = "allow";
  const rationale = `allow (contract v${VERDICT_CONTRACT_VERSION}): op=${action.op} passed all active block rules`;

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
