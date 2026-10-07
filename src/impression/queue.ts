import type { QueuedImpression, SentImpressionEntry, ValidImpressionEntry } from './types';

/**
 * Persistent impression storage backed by chrome.storage.local.
 *
 * Two separate stores:
 * - Queue: pending impressions waiting to be sent (retry candidates).
 * - Sent cache: dedupeKey → SentImpressionEntry for impressions already
 *   successfully delivered. Survives extension and browser restarts so a
 *   re-render after restart cannot produce a duplicate impression.
 *
 * No credentials, tokens, or sensitive data are stored here.
 */

const QUEUE_KEY = 'impressionQueue';
const SENT_KEY = 'impressionSent';
const VALID_KEY = 'impressionValid';

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export async function readQueue(): Promise<QueuedImpression[]> {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const raw = stored[QUEUE_KEY];
  return Array.isArray(raw) ? (raw as QueuedImpression[]) : [];
}

export async function writeQueue(queue: QueuedImpression[]): Promise<void> {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

export async function enqueue(item: QueuedImpression): Promise<void> {
  const queue = await readQueue();
  queue.push(item);
  await writeQueue(queue);
}

// ---------------------------------------------------------------------------
// Sent cache
// ---------------------------------------------------------------------------

export async function readSentCache(): Promise<Record<string, SentImpressionEntry>> {
  const stored = await chrome.storage.local.get(SENT_KEY);
  const raw = stored[SENT_KEY];
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, SentImpressionEntry>)
    : {};
}

export async function markSent(dedupeKey: string): Promise<void> {
  const cache = await readSentCache();
  cache[dedupeKey] = { sentAt: Date.now() };
  await chrome.storage.local.set({ [SENT_KEY]: cache });
}

/**
 * Remove sent-cache entries older than `ttlMs`. Called periodically so the
 * cache never grows without bound.
 */
export async function evictSentCache(ttlMs: number): Promise<void> {
  const cache = await readSentCache();
  const cutoff = Date.now() - ttlMs;
  const pruned: Record<string, SentImpressionEntry> = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (entry.sentAt > cutoff) {
      pruned[key] = entry;
    }
  }
  await chrome.storage.local.set({ [SENT_KEY]: pruned });
}

// ---------------------------------------------------------------------------
// Valid impressions for click gating
// ---------------------------------------------------------------------------

export async function readValidImpressions(): Promise<Record<string, ValidImpressionEntry>> {
  const stored = await chrome.storage.local.get(VALID_KEY);
  const raw = stored[VALID_KEY];
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, ValidImpressionEntry>)
    : {};
}

export async function markValidImpression(
  dedupeKey: string,
  entry: ValidImpressionEntry,
): Promise<void> {
  const cache = await readValidImpressions();
  cache[dedupeKey] = entry;
  await chrome.storage.local.set({ [VALID_KEY]: cache });
}

export async function evictValidImpressions(ttlMs: number): Promise<void> {
  const cache = await readValidImpressions();
  const cutoff = Date.now() - ttlMs;
  const pruned: Record<string, ValidImpressionEntry> = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (entry.validAt > cutoff) {
      pruned[key] = entry;
    }
  }
  await chrome.storage.local.set({ [VALID_KEY]: pruned });
}
