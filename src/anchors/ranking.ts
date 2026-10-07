import type { Anchor } from '../adapters/types';

/**
 * Rank anchors best-first.
 *
 * Primary key: confidence, descending. Tie-break: anchor `id`, ascending, so the
 * ordering is deterministic and stable across runs. Ranking does not select,
 * persist, or render anything — it only orders the candidates.
 */
export function rankAnchors(anchors: readonly Anchor[]): Anchor[] {
  return [...anchors].sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
