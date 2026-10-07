import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SponsoredProvider } from '../sponsored';
import { createImpressionService } from './service';
import type { RecordImpressionInput } from './service';
import type { QueuedImpression, SentImpressionEntry } from './types';

// ---------------------------------------------------------------------------
// Chrome API mocks
// ---------------------------------------------------------------------------

const storageData: Record<string, unknown> = {};

const chromeMock = {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(storageData, items);
      }),
    },
  },
  tabs: {
    get: vi.fn(async (_tabId: number) => ({ id: _tabId, active: true, windowId: 1 })),
  },
  windows: {
    get: vi.fn(async (_windowId: number) => ({ id: _windowId, focused: true })),
  },
};

vi.stubGlobal('chrome', chromeMock);

// ---------------------------------------------------------------------------
// SDK mock
// ---------------------------------------------------------------------------

const mockPost = vi.fn();
const mockHeartbeat = vi.fn();
const mockComplete = vi.fn();
const mockRegisterDevice = vi.fn();

vi.mock('../sdk', () => ({
  sdk: {
    v1: {
      devices: {
        register: {
          $post: (...args: unknown[]) => mockRegisterDevice(...args),
        },
      },
    },
    v2: {
      impressions: {
        challenges: { $post: (...args: unknown[]) => mockPost(...args) },
        ':impressionId': {
          heartbeats: { $post: (...args: unknown[]) => mockHeartbeat(...args) },
          complete: { $post: (...args: unknown[]) => mockComplete(...args) },
        },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Provider mock
// ---------------------------------------------------------------------------

function makeProvider(trackingSignature: string | null = 'sig:123:abc'): SponsoredProvider {
  return {
    resolve: vi.fn(),
    refresh: vi.fn(),
    rotate: vi.fn(),
    getTrackingSignature: vi.fn(() => trackingSignature),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function onlineAs(online: boolean): void {
  vi.stubGlobal('navigator', { onLine: online });
}

function mockApiSuccess(): void {
  mockPost.mockResolvedValue({
    status: 201,
    json: async () => ({
      data: { impression_id: '99999999-9999-4999-8999-999999999999', challenge: 'c'.repeat(64) },
    }),
  });
  mockHeartbeat.mockResolvedValue({ status: 200 });
  mockComplete.mockResolvedValue({ status: 201 });
}

function mockDeviceRegistrationSuccess(): void {
  mockRegisterDevice.mockResolvedValue({ status: 201 });
}

function mockDeviceRegistrationFailure(): void {
  mockRegisterDevice.mockResolvedValue({ status: 401 });
}

function mockApiTransient(): void {
  mockPost.mockResolvedValue({ status: 500 });
}

function mockApiNonRetryable(status: number): void {
  mockPost.mockResolvedValue({ status });
}

function mockApiNetworkError(): void {
  mockPost.mockRejectedValue(new Error('Network error'));
}

async function readStoredQueue(): Promise<QueuedImpression[]> {
  const stored = storageData.impressionQueue;
  return Array.isArray(stored) ? (stored as QueuedImpression[]) : [];
}

async function readStoredSentCache(): Promise<Record<string, SentImpressionEntry>> {
  const stored = storageData.impressionSent;
  return stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, SentImpressionEntry>)
    : {};
}

async function readStoredValidImpressions(): Promise<
  Record<string, { impressionId: string; validAt: number }>
> {
  const stored = storageData.impressionValid;
  return stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, { impressionId: string; validAt: number }>)
    : {};
}

function impressionInput(
  adId: string,
  placementId: string,
  tabId: number,
  impressionId = '11111111-1111-4111-8111-111111111111',
): RecordImpressionInput {
  return {
    adId,
    impressionId,
    placementId,
    tabId,
    provider: 'CHATGPT',
    conversationId: '/c/test',
    destinationUrl: 'https://advertiser.example/path',
    viewedAt: Date.now(),
    durationMs: 5_000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImpressionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 1_000 && typeof callback === 'function') {
        queueMicrotask(() => callback(...args));
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    // Reset storage between tests.
    for (const key of Object.keys(storageData)) {
      delete storageData[key];
    }
    // Re-wire storage mock to use the shared storageData object.
    chromeMock.storage.local.get.mockImplementation(async (key: string) => ({
      [key]: storageData[key],
    }));
    chromeMock.storage.local.set.mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(storageData, items);
    });
    // Tab is active in a focused window by default.
    chromeMock.tabs.get.mockResolvedValue({ id: 1, active: true, windowId: 1 });
    chromeMock.windows.get.mockResolvedValue({ id: 1, focused: true });
    onlineAs(true);
    mockDeviceRegistrationSuccess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Render once → one impression
  // -------------------------------------------------------------------------
  it('sends exactly one impression for a single render', async () => {
    mockApiSuccess();
    const service = createImpressionService(makeProvider());

    await service.record(impressionInput('ad-1', 'anchor-1', 1));

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith({
      json: expect.objectContaining({
        ad_id: 'ad-1',
        tracking_signature: 'sig:123:abc',
        provider: 'CHATGPT',
        platform: 'chatgpt',
        conversation_id: '/c/test',
      }),
    });
    expect(mockHeartbeat).toHaveBeenCalledTimes(6);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockRegisterDevice).toHaveBeenCalledWith({
      json: {
        type: 'BROWSER_EXTENSION',
        fingerprint: expect.stringMatching(/^browser-extension:/),
      },
    });
    expect(storageData.deviceFingerprint).toEqual(expect.stringMatching(/^browser-extension:/));
  });

  it('reuses the stored device fingerprint when registering before an impression', async () => {
    storageData.deviceFingerprint = 'browser-extension:existing';
    mockApiSuccess();
    const service = createImpressionService(makeProvider());

    await service.record(impressionInput('ad-1', 'anchor-1', 1));

    expect(mockRegisterDevice).toHaveBeenCalledWith({
      json: { type: 'BROWSER_EXTENSION', fingerprint: 'browser-extension:existing' },
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('keeps the impression queued when device registration fails', async () => {
    mockDeviceRegistrationFailure();
    mockApiSuccess();
    const service = createImpressionService(makeProvider());

    await service.record(impressionInput('ad-1', 'anchor-1', 1));

    expect(mockRegisterDevice).toHaveBeenCalledTimes(1);
    expect(mockPost).not.toHaveBeenCalled();
    const queue = await readStoredQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.attempts).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. Duplicate render (same session) → one impression
  // -------------------------------------------------------------------------
  it('deduplicates duplicate renders within the same session', async () => {
    mockApiSuccess();
    const service = createImpressionService(makeProvider());

    await service.record(impressionInput('ad-1', 'anchor-1', 1));
    await service.record(impressionInput('ad-1', 'anchor-1', 1));

    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('deduplicates duplicate callbacks for the same rendered impression', async () => {
    mockApiSuccess();
    const service = createImpressionService(makeProvider());

    await service.record(
      impressionInput('ad-1', 'anchor-1', 1, '11111111-1111-4111-8111-111111111111'),
    );
    await service.record(
      impressionInput('ad-1', 'anchor-1', 1, '11111111-1111-4111-8111-111111111111'),
    );

    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('keeps the valid impression entry aligned with the latest rendered tracking link', async () => {
    mockApiSuccess();
    const service = createImpressionService(makeProvider());

    await service.record(
      impressionInput('ad-1', 'anchor-1', 1, '11111111-1111-4111-8111-111111111111'),
    );
    await service.record(
      impressionInput('ad-1', 'anchor-1', 1, '22222222-2222-4222-8222-222222222222'),
    );

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost).toHaveBeenNthCalledWith(2, {
      json: expect.objectContaining({ ad_id: 'ad-1' }),
    });
    const validImpressions = await readStoredValidImpressions();
    expect(validImpressions['ad-1:anchor-1']?.impressionId).toBe(
      '99999999-9999-4999-8999-999999999999',
    );
  });

  // -------------------------------------------------------------------------
  // 3. Duplicate render (after restart) → one impression via durable cache
  // -------------------------------------------------------------------------
  it('deduplicates via durable sent cache after a simulated restart', async () => {
    mockApiSuccess();
    // First session: record and send.
    const service1 = createImpressionService(makeProvider());
    await service1.record(impressionInput('ad-1', 'anchor-1', 1));
    expect(mockPost).toHaveBeenCalledTimes(1);

    // Verify sent cache was written.
    const sentCache = await readStoredSentCache();
    expect(sentCache['11111111-1111-4111-8111-111111111111']).toBeDefined();

    // Second session (simulated restart): new service instance, same storage.
    mockPost.mockClear();
    const service2 = createImpressionService(makeProvider());
    // Allow async init to complete.
    await new Promise((r) => setTimeout(r, 0));

    await service2.record(impressionInput('ad-1', 'anchor-1', 1));
    expect(mockPost).toHaveBeenCalledTimes(0);
  });

  // -------------------------------------------------------------------------
  // 4. Offline → queue, no API call
  // -------------------------------------------------------------------------
  it('queues the impression when offline and does not call the API', async () => {
    onlineAs(false);
    const service = createImpressionService(makeProvider());

    await service.record(impressionInput('ad-1', 'anchor-1', 1));

    expect(mockPost).not.toHaveBeenCalled();
    const queue = await readStoredQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.adId).toBe('ad-1');
  });

  it('preserves concurrent queued impressions without overwriting storage', async () => {
    onlineAs(false);
    const service = createImpressionService(makeProvider());

    await Promise.all([
      service.record(
        impressionInput('ad-1', 'anchor-1', 1, '11111111-1111-4111-8111-111111111111'),
      ),
      service.record(
        impressionInput('ad-2', 'anchor-2', 1, '22222222-2222-4222-8222-222222222222'),
      ),
    ]);

    const queue = await readStoredQueue();
    expect(queue.map((item) => item.impressionId)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('does not poison dedupe state when enqueue storage fails transiently', async () => {
    onlineAs(false);
    let failNextQueueWrite = true;
    chromeMock.storage.local.set.mockImplementation(async (items: Record<string, unknown>) => {
      if (failNextQueueWrite && Object.prototype.hasOwnProperty.call(items, 'impressionQueue')) {
        failNextQueueWrite = false;
        throw new Error('storage unavailable');
      }
      Object.assign(storageData, items);
    });
    const service = createImpressionService(makeProvider());
    const input = impressionInput('ad-1', 'anchor-1', 1);

    await service.record(input);
    expect(await readStoredQueue()).toHaveLength(0);

    await service.record(input);

    expect(await readStoredQueue()).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 5. Reconnect → flush sends queued impression
  // -------------------------------------------------------------------------
  it('sends queued impressions on flush after coming back online', async () => {
    onlineAs(false);
    const service = createImpressionService(makeProvider());
    await service.record(impressionInput('ad-1', 'anchor-1', 1));
    expect(mockPost).not.toHaveBeenCalled();

    mockApiSuccess();
    onlineAs(true);
    await service.flush();

    expect(mockPost).toHaveBeenCalledTimes(1);
    const queue = await readStoredQueue();
    expect(queue).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 6. Renderer exception (no tracking_signature) → no impression
  // -------------------------------------------------------------------------
  it('drops the impression silently when no tracking_signature is available', async () => {
    const service = createImpressionService(makeProvider(null));

    await service.record(impressionInput('placeholder', 'anchor-1', 1));

    expect(mockPost).not.toHaveBeenCalled();
    const queue = await readStoredQueue();
    expect(queue).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 7. Expired tracking signature → discard on flush
  // -------------------------------------------------------------------------
  it('discards queue items whose tracking signature has expired', async () => {
    onlineAs(false);
    const service = createImpressionService(makeProvider());
    await service.record(impressionInput('ad-1', 'anchor-1', 1));

    // Manually age the queue item past the 5-minute TTL.
    const queue = await readStoredQueue();
    const first = queue[0];
    if (first) (first as { renderedAt: number }).renderedAt = Date.now() - 6 * 60 * 1000;
    storageData.impressionQueue = queue;

    mockApiSuccess();
    onlineAs(true);
    await service.flush();

    expect(mockPost).not.toHaveBeenCalled();
    const remaining = await readStoredQueue();
    expect(remaining).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 8. Non-retryable HTTP status → discard immediately
  // -------------------------------------------------------------------------
  it.each([400, 401, 403, 404])(
    'discards the impression permanently on non-retryable status %i',
    async (status) => {
      mockApiNonRetryable(status);
      const service = createImpressionService(makeProvider());

      await service.record(impressionInput('ad-1', 'anchor-1', 1));

      expect(mockPost).toHaveBeenCalledTimes(1);
      const queue = await readStoredQueue();
      expect(queue).toHaveLength(0);
    },
  );

  // -------------------------------------------------------------------------
  // 9. Retryable 500 → retry with backoff
  // -------------------------------------------------------------------------
  it('retries on a 500 response and succeeds on the second attempt', async () => {
    mockPost.mockResolvedValueOnce({ status: 500 }).mockResolvedValueOnce({
      status: 201,
      json: async () => ({
        data: { impression_id: '99999999-9999-4999-8999-999999999999', challenge: 'c'.repeat(64) },
      }),
    });
    mockHeartbeat.mockResolvedValue({ status: 200 });
    mockComplete.mockResolvedValue({ status: 201 });

    const service = createImpressionService(makeProvider());
    await service.record(impressionInput('ad-1', 'anchor-1', 1));

    // First flush: 500 → item stays in queue with nextAttemptAt in the future.
    const queueAfterFirst = await readStoredQueue();
    expect(queueAfterFirst).toHaveLength(1);
    expect(queueAfterFirst[0]?.attempts).toBe(1);

    // Force nextAttemptAt into the past so the second flush sends immediately.
    const firstItem = queueAfterFirst[0];
    if (firstItem) firstItem.nextAttemptAt = 0;
    storageData.impressionQueue = queueAfterFirst;

    await service.flush();

    expect(mockPost).toHaveBeenCalledTimes(2);
    const queueAfterSecond = await readStoredQueue();
    expect(queueAfterSecond).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 10. Network error → retry
  // -------------------------------------------------------------------------
  it('retries on a network error', async () => {
    mockApiNetworkError();
    const service = createImpressionService(makeProvider());
    await service.record(impressionInput('ad-1', 'anchor-1', 1));

    const queue = await readStoredQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.attempts).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 11. Queue survives restart (persistence)
  // -------------------------------------------------------------------------
  it('queue persists across a simulated extension restart', async () => {
    onlineAs(false);
    const service1 = createImpressionService(makeProvider());
    await service1.record(impressionInput('ad-1', 'anchor-1', 1));

    const queueBefore = await readStoredQueue();
    expect(queueBefore).toHaveLength(1);

    // Simulate restart: new service instance reads from the same storage.
    mockApiSuccess();
    onlineAs(true);
    const service2 = createImpressionService(makeProvider());
    await service2.flush();

    expect(mockPost).toHaveBeenCalledTimes(1);
    const queueAfter = await readStoredQueue();
    expect(queueAfter).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 12. Closed tab → no impression recorded
  // -------------------------------------------------------------------------
  it('drops the impression when the originating tab no longer exists', async () => {
    chromeMock.tabs.get.mockRejectedValue(new Error('No tab with id: 99'));
    const service = createImpressionService(makeProvider());

    await service.record(impressionInput('ad-1', 'anchor-1', 99));

    expect(mockPost).not.toHaveBeenCalled();
    const queue = await readStoredQueue();
    expect(queue).toHaveLength(0);
  });

  it('drops the impression when the originating tab is not active in the focused window', async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 1, active: false, windowId: 1 });
    mockApiSuccess();
    const service = createImpressionService(makeProvider());

    await service.record(impressionInput('ad-1', 'anchor-1', 1));

    expect(mockPost).not.toHaveBeenCalled();
    let queue = await readStoredQueue();
    expect(queue).toHaveLength(0);

    chromeMock.tabs.get.mockResolvedValue({ id: 1, active: true, windowId: 1 });
    chromeMock.windows.get.mockResolvedValue({ id: 1, focused: false });
    await service.record(
      impressionInput('ad-1', 'anchor-1', 1, '22222222-2222-4222-8222-222222222222'),
    );

    expect(mockPost).not.toHaveBeenCalled();
    queue = await readStoredQueue();
    expect(queue).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 13. Max attempts → discard on sweep
  // -------------------------------------------------------------------------
  it('discards items that have exhausted all retry attempts during sweep', async () => {
    onlineAs(false);
    const service = createImpressionService(makeProvider());
    await service.record(impressionInput('ad-1', 'anchor-1', 1));

    // Exhaust attempts.
    const queue = await readStoredQueue();
    const first = queue[0];
    if (first) first.attempts = 5;
    storageData.impressionQueue = queue;

    await service.sweep();

    const remaining = await readStoredQueue();
    expect(remaining).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 14. Sent cache eviction on sweep
  // -------------------------------------------------------------------------
  it('evicts old sent-cache entries during sweep', async () => {
    mockApiSuccess();
    const service = createImpressionService(makeProvider());
    await service.record(impressionInput('ad-1', 'anchor-1', 1));

    // Age the sent-cache entry past the 10-minute TTL.
    const sentCache = await readStoredSentCache();
    const entry = sentCache['11111111-1111-4111-8111-111111111111'];
    if (entry) (entry as { sentAt: number }).sentAt = Date.now() - 11 * 60 * 1000;
    storageData.impressionSent = sentCache;

    await service.sweep();

    const afterSweep = await readStoredSentCache();
    expect(afterSweep['11111111-1111-4111-8111-111111111111']).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 15. Initialization Race (Regression)
  // -------------------------------------------------------------------------
  it('awaits initialization before processing record() to prevent dedupe race', async () => {
    let resolveInit!: (value: unknown) => void;
    const initDelay = new Promise<unknown>((r) => {
      resolveInit = r;
    });

    const executionOrder: string[] = [];

    // Hook storage to track ordering and delay initialization
    const originalGet = chromeMock.storage.local.get.getMockImplementation();
    if (!originalGet) throw new Error('originalGet missing');
    let readQueueCallCount = 0;
    chromeMock.storage.local.get.mockImplementation(async (keys) => {
      if (keys === 'impressionSent') {
        executionOrder.push('init-read-sent-cache-start');
        await initDelay;
        executionOrder.push('init-read-sent-cache-end');
      }
      if (keys === 'impressionQueue') {
        readQueueCallCount++;
        if (readQueueCallCount > 1) {
          executionOrder.push('record-read-queue');
        }
      }
      return originalGet(keys);
    });

    const originalSet = chromeMock.storage.local.set.getMockImplementation();
    if (!originalSet) throw new Error('originalSet missing');
    chromeMock.storage.local.set.mockImplementation(async (items) => {
      executionOrder.push('record-write-queue');
      return originalSet(items);
    });

    // Pre-populate storage with a sent cache item so the dedupe key is seeded during init
    storageData.impressionSent = {
      '11111111-1111-4111-8111-111111111111': { sentAt: Date.now() },
    };

    const service = createImpressionService(makeProvider());

    // Ensure the init process has started
    await new Promise((r) => setTimeout(r, 0));
    expect(executionOrder).toContain('init-read-sent-cache-start');

    // Call record() immediately (it should block)
    let recordFinished = false;
    const recordPromise = service.record(impressionInput('ad-race', 'anchor-race', 1)).then(() => {
      executionOrder.push('record-finished');
      recordFinished = true;
    });

    // Verify record() is blocked and hasn't tried to enqueue or even read the queue
    await new Promise((r) => setTimeout(r, 20));
    expect(recordFinished).toBe(false);
    expect(executionOrder).not.toContain('record-read-queue');
    expect(executionOrder).not.toContain('record-write-queue');

    // Unblock initialization
    resolveInit(undefined);
    await recordPromise;

    // Verify strict ordering: init completes -> record resumes and finishes (without writing)
    expect(executionOrder).toEqual([
      'init-read-sent-cache-start',
      'init-read-sent-cache-end',
      'record-finished',
    ]);

    // Verify it was correctly deduplicated (no write happened)
    const queue = await readStoredQueue();
    expect(queue).toHaveLength(0);
  });
});
