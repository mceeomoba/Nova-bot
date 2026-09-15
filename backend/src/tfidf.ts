/**
 * Deliberately not embeddings-API-based: OpenRouter's embedding support
 * varies by model and this shouldn't break because a provider changed
 * something. TF-IDF cosine similarity is dependency-free, deterministic,
 * and plenty good for the corpus size a single agent's memory realistically
 * reaches (hundreds to low thousands of entries, not millions).
 *
 * Zent.md Phase 3c reuses scoreCorpus() below for the expansion
 * pipeline's opportunity de-dup pass (expansion.ts's
 * findNearDuplicateOpportunity()) — the same "TF-IDF cosine similarity,
 * reusing tfidf.ts" Zent.md 3c calls for by name, rather than a second
 * from-scratch similarity metric.
 *
 * IDF fix, found while building 3c: the raw idf = ln(N / (1+df)) this
 * file originally used goes to exactly 0 for any term appearing in only
 * one of the (corpus + query) documents once N is small, and NEGATIVE
 * for any term appearing in most of them — at de-dup's realistic corpus
 * size (an agent's own scored opportunities: often 0-5 in the window,
 * not the "hundreds to low thousands" this file's own opening paragraph
 * assumes for memory search), that meant a single incidental shared
 * word between two OTHERWISE UNRELATED opportunities (e.g. both
 * happening to say "...by hand") could become the only nonzero
 * dimension in both vectors and drive cosine similarity to a false 1.0
 * — verified directly: two opportunities about invoice reconciliation
 * and podcast show-notes, sharing only the word "hand", scored a
 * perfect 1.0 match under the raw formula. Switched to the standard
 * smoothed idf = ln((1+N)/(1+df)) + 1 (the same formula scikit-learn's
 * TfidfVectorizer defaults to): always strictly positive regardless of
 * corpus size, so a term unique to one document is down-weighted, never
 * zeroed out or inverted. Same two opportunities re-scored under the
 * smoothed formula: 0.03 (correctly far below any reasonable duplicate
 * threshold), while a genuine near-duplicate pair still scores 0.90.
 * rankByRelevance()'s own relevance-search use case is unaffected in
 * the corpus sizes it actually runs at — smoothing only changes
 * behavior sharply at the small-N end this file wasn't originally
 * exercised against.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "to", "of", "and",
  "in", "on", "for", "with", "this", "that", "it", "as", "at", "by", "from",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/**
 * Scores every corpus entry's similarity to `query`, using TF-IDF
 * cosine similarity computed fresh over corpus + query each call.
 * Returns one { item, score } pair per corpus entry, in corpus order,
 * unfiltered and unsorted — rankByRelevance() below is the
 * "top-K, relevant-only" convenience built on top of this; a caller
 * that needs the raw score against a *specific* candidate (rather than
 * a ranked top-K) — e.g. a near-duplicate check comparing one new item
 * against a small set of existing ones — wants this shape instead, so
 * it isn't forced to reconstruct threshold logic rankByRelevance
 * intentionally applies for the search use case.
 */
export function scoreCorpus<T>(
  query: string,
  corpus: T[],
  getText: (item: T) => string,
): { item: T; score: number }[] {
  if (corpus.length === 0) return [];

  const docs = corpus.map((item) => tokenize(getText(item)));
  const queryTokens = tokenize(query);
  const allDocs = [...docs, queryTokens];

  const df = new Map<string, number>();
  for (const doc of allDocs) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const N = allDocs.length;
  // Smoothed idf — see this file's own module doc for why the naive
  // ln(N/(1+df)) formula is unsafe at small corpus sizes.
  const idf = (term: string) => Math.log((1 + N) / (1 + (df.get(term) ?? 0))) + 1;

  function vector(tokens: string[]): Map<string, number> {
    const tf = termFreq(tokens);
    const vec = new Map<string, number>();
    for (const [term, freq] of tf) vec.set(term, freq * idf(term));
    return vec;
  }

  function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0;
    for (const [term, weight] of a) dot += weight * (b.get(term) ?? 0);
    const magA = Math.sqrt([...a.values()].reduce((s, w) => s + w * w, 0));
    const magB = Math.sqrt([...b.values()].reduce((s, w) => s + w * w, 0));
    if (magA === 0 || magB === 0) return 0;
    return dot / (magA * magB);
  }

  const queryVec = vector(queryTokens);
  return corpus.map((item, i) => ({
    item,
    score: cosineSim(queryVec, vector(docs[i])),
  }));
}

/**
 * Ranks `corpus` entries by relevance to `query`, using TF-IDF computed
 * fresh over corpus + query each call. Fine at this scale; if the corpus
 * grows into the tens of thousands of entries, precompute and cache IDF
 * instead of recomputing per search.
 */
export function rankByRelevance<T>(
  query: string,
  corpus: T[],
  getText: (item: T) => string,
  topK: number,
): T[] {
  return scoreCorpus(query, corpus, getText)
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.item);
}
