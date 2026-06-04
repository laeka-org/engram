/**
 * manifest.ts — the Monade integrity manifest loader (verdict contract §6).
 *
 * The manifest (manifest/invariants.yaml) is the ONLY Sid-facing policy
 * surface: plain-language business invariants, no numeric tuning. verdict()
 * reads the manifest as its source of policy; numeric knobs live separately in
 * the runtime-tuning JSONL (never surfaced to Sid).
 *
 * Parser scope: we deliberately do NOT pull a YAML dependency ("ajuster avant
 * ajouter" + the package keeps a minimal dependency set). The manifest has a
 * fixed, documented shape — a flat `invariants:` list of {id, statement,
 * applies_to, decision} plus a `signature:` block — so a small purpose-built
 * parser for exactly that subset is appropriate and fully testable. It is NOT
 * a general YAML parser and does not pretend to be.
 *
 * The two surfaces (§6) are kept strictly separate:
 *   - Manifest invariants  → plain language, signed by Sid, re-signature to change.
 *   - Runtime tuning JSONL → numeric floors/TTLs/thresholds, append-only audit.
 * No numeric parameter ever appears in an invariant `statement` (conformance
 * §11.6 pins this with a static test over the manifest file).
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MemoryOp, VerdictDecision } from "./wire-types.js";

export interface ManifestInvariant {
  id: string;
  statement: string;
  applies_to: MemoryOp[];
  decision: VerdictDecision;
}

export interface ManifestSignature {
  signed: boolean;
  signed_at: string | null;
  signed_by: string | null;
  value: string | null;
}

export interface IntegrityManifest {
  spec_version: string;
  invariants: ManifestInvariant[];
  signature: ManifestSignature;
}

const VALID_OPS = new Set<string>(["store", "recall", "correct", "forget"]);
const VALID_DECISIONS = new Set<string>([
  "allow",
  "block",
  "inject",
  "reconcile",
  "escalate",
]);

/**
 * Strip a quoted scalar value: trims, removes a surrounding pair of single or
 * double quotes, and resolves the literal `null` to a JS null.
 */
function scalar(raw: string): string | null {
  const t = raw.trim();
  if (t === "null" || t === "~" || t === "") return null;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse a flow-style list `[a, b, c]` into trimmed string items. */
function flowList(raw: string): string[] {
  const t = raw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return [];
  const inner = t.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Parse the constrained manifest YAML subset. Throws on a malformed invariant
 * (unknown op / decision, missing id or statement) — a manifest that does not
 * conform to its own shape is a policy-integrity failure, not a silent skip.
 */
export function parseManifest(text: string): IntegrityManifest {
  const lines = text.split("\n");

  let spec_version = "";
  const invariants: ManifestInvariant[] = [];
  const signature: ManifestSignature = {
    signed: false,
    signed_at: null,
    signed_by: null,
    value: null,
  };

  type Section = "top" | "invariants" | "signature";
  let section: Section = "top";
  let current: Partial<ManifestInvariant> | null = null;

  const flushCurrent = () => {
    if (!current) return;
    if (!current.id || !current.statement) {
      throw new Error(`manifest: invariant missing id/statement: ${JSON.stringify(current)}`);
    }
    for (const op of current.applies_to ?? []) {
      if (!VALID_OPS.has(op)) throw new Error(`manifest: invariant '${current.id}' has unknown op '${op}'`);
    }
    if (!current.decision || !VALID_DECISIONS.has(current.decision)) {
      throw new Error(`manifest: invariant '${current.id}' has invalid decision '${current.decision}'`);
    }
    invariants.push(current as ManifestInvariant);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");
    const noComment = line.replace(/\s+#.*$/, ""); // strip trailing comments
    if (noComment.trim() === "" || noComment.trim().startsWith("#")) continue;

    // Top-level section keys (no indentation).
    if (/^spec_version\s*:/.test(noComment)) {
      flushCurrent();
      section = "top";
      spec_version = scalar(noComment.split(":").slice(1).join(":")) ?? "";
      continue;
    }
    if (/^invariants\s*:/.test(noComment)) {
      flushCurrent();
      section = "invariants";
      continue;
    }
    if (/^signature\s*:/.test(noComment)) {
      flushCurrent();
      section = "signature";
      continue;
    }

    if (section === "invariants") {
      const itemMatch = /^\s*-\s+(.*)$/.exec(noComment);
      if (itemMatch) {
        // New list item begins.
        flushCurrent();
        current = { applies_to: [] };
        // The item line may carry the first key inline (`- id: ...`).
        const inline = itemMatch[1];
        applyInvariantKey(current, inline);
        continue;
      }
      if (current) {
        applyInvariantKey(current, noComment.trim());
      }
      continue;
    }

    if (section === "signature") {
      const kv = /^\s*([a-z_]+)\s*:\s*(.*)$/.exec(noComment);
      if (!kv) continue;
      const [, key, valRaw] = kv;
      const val = scalar(valRaw);
      if (key === "signed") signature.signed = val === "true";
      else if (key === "signed_at") signature.signed_at = val;
      else if (key === "signed_by") signature.signed_by = val;
      else if (key === "value") signature.value = val;
      continue;
    }
  }
  flushCurrent();

  return { spec_version, invariants, signature };
}

/** Apply a single `key: value` line to the invariant being assembled. */
function applyInvariantKey(inv: Partial<ManifestInvariant>, line: string): void {
  const kv = /^([a-z_]+)\s*:\s*(.*)$/.exec(line.trim());
  if (!kv) return;
  const [, key, valRaw] = kv;
  if (key === "id") inv.id = scalar(valRaw) ?? "";
  else if (key === "statement") inv.statement = scalar(valRaw) ?? "";
  else if (key === "applies_to") inv.applies_to = flowList(valRaw) as MemoryOp[];
  else if (key === "decision") inv.decision = (scalar(valRaw) ?? "") as VerdictDecision;
}

/** Default manifest path (relative to the built dist/, resolving to the repo). */
export function defaultManifestPath(): string {
  // dist/services/manifest.js → up to mcp-server/ → manifest/invariants.yaml.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "manifest", "invariants.yaml");
}

/**
 * Load + parse the manifest from disk. Returns null when the file does not
 * exist (verdict() then runs on the §4 code floor — the manifest can only
 * WIDEN policy when present AND signed, never the inverse). Never throws on a
 * missing file; DOES throw on a malformed one (a broken manifest is a
 * policy-integrity failure that must surface, not degrade silently).
 */
export function loadManifest(path?: string): IntegrityManifest | null {
  const p = path ?? defaultManifestPath();
  if (!existsSync(p)) return null;
  return parseManifest(readFileSync(p, "utf8"));
}

/**
 * Whether the manifest may WIDEN policy beyond the §4 code floor. A manifest
 * widens authority only when it is signed by Sid (§6.1: changing an invariant
 * = a re-signature). An unsigned manifest is advisory: verdict() still runs on
 * the §4 code floor, but the unsigned manifest's invariants do NOT grant new
 * authority. This is the safe direction — a tampered/unsigned manifest can
 * never loosen the floor, only the signed one can extend it.
 */
export function manifestIsAuthoritative(m: IntegrityManifest | null): boolean {
  return !!m && m.signature.signed === true && typeof m.signature.value === "string";
}

/**
 * A compact, introspectable summary of the manifest's policy surface — used for
 * boot logging + the conformance assertion that the manifest carries no numeric
 * tuning. Returns the invariant ids + statements + whether it is signed.
 */
export function manifestSummary(m: IntegrityManifest | null): {
  signed: boolean;
  invariant_count: number;
  invariant_ids: string[];
} {
  return {
    signed: m?.signature.signed ?? false,
    invariant_count: m?.invariants.length ?? 0,
    invariant_ids: (m?.invariants ?? []).map((i) => i.id),
  };
}
