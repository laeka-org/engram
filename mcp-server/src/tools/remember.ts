import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";
import type { ProjectService } from "../services/projects.js";

export const rememberSchema = z.object({
  content: z.string().describe("The information to remember"),
  category: z
    .enum(["general", "people", "projects", "topics", "decisions"])
    .optional()
    .default("general")
    .describe("Category for the memory"),
  tags: z.array(z.string()).optional().default([]).describe("Tags for filtering"),
  source: z.string().optional().describe("Where this information came from"),
  importance: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Encoding strength 0..1. Higher = decays slower. Default 0.5."),
  valence: z
    .number()
    .min(-1)
    .max(1)
    .optional()
    .describe("Emotional valence -1..1 (negative..positive). Boosts salience."),
  arousal: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Emotional arousal 0..1. High arousal slows decay (amygdala effect)."),
  pinned: z
    .boolean()
    .optional()
    .describe("Pin this memory — it will never be forgotten and gets a salience bonus."),
  project: z
    .string()
    .nullable()
    .optional()
    .describe("Project slug to scope this memory to. Omit to use the agent's active project (if any). Pass null to force global (no project)."),
  force_new: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Bypass near-duplicate check and always create a new memory row, even when the content is semantically very close to an existing one. Use when you intentionally want to record a distinct observation that happens to share vocabulary with prior memories (e.g. 'phase 2 ADOPTED' followed by 'phase 2 REJECTED' as a deliberate state transition rather than a near-dup of the first). Default false: the server merges into the existing memory and returns dedup_to_existing signaling so you know the merge happened."
    ),
});

export async function remember(
  service: MemoryService,
  projects: ProjectService,
  agentLabel: string,
  input: z.infer<typeof rememberSchema>
) {
  const project_id = await projects.resolveScope(input.project, agentLabel);
  const result = await service.createWithDedupInfo(
    { ...input, project_id },
    { force_new: input.force_new }
  );
  const { memory, deduped } = result;
  const preview = memory.content.slice(0, 100) + (memory.content.length > 100 ? "..." : "");

  // R4 transparency (HIGH-4 fix from stress-test handoff 2026-05-03): if the
  // server merged this write into an existing memory, surface that explicitly
  // so the caller can decide whether to retry with force_new=true or accept
  // the merge. Previously the dedup was silent and the caller saw an
  // identical-shape success response with the existing UUID — looking like
  // the new content was persisted when it actually wasn't.
  if (deduped) {
    const existingPreview =
      deduped.existing_content.slice(0, 100) +
      (deduped.existing_content.length > 100 ? "..." : "");
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Merged into near-duplicate existing memory ` +
            `(similarity=${deduped.similarity_score.toFixed(3)}): ` +
            `"${existingPreview}" [existing_id: ${deduped.existing_id}]. ` +
            `New content was NOT persisted as a separate memory. ` +
            `Pass force_new=true to override.`,
          dedup_to_existing: true,
          existing_id: deduped.existing_id,
          similarity_score: deduped.similarity_score,
        } as const,
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Remembered (${memory.category}, importance=${memory.importance}${memory.pinned ? ", pinned" : ""}${project_id ? ", project-scoped" : ""}): "${preview}" [id: ${memory.id}]`,
      },
    ],
  };
}
