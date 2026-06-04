-- 086_verdict_event_type.sql — verdict-contract audit trail (palier 2, STEP 3).
--
-- The integrity verdict contract (services/verdict.ts) persists one audit row
-- per verdict via log_memory_event, so that every IntegrityVerdict.audit_id
-- resolves to a real memory_events row (conformance §11.2: "tout verdict
-- produit un audit_id résolvable vers une ligne memory_events").
--
-- This migration is ADDITIVE and NON-DESTRUCTIVE: it reproduces the full
-- event_type set from migration 062 (the last migration to touch this CHECK)
-- VERBATIM and only ADDS 'verdict'. Every event_type that was valid before
-- this migration remains valid after it — no emitter can regress.
--
-- The DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT pattern is the same
-- proven-non-destructive shape used by migrations 058 and 062.

BEGIN;

ALTER TABLE memory_events
  DROP CONSTRAINT IF EXISTS memory_events_event_type_check;

ALTER TABLE memory_events
  ADD CONSTRAINT memory_events_event_type_check CHECK (event_type IN (
    -- lifecycle
    'created', 'updated', 'archived', 'restored', 'superseded',
    -- access / use
    'accessed', 'recalled', 'used_in_response', 'pinned', 'unpinned',
    -- feedback / learning
    'promoted', 'demoted', 'positive_feedback', 'negative_feedback',
    'mark_useful', 'emphasis_bump',
    -- relations
    'relation_added', 'relation_removed', 'coactivated',
    -- guard / conscience
    'guard_hit', 'guard_miss', 'prevention_hit', 'prevention_miss',
    'conscience_warning', 'contradiction_detected', 'contradiction_resolved',
    -- agent bus
    'agent_triggered', 'agent_completed', 'agent_error',
    'consolidation_done', 'synthesis_created',
    -- observability
    'reasoning_trace', 'tool_call_trace', 'prompt_received',
    -- generic
    'note',
    -- affect engine (migration 062)
    'compute_affect',
    -- integrity verdict contract (palier 2 — THIS migration, additive)
    'verdict'
  ));

COMMIT;
