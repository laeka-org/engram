// Vanilla TS Okapi BM25 — used as a TS-side re-ranker over the cosine
// candidate pool inside recall.
//
// Why hybrid: pure cosine similarity can miss memories whose vocabulary
// diverges from the query (e.g. query "ordi" vs memory "serveur Dell" —
// same hardware, different words). BM25 rewards exact keyword overlap and
// closes that vocab-divergent blind spot.
//
// IDF/avgdl are computed over the candidate pool, not the full corpus —
// this is a local re-ranker, not a global BM25. The intent is "which of
// these K*3 cosine candidates is the closest keyword match", not absolute
// BM25 over the whole memory store (which would require persisted term-doc
// statistics in Supabase, and migration 060 already exposes a different
// FTS path at SQL level).

const STOPWORDS = new Set<string>([
  // FR — function words / common verbs
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "est", "sont",
  "ai", "as", "au", "aux", "ce", "ces", "cet", "cette", "dans", "par", "pour",
  "que", "qui", "sur", "tu", "te", "ta", "tes", "ton", "mon", "ma", "mes",
  "je", "ne", "pas", "en", "se", "si", "mais", "plus", "moins", "aussi", "comme",
  "il", "elle", "on", "nous", "vous", "ils", "elles", "leur", "leurs",
  // EN — function words / common verbs
  "the", "an", "and", "or", "is", "are", "was", "were", "be", "been", "being",
  "of", "in", "on", "at", "to", "for", "with", "as", "my", "your", "his",
  "her", "its", "our", "their", "i", "you", "he", "she", "it", "we", "they",
  "this", "that", "these", "those", "do", "does", "did", "not", "but", "so",
  "if", "then", "than", "there", "here", "also", "such",
]);

// Strip ASCII + common Unicode punctuation. Keep word characters (Unicode
// letters, digits, accented chars) intact so French diacritics survive.
const PUNCT_RE = /[.,;:!?¿¡()\[\]{}<>"'`«»…—–\-_/\\|+*=#@&^%$~]+/gu;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(PUNCT_RE, " ")
    .split(/\s+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

export interface BM25Doc {
  id: string;
  text: string;
}

export interface BM25Result {
  id: string;
  score: number;
}

export interface BM25Options {
  k1?: number;
  b?: number;
}

export function bm25Score(
  query: string,
  docs: BM25Doc[],
  options: BM25Options = {}
): BM25Result[] {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;

  if (docs.length === 0) return [];

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return docs.map((d) => ({ id: d.id, score: 0 }));
  }

  const tokenizedDocs = docs.map((d) => ({
    id: d.id,
    tokens: tokenize(d.text),
  }));

  const N = tokenizedDocs.length;
  const totalLen = tokenizedDocs.reduce((sum, d) => sum + d.tokens.length, 0);
  const avgdl = totalLen === 0 ? 1 : totalLen / N;

  const df = new Map<string, number>();
  for (const d of tokenizedDocs) {
    const seen = new Set<string>();
    for (const tok of d.tokens) {
      if (!seen.has(tok)) {
        seen.add(tok);
        df.set(tok, (df.get(tok) ?? 0) + 1);
      }
    }
  }

  // BM25 smoothed-IDF — log(1 + (N-n+0.5)/(n+0.5)) is always >= 0.
  const idf = (term: string): number => {
    const n = df.get(term) ?? 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  const queryIdf = queryTerms.map((q) => ({ term: q, idf: idf(q) }));

  return tokenizedDocs.map((d) => {
    const dl = d.tokens.length;
    const tf = new Map<string, number>();
    for (const tok of d.tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);

    let score = 0;
    for (const { term, idf: w } of queryIdf) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const num = f * (k1 + 1);
      const denom = f + k1 * (1 - b + (b * dl) / (avgdl || 1));
      score += w * (num / denom);
    }

    return { id: d.id, score };
  });
}

// Min-max scale a score list to [0, 1]. Edge cases: empty → empty, all-equal
// → all 0 (no signal to spread), all-zero → all 0.
export function normalizeScores(scored: BM25Result[]): BM25Result[] {
  if (scored.length === 0) return scored;
  let min = Infinity;
  let max = -Infinity;
  for (const s of scored) {
    if (s.score < min) min = s.score;
    if (s.score > max) max = s.score;
  }
  if (max <= 0 || max === min) return scored.map((s) => ({ id: s.id, score: 0 }));
  const span = max - min;
  return scored.map((s) => ({ id: s.id, score: (s.score - min) / span }));
}
