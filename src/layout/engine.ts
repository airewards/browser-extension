import type { PlacementRequest } from '../placement';
import type { SponsoredRecommendation } from '../sponsored';
import { layoutStrategies } from './strategies';
import type { LayoutDocument, RenderRequest } from './types';

/**
 * Layout engine.
 *
 * Resolves the platform's footer {@link LayoutStrategy}, asks it for a layout
 * plan at the placement's anchor, and combines the plan with the generic
 * sponsored content into a {@link RenderRequest} for the render controller.
 *
 * Pure and read-only: it resolves a plan and assembles a request. It performs no
 * insertion, no selection, no content decisions, and never reaches the backend.
 * Returns `null` when the platform's strategy finds no safe footer placement, so
 * the caller renders nothing rather than guessing.
 */
export function planLayout(
  placement: PlacementRequest,
  content: SponsoredRecommendation,
  document: LayoutDocument,
  tracking: RenderRequest['tracking'],
): RenderRequest | null {
  const strategy = layoutStrategies[placement.platform];
  const layout = strategy.plan(placement.anchor, document);

  if (!layout) {
    return null;
  }

  return { platform: placement.platform, layout, content, tracking };
}
