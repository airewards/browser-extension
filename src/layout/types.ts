import type { Anchor, SupportedPlatform } from '../adapters/types';
import type { SponsoredRecommendation } from '../sponsored';

/**
 * Layout strategy layer.
 *
 * Sits between the placement engine and the render controller:
 *
 *   Discovery → Placement Engine → Layout Strategy → Render Controller → Renderer
 *
 * The placement engine decides *which anchor* a recommendation belongs to. The
 * layout strategy decides *how to sit at that anchor on this platform's footer*:
 * which stable landmark to attach to, where relative to it, and how to stay
 * adjacent to (never obscuring) the platform's own first-party disclaimers.
 *
 * Layout strategies are pure and read-only: they inspect stable structural
 * landmarks via `querySelector` and return a {@link LayoutPlan}. They never
 * insert nodes, mutate the DOM, attach listeners, observe, or reach the backend.
 * This is where platform-specific layout knowledge lives, keeping the renderer
 * generic.
 */

/** Where the recommendation line should sit relative to the resolved landmark. */
export type LayoutInsertion = 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend';

/**
 * A resolved, platform-specific plan for placing the one-line recommendation.
 *
 * Describes the host page landmark and the insertion point only — it never
 * carries the content to render. The renderer consumes the plan to insert its
 * single host node additively, without modifying the landmark or any
 * first-party disclaimer.
 */
export interface LayoutPlan {
  /** A stable CSS selector for the landmark to attach the line to. */
  readonly landmarkSelector: string;
  /** Where to insert the host node relative to the resolved landmark. */
  readonly insertion: LayoutInsertion;
  /**
   * Whether the platform exposes a first-party disclaimer near this landmark.
   * When true the line is placed in available footer space adjacent to it; the
   * disclaimer is never removed, hidden, replaced, or modified. Informational
   * for diagnostics; the renderer's insertion is additive either way.
   */
  readonly disclaimerPresent: boolean;
}

/**
 * A platform's footer layout strategy.
 *
 * Given a selected anchor, returns a {@link LayoutPlan} for this platform's
 * available footer space, or `null` when no safe footer placement exists (so the
 * pipeline renders nothing rather than guessing a location).
 */
export interface LayoutStrategy {
  readonly platform: SupportedPlatform;
  /** Read-only: resolve a footer layout plan for the anchor, or `null`. */
  plan(anchor: Anchor, document: LayoutDocument): LayoutPlan | null;
}

/** The read-only subset of `Document` a layout strategy may inspect. */
export type LayoutDocument = Pick<Document, 'querySelector'>;

/**
 * The full render request handed to the render controller and renderer.
 *
 * Combines the selected platform, the resolved layout plan, and the generic
 * sponsored content. The renderer consumes this and nothing else; it performs no
 * selection, no layout resolution, and no content decisions.
 */
export interface RenderRequest {
  readonly platform: SupportedPlatform;
  readonly layout: LayoutPlan;
  readonly content: SponsoredRecommendation;
  readonly tracking: {
    readonly href: string;
    readonly impressionId: string;
  };
}
