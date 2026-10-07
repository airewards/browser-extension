import type { Anchor } from '../adapters/types';
import type { PlacementStrategy } from './types';

/**
 * Placement strategies.
 *
 * Each strategy is a pure selection policy over the ranked, validated anchors.
 * Strategies never render, mutate the DOM, persist, or reach the backend — they
 * only choose. New policies are added here without touching the engine.
 */

/** An anchor is a usable placement target only if discovery marked it `valid`. */
function isValidTarget(anchor: Anchor): boolean {
  return anchor.status === 'valid';
}

/**
 * Highest-ranked strategy: choose the first valid anchor in the ranked list.
 *
 * The input is already ordered best-first by {@link rankAnchors}, so the first
 * valid candidate is the highest-ranked one. Returns `null` when no anchor is
 * valid.
 */
export function highestRankedStrategy(): PlacementStrategy {
  return {
    name: 'highest-ranked',
    select(rankedAnchors) {
      return rankedAnchors.find(isValidTarget) ?? null;
    },
  };
}
