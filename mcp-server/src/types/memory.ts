export interface Memory {
  id: string;
  content: string;
  category: string;
  tags: string[];
  embedding?: number[];
  metadata: Record<string, unknown>;
  source?: string;
  created_at: string;
  updated_at: string;
  // Cognitive fields (migration 007)
  strength: number;
  importance: number;
  access_count: number;
  last_accessed_at?: string;
  valence: number;
  arousal: number;
  stage: "episodic" | "semantic" | "archived";
  pinned: boolean;
  decay_tau_days: number;
  useful_count: number;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  category: string;
  tags: string[];
  metadata: Record<string, unknown>;
  source?: string;
  stage: string;
  strength: number;
  importance: number;
  access_count: number;
  pinned: boolean;
  relevance: number;
  strength_now: number;
  salience: number;
  effective_score: number;
  created_at: string;
  last_accessed_at?: string;
}

export interface SpreadResult {
  id: string;
  content: string;
  category: string;
  tags: string[];
  link_strength: number;
}

/** Polymorphic spread result — Migration 054 spread_activation_cross.
 *  `kind` widens as new Hebbian tables come online (today: memory,
 *  experience; future: lesson, trait, intention). */
export interface CrossSpreadResult {
  kind: "memory" | "experience" | "lesson" | "trait" | "intention";
  id: string;
  content: string;
  category: string;
  tags: string[];
  link_strength: number;
}

export interface CreateMemoryInput {
  content: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  source?: string;
  importance?: number;
  valence?: number;
  arousal?: number;
  pinned?: boolean;
  decay_tau_days?: number;
  project_id?: string | null;
}

/** Information about a near-duplicate hit during memory creation.
 *  Surfaced via createWithDedupInfo() when an incoming write was merged into
 *  an existing memory rather than creating a new one (R4 transparency fix —
 *  HIGH-4 from stress-test handoff 2026-05-03). */
export interface DedupInfo {
  existing_id: string;
  similarity_score: number;
  existing_content: string;
}

/** Result of a memory creation attempt. When `deduped` is set, the returned
 *  `memory` is an EXISTING memory the new content was merged into; the new
 *  content was NOT persisted as a separate row (R4 transparency). */
export interface CreateMemoryResult {
  memory: Memory;
  deduped?: DedupInfo;
}

export interface UpdateMemoryInput {
  id: string;
  content?: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  importance?: number;
  valence?: number;
  arousal?: number;
  pinned?: boolean;
}

export interface SearchMemoryInput {
  query: string;
  category?: string;
  limit?: number;
  vector_weight?: number;
}
