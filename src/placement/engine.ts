import type { SupportedPlatform } from '../adapters/types';
import { highestRankedStrategy } from './strategies';
import type { PlacementEngine, PlacementRequest, PlacementStrategy } from './types';

/**
 * Placement engine.
 *
 * Converts ranked, validated anchors into a {@link PlacementRequest} using a
 * pluggable {@link PlacementStrategy}. It selects only — it performs no
 * discovery, holds no state, mutates no DOM, and never reaches the backend.
 * Discovery feeds it ranked anchors; it hands a request to the render
 * controller.
 *
 * For now the default strategy always chooses the highest-ranked valid anchor.
 * The strategy seam exists so future placement policies (rotation, position
 * preferences, density rules) can be introduced without changing callers.
 */
export function createPlacementEngine(
  strategy: PlacementStrategy = highestRankedStrategy(),
): PlacementEngine {
  return {
    plan(platform: SupportedPlatform, rankedAnchors): PlacementRequest | null {
      const anchor = strategy.select(rankedAnchors);

      if (!anchor) {
        return null;
      }

      return { platform, anchor };
    },
  };
}
