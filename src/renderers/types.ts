import type { RenderRequest } from '../layout';

/**
 * Renderer layer.
 *
 * Renderers are the only part of the extension permitted to insert nodes into a
 * host page, and they do so safely and reversibly. A renderer receives a single
 * {@link RenderRequest} (platform + resolved layout plan + generic sponsored
 * content) and nothing else; it is independent of adapters, providers, ranking,
 * placement selection, and layout resolution. It contains no advertiser-specific
 * assumptions and no business logic — only the text content changes between
 * advertisers, never the layout.
 *
 * Safety contract (enforced by every renderer):
 * - Insertion is additive only — never overwrites or removes website nodes, and
 *   never removes, hides, replaces, or modifies first-party disclaimers.
 * - Existing event handlers and page behavior are never touched.
 * - The inserted content is isolated in a Shadow DOM so styles cannot leak in
 *   either direction.
 * - Every insertion is fully reversible via {@link Renderer.destroy}.
 * - No MutationObserver and no continuous animation.
 */
export interface Renderer {
  /**
   * Insert the recommendation line for the given request. Idempotent: calling
   * `render` while already rendered is a no-op (use {@link Renderer.rerender} to
   * replace). Returns true when the line is present after the call.
   */
  render(request: RenderRequest): boolean;

  /**
   * Remove the line if present. Removes only the renderer's own node; never
   * affects website content. Idempotent.
   */
  destroy(): void;

  /** Destroy any existing line, then render for the given request. */
  rerender(request: RenderRequest): boolean;

  /** Whether the recommendation line is currently inserted in the page. */
  isRendered(): boolean;

  /** Return the inserted host node when it is currently connected. */
  getHost(): HTMLElement | null;
}
