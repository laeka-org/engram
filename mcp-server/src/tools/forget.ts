import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";

export const forgetSchema = z.object({
  id: z.string().uuid().describe("UUID of the memory to delete"),
});

export async function forget(
  service: MemoryService,
  input: z.infer<typeof forgetSchema>
) {
  const existing = await service.get(input.id);
  if (!existing) {
    return {
      content: [
        { type: "text" as const, text: `Memory ${input.id} not found.` },
      ],
    };
  }

  // Pass the memory's content as `subject` so the Monade judge (consulted on
  // every hard delete — Sid Option A 2026-06-05) assesses what is actually
  // being destroyed, not just the opaque id.
  await service.delete(input.id, undefined, existing.content);
  return {
    content: [
      {
        type: "text" as const,
        text: `Deleted memory: "${existing.content.slice(0, 100)}${existing.content.length > 100 ? "..." : ""}" [${existing.category}]`,
      },
    ],
  };
}
