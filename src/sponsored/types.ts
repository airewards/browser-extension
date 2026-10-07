/**
 * Sponsored content model.
 *
 * A {@link SponsoredRecommendation} is the generic, advertiser-agnostic text the
 * renderer displays. It is intentionally minimal: a sponsor name and a short
 * value proposition. Only the text changes between advertisers (AIRewards,
 * Grammarly, Notion, Cursor, Perplexity, Ramp, Linear, ...); the layout and the
 * renderer never carry advertiser-specific assumptions.
 *
 * This is browser-side presentation data only. It is a presentation projection of
 * the backend Advertisement business object (see AGENTS.md → "Recommendation is a
 * presentation concept"). It deliberately carries NO backend business concepts —
 * no campaign, advertiser id, reward amount, impression, CPC/CPM bid, or
 * `tracking_signature`. The browser maps the backend Ad payload into this model
 * (see {@link ./mapping}); the backend contract remains authoritative.
 */
export interface SponsoredRecommendation {
  /**
   * Stable identifier for the recommendation, projected from the backend ad id.
   * Presentation-only: used to dedupe/cache the current line, never to drive any
   * reward, impression, or business logic in the browser.
   */
  readonly id: string;
  /** The sponsor's display name, e.g. "AIRewards", "Grammarly". */
  readonly sponsor: string;
  /** A short value proposition, e.g. "Write with confidence". */
  readonly message: string;
  /** The destination URL for the recommendation, projected from the backend ad. */
  readonly url: string;
}

/** The fixed sponsorship label shown before the sponsor name. */
export const SPONSORED_LABEL = 'Sponsored';

/**
 * Maximum length of the rendered value proposition. Aligned with ADR 0005
 * (text-only ads, strict character limit) and the one-line UI: long messages are
 * truncated rather than allowed to wrap and grow the line beyond its max height.
 */
export const MAX_MESSAGE_LENGTH = 120;
