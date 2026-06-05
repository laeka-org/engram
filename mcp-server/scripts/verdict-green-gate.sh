#!/usr/bin/env bash
#
# verdict-green-gate.sh — the empirical green that gates wiring the REAL Monade
# judge in place of the escalate stub.
#
# It compiles the verdict suites, runs them, and evaluates the 6 GREEN CRITERIA
# from the campaign design (§4 of the Maya handoff). It emits a per-criterion
# PASS/FAIL plus a single GLOBAL GREEN/RED. Maya relays the GLOBAL line as "the
# green that gates the cabling".
#
# Criteria (design §4):
#   C1 Unitaire           : verdict-contract.test.ts 100% pass.
#   C2 Intégration escalate: adversarial ops → escalate/judge-honored, audited,
#                            HALTED, zero silent drop (verdict-integration A1..A8).
#   C3 Fail-soft câblé     : core-down destructive→block, non-destructive→allow-degraded
#                            on the wired MemoryService path (A6, A7).
#   C4 Safe-swap invariant : judge-present→honored AND judge-throw→escalate-local
#                            (never silent-allow) — proven wired (A3, A4, A5).
#   C5 §11.1 non-orphelin  : structural lint — every memories mutation goes through
#                            the gated choke-point (contract suite §11.1 tests).
#   C6 Perf fast-path      : allow is NOT consulting the judge on normal traffic
#                            (contract suite "normal traffic does NOT consult the judge").
#
# NO PROD WRITES: both suites use injected audit sinks / a FakeDb. This script
# only compiles + runs node --test; it never touches a live DB.
#
# Exit 0 ⇒ GLOBAL GREEN ; exit 1 ⇒ GLOBAL RED (any criterion failed or a suite
# failed to compile/run).

set -euo pipefail

# Resolve to mcp-server root regardless of CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}"

UNIT_SRC="src/__tests__/verdict-contract.test.ts"
INT_SRC="src/__tests__/verdict-integration.test.ts"
UNIT_JS="dist/__tests__/verdict-contract.test.js"
INT_JS="dist/__tests__/verdict-integration.test.js"

OUT_DIR="$(mktemp -d)"
UNIT_OUT="${OUT_DIR}/unit.txt"
INT_OUT="${OUT_DIR}/int.txt"
trap 'rm -rf "${OUT_DIR}"' EXIT

echo "== verdict green-gate =="
echo "root: ${ROOT}"

# --- compile -----------------------------------------------------------------
echo "-- compiling (tsc) ..."
if ! npx tsc; then
  echo "GLOBAL: RED (tsc failed to compile)"
  exit 1
fi

[ -f "${UNIT_JS}" ] || { echo "GLOBAL: RED (missing ${UNIT_JS})"; exit 1; }
[ -f "${INT_JS}" ]  || { echo "GLOBAL: RED (missing ${INT_JS})"; exit 1; }

# --- run suites (capture, do not abort on test failure) ----------------------
echo "-- running unit suite (${UNIT_SRC}) ..."
set +e
node --test "${UNIT_JS}" > "${UNIT_OUT}" 2>&1
UNIT_RC=$?
echo "-- running integration suite (${INT_SRC}) ..."
node --test "${INT_JS}" > "${INT_OUT}" 2>&1
INT_RC=$?
set -e

# Helper: extract a `# pass N` / `# fail N` count from a node --test TAP summary.
tap_count() { grep -E "^# ${1} " "${2}" | awk '{print $3}' | tail -1; }
# Helper: a named subtest line `ok N - <substr>` exists (the test passed).
test_ok() { grep -qE "^ok [0-9]+ - .*$1" "${2}"; }

UNIT_PASS="$(tap_count pass "${UNIT_OUT}")"; UNIT_PASS="${UNIT_PASS:-0}"
UNIT_FAIL="$(tap_count fail "${UNIT_OUT}")"; UNIT_FAIL="${UNIT_FAIL:-0}"
INT_PASS="$(tap_count pass "${INT_OUT}")";   INT_PASS="${INT_PASS:-0}"
INT_FAIL="$(tap_count fail "${INT_OUT}")";   INT_FAIL="${INT_FAIL:-0}"

echo
echo "suite results:"
echo "  unit        : ${UNIT_PASS} pass / ${UNIT_FAIL} fail (rc=${UNIT_RC})"
echo "  integration : ${INT_PASS} pass / ${INT_FAIL} fail (rc=${INT_RC})"
echo

# --- evaluate the 6 criteria -------------------------------------------------
GLOBAL=0
report() { # name, status(0/1), detail
  if [ "$2" -eq 0 ]; then echo "  [PASS] $1 — $3"; else echo "  [FAIL] $1 — $3"; GLOBAL=1; fi
}

echo "green criteria:"

# C1 — unitaire 100%
if [ "${UNIT_RC}" -eq 0 ] && [ "${UNIT_FAIL}" -eq 0 ] && [ "${UNIT_PASS}" -gt 0 ]; then
  report "C1 unitaire-100%" 0 "verdict-contract ${UNIT_PASS}/${UNIT_PASS}"
else
  report "C1 unitaire-100%" 1 "verdict-contract ${UNIT_PASS} pass / ${UNIT_FAIL} fail"
fi

# C2 — intégration escalate (A1 escalate audited+halted, A2 block)
if [ "${INT_RC}" -eq 0 ] && test_ok "(A1).*escalate.*halted.*audited" "${INT_OUT}" && test_ok "(A2).*block" "${INT_OUT}"; then
  report "C2 integration-escalate" 0 "A1 escalate audited+halted; A2 block ordering"
else
  report "C2 integration-escalate" 1 "A1/A2 not both green (int rc=${INT_RC})"
fi

# C3 — fail-soft câblé (A6 block fail-closed, A7 allow-degraded)
if test_ok "(A6).*block.*fail-closed" "${INT_OUT}" && test_ok "(A7).*allow-degraded" "${INT_OUT}"; then
  report "C3 failsoft-cabled" 0 "A6 fail-closed block; A7 allow-degraded"
else
  report "C3 failsoft-cabled" 1 "A6/A7 not both green"
fi

# C4 — safe-swap invariant (A3 judge-throw→escalate-local, A4 honored block, A5 honored allow)
if test_ok "(A3).*NEVER silent-allow" "${INT_OUT}" \
   && test_ok "(A4).*honored" "${INT_OUT}" \
   && test_ok "(A5).*EXECUTES" "${INT_OUT}"; then
  report "C4 safe-swap-invariant" 0 "A3 judge-throw→escalate-local; A4 honored-block; A5 honored-allow"
else
  report "C4 safe-swap-invariant" 1 "A3/A4/A5 not all green (the critical invariant)"
fi

# C5 — §11.1 non-orphelin (structural lint in the unit suite)
if test_ok "11.1 structural: memories-table MUTATIONS are confined" "${UNIT_OUT}" \
   && test_ok "11.1 structural: every public MemoryService op gates" "${UNIT_OUT}"; then
  report "C5 gate-non-orphan" 0 "§11.1 mutation-confinement + per-op gate lints green"
else
  report "C5 gate-non-orphan" 1 "§11.1 structural lints not green"
fi

# C6 — perf fast-path (judge not consulted on normal traffic)
if test_ok "normal traffic does NOT consult the judge" "${UNIT_OUT}"; then
  report "C6 perf-fastpath" 0 "judge not consulted on normal (allow) traffic"
else
  report "C6 perf-fastpath" 1 "fast-path judge-skip not proven"
fi

echo
if [ "${GLOBAL}" -eq 0 ]; then
  echo "GLOBAL: GREEN — all 6 criteria pass. Cabling the real Monade judge is gated-OPEN."
  echo "        (swap touches only escalate+judge; the contract guarantees degrade-safe.)"
  exit 0
else
  echo "GLOBAL: RED — at least one criterion failed. DO NOT cable the real judge yet."
  echo "        unit tail:"; tail -6 "${UNIT_OUT}" | sed 's/^/          /'
  echo "        int tail:";  tail -6 "${INT_OUT}"  | sed 's/^/          /'
  exit 1
fi
