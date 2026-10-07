import type { SupportedPlatform } from '../adapters/types';

/**
 * Impression pipeline types.
 *
 * The render id is local deduplication/click-correlation metadata. The server
 * creates the economic impression UUID when the background requests a v2
 * challenge; queued client identifiers never authorize billing.
 *
 * The tracking_signature is time-limited (TRACKING_SIGNATURE_TTL_MS = 5 min).
 * Items that have aged past the TTL are discarded rather than retried, because
 * the backend will reject them with 400 regardless.
 */

/** A queued impression waiting to be sent to the API. */
export interface QueuedImpression {
  /** Stable identifier for the queued item; used for deduplication. */
  readonly queueId: string;
  /** Client-generated UUID persisted as the backend impression primary key. */
  readonly impressionId: string;
  /** The backend ad id. Sent as `ad_id` in the API request. */
  readonly adId: string;
  /**
   * The HMAC tracking signature from the same ad fetch. Time-limited to
   * TRACKING_SIGNATURE_TTL_MS. Items older than the TTL are discarded.
   */
  readonly trackingSignature: string;
  /**
   * Deduplication key: the rendered recommendation's impressionId. Prevents
   * duplicate observer/recovery events for one render from generating multiple
   * impressions while allowing a later render with a new native link to record
   * its own impression.
   */
  readonly dedupeKey: string;
  /** Placement that produced the rendered recommendation. */
  readonly placementId: string;
  /** Unix timestamp (ms) when the renderer confirmed the render. */
  readonly renderedAt: number;
  /** Provider where the impression occurred. */
  readonly provider: SupportedPlatform;
  /** Optional conversation/page context for SPA conversations. */
  readonly conversationId: string | null;
  /** Advertiser destination retained for click validation. */
  readonly destinationUrl: string;
  /** Continuous visible duration that made the impression valid. */
  readonly durationMs: number;
  /** Browser tab observed by the background worker during heartbeats. */
  readonly tabId?: number;
  /** Number of send attempts made so far. */
  attempts: number;
  /** Unix timestamp (ms) of the next allowed send attempt. */
  nextAttemptAt: number;
}

/**
 * A record of a successfully sent impression, persisted to prevent duplicate
 * sends across extension restarts.
 *
 * Entries expire after SENT_CACHE_TTL_MS so storage does not grow forever.
 * The cache is keyed by dedupeKey (`impressionId`).
 */
export interface SentImpressionEntry {
  /** Unix timestamp (ms) when the impression was successfully sent. */
  readonly sentAt: number;
}

export interface ValidImpressionEntry {
  readonly impressionId: string;
  readonly adId: string;
  readonly placementId: string;
  readonly provider: SupportedPlatform;
  readonly destinationUrl: string;
  readonly validAt: number;
}
