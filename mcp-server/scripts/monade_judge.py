#!/usr/bin/env python3
"""monade_judge.py — thin bridge from engram's verdict() escalate path to the
shared cross-vendor Monade judge (``laeka_llm_judge_client.judge_call``).

WHY A BRIDGE (and not a native TS re-implementation): the Monade judging core
already exists as a single maintained client with the cross-vendor cost
discipline baked in (DeepSeek direct → DeepSeek/Qwen via OpenRouter →
fail-soft skip; never the Anthropic family). "Ajuster avant ajouter" — engram
reuses that one brain rather than duplicating the vendor cascade in TypeScript.
The verdict() escalate path is rare (high-risk destructive op from a trusted
seat only), so a per-escalate subprocess hop costs nothing on normal traffic.

CONTRACT (stdin/stdout, one JSON object each):
  stdin  : {"op","payload","seatId","trustClass","riskLevel","rationale"}
  stdout : {"decision": <engram-decision>, "rationale": str, "vendor": str}
           where <engram-decision> ∈ {allow, escalate, inject, block}
  exit 0 : a usable judgement was produced (stdout is the mapped decision)
  exit 3 : no usable judgement (client missing / vendor skip / api error /
           unparseable). stdout is {"error": <reason>}. The TS caller MUST
           treat a non-zero exit as "judge unreachable" and THROW, so
           verdict() falls through to its proven escalate-local hand-up
           (safe-swap invariant: a judge that cannot decide never silently
           clears a destructive op).

HEALTH (--health): cheap liveness — the client imports AND at least one
  cross-vendor key is present. NO LLM call. exit 0 = reachable, 1 = not.

The decision mapping is the security-critical surface and is intentionally
safe-by-default: only an explicit affirmative clearance lets a high-risk
destructive op proceed; every uncertain signal hands up or refuses.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Resolution order for the shared judge client. Env override first (deploys
# that relocate it), then the proven-live runtime mirror, then the tracked
# source copy in laeka-manager/armor as a fallback.
_CLIENT_DIRS = [
    os.environ.get("ENGRAM_JUDGE_CLIENT_DIR"),
    str(Path.home() / ".claude" / "hooks" / "lib"),
    str(Path.home() / "Documents" / "laeka-manager" / "armor" / "sources" / "hooks" / "lib"),
]

# The judge's own decision vocabulary → engram's VerdictDecision. Safe-by-
# default: only an affirmative clearance ("pass") allows the op; an advisory
# ("warn") on a high-risk destructive op is NOT enough to auto-allow — it is
# handed up. Anything the judge cannot net-decide never reaches this map (it
# becomes an error/exit-3 → caller throws → escalate-local).
_DECISION_MAP = {
    "PASS": "allow",       # affirmative living clearance of the op
    "WARN": "escalate",    # advisory only → hand up, never auto-allow destructive
    "INJECT": "inject",    # deny-with-content (corrective substitute)
    "BLOCK": "block",      # refuse
}

_SYSTEM_PROMPT = (
    "You are a cross-vendor integrity judge for an AI memory system. The fast "
    "local path could not net-decide an operation that is both destructive and "
    "high-risk, coming from a trusted seat. Decide the safest verdict. Reply "
    "with STRICT JSON only, no prose, on a single line: "
    '{"decision": "PASS|WARN|INJECT|BLOCK", "rationale": "<short reason>"}. '
    "PASS = the operation is clearly safe to allow; WARN = proceed only with an "
    "advisory; INJECT = substitute a corrective payload instead of executing; "
    "BLOCK = must not proceed. Prefer the least-restrictive verdict that is "
    "safe; reserve PASS for operations you are confident are legitimate, since "
    "PASS will let a high-consequence memory operation through."
)


def _load_judge_call():
    for d in _CLIENT_DIRS:
        if not d:
            continue
        if d not in sys.path:
            sys.path.insert(0, d)
        try:
            import laeka_llm_judge_client as client  # noqa: E402
        except Exception:
            continue
        fn = getattr(client, "judge_call", None)
        if fn is not None:
            return fn
    return None


def _vendor_key_present() -> bool:
    for var in ("DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "DASHSCOPE_API_KEY"):
        if os.environ.get(var):
            return True
    return False


def _emit(obj: dict, code: int) -> int:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")))
    sys.stdout.flush()
    return code


def _health() -> int:
    # Cheap: the client must import and at least one cross-vendor key must be
    # configured. No network call — a real probe would cost a token round-trip.
    if _load_judge_call() is None:
        return 1
    return 0 if _vendor_key_present() else 1


def _build_user_prompt(emission: dict) -> str:
    text = str(emission.get("payload") or "")[:1500]
    return (
        "Operation under judgement (routed from the fast path to the living core):\n"
        f"  op: {emission.get('op')!r}\n"
        f"  payload: {text!r}\n"
        f"  seat_id: {emission.get('seatId')!r}\n"
        f"  trust_class: {emission.get('trustClass')!r}\n"
        f"  risk_level: {emission.get('riskLevel')!r}\n"
        f"  fast_path_rationale: {str(emission.get('rationale') or '')[:400]!r}\n"
    )


def _parse_decision(content: str):
    if not content:
        return None
    stripped = content.strip()
    if stripped in ("SKIP-NO-VENDOR", "JUDGE-API-ERROR"):
        return None
    candidates = [stripped]
    if "{" in stripped and "}" in stripped:
        candidates.append(stripped[stripped.index("{"): stripped.rindex("}") + 1])
    for cand in candidates:
        try:
            obj = json.loads(cand)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(obj, dict):
            continue
        raw = str(obj.get("decision", "")).strip().upper()
        mapped = _DECISION_MAP.get(raw)
        if mapped:
            return mapped, str(obj.get("rationale", "")).strip()
    return None


def _judge() -> int:
    raw = sys.stdin.read()
    try:
        emission = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, ValueError) as e:
        return _emit({"error": f"bad-emission-json: {e}"}, 3)
    if not isinstance(emission, dict):
        return _emit({"error": "emission-not-object"}, 3)

    judge = _load_judge_call()
    if judge is None:
        return _emit({"error": "judge-client-unavailable"}, 3)

    try:
        content, telemetry = judge(
            _build_user_prompt(emission),
            system_prompt=_SYSTEM_PROMPT,
            max_tokens=int(os.environ.get("ENGRAM_MONADE_MAX_TOKENS", "256")),
        )
    except Exception as e:  # any client-side failure → unreachable, caller throws
        return _emit({"error": f"judge-call-failed: {type(e).__name__}"}, 3)

    vendor = (telemetry or {}).get("vendor")
    parsed = _parse_decision(content)
    if parsed is None:
        return _emit({"error": "no-usable-decision", "vendor": vendor}, 3)

    decision, rationale = parsed
    if not rationale:
        rationale = f"monade judge ({vendor}) returned {decision}"
    return _emit({"decision": decision, "rationale": rationale, "vendor": vendor}, 0)


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--health" in argv:
        return _health()
    return _judge()


if __name__ == "__main__":
    sys.exit(main())
