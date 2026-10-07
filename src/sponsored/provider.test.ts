import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSponsoredProvider } from './provider';
import type { SponsoredProviderDiagnosticEvent } from './provider';

const currentAdGet = vi.hoisted(() => vi.fn());

vi.mock('../sdk', () => ({
  sdk: {
    v1: {
      ads: {
        current: {
          $get: currentAdGet,
        },
      },
    },
  },
}));

vi.mock('../config', () => ({
  config: {
    apiBaseUrl: 'http://localhost:3001',
  },
}));

function adResponse(id: string) {
  return {
    status: 200,
    json: async () => ({
      data: {
        ad_id: id,
        text: `Recommendation ${id}`,
        url: 'https://advertiser.example/path',
        tracking_signature: `sig-${id}`,
      },
    }),
  };
}

function collectEvents(): SponsoredProviderDiagnosticEvent[] {
  return [];
}

const REQUIRED_DETAIL_KEYS = [
  'provider',
  'pathname',
  'cacheKey',
  'recommendationId',
  'impressionId',
  'placementId',
  'storageBackend',
  'cacheSize',
  'cacheAge',
  'expirationTime',
  'failureReason',
] as const;

function expectRequiredDiagnosticFields(events: readonly SponsoredProviderDiagnosticEvent[]): void {
  for (const event of events) {
    expect(event.timestamp).toEqual(expect.any(String));
    expect(event.details).toBeDefined();
    for (const key of REQUIRED_DETAIL_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(event.details, key)).toBe(true);
    }
  }
}

describe('SponsoredProvider rotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-27T21:00:00.000Z'));
  });

  it('bypasses the cache TTL for scheduled rotation', async () => {
    currentAdGet.mockResolvedValueOnce(adResponse('11111111-1111-4111-8111-111111111111'));
    currentAdGet.mockResolvedValueOnce(adResponse('22222222-2222-4222-8222-222222222222'));
    const provider = createSponsoredProvider();

    await expect(provider.resolve()).resolves.toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
    });
    await expect(provider.rotate()).resolves.toMatchObject({
      changed: true,
      content: { id: '22222222-2222-4222-8222-222222222222' },
    });

    expect(currentAdGet).toHaveBeenCalledTimes(2);
  });

  it('treats a fresh scheduled rotation as changed even when inventory returns the same ad id', async () => {
    currentAdGet.mockResolvedValueOnce(adResponse('11111111-1111-4111-8111-111111111111'));
    currentAdGet.mockResolvedValueOnce(adResponse('11111111-1111-4111-8111-111111111111'));
    const provider = createSponsoredProvider();

    await provider.resolve();

    await expect(provider.rotate()).resolves.toMatchObject({
      changed: true,
      content: { id: '11111111-1111-4111-8111-111111111111' },
    });
    expect(currentAdGet).toHaveBeenCalledTimes(2);
  });

  it('excludes the three most recently rendered ads and rolls the history forward', async () => {
    const adIds = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ];
    for (const adId of adIds) {
      currentAdGet.mockResolvedValueOnce(adResponse(adId));
    }
    const provider = createSponsoredProvider();

    for (let index = 0; index < adIds.length; index += 1) {
      const recommendation =
        index === 0 ? await provider.resolve() : (await provider.rotate()).content;
      provider.recordRenderedAd?.(recommendation?.id ?? '');
    }

    expect(currentAdGet.mock.calls).toEqual([
      [{ query: {} }],
      [{ query: { exclude_ads: adIds.slice(0, 1).join(',') } }],
      [{ query: { exclude_ads: adIds.slice(0, 2).join(',') } }],
      [{ query: { exclude_ads: adIds.slice(0, 3).join(',') } }],
      [{ query: { exclude_ads: adIds.slice(1, 4).join(',') } }],
    ]);
  });

  it('does not rotate stale cached fallback content when the backend is unavailable', async () => {
    currentAdGet.mockResolvedValueOnce(adResponse('11111111-1111-4111-8111-111111111111'));
    currentAdGet.mockResolvedValueOnce({ status: 500 });
    currentAdGet.mockResolvedValueOnce({ status: 500 });
    const provider = createSponsoredProvider();

    await provider.resolve();

    await expect(provider.rotate()).resolves.toMatchObject({
      changed: false,
      content: { id: '11111111-1111-4111-8111-111111111111' },
    });
    expect(currentAdGet).toHaveBeenCalledTimes(3);
  });

  it('does not resolve a browser-generated placeholder when no backend recommendation is available', async () => {
    currentAdGet.mockResolvedValueOnce({ status: 500 });
    currentAdGet.mockResolvedValueOnce({ status: 500 });
    const provider = createSponsoredProvider();

    await expect(provider.resolve()).resolves.toBeNull();

    expect(currentAdGet).toHaveBeenCalledTimes(2);
  });

  it('records the reason a backend request failed before falling back to no recommendation', async () => {
    const events = collectEvents();
    currentAdGet.mockResolvedValueOnce({ status: 401 });
    const provider = createSponsoredProvider({
      onDiagnosticEvent(event) {
        events.push(event);
      },
    });

    await expect(provider.resolve()).resolves.toBeNull();

    expect(events.map((event) => event.name)).toEqual([
      'CACHE_HYDRATED',
      'REQUEST_STARTED',
      'REQUEST_COMPLETED',
      'REQUEST_FAILED',
      'CACHE_READ_STARTED',
      'CACHE_READ_COMPLETED',
      'CACHE_LOOKUP',
      'CACHE_MISS',
      'FALLBACK_SELECTED',
    ]);
    expectRequiredDiagnosticFields(events);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'REQUEST_COMPLETED',
          details: expect.objectContaining({ status: 401 }),
        }),
        expect.objectContaining({
          name: 'REQUEST_FAILED',
          details: expect.objectContaining({ reason: 'http_401' }),
        }),
        expect.objectContaining({
          name: 'CACHE_MISS',
          details: expect.objectContaining({
            storageBackend: 'memory',
            cacheValidity: 'empty',
            cacheMissReason: 'cache_empty',
          }),
        }),
        expect.objectContaining({
          name: 'FALLBACK_SELECTED',
          details: expect.objectContaining({
            source: 'none',
            selectedRecommendationSource: 'none',
            reason: 'http_401',
          }),
        }),
      ]),
    );
  });

  it('records backend success with request URL and cache write diagnostics', async () => {
    const events = collectEvents();
    currentAdGet.mockResolvedValueOnce(adResponse('11111111-1111-4111-8111-111111111111'));
    const provider = createSponsoredProvider({
      onDiagnosticEvent(event) {
        events.push(event);
      },
    });

    await expect(
      provider.resolve({
        provider: 'CHATGPT',
        pathname: '/c/thread-1',
        placementId: 'chatgpt-below-input',
        reason: 'initial',
      }),
    ).resolves.toMatchObject({ id: '11111111-1111-4111-8111-111111111111' });

    expect(currentAdGet).toHaveBeenCalledWith({ query: { platform: 'chatgpt' } });

    expect(events).toEqual([
      expect.objectContaining({
        name: 'CACHE_HYDRATED',
        details: expect.objectContaining({
          storageBackend: 'memory',
          cacheSize: 0,
          cacheValidity: 'empty',
          hydrationResult: 'memory_cache_initialized_empty',
        }),
      }),
      expect.objectContaining({
        name: 'REQUEST_STARTED',
        details: expect.objectContaining({
          provider: 'CHATGPT',
          pathname: '/c/thread-1',
          requestUrl: 'http://localhost:3001/v1/ads/current?platform=chatgpt',
          placementId: 'chatgpt-below-input',
        }),
      }),
      expect.objectContaining({
        name: 'REQUEST_COMPLETED',
        details: expect.objectContaining({
          responseStatus: 200,
          requestUrl: 'http://localhost:3001/v1/ads/current?platform=chatgpt',
        }),
      }),
      expect.objectContaining({
        name: 'CACHE_WRITE_STARTED',
        details: expect.objectContaining({
          cacheKey: 'current-recommendation',
          storageBackend: 'memory',
          cacheSize: 0,
          nextCacheSize: 1,
          nextRecommendationId: '11111111-1111-4111-8111-111111111111',
        }),
      }),
      expect.objectContaining({
        name: 'CACHE_SERIALIZED',
        details: expect.objectContaining({
          recommendationId: '11111111-1111-4111-8111-111111111111',
          storageBackend: 'memory',
          cacheSize: 1,
          serializationSuccessful: true,
          parsedRecommendation: {
            id: '11111111-1111-4111-8111-111111111111',
            sponsor: 'Sponsored',
            message: 'Recommendation 11111111-1111-4111-8111-111111111111',
            url: 'https://advertiser.example/path',
          },
        }),
      }),
      expect.objectContaining({
        name: 'CACHE_WRITE_COMPLETED',
        details: expect.objectContaining({
          recommendationId: '11111111-1111-4111-8111-111111111111',
          storageBackend: 'memory',
          cacheSize: 1,
          cacheAge: 0,
          expirationTime: '2026-06-27T21:05:00.000Z',
          writeSuccessful: true,
          writeFailureReason: null,
        }),
      }),
      expect.objectContaining({
        name: 'RECOMMENDATION_SELECTED',
        details: expect.objectContaining({
          selectedRecommendationSource: 'backend',
          recommendationId: '11111111-1111-4111-8111-111111111111',
          cacheKey: 'current-recommendation',
          cacheWritten: true,
          storageBackend: 'memory',
          cacheSize: 1,
          cacheValidity: 'valid',
        }),
      }),
    ]);
    expectRequiredDiagnosticFields(events);
  });

  it('records cache lookup and cache miss before selecting no fallback recommendation', async () => {
    const events = collectEvents();
    currentAdGet.mockResolvedValueOnce({ status: 500 });
    currentAdGet.mockResolvedValueOnce({ status: 500 });
    const provider = createSponsoredProvider({
      onDiagnosticEvent(event) {
        events.push(event);
      },
    });

    await expect(
      provider.resolve({
        provider: 'CLAUDE',
        pathname: '/chat/thread-1',
        placementId: 'claude-below-input',
        reason: 'initial',
      }),
    ).resolves.toBeNull();

    expect(events.map((event) => event.name)).toEqual([
      'CACHE_HYDRATED',
      'REQUEST_STARTED',
      'REQUEST_COMPLETED',
      'REQUEST_FAILED',
      'REQUEST_STARTED',
      'REQUEST_COMPLETED',
      'REQUEST_FAILED',
      'CACHE_READ_STARTED',
      'CACHE_READ_COMPLETED',
      'CACHE_LOOKUP',
      'CACHE_MISS',
      'FALLBACK_SELECTED',
    ]);
    expectRequiredDiagnosticFields(events);
    expect(events.at(-3)).toMatchObject({
      name: 'CACHE_LOOKUP',
      details: expect.objectContaining({
        cacheKey: 'current-recommendation',
        cacheContents: null,
        cacheAgeMs: null,
        storageBackend: 'memory',
        cacheSize: 0,
        cacheValidity: 'empty',
      }),
    });
    expect(events.at(-2)).toMatchObject({
      name: 'CACHE_MISS',
      details: expect.objectContaining({
        cacheMissReason: 'cache_empty',
        fallbackReason: 'http_500',
      }),
    });
    expect(events.at(-1)).toMatchObject({
      name: 'FALLBACK_SELECTED',
      details: expect.objectContaining({
        source: 'none',
        selectedRecommendationSource: 'none',
        reason: 'http_500',
      }),
    });
  });

  it('records cache hit and returns cached recommendation when backend fails', async () => {
    const events = collectEvents();
    currentAdGet.mockResolvedValueOnce(adResponse('11111111-1111-4111-8111-111111111111'));
    currentAdGet.mockResolvedValueOnce({ status: 500 });
    currentAdGet.mockResolvedValueOnce({ status: 500 });
    const provider = createSponsoredProvider({
      onDiagnosticEvent(event) {
        events.push(event);
      },
    });

    await provider.resolve({ provider: 'CHATGPT', pathname: '/c/thread-1', reason: 'initial' });
    events.length = 0;

    await expect(
      provider.resolve({
        provider: 'CHATGPT',
        pathname: '/c/thread-1',
        placementId: 'chatgpt-below-input',
        reason: 'initial',
      }),
    ).resolves.toMatchObject({ id: '11111111-1111-4111-8111-111111111111' });

    expect(events.map((event) => event.name)).toEqual([
      'REQUEST_STARTED',
      'REQUEST_COMPLETED',
      'REQUEST_FAILED',
      'REQUEST_STARTED',
      'REQUEST_COMPLETED',
      'REQUEST_FAILED',
      'CACHE_READ_STARTED',
      'CACHE_READ_COMPLETED',
      'CACHE_DESERIALIZED',
      'CACHE_LOOKUP',
      'CACHE_HIT',
      'FALLBACK_SELECTED',
      'RECOMMENDATION_SELECTED',
    ]);
    expectRequiredDiagnosticFields(events);
    expect(events.at(-3)).toMatchObject({
      name: 'CACHE_HIT',
      details: expect.objectContaining({
        cacheKey: 'current-recommendation',
        storageBackend: 'memory',
        cacheSize: 1,
        cacheValidity: 'valid',
        recommendationId: '11111111-1111-4111-8111-111111111111',
      }),
    });
    expect(events.at(-1)).toMatchObject({
      name: 'RECOMMENDATION_SELECTED',
      details: expect.objectContaining({
        selectedRecommendationSource: 'cache',
        recommendationId: '11111111-1111-4111-8111-111111111111',
      }),
    });
  });

  it('records cache invalidation when a later backend success replaces the cached recommendation', async () => {
    const events = collectEvents();
    currentAdGet.mockResolvedValueOnce(adResponse('11111111-1111-4111-8111-111111111111'));
    currentAdGet.mockResolvedValueOnce(adResponse('22222222-2222-4222-8222-222222222222'));
    const provider = createSponsoredProvider({
      onDiagnosticEvent(event) {
        events.push(event);
      },
    });

    await provider.resolve({ provider: 'CHATGPT', pathname: '/c/thread-1', reason: 'initial' });
    events.length = 0;

    await expect(
      provider.rotate({
        provider: 'CHATGPT',
        pathname: '/c/thread-1',
        placementId: 'chatgpt-below-input',
        reason: 'rotation',
      }),
    ).resolves.toMatchObject({
      changed: true,
      content: { id: '22222222-2222-4222-8222-222222222222' },
    });

    expect(events.map((event) => event.name)).toEqual([
      'REQUEST_STARTED',
      'REQUEST_COMPLETED',
      'CACHE_WRITE_STARTED',
      'CACHE_INVALIDATED',
      'CACHE_SERIALIZED',
      'CACHE_WRITE_COMPLETED',
      'RECOMMENDATION_SELECTED',
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'CACHE_INVALIDATED',
          details: expect.objectContaining({
            storageBackend: 'memory',
            cacheSize: 1,
            invalidatedRecommendationId: '11111111-1111-4111-8111-111111111111',
            replacementRecommendationId: '22222222-2222-4222-8222-222222222222',
            failureReason: 'cache_replaced',
          }),
        }),
        expect.objectContaining({
          name: 'CACHE_WRITE_COMPLETED',
          details: expect.objectContaining({
            recommendationId: '22222222-2222-4222-8222-222222222222',
            writeSuccessful: true,
          }),
        }),
      ]),
    );
    expectRequiredDiagnosticFields(events);
  });

  it('records expired cache as a cache miss and returns null', async () => {
    const events = collectEvents();
    currentAdGet.mockResolvedValueOnce(adResponse('11111111-1111-4111-8111-111111111111'));
    currentAdGet.mockResolvedValueOnce({ status: 500 });
    currentAdGet.mockResolvedValueOnce({ status: 500 });
    const provider = createSponsoredProvider({
      onDiagnosticEvent(event) {
        events.push(event);
      },
    });

    await provider.resolve({ provider: 'CLAUDE', pathname: '/chat/thread-1', reason: 'initial' });
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    events.length = 0;

    await expect(
      provider.resolve({
        provider: 'CLAUDE',
        pathname: '/chat/thread-1',
        placementId: 'claude-below-input',
        reason: 'initial',
      }),
    ).resolves.toBeNull();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'CACHE_LOOKUP',
          details: expect.objectContaining({
            cacheKey: 'current-recommendation',
            storageBackend: 'memory',
            cacheSize: 1,
            cacheValidity: 'expired',
            cacheAgeMs: 5 * 60 * 1000 + 1,
          }),
        }),
        expect.objectContaining({
          name: 'CACHE_EXPIRED',
          details: expect.objectContaining({
            storageBackend: 'memory',
            cacheMissReason: 'cache_expired',
            cacheValidity: 'expired',
          }),
        }),
        expect.objectContaining({
          name: 'CACHE_MISS',
          details: expect.objectContaining({
            cacheMissReason: 'cache_expired',
          }),
        }),
        expect.objectContaining({
          name: 'FALLBACK_SELECTED',
          details: expect.objectContaining({
            source: 'none',
            selectedRecommendationSource: 'none',
          }),
        }),
      ]),
    );
    expectRequiredDiagnosticFields(events);
  });

  it('records an empty cache after provider recreation, matching service-worker restart behavior', async () => {
    const events = collectEvents();
    currentAdGet.mockResolvedValueOnce(adResponse('11111111-1111-4111-8111-111111111111'));
    currentAdGet.mockResolvedValueOnce({ status: 500 });
    currentAdGet.mockResolvedValueOnce({ status: 500 });
    const firstProvider = createSponsoredProvider();
    await firstProvider.resolve({
      provider: 'CHATGPT',
      pathname: '/c/thread-1',
      reason: 'initial',
    });

    const restartedProvider = createSponsoredProvider({
      onDiagnosticEvent(event) {
        events.push(event);
      },
    });

    await expect(
      restartedProvider.resolve({
        provider: 'CHATGPT',
        pathname: '/c/thread-1',
        placementId: 'chatgpt-below-input',
        reason: 'initial',
      }),
    ).resolves.toBeNull();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'CACHE_HYDRATED',
          details: expect.objectContaining({
            storageBackend: 'memory',
            cacheSize: 0,
            cacheValidity: 'empty',
            hydrationResult: 'memory_cache_initialized_empty',
          }),
        }),
        expect.objectContaining({
          name: 'CACHE_MISS',
          details: expect.objectContaining({
            cacheKey: 'current-recommendation',
            storageBackend: 'memory',
            cacheSize: 0,
            cacheValidity: 'empty',
            cacheMissReason: 'cache_empty',
          }),
        }),
      ]),
    );
    expectRequiredDiagnosticFields(events);
  });

  it('reads the unexpired in-memory cache during refresh without another backend request', async () => {
    const events = collectEvents();
    currentAdGet.mockResolvedValueOnce(adResponse('11111111-1111-4111-8111-111111111111'));
    const provider = createSponsoredProvider({
      onDiagnosticEvent(event) {
        events.push(event);
      },
    });

    await provider.resolve({ provider: 'CHATGPT', pathname: '/c/thread-1', reason: 'initial' });
    events.length = 0;

    await expect(
      provider.refresh({
        provider: 'CHATGPT',
        pathname: '/c/thread-1',
        placementId: 'chatgpt-below-input',
        reason: 'refresh',
      }),
    ).resolves.toMatchObject({
      changed: false,
      content: { id: '11111111-1111-4111-8111-111111111111' },
    });

    expect(currentAdGet).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.name)).toEqual([
      'CACHE_READ_STARTED',
      'CACHE_READ_COMPLETED',
      'CACHE_DESERIALIZED',
      'CACHE_LOOKUP',
      'CACHE_HIT',
    ]);
    expect(events.at(-1)).toMatchObject({
      name: 'CACHE_HIT',
      details: expect.objectContaining({
        provider: 'CHATGPT',
        pathname: '/c/thread-1',
        placementId: 'chatgpt-below-input',
        recommendationId: '11111111-1111-4111-8111-111111111111',
        storageBackend: 'memory',
        cacheSize: 1,
        cacheValidity: 'valid',
      }),
    });
    expectRequiredDiagnosticFields(events);
  });

  it('does not write recommendations to chrome storage or IndexedDB', async () => {
    const sessionSet = vi.fn();
    const localSet = vi.fn();
    const indexedDbOpen = vi.fn();
    vi.stubGlobal('chrome', {
      storage: {
        session: { set: sessionSet },
        local: { set: localSet },
      },
    });
    vi.stubGlobal('indexedDB', { open: indexedDbOpen });
    currentAdGet.mockResolvedValueOnce(adResponse('11111111-1111-4111-8111-111111111111'));
    const events = collectEvents();
    const provider = createSponsoredProvider({
      onDiagnosticEvent(event) {
        events.push(event);
      },
    });

    await provider.resolve({ provider: 'CHATGPT', pathname: '/c/thread-1', reason: 'initial' });

    expect(sessionSet).not.toHaveBeenCalled();
    expect(localSet).not.toHaveBeenCalled();
    expect(indexedDbOpen).not.toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'CACHE_WRITE_COMPLETED',
          details: expect.objectContaining({
            storageBackend: 'memory',
            writeSuccessful: true,
          }),
        }),
      ]),
    );
    expectRequiredDiagnosticFields(events);
  });

  it('returns cached recommendations across refresh, SPA navigation, and conversation switch contexts while memory survives', async () => {
    const events = collectEvents();
    currentAdGet.mockResolvedValueOnce(adResponse('11111111-1111-4111-8111-111111111111'));
    currentAdGet.mockResolvedValue({ status: 500 });
    const provider = createSponsoredProvider({
      onDiagnosticEvent(event) {
        events.push(event);
      },
    });

    await provider.resolve({
      provider: 'CHATGPT',
      pathname: '/c/thread-1',
      placementId: 'chatgpt-below-input',
      reason: 'initial',
    });
    events.length = 0;

    await expect(
      provider.resolve({
        provider: 'CHATGPT',
        pathname: '/c/thread-1',
        placementId: 'chatgpt-below-input',
        reason: 'initial',
      }),
    ).resolves.toMatchObject({ id: '11111111-1111-4111-8111-111111111111' });
    await expect(
      provider.resolve({
        provider: 'CHATGPT',
        pathname: '/c/thread-1?model=gpt-4.1',
        placementId: 'chatgpt-below-input',
        reason: 'initial',
      }),
    ).resolves.toMatchObject({ id: '11111111-1111-4111-8111-111111111111' });
    await expect(
      provider.resolve({
        provider: 'CHATGPT',
        pathname: '/c/thread-2',
        placementId: 'chatgpt-below-input',
        reason: 'initial',
      }),
    ).resolves.toMatchObject({ id: '11111111-1111-4111-8111-111111111111' });

    const hits = events.filter((event) => event.name === 'CACHE_HIT');
    expect(hits).toHaveLength(3);
    expect(hits.map((event) => event.details?.pathname)).toEqual([
      '/c/thread-1',
      '/c/thread-1?model=gpt-4.1',
      '/c/thread-2',
    ]);
    expect(hits).toEqual(
      hits.map((event) =>
        expect.objectContaining({
          details: expect.objectContaining({
            recommendationId: '11111111-1111-4111-8111-111111111111',
            storageBackend: 'memory',
            cacheSize: 1,
            cacheValidity: 'valid',
          }),
        }),
      ),
    );
    expect(currentAdGet).toHaveBeenCalledTimes(7);
    expectRequiredDiagnosticFields(events);
  });
});
