import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";

// --- pin_memory ---------------------------------------------------------------
export const pinSchema = z.object({
  id: z.string().describe("Memory UUID"),
  pinned: z.boolean().default(true).describe("true = never forget, false = unpin"),
});

export async function pin(service: MemoryService, input: z.infer<typeof pinSchema>) {
  const m = await service.update({ id: input.id, pinned: input.pinned });
  return {
    content: [
      { type: "text" as const, text: `${input.pinned ? "Pinned" : "Unpinned"}: ${m.id}` },
    ],
  };
}

// --- introspect_memory --------------------------------------------------------
export const introspectSchema = z.object({
  id: z.string().describe("Memory UUID"),
});

export async function introspect(
  service: MemoryService,
  input: z.infer<typeof introspectSchema>
) {
  const m = await service.get(input.id);
  if (!m) {
    return { content: [{ type: "text" as const, text: `Not found: ${input.id}` }] };
  }
  const ageDays =
    (Date.now() - new Date(m.last_accessed_at ?? m.created_at).getTime()) / 86400000;
  const strengthNow =
    m.strength *
    Math.exp(-ageDays / (m.decay_tau_days * (1 + m.importance))) *
    (1 + Math.log1p(m.access_count));

  const text = [
    `id:           ${m.id}`,
    `content:      ${m.content}`,
    `category:     ${m.category}    stage: ${m.stage}    pinned: ${m.pinned}`,
    `tags:         ${m.tags.join(", ") || "(none)"}`,
    `created:      ${m.created_at}`,
    `last accessed:${m.last_accessed_at ?? "(never)"}`,
    `access_count: ${m.access_count}`,
    `importance:   ${m.importance}     valence: ${m.valence}    arousal: ${m.arousal}`,
    `strength:     ${m.strength.toFixed(3)} (base) -> ${strengthNow.toFixed(3)} (now, after ${ageDays.toFixed(1)}d)`,
    `decay_tau:    ${m.decay_tau_days} days`,
  ].join("\n");

  return { content: [{ type: "text" as const, text }] };
}

// --- consolidate_memories -----------------------------------------------------
export const consolidateSchema = z.object({
  min_access_count: z.number().int().min(1).optional().default(3),
  min_age_days: z.number().int().min(0).optional().default(1),
});

export async function consolidate(
  service: MemoryService,
  input: z.infer<typeof consolidateSchema>
) {
  const promoted = await service.consolidate(input.min_access_count, input.min_age_days);
  return {
    content: [
      {
        type: "text" as const,
        text: `Consolidated ${promoted} episodic memories into semantic stage.`,
      },
    ],
  };
}

// --- mark_useful --------------------------------------------------------------
export const markUsefulSchema = z.object({
  id: z.string().describe("Memory UUID that was actually used in an answer"),
});

export async function markUseful(
  service: MemoryService,
  input: z.infer<typeof markUsefulSchema>
) {
  await service.markUseful(input.id);
  return {
    content: [
      {
        type: "text" as const,
        text: `Marked useful: ${input.id} (strength bumped, useful_count++)`,
      },
    ],
  };
}

// --- dedup_memories -----------------------------------------------------------
//
// R2 (HIGH-5 fix) — destructive ops now require explicit scope or `all=true`.
// Stress-test 2026-05-03 found dedup_memories operated globally over Saphi's
// full memory store with no preview path, archiving originals on the first
// invocation. The new contract:
//
//   - At least one of {scope_tag, scope_project, scope_ids} must be set,
//     OR `all=true` must be passed explicitly. Otherwise the tool refuses.
//   - `dry_run` defaults to true: returns the proposed merge plan as text
//     without archiving anything. Set dry_run=false to actually execute.
//   - When `all=true`, scoped preview is not supported (the candidate set
//     would be every memory in the DB, so the dry-run cost approaches a
//     full table scan + per-row similarity probe). all=true always executes
//     via the legacy global SQL RPC; pair it with explicit operator intent.
//
export const dedupSchema = z.object({
  similarity_threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.93)
    .describe("Cosine similarity ≥ this threshold counts as a near-duplicate."),
  scope_tag: z
    .string()
    .optional()
    .describe("Restrict dedup to memories carrying this tag."),
  scope_project: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Restrict dedup to a project_id. Pass null to scope to memories without a project."
    ),
  scope_ids: z
    .array(z.string())
    .optional()
    .describe("Restrict dedup to this explicit list of memory IDs."),
  dry_run: z
    .boolean()
    .optional()
    .default(true)
    .describe("Default true — return the merge plan without archiving."),
  all: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Set true to opt into the legacy global dedup over all memories. Required when no scope_* param is provided."
    ),
});

function hasScope(input: z.infer<typeof dedupSchema> | z.infer<typeof forgetWeakSchema>): boolean {
  if ("scope_tag" in input && input.scope_tag) return true;
  // scope_project=null is a valid scope ("memories without a project").
  if ("scope_project" in input && input.scope_project !== undefined) return true;
  if ("scope_ids" in input && input.scope_ids && input.scope_ids.length > 0) return true;
  return false;
}

export async function dedup(
  service: MemoryService,
  input: z.infer<typeof dedupSchema>
) {
  const scoped = hasScope(input);
  if (!scoped && !input.all) {
    throw new Error(
      "Global dedup unsafe — provide scope_tag, scope_project, scope_ids, or set all=true"
    );
  }

  // ---- all=true path: legacy global SQL RPC, no preview ------------------
  if (!scoped) {
    if (input.dry_run) {
      return {
        content: [
          {
            type: "text" as const,
            text: "dry_run=true is not supported with all=true (global dry-run would scan the entire memory store). Re-run with dry_run=false to execute global dedup, or provide a scope_* param to preview a scoped plan.",
          },
        ],
      };
    }
    const merged = await service.dedup(input.similarity_threshold);
    return {
      content: [
        {
          type: "text" as const,
          text: `Merged ${merged} near-duplicate memories into their representatives. Originals archived. (all=true global dedup)`,
        },
      ],
    };
  }

  // ---- scoped path: TS-side cluster build over candidate pool ------------
  const candidates = await service.listByScope({
    tag: input.scope_tag,
    project: input.scope_project,
    ids: input.scope_ids,
  });
  if (candidates.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No memories match the provided scope — nothing to dedup.",
        },
      ],
    };
  }

  const candidateIds = new Set(candidates.map((c) => c.id));
  const processed = new Set<string>();
  const clusters: Array<{ kept_id: string; merged_ids: string[]; reason: string }> = [];

  for (const m of candidates) {
    if (processed.has(m.id)) continue;
    const similar = await service.findSimilar(m.content, input.similarity_threshold);
    const inScope = similar.filter(
      (s) => s.id !== m.id && candidateIds.has(s.id) && !processed.has(s.id)
    );
    if (inScope.length === 0) {
      processed.add(m.id);
      continue;
    }
    // Keep the strongest member of the cluster as the representative;
    // archive the rest. Strength reflects accumulated activations + decay
    // and is the cleanest "this trace is the active one" signal we have.
    const cluster = [m, ...inScope.map((s) => candidates.find((c) => c.id === s.id)!)];
    cluster.sort((a, b) => b.strength - a.strength);
    const kept = cluster[0];
    const merged = cluster.slice(1);
    clusters.push({
      kept_id: kept.id,
      merged_ids: merged.map((x) => x.id),
      reason: `similarity ≥ ${input.similarity_threshold}`,
    });
    for (const c of cluster) processed.add(c.id);
  }

  if (clusters.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Scanned ${candidates.length} memories in scope; no near-duplicates above similarity ${input.similarity_threshold}.`,
        },
      ],
    };
  }

  if (input.dry_run) {
    const lines = clusters
      .map(
        (c, i) =>
          `${i + 1}. keep ${c.kept_id} → archive ${c.merged_ids.length} (${c.merged_ids.join(", ")}) — ${c.reason}`
      )
      .join("\n");
    const totalToArchive = clusters.reduce((n, c) => n + c.merged_ids.length, 0);
    return {
      content: [
        {
          type: "text" as const,
          text: `[DRY RUN] ${clusters.length} cluster(s), ${totalToArchive} memorie(s) would be archived.\n${lines}\n\nRe-run with dry_run=false to execute.`,
        },
      ],
    };
  }

  // Execute: archive merged_ids
  let archived = 0;
  for (const c of clusters) {
    for (const id of c.merged_ids) {
      await service.archive(id);
      archived += 1;
    }
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `Merged ${clusters.length} cluster(s); archived ${archived} memorie(s) in scope. Representatives kept: ${clusters.map((c) => c.kept_id).join(", ")}.`,
      },
    ],
  };
}

// --- forget_weak --------------------------------------------------------------
//
// R2 (LOW-1 fix) — same scope/dry-run contract as dedup_memories. Defaults
// stay conservative (min_age_days=7, strength_threshold=0.05) so even an
// accidental scoped run won't sweep fresh memories.
//
export const forgetWeakSchema = z.object({
  strength_threshold: z
    .number()
    .min(0)
    .optional()
    .default(0.05)
    .describe("Forget memories with strength_now ≤ this value."),
  min_age_days: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(7)
    .describe("Only forget memories older than this many days."),
  scope_tag: z
    .string()
    .optional()
    .describe("Restrict to memories carrying this tag."),
  scope_project: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Restrict to a project_id. Pass null to scope to memories without a project."
    ),
  scope_ids: z
    .array(z.string())
    .optional()
    .describe("Restrict to this explicit list of memory IDs."),
  dry_run: z
    .boolean()
    .optional()
    .default(true)
    .describe("Default true — return the forget plan without archiving."),
  all: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Set true to opt into the legacy global forget over all eligible memories. Required when no scope_* param is provided."
    ),
});

export async function forgetWeak(
  service: MemoryService,
  input: z.infer<typeof forgetWeakSchema>
) {
  const scoped = hasScope(input);
  if (!scoped && !input.all) {
    throw new Error(
      "Global forget_weak unsafe — provide scope_tag, scope_project, scope_ids, or set all=true"
    );
  }

  // ---- all=true path: legacy global SQL RPC, no preview ------------------
  if (!scoped) {
    if (input.dry_run) {
      return {
        content: [
          {
            type: "text" as const,
            text: "dry_run=true is not supported with all=true (global dry-run would scan the entire memory store). Re-run with dry_run=false to execute global forget_weak, or provide a scope_* param to preview a scoped plan.",
          },
        ],
      };
    }
    const archived = await service.forgetWeak(
      input.strength_threshold,
      input.min_age_days
    );
    return {
      content: [
        {
          type: "text" as const,
          text: `Soft-forgot (archived) ${archived} weak memories. Originals preserved in forgotten_memories. (all=true global forget)`,
        },
      ],
    };
  }

  // ---- scoped path: filter candidate pool by age + strength --------------
  const candidates = await service.listByScope({
    tag: input.scope_tag,
    project: input.scope_project,
    ids: input.scope_ids,
  });
  const now = Date.now();
  const minAgeMs = input.min_age_days * 86_400_000;
  const eligible = candidates.filter((m) => {
    if (m.strength > input.strength_threshold) return false;
    const ageMs = now - new Date(m.created_at).getTime();
    return ageMs >= minAgeMs;
  });

  if (eligible.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Scanned ${candidates.length} memories in scope; none meet (strength ≤ ${input.strength_threshold} AND age ≥ ${input.min_age_days}d).`,
        },
      ],
    };
  }

  if (input.dry_run) {
    const lines = eligible
      .map(
        (m, i) =>
          `${i + 1}. ${m.id} — strength=${m.strength.toFixed(3)} age=${Math.floor(
            (now - new Date(m.created_at).getTime()) / 86_400_000
          )}d`
      )
      .join("\n");
    return {
      content: [
        {
          type: "text" as const,
          text: `[DRY RUN] ${eligible.length} memorie(s) would be archived from scope.\n${lines}\n\nRe-run with dry_run=false to execute.`,
        },
      ],
    };
  }

  let archived = 0;
  for (const m of eligible) {
    await service.archive(m.id);
    archived += 1;
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `Soft-forgot (archived) ${archived} memorie(s) in scope. Originals recoverable via stage='archived' filter.`,
      },
    ],
  };
}
