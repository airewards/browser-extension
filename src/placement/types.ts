import type { Anchor, SupportedPlatform } from '../adapters/types';

/**
 * Placement layer.
 *
 * The placement engine sits between anchor discovery and the render controller:
 *
 *   Ranked Anchors → Placement Engine → PlacementRequest → Render Controller → Renderer
 *
 * It decides *where* a render should happen by selecting from the ranked,
 * validated anchors and producing a {@link PlacementRequest} — the single
 * canonical browser-side render request. The engine is independent of the
 * renderer and the controller: it returns a request, it does not render.
 */

/**
 * The canonical browser-side render request.
 *
 * This is the one shape the render controller and renderer consume. It is
 * deliberately browser-only: it carries the selected {@link Anchor} (already a
 * pure browser-side description: id, platform, position, confidence, status)
 * and nothing else.
 *
 * It intentionally contains NO backend concepts — no campaign, advertiser,
 * reward, impression, or ad payload. Those belong to later, separately approved
 * work and must never leak into the placement layer.
 */
export interface PlacementRequest {
  /** The platform the placement targets. */
  readonly platform: SupportedPlatform;
  /** The single anchor selected for rendering. */
  readonly anchor: Anchor;
}

/**
 * A strategy that selects one anchor from the ranked, validated candidates.
 *
 * Strategies are pure: given the ranked anchors they return the chosen anchor,
 * or `null` when none is suitable. They never render, never mutate the DOM, and
 * never reach the backend. This is the extension point for future placement
 * policies; today there is a single highest-ranked strategy.
 */
export interface PlacementStrategy {
  /** Human-readable name, used only for diagnostics. */
  readonly name: string;
  /**
   * Choose an anchor from the ranked candidates (best-first), or `null` if none
   * is a valid placement target.
   */
  select(rankedAnchors: readonly Anchor[]): Anchor | null;
}

/**
 * The placement engine.
 *
 * Converts ranked, validated anchors into an optional {@link PlacementRequest}.
 * Returns `null` when no anchor is a suitable placement target, so the caller
 * renders nothing rather than guessing.
 */
export interface PlacementEngine {
  /**
   * Build a placement request for the platform from its ranked anchors, or
   * `null` when none is suitable.
   */
  plan(platform: SupportedPlatform, rankedAnchors: readonly Anchor[]): PlacementRequest | null;
}
