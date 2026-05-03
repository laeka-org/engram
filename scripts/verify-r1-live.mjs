#!/usr/bin/env node
// Live-DB verification for R1 additive log-scale scoring (engram).
//
// Calls engram's compiled MemoryService.search() against the running
// Mycelium Supabase + Ollama, then runs engram's rerankHybrid() on the
// candidate pool. Prints top-N results for the three queries from the
// stress-test handoff (HIGH-1 repro):
//   1. "ordi Dell"
//   2. "machine stable"
//   3. "serveur Dell"
//
// Run :  node scripts/verify-r1-live.mjs
// Env  :  SUPABASE_URL (default http://localhost:54321), SUPABASE_KEY (read
//         from .mcp.json fallback), OLLAMA_URL, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS.

import { MemoryService } from "../mcp-server/dist/services/supabase.js";
import { OllamaEmbeddingProvider } from "../mcp-server/dist/services/embeddings.js";
import { rerankHybrid } from "../mcp-server/dist/tools/recall.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://localhost:54321";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
const EMBED_DIM = parseInt(process.env.EMBEDDING_DIMENSIONS ?? "768", 10);

if (!SUPABASE_KEY) {
  console.error("SUPABASE_KEY env required.");
  process.exit(1);
}

const embeddings = new OllamaEmbeddingProvider(OLLAMA_URL, EMBED_MODEL, EMBED_DIM);
const service = new MemoryService(SUPABASE_URL, SUPABASE_KEY, embeddings);

const POOL = 30; // CANDIDATE_POOL_FLOOR
const TOP = 3;

const queries = [
  { q: "ordi Dell", note: "Saphi-bug pattern (vocab divergence)" },
  { q: "machine stable", note: "stress-test HIGH-1 repro" },
  { q: "serveur Dell", note: "exact match — must rank #1" },
];

console.log("\n=== R1 ADDITIVE LOG-SCALE — LIVE-DB VERIFY ===\n");
console.log(`Engram code path : rerankHybrid (additive)`);
console.log(`α=0.6, β=0.1, γ=0.05  (defaults from env or builtin)`);
console.log(`Pool size : ${POOL} candidates → top ${TOP}\n`);

for (const { q, note } of queries) {
  console.log(`──────────────────────────────────────────────`);
  console.log(`Query : "${q}"   (${note})`);
  console.log(`──────────────────────────────────────────────`);

  let candidates;
  try {
    // SQL with vector_weight=1.0 — engram pure-cosine pool path
    candidates = await service.search(q, undefined, POOL, 1.0);
  } catch (err) {
    console.error(`  ! search failed: ${err.message ?? err}`);
    continue;
  }

  if (candidates.length === 0) {
    console.log("  (no candidates returned)\n");
    continue;
  }

  const ranked = rerankHybrid(candidates, q, 0.6, TOP);

  ranked.forEach((r, i) => {
    const isDell =
      /\bdell\b/i.test(r.content) ||
      /\bdell\b/i.test((r.tags ?? []).join(" "));
    const flag = isDell ? "  ← DELL" : "";
    const snippet = r.content.replace(/\s+/g, " ").slice(0, 100);
    console.log(
      `  ${i + 1}. score=${r.effective_score.toFixed(3)}  rel=${r.relevance.toFixed(3)}  str=${r.strength_now.toFixed(2)}  ax=${r.access_count}  ${flag}`
    );
    console.log(`     ${snippet}${r.content.length > 100 ? "…" : ""}`);
    console.log(`     id: ${r.id}`);
  });

  const dellInTop = ranked.some(
    (r) => /\bdell\b/i.test(r.content) || /\bdell\b/i.test((r.tags ?? []).join(" "))
  );
  console.log(`  ${dellInTop ? "✓" : "✗"} Dell memory ${dellInTop ? "PRESENT" : "ABSENT"} in top-${TOP}\n`);
}

console.log("=== END VERIFY ===\n");
