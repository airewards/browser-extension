import type { SponsoredRecommendation } from './types';

/**
 * Placeholder sponsored content.
 *
 * This is the lowest-priority fallback: the pipeline renders it only when the
 * backend is unavailable AND no cached recommendation exists (see the render
 * controller's fallback order: fresh API data → cached recommendation → this
 * placeholder). It guarantees the recommendation area never disappears and never
 * breaks. It is deliberately a real-looking example using the platform's own
 * sponsor so nothing impersonates a third party. The renderer and layout are
 * unchanged whether the content is fresh, cached, or this placeholder — only the
 * text differs.
 */
export const PLACEHOLDER_RECOMMENDATION: SponsoredRecommendation = {
  id: 'placeholder',
  sponsor: 'AIRewards',
  message: 'Review this answer and earn 8 pts',
  url: 'https://airewards.example',
};
