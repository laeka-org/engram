/**
 * monade-core.ts — the living Monade judge, wired onto verdict()'s escalate path.
 *
 * verdict.ts defines the narrow MonadeCore interface (health + judge) and the
 * safe-swap invariant: it consults monade.judge ONLY on escalate (high-risk
 * destructive op from a trusted seat), and a judge that THROWS degrades to a
 * local escalate hand-up — it never silently clears the op. This module is the
 * real implementation behind that interface.
 *
 * It bridges to the shared cross-vendor judge client (scripts/monade_judge.py →
 * laeka_llm_judge_client.judge_call) via a short-lived subprocess. We reuse that
 * one maintained brain instead of re-implementing the vendor cascade in TS
 * ("ajuster avant ajouter"); the escalate path is rare, so the subprocess hop is
 * free on normal traffic.
 *
 * Style mirrors the existing sidecar clients (guard.ts / belief.ts): a cheap
 * health() probe, a bounded-timeout call, and fail-soft semantics — except here
 * fail-soft means THROW, because the verdict() escalate catch turns a throw into
 * the safe local escalate. Returning a fabricated "allow" would be the one
 * unsafe outcome, so we never do.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MonadeCore } from "./verdict.js";
import type {
  VerdictAction,
  VerdictContext,
  VerdictDecision,
} from "./wire-types.js";

/** Result of one shim invocation. */
interface ShimResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable runner — defaults to spawning the python shim. Tests inject a
 *  fake so the suite never spawns a process nor touches a live LLM. */
export type ShimRunner = (input: string, args: string[]) => Promise<ShimResult>;

/** The engram decisions the shim is allowed to return from a judgement. A
 *  value outside this set is treated as unusable → throw → escalate-local. */
const ALLOWED_DECISIONS: ReadonlySet<string> = new Set<VerdictDecision>([
  "allow",
  "escalate",
  "inject",
  "block",
]);

function defaultShimPath(): string {
  // dist/services/monade-core.js → ../../scripts/monade_judge.py
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "scripts", "monade_judge.py");
}

export interface MonadeJudgeOptions {
  /** Absolute path to monade_judge.py. Defaults to the sibling scripts dir. */
  shimPath?: string;
  /** Python interpreter. Defaults to env ENGRAM_PYTHON or "python3". */
  python?: string;
  /** Hard timeout per invocation (ms). Defaults to env or 15000. */
  timeoutMs?: number;
  /** Injectable runner (tests). Defaults to the real subprocess spawn. */
  runner?: ShimRunner;
}

export class MonadeJudge implements MonadeCore {
  private readonly shimPath: string;
  private readonly python: string;
  private readonly timeoutMs: number;
  private readonly runner: ShimRunner;

  constructor(opts: MonadeJudgeOptions = {}) {
    this.shimPath = opts.shimPath ?? defaultShimPath();
    this.python = opts.python ?? process.env.ENGRAM_PYTHON ?? "python3";
    this.timeoutMs = opts.timeoutMs ?? parseInt(process.env.ENGRAM_MONADE_TIMEOUT_MS ?? "15000", 10);
    this.runner = opts.runner ?? this.spawnRunner.bind(this);
  }

  /** Cheap liveness — shim --health (client imports AND a vendor key present).
   *  Any failure ⇒ not live; the fast path then treats the core as unreachable
   *  and verdict()'s fail-soft policy applies (non-destructive proceeds with a
   *  degraded flag; destructive fails closed). Never throws. */
  async health(): Promise<boolean> {
    try {
      const r = await this.runner("", ["--health"]);
      return r.code === 0;
    } catch {
      return false;
    }
  }

  /** Expensive E/S/A synthesis — consulted ONLY on escalate. Returns the mapped
   *  decision + rationale, or THROWS when no usable judgement was produced
   *  (client missing / vendor skip / api error / unparseable / unknown decision
   *  / timeout). A throw is the safe outcome: verdict() catches it and hands the
   *  op up via a local escalate (safe-swap invariant — never a silent allow). */
  async judge(
    action: VerdictAction,
    context: VerdictContext,
  ): Promise<{ decision: VerdictDecision; rationale: string }> {
    const emission = JSON.stringify({
      op: action.op,
      payload: typeof action.payload === "string" ? action.payload : null,
      seatId: context.seatId ?? null,
      trustClass: context.trustClass ?? null,
      riskLevel: context.riskLevel ?? null,
      // The fast-path reason this reached escalate (high-risk destructive op
      // that the block layer let through). VerdictContext carries no free-form
      // rationale, so we describe the trigger the judge is being asked about.
      rationale: `fast-path escalate: high-risk destructive op=${action.op} from a trusted seat`,
    });

    const r = await this.runner(emission, []);
    if (r.code !== 0) {
      let reason = r.stderr || r.stdout || `exit ${r.code}`;
      try {
        const parsed = JSON.parse(r.stdout);
        if (parsed && parsed.error) reason = String(parsed.error);
      } catch {
        /* keep raw reason */
      }
      throw new Error(`monade judge unreachable: ${reason}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      throw new Error(`monade judge: unparseable stdout: ${r.stdout.slice(0, 200)}`);
    }
    const obj = parsed as { decision?: unknown; rationale?: unknown };
    const decision = String(obj?.decision ?? "");
    if (!ALLOWED_DECISIONS.has(decision)) {
      throw new Error(`monade judge: unknown decision ${JSON.stringify(obj?.decision)}`);
    }
    const rationale = typeof obj.rationale === "string" && obj.rationale
      ? obj.rationale
      : `monade judge returned ${decision}`;
    return { decision: decision as VerdictDecision, rationale };
  }

  /** Default runner: spawn `python3 monade_judge.py [args]`, feed stdin, collect
   *  stdout/stderr, enforce a hard timeout (kill the child on expiry → rejects,
   *  which judge() surfaces as a throw = escalate-local). */
  private spawnRunner(input: string, args: string[]): Promise<ShimResult> {
    return new Promise<ShimResult>((resolve, reject) => {
      const child = spawn(this.python, [this.shimPath, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`monade judge timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });

      if (input) child.stdin.write(input);
      child.stdin.end();
    });
  }
}

/**
 * Build the MonadeCore to wire into MemoryService, honouring the kill switch.
 * Returns undefined when disabled (ENGRAM_MONADE_JUDGE_DISABLE=1) so the gate
 * runs judge-less exactly as before — a one-env rollback with no redeploy. When
 * enabled (default), verdict() still only consults it on escalate, and every
 * failure mode degrades safe.
 */
export function buildMonadeCore(opts: MonadeJudgeOptions = {}): MonadeCore | undefined {
  if (process.env.ENGRAM_MONADE_JUDGE_DISABLE === "1") return undefined;
  return new MonadeJudge(opts);
}
