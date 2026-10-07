import type { Anchor, SupportedPlatform } from '../adapters/types';
import type { AnchorCandidate } from './types';

/**
 * Validate a raw candidate into a typed {@link Anchor}. A candidate is `valid`
 * only when its landmark was present and its confidence is a finite number in
 * [0, 1]; otherwise it is `rejected`. Rejected anchors are returned (not
 * dropped) so callers can rank/diagnose, but they are never treated as eligible.
 */
export function validateCandidate(platform: SupportedPlatform, candidate: AnchorCandidate): Anchor {
  const confidenceValid =
    Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1;
  const idValid = candidate.id.length > 0;

  const valid = candidate.present && confidenceValid && idValid;

  return {
    id: candidate.id,
    platform,
    position: candidate.position,
    confidence: confidenceValid ? candidate.confidence : 0,
    status: valid ? 'valid' : 'rejected',
  };
}

/** Keep only anchors that passed validation. */
export function acceptValid(anchors: readonly Anchor[]): Anchor[] {
  return anchors.filter((anchor) => anchor.status === 'valid');
}
