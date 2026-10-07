import type { SupportedPlatform } from '../adapters/types';
import { sdk } from '../sdk';
import type { SponsoredProvider } from '../sponsored';
import { getOrCreateDeviceFingerprint } from '../storage';
import {
  enqueue,
  evictSentCache,
  evictValidImpressions,
  markSent,
  markValidImpression,
  readQueue,
  readSentCache,
  readValidImpressions,
  writeQueue,
} from './queue';
import type { QueuedImpression, ValidImpressionEntry } from './types';

/**
 * Impression Service.
 *
 * Background-only. Owns the full impression lifecycle:
 *
 * Deduplication — two layers:
 *   1. In-memory Set for the current worker session (fast path).
 *   2. Durable sent cache in chrome.storage.local (survives restarts). A
 *      successfully sent impression is written to the sent cache before the
 *      queue item is removed, so a re-render after an extension or browser
 *      restart cannot produce a duplicate.
 *
 * Persistence — the retry queue survives extension and browser restarts via
 *   chrome.storage.local.
 *
 * Retry — transient failures (network, 5xx, timeout) are retried with
 *   exponential backoff ±20% jitter. Non-transient failures (400, 401, 403,
 *   404) are discarded immediately.
 *
 * TTL eviction — tracking_signature expires after TRACKING_SIGNATURE_TTL_MS
 *   (5 min). Items older than the TTL are discarded rather than retried.
 *
 * Offline — items remain queued until the browser is online, then flush.
 *
 * Periodic sweep — a periodic alarm evicts expired queue items and old sent-
 *   cache entries so storage never grows without bound.
 *
 * The service never touches the renderer, the popup, or the content script.
 * It communicates only with the backend via the canonical SDK instance.
 */

export interface ImpressionService {
  /**
   * Record that a recommendation was successfully rendered for a verified tab.
   * Retrieves the tracking_signature from the SponsoredProvider, deduplicates
   * against both the in-memory set and the durable sent cache, enqueues, and
   * attempts an immediate send. Never throws.
   *
   * If the provider has no tracking_signature for the ad (evicted cache,
   * unknown id, or no real ad), the impression is silently dropped — the backend
   * would reject it.
   */
  record(input: RecordImpressionInput): Promise<void>;

  /**
   * Flush all queued impressions that are ready to send. Called on browser
   * online events, extension startup, and service-worker wake. Never throws.
   */
  flush(): Promise<void>;

  /**
   * Evict expired entries from the retry queue and the sent cache. Called by
   * the periodic alarm so storage never grows without bound. Never throws.
   */
  sweep(): Promise<void>;
}

export interface RecordImpressionInput {
  readonly adId: string;
  readonly impressionId: string;
  readonly placementId: string;
  readonly tabId: number;
  readonly provider: SupportedPlatform;
  readonly conversationId: string | null;
  readonly destinationUrl: string;
  readonly viewedAt: number;
  readonly durationMs: number;
}

/** Tracking signature TTL matches the backend constant (5 minutes). */
const TRACKING_SIGNATURE_TTL_MS = 5 * 60 * 1000;

/**
 * How long a sent-impression entry is retained in the durable cache.
 * Long enough to cover a full browser session; short enough to avoid
 * unbounded growth. 10 minutes gives comfortable headroom beyond the
 * 5-minute tracking-signature TTL.
 */
const SENT_CACHE_TTL_MS = 10 * 60 * 1000;
const VALID_IMPRESSION_TTL_MS = 60 * 60 * 1000;

/** Maximum send attempts before an item is permanently discarded. */
const MAX_ATTEMPTS = 5;

/** Base delay for exponential backoff (ms). */
const BASE_BACKOFF_MS = 2_000;

/** Maximum backoff before jitter (ms). */
const MAX_BACKOFF_MS = 32_000;

/** Jitter fraction applied symmetrically around the base delay (±20%). */
const JITTER_FACTOR = 0.2;

/** HTTP status codes that must not be retried. */
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 409]);

function buildDedupeKey(impressionId: string): string {
  return impressionId;
}

function buildPlacementKey(adId: string, placementId: string): string {
  return `${adId}:${placementId}`;
}

function buildQueueId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function backoffDelay(attempts: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
  // ±20% uniform jitter prevents thundering-herd when many clients reconnect.
  const jitter = base * JITTER_FACTOR * (2 * Math.random() - 1);
  return Math.max(0, Math.round(base + jitter));
}

function isExpired(item: QueuedImpression): boolean {
  return Date.now() - item.renderedAt > TRACKING_SIGNATURE_TTL_MS;
}

/**
 * Verify the tab still exists and is active in a focused window before recording
 * an impression. The content script owns the primary visibility lifecycle; this
 * background check prevents stale messages from closed, background, or unfocused
 * tabs from reaching the backend.
 */
async function tabCanRecord(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || tab.windowId === undefined) {
      return false;
    }
    const windowInfo = await chrome.windows.get(tab.windowId);
    return windowInfo.focused === true;
  } catch {
    return false;
  }
}

/**
 * Attempt to send one impression to the API.
 * Returns the server-owned impression id on success, null on transient failure, and throws on
 * non-retryable failure so the caller can discard the item.
 */
async function trySend(
  item: QueuedImpression,
  ensureDeviceRegistered: () => Promise<boolean>,
): Promise<string | null> {
  let challengeIssued = false;
  try {
    const deviceRegistered = await ensureDeviceRegistered();
    if (!deviceRegistered) {
      return null;
    }

    const response = await sdk.v2.impressions.challenges.$post({
      json: {
        ad_id: item.adId,
        tracking_signature: item.trackingSignature,
        provider: item.provider,
        platform: item.provider.toLowerCase() as Lowercase<typeof item.provider>,
        conversation_id: item.conversationId,
      },
    });

    if (response.status === 201) {
      challengeIssued = true;
      const envelope = await response.json();
      const impressionId = envelope.data.impression_id;
      const challenge = envelope.data.challenge;
      const heartbeatCount = Math.max(6, Math.ceil(item.durationMs / 1_000) + 1);
      for (let sequence = 0; sequence < heartbeatCount; sequence += 1) {
        if (sequence > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
        const heartbeat = await sdk.v2.impressions[':impressionId'].heartbeats.$post({
          param: { impressionId },
          json: {
            challenge,
            sequence,
            visible: item.tabId === undefined ? true : await tabCanRecord(item.tabId),
          },
        });
        if (heartbeat.status !== 200) throw new Error(`non_retryable:${heartbeat.status}`);
      }
      const complete = await sdk.v2.impressions[':impressionId'].complete.$post({
        param: { impressionId },
        json: { challenge },
      });
      if (complete.status === 201) return impressionId;
      throw new Error(`non_retryable:${complete.status}`);
    }

    if (NON_RETRYABLE_STATUSES.has(response.status)) {
      throw new Error(`non_retryable:${response.status}`);
    }

    // 5xx or unexpected: transient, schedule retry.
    return null;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('non_retryable:')) {
      throw error;
    }
    if (challengeIssued) throw new Error('non_retryable:evidence_incomplete');
    // Network error / timeout: transient.
    return null;
  }
}

async function registerDevice(): Promise<boolean> {
  try {
    const fingerprint = await getOrCreateDeviceFingerprint();
    const response = await sdk.v1.devices.register.$post({
      json: { type: 'BROWSER_EXTENSION', fingerprint },
    });

    return response.status === 200 || response.status === 201;
  } catch {
    return false;
  }
}

export function createImpressionService(provider: SponsoredProvider): ImpressionService {
  /**
   * In-memory deduplication set for the current worker session.
   *
   * Seeded on startup from both the retry queue (pending items) and the durable
   * sent cache (already-delivered items). This means a re-render after an
   * extension restart is caught by the in-memory set on the first record() call
   * within the same worker lifetime, and by the durable cache on subsequent
   * restarts.
   */
  const sessionDedupeKeys = new Set<string>();
  let deviceRegistrationPromise: Promise<boolean> | null = null;

  async function ensureDeviceRegistered(): Promise<boolean> {
    deviceRegistrationPromise ??= registerDevice();
    const registered = await deviceRegistrationPromise;
    if (!registered) {
      deviceRegistrationPromise = null;
    }
    return registered;
  }

  async function initSessionDedupeKeys(): Promise<void> {
    const [queue, sentCache] = await Promise.all([readQueue(), readSentCache()]);
    for (const item of queue) {
      sessionDedupeKeys.add(item.dedupeKey);
    }
    for (const key of Object.keys(sentCache)) {
      sessionDedupeKeys.add(key);
    }
  }

  const initPromise = initSessionDedupeKeys();

  let isFlushing = false;
  let flushRequested = false;
  let operationChain: Promise<void> = Promise.resolve();

  function runSerialized(operation: () => Promise<void>): Promise<void> {
    const run = operationChain.catch(() => undefined).then(operation);
    operationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function flushNow(): Promise<void> {
    await initPromise;
    if (isFlushing) {
      flushRequested = true;
      return;
    }
    isFlushing = true;

    try {
      do {
        flushRequested = false;
        try {
          const queue = await readQueue();
          const now = Date.now();
          const remaining: QueuedImpression[] = [];

          for (const item of queue) {
            if (isExpired(item) || item.attempts >= MAX_ATTEMPTS) {
              sessionDedupeKeys.delete(item.dedupeKey);
              continue;
            }

            if (item.nextAttemptAt > now) {
              remaining.push(item);
              continue;
            }

            try {
              const sent = await trySend(item, ensureDeviceRegistered);

              if (sent) {
                // Write to the durable sent cache before removing from the queue so
                // a crash between the two operations leaves the item in the queue
                // (safe to retry) rather than lost from both stores.
                await markSent(item.dedupeKey);
                await markValidImpression(buildPlacementKey(item.adId, item.placementId), {
                  impressionId: sent,
                  adId: item.adId,
                  placementId: item.placementId,
                  provider: item.provider,
                  destinationUrl: item.destinationUrl,
                  validAt: Date.now(),
                });
                sessionDedupeKeys.delete(item.dedupeKey);
                continue;
              }

              item.attempts += 1;
              item.nextAttemptAt = now + backoffDelay(item.attempts);
              remaining.push(item);
            } catch {
              // Non-retryable: discard permanently.
              sessionDedupeKeys.delete(item.dedupeKey);
            }
          }

          await writeQueue(remaining);
        } catch {
          // Never propagate: flush must never disrupt the worker.
        }
      } while (flushRequested);
    } finally {
      isFlushing = false;
    }
  }

  async function sweepNow(): Promise<void> {
    await initPromise;
    try {
      // Evict expired queue items.
      const queue = await readQueue();
      const pruned = queue.filter((item) => !isExpired(item) && item.attempts < MAX_ATTEMPTS);
      if (pruned.length !== queue.length) {
        for (const item of queue) {
          if (!pruned.includes(item)) {
            sessionDedupeKeys.delete(item.dedupeKey);
          }
        }
        await writeQueue(pruned);
      }

      // Evict old sent-cache entries.
      await evictSentCache(SENT_CACHE_TTL_MS);
      await evictValidImpressions(VALID_IMPRESSION_TTL_MS);
    } catch {
      // Never propagate.
    }
  }

  async function recordNow(input: RecordImpressionInput): Promise<void> {
    await initPromise;
    let dedupeKey: string | null = null;
    let enqueued = false;

    try {
      const { adId, placementId, tabId } = input;
      dedupeKey = buildDedupeKey(input.impressionId);

      // Fast path: in-memory check (covers current session and seeded history).
      if (sessionDedupeKeys.has(dedupeKey)) {
        return;
      }

      // Durable check: covers the gap between a successful send and the next
      // worker restart where the in-memory set has not yet been seeded.
      const sentCache = await readSentCache();
      if (sentCache[dedupeKey]) {
        sessionDedupeKeys.add(dedupeKey);
        return;
      }

      // Defense in depth: the originating tab must still be active and focused
      // when the background worker records the impression.
      if (!(await tabCanRecord(tabId))) {
        return;
      }

      const trackingSignature = provider.getTrackingSignature(adId);
      if (!trackingSignature) {
        // Placeholder recommendation: no valid signature, backend would reject.
        return;
      }

      sessionDedupeKeys.add(dedupeKey);

      const item: QueuedImpression = {
        queueId: buildQueueId(),
        impressionId: input.impressionId,
        adId,
        trackingSignature,
        dedupeKey,
        placementId,
        renderedAt: input.viewedAt,
        provider: input.provider,
        conversationId: input.conversationId,
        destinationUrl: input.destinationUrl,
        durationMs: input.durationMs,
        tabId,
        attempts: 0,
        nextAttemptAt: 0,
      };

      await enqueue(item);
      enqueued = true;

      if (navigator.onLine) {
        await flushNow();
      }
    } catch {
      if (dedupeKey && !enqueued) {
        sessionDedupeKeys.delete(dedupeKey);
      }
      // Never propagate: impression recording must never disrupt the pipeline.
    }
  }

  return {
    record(input) {
      return runSerialized(() => recordNow(input));
    },
    flush() {
      return runSerialized(flushNow);
    },
    sweep() {
      return runSerialized(sweepNow);
    },
  };
}

export async function getValidImpression(
  adId: string,
  placementId: string,
): Promise<ValidImpressionEntry | null> {
  const dedupeKey = buildPlacementKey(adId, placementId);
  const cache = await readValidImpressions();
  return cache[dedupeKey] ?? null;
}
