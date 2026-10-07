import type { AnchorPosition, PageDocument, SupportedPlatform } from '../adapters/types';

/**
 * Anchor provider layer.
 *
 * Anchor discovery is deliberately separated from the platform adapters: an
 * adapter answers "which platform and is it ready?", a provider answers "where
 * could an advertisement go?". Providers are independent of adapters — they
 * import only shared data types, never adapter logic.
 *
 * Discovery is strictly read-only. Providers query the DOM for stable structural
 * landmarks and return candidate anchors. They never insert elements, mutate
 * styles, attach listeners, or create observers.
 */

/**
 * A raw candidate produced by a provider before validation. Confidence is the
 * provider's self-assessed likelihood that the location is a safe, stable
 * insertion point.
 */
export interface AnchorCandidate {
  readonly id: string;
  readonly position: AnchorPosition;
  readonly confidence: number;
  /**
   * Whether the structural landmark this candidate describes was actually found
   * in the DOM. Providers set this from read-only queries; validation rejects
   * candidates that were not present.
   */
  readonly present: boolean;
}

export interface AnchorProvider {
  readonly platform: SupportedPlatform;
  /**
   * Inspect the document (read-only) and return raw anchor candidates for this
   * platform. Must not insert, mutate, attach listeners, or observe.
   */
  discover(document: PageDocument): AnchorCandidate[];
}
