import type { AnchorPosition, PageDocument } from '../adapters/types';
import type { AnchorCandidate } from './types';

/**
 * A declarative landmark rule shared by all providers: if `selector` matches an
 * element, a candidate at `position` with `confidence` is produced. This keeps
 * the actual DOM-reading logic in one place so no provider duplicates it.
 */
export interface LandmarkRule {
  readonly id: string;
  readonly selector: string;
  readonly position: AnchorPosition;
  readonly confidence: number;
}

/**
 * Produce anchor candidates from landmark rules using read-only structural
 * queries. Presence is determined solely by `querySelector`; no element content
 * is read, nothing is inserted, no styles change, and no listeners or observers
 * are attached.
 */
export function discoverFromLandmarks(
  document: PageDocument,
  rules: readonly LandmarkRule[],
): AnchorCandidate[] {
  return rules.map((rule) => ({
    id: rule.id,
    position: rule.position,
    confidence: rule.confidence,
    present: document.querySelector(rule.selector) !== null,
  }));
}
