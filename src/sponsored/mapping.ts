import { SPONSORED_LABEL, type SponsoredRecommendation } from './types';

/**
 * Presentation mapping: backend Advertisement → browser SponsoredRecommendation.
 *
 * This is the single, thin projection from the backend's canonical Ad payload
 * (`GET /v1/ads/current`) into the browser's presentation model. Per AGENTS.md
 * the browser is a presentation client: it transforms, it never creates,
 * selects, ranks, prioritizes, or generates recommendations.
 *
 * The mapping is purely STRUCTURAL and deterministic — never semantic. It copies
 * fields one-to-one and never infers, parses, or generates meaning:
 * - `ad_id` → `id`
 * - `text` → `message`
 * - `url` → `url`
 * - `sponsor` is the fixed generic disclosure label ({@link SPONSORED_LABEL}).
 *   The browser never infers branding, never parses domains, and never generates
 *   company names. If a future backend payload adds a `displayName`/`sponsor`
 *   field, the browser may display it; until then the sponsor is a generic
 *   disclosure only.
 *
 * There is NO business logic, targeting, campaign selection, reward logic, or
 * validation beyond simple defensive checks. The backend contract is
 * authoritative; `tracking_signature` is ignored completely (not read, stored,
 * exposed to the renderer, or mapped).
 */

/**
 * The subset of the backend Ad payload this mapper consumes. It mirrors the
 * fields of the `GET /v1/ads/current` response that are relevant to
 * presentation. `tracking_signature` is intentionally absent here so it can
 * never leak into the browser presentation layer.
 *
 * This is not a duplicate of the backend type: it is the minimal input contract
 * the presentation mapper reads. The authoritative shape lives in the backend
 * and is enforced by the SDK's response type at the call site.
 */
export interface BackendAdPayload {
  readonly ad_id: string;
  readonly text: string;
  readonly url: string;
}

/**
 * Map a backend Ad payload to a browser {@link SponsoredRecommendation}, or
 * `null` when the payload fails simple defensive checks (missing id, empty text,
 * or empty url). Returning `null` lets the provider use cached real content or
 * return no recommendation rather than rendering invalid content.
 *
 * Structural only: fields are copied directly and the sponsor is the fixed
 * generic disclosure label. No semantic inference of any kind.
 */
export function toRecommendation(ad: BackendAdPayload): SponsoredRecommendation | null {
  const id = ad.ad_id?.trim();
  const message = ad.text?.trim();
  const url = ad.url?.trim();

  if (!id || !message || !url) {
    return null;
  }

  return {
    id,
    sponsor: SPONSORED_LABEL,
    message,
    url,
  };
}
