import type { SupportedPlatform } from '../adapters/types';
import { config } from '../config';
import { sdk } from '../sdk';
import { toRecommendation } from './mapping';
import type { SponsoredRecommendation } from './types';

/**
 * Outcome of a {@link SponsoredProvider.refresh}.
 *
 * For TTL refresh, `changed` is `true` only when the refreshed recommendation
 * has a different `id` than the one the provider last delivered, so callers can
 * avoid flicker. Scheduled rotation uses the same shape but also reports
 * `changed: true` for fresh backend content with the same id, because a new
 * render needs a new tracking link and impression lifecycle. `content` is always
 * the current recommendation, or `null` when neither fresh backend content nor
 * an unexpired cached recommendation is available.
 */
export interface RefreshOutcome {
  readonly changed: boolean;
  readonly content: SponsoredRecommendation | null;
}

export type SponsoredProviderDiagnosticEventName =
  | 'REQUEST_STARTED'
  | 'REQUEST_COMPLETED'
  | 'REQUEST_FAILED'
  | 'CACHE_HYDRATED'
  | 'CACHE_READ_STARTED'
  | 'CACHE_READ_COMPLETED'
  | 'CACHE_LOOKUP'
  | 'CACHE_HIT'
  | 'CACHE_MISS'
  | 'CACHE_WRITE_STARTED'
  | 'CACHE_WRITE_COMPLETED'
  | 'CACHE_INVALIDATED'
  | 'CACHE_EXPIRED'
  | 'CACHE_CLEARED'
  | 'CACHE_SERIALIZED'
  | 'CACHE_DESERIALIZED'
  | 'FALLBACK_SELECTED'
  | 'RECOMMENDATION_SELECTED';

export interface SponsoredProviderDiagnosticEvent {
  readonly name: SponsoredProviderDiagnosticEventName;
  readonly timestamp: string;
  readonly details?: Record<string, unknown>;
}

export interface SponsoredProviderOptions {
  readonly onDiagnosticEvent?: (event: SponsoredProviderDiagnosticEvent) => void;
}

export interface SponsoredProviderRequestContext {
  readonly provider?: SupportedPlatform;
  readonly pathname?: string | null;
  readonly impressionId?: string | null;
  readonly placementId?: string | null;
  readonly reason?: 'initial' | 'refresh' | 'rotation';
}

/**
 * Sponsored Provider.
 *
 * The single browser component allowed to communicate with the SDK for
 * recommendation content. It is the browser-side content resolver for the frozen
 * pipeline (SDK → Sponsored Provider → Render Controller → Placement Engine →
 * Layout Strategy → Renderer): it owns the SDK request, the structural mapping,
 * the in-memory cache, the retry, the fallback, and all refresh timing.
 *
 * It contains no business logic: no targeting, ranking, campaign selection, or
 * advertiser logic. Selection, validation, and prioritization remain backend
 * responsibilities. This is browser-side content resolution only.
 *
 * The mapping is purely structural (see {@link toRecommendation});
 * `tracking_signature` is retained internally for impression reporting only —
 * it is never exposed to the renderer, the content script, or the popup.
 *
 * Refresh ownership: the provider — not the controller, worker, or renderer —
 * owns refresh timing and the cache-TTL throttle. {@link SponsoredProvider.refresh}
 * re-resolves content but only queries the API once the cached recommendation
 * has expired, so refresh never hits the backend more frequently than the cache
 * TTL. It reports whether the content actually changed so callers re-render only
 * on a genuine change.
 */
export interface SponsoredProvider {
  /**
   * Resolve the recommendation to render using the deterministic fallback order:
   * fresh API data → unexpired cache → null.
   *
   * Always queries the API (subject to retry). Used for the initial render of a
   * placement, where there is nothing on screen yet.
   */
  resolve(context?: SponsoredProviderRequestContext): Promise<SponsoredRecommendation | null>;

  /**
   * Re-resolve the recommendation, throttled to the cache TTL.
   *
   * While the cached recommendation is unexpired this is a no-op that returns
   * the current content with `changed: false` (no API call, no flicker). Once
   * the cache has expired it re-resolves via the deterministic fallback (fresh
   * API → cache → null) and reports `changed: true` only when the resulting
   * recommendation `id` differs from the last delivered recommendation. Never
   * throws.
   */
  refresh(context?: SponsoredProviderRequestContext): Promise<RefreshOutcome>;

  /**
   * Resolve the next recommendation for scheduled rotation, bypassing the cache
   * TTL so long sessions can receive fresh backend selection while staying on
   * one conversation. A fresh backend result is treated as changed even when the
   * ad id repeats, so rotation creates a new native link and impression
   * lifecycle. Never throws.
   */
  rotate(context?: SponsoredProviderRequestContext): Promise<RefreshOutcome>;

  /** Record an ad only after the content script confirms it rendered the ad. */
  recordRenderedAd?(adId: string): void;

  /**
   * Return the tracking signature for the given ad id, or `null` when the
   * provider has no record of it (evicted cache, unknown id, or no real ad).
   *
   * This is the only path through which the tracking_signature leaves the
   * provider. It is consumed exclusively by the background ImpressionService
   * and is never forwarded to the renderer, content script, or popup.
   */
  getTrackingSignature(adId: string): string | null;
}

/** How long a fetched recommendation is reused before the API is queried again. */
const CACHE_TTL_MS = 5 * 60 * 1000;

const CACHE_KEY = 'current-recommendation';
const CACHE_STORAGE_BACKEND = 'memory';

/** Number of extra attempts after the first failed fetch. */
const FETCH_RETRIES = 1;

const RECENT_AD_HISTORY_SIZE = 3;

interface FetchedAd {
  readonly recommendation: SponsoredRecommendation;
  /** Retained for impression reporting only; never forwarded to the renderer. */
  readonly trackingSignature: string;
}

interface CachedRecommendation {
  readonly recommendation: SponsoredRecommendation;
  readonly expiresAt: number;
  readonly writtenAt: number;
}

interface ResolvedContent {
  readonly recommendation: SponsoredRecommendation | null;
  readonly fresh: boolean;
  readonly reason: string | null;
}

interface FetchRecommendationResult {
  readonly fetched: FetchedAd | null;
  readonly reason: string | null;
}

type EmitDiagnostic = (
  name: SponsoredProviderDiagnosticEventName,
  details?: Record<string, unknown>,
) => void;

type CacheValidity = 'empty' | 'valid' | 'expired';

interface CacheSnapshot {
  readonly key: typeof CACHE_KEY;
  readonly contents: SponsoredRecommendation | null;
  readonly ageMs: number | null;
  readonly expiresAt: number | null;
  readonly validity: CacheValidity;
}

function requestUrl(excludedAdIds: readonly string[], platform?: SupportedPlatform): string {
  const url = new URL('/v1/ads/current', config.apiBaseUrl);
  if (excludedAdIds.length > 0) {
    url.searchParams.set('exclude_ads', excludedAdIds.join(','));
  }
  if (platform) url.searchParams.set('platform', platform.toLowerCase());
  return url.toString();
}

function withContext(
  context: SponsoredProviderRequestContext | undefined,
  details: Record<string, unknown>,
): Record<string, unknown> {
  return {
    provider: context?.provider ?? null,
    pathname: context && 'pathname' in context ? (context.pathname ?? null) : null,
    impressionId: context && 'impressionId' in context ? (context.impressionId ?? null) : null,
    placementId: context && 'placementId' in context ? (context.placementId ?? null) : null,
    renderReason: context?.reason ?? null,
    ...details,
  };
}

/**
 * Fetch and map the current ad, retrying once on failure. Returns the mapped
 * recommendation and its tracking_signature, or `null` when the backend is
 * unavailable, returns no ad (404), is unauthorized (401), or the payload fails
 * defensive mapping checks. Never throws.
 */
async function fetchRecommendation(
  emit: EmitDiagnostic,
  excludedAdIds: readonly string[],
  context?: SponsoredProviderRequestContext,
): Promise<FetchRecommendationResult> {
  let lastReason: string | null = null;

  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    emit(
      'REQUEST_STARTED',
      withContext(context, {
        endpoint: '/v1/ads/current',
        requestUrl: requestUrl(excludedAdIds, context?.provider),
        attempt: attempt + 1,
      }),
    );

    try {
      const response = await sdk.v1.ads.current.$get({
        query: {
          ...(excludedAdIds.length > 0 ? { exclude_ads: excludedAdIds.join(',') } : {}),
          ...(context?.provider
            ? {
                platform: context.provider.toLowerCase() as
                  | 'chatgpt'
                  | 'claude'
                  | 'gemini'
                  | 'grok',
              }
            : {}),
        },
      });
      emit(
        'REQUEST_COMPLETED',
        withContext(context, {
          endpoint: '/v1/ads/current',
          requestUrl: requestUrl(excludedAdIds, context?.provider),
          responseStatus: response.status,
          status: response.status,
        }),
      );

      if (response.status !== 200) {
        lastReason = `http_${response.status}`;
        emit(
          'REQUEST_FAILED',
          withContext(context, {
            endpoint: '/v1/ads/current',
            requestUrl: requestUrl(excludedAdIds, context?.provider),
            responseStatus: response.status,
            status: response.status,
            reason: lastReason,
            networkError: null,
          }),
        );

        // 401 (logged out) / 404 (no ad available): nothing to render from the
        // API right now. Fall through to cache/no recommendation; no point retrying.
        if (response.status === 401 || response.status === 404) {
          return { fetched: null, reason: lastReason };
        }

        continue;
      }

      const body = await response.json();
      const recommendation = toRecommendation(body.data);
      if (!recommendation) {
        lastReason = 'invalid_payload';
        emit('REQUEST_FAILED', {
          ...withContext(context, {
            endpoint: '/v1/ads/current',
            requestUrl: requestUrl(excludedAdIds, context?.provider),
            responseStatus: response.status,
            status: response.status,
            reason: lastReason,
            networkError: null,
            bodyKeys: body?.data && typeof body.data === 'object' ? Object.keys(body.data) : [],
          }),
        });
        return { fetched: null, reason: lastReason };
      }

      return {
        fetched: { recommendation, trackingSignature: body.data.tracking_signature },
        reason: null,
      };
    } catch {
      lastReason = 'network_error';
      emit(
        'REQUEST_FAILED',
        withContext(context, {
          endpoint: '/v1/ads/current',
          requestUrl: requestUrl(excludedAdIds, context?.provider),
          attempt: attempt + 1,
          reason: lastReason,
          networkError: 'fetch_failed',
        }),
      );
      // Network error / transient worker failure: retry, then give up.
    }
  }

  return { fetched: null, reason: lastReason ?? 'request_failed' };
}

export function createSponsoredProvider(options: SponsoredProviderOptions = {}): SponsoredProvider {
  // Single in-memory cache slot for the current recommendation. Transient worker
  // state only: never persisted, never sent to the backend. Holds presentation
  // data only.
  let cache: CachedRecommendation | null = null;

  // The recommendation last delivered to a caller. Used only to detect whether a
  // refresh produced genuinely different content; presentation state only.
  let current: SponsoredRecommendation | null = null;

  // Maps ad_id → tracking_signature for the currently cached ad. Consumed only
  // by the ImpressionService via getTrackingSignature(); never forwarded to the
  // renderer, content script, or popup.
  const trackingSignatures = new Map<string, string>();

  const recentAdIds: string[] = [];

  function recordRenderedAd(adId: string): void {
    recentAdIds.push(adId);
    if (recentAdIds.length > RECENT_AD_HISTORY_SIZE) {
      recentAdIds.shift();
    }
  }

  function emit(
    name: SponsoredProviderDiagnosticEventName,
    details?: Record<string, unknown>,
  ): void {
    const snapshot = cacheSnapshot();
    options.onDiagnosticEvent?.({
      name,
      timestamp: new Date().toISOString(),
      details: {
        provider: null,
        pathname: null,
        impressionId: null,
        placementId: null,
        renderReason: null,
        cacheKey: CACHE_KEY,
        recommendationId: snapshot.contents?.id ?? null,
        storageBackend: CACHE_STORAGE_BACKEND,
        cacheSize: snapshot.contents ? 1 : 0,
        cacheAge: snapshot.ageMs,
        cacheAgeMs: snapshot.ageMs,
        expiresAt: snapshot.expiresAt,
        expirationTime: snapshot.expiresAt ? new Date(snapshot.expiresAt).toISOString() : null,
        failureReason: null,
        ...(details ?? {}),
      },
    });
  }

  /**
   * Resolve content via the deterministic fallback order (fresh API → unexpired
   * cache → null), record it as the cache and the current recommendation,
   * and return whether the value came from a fresh backend response. Never throws.
   */
  function cacheSnapshot(): CacheSnapshot {
    if (!cache) {
      return {
        key: CACHE_KEY,
        contents: null,
        ageMs: null,
        expiresAt: null,
        validity: 'empty',
      };
    }

    return {
      key: CACHE_KEY,
      contents: cache.recommendation,
      ageMs: Math.max(0, Date.now() - cache.writtenAt),
      expiresAt: cache.expiresAt,
      validity: cache.expiresAt > Date.now() ? 'valid' : 'expired',
    };
  }

  function cacheDetails(
    snapshot: CacheSnapshot,
    reason: string | null,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      cacheKey: snapshot.key,
      recommendationId: snapshot.contents?.id ?? null,
      storageBackend: CACHE_STORAGE_BACKEND,
      cacheSize: snapshot.contents ? 1 : 0,
      cacheContents: snapshot.contents
        ? {
            id: snapshot.contents.id,
            url: snapshot.contents.url,
            sponsor: snapshot.contents.sponsor,
            messageLength: snapshot.contents.message.length,
          }
        : null,
      cacheAgeMs: snapshot.ageMs,
      cacheAge: snapshot.ageMs,
      expiresAt: snapshot.expiresAt,
      expirationTime: snapshot.expiresAt ? new Date(snapshot.expiresAt).toISOString() : null,
      cacheValidity: snapshot.validity,
      failureReason: reason,
      fallbackReason: reason ?? 'backend_unavailable',
      ...extra,
    };
  }

  function readCache(
    context: SponsoredProviderRequestContext | undefined,
    reason: string | null,
  ): CacheSnapshot {
    const started = cacheSnapshot();
    emit(
      'CACHE_READ_STARTED',
      withContext(
        context,
        cacheDetails(started, reason, {
          operation: 'read',
        }),
      ),
    );

    const completed = cacheSnapshot();
    emit(
      'CACHE_READ_COMPLETED',
      withContext(
        context,
        cacheDetails(completed, reason, {
          operation: 'read',
          readSuccessful: true,
        }),
      ),
    );

    if (completed.contents) {
      emit(
        'CACHE_DESERIALIZED',
        withContext(
          context,
          cacheDetails(completed, reason, {
            operation: 'deserialize',
            deserializationSuccessful: true,
          }),
        ),
      );
    }

    if (completed.validity === 'expired') {
      emit(
        'CACHE_EXPIRED',
        withContext(
          context,
          cacheDetails(completed, reason, {
            cacheMissReason: 'cache_expired',
          }),
        ),
      );
    }

    return completed;
  }

  function emitHydrated(): void {
    const snapshot = cacheSnapshot();
    emit(
      'CACHE_HYDRATED',
      withContext(
        undefined,
        cacheDetails(snapshot, null, {
          hydratedFrom: null,
          hydrationResult: 'memory_cache_initialized_empty',
        }),
      ),
    );
  }

  function writeCache(
    fetched: FetchedAd,
    context: SponsoredProviderRequestContext | undefined,
  ): void {
    const previous = cacheSnapshot();
    emit(
      'CACHE_WRITE_STARTED',
      withContext(
        context,
        cacheDetails(previous, null, {
          operation: 'write',
          nextRecommendationId: fetched.recommendation.id,
          nextCacheSize: 1,
          parsedRecommendation: fetched.recommendation,
        }),
      ),
    );

    if (previous.contents) {
      emit(
        'CACHE_INVALIDATED',
        withContext(
          context,
          cacheDetails(previous, 'cache_replaced', {
            operation: 'invalidate',
            invalidatedRecommendationId: previous.contents.id,
            replacementRecommendationId: fetched.recommendation.id,
          }),
        ),
      );
    }

    const now = Date.now();
    const nextCache = {
      recommendation: fetched.recommendation,
      expiresAt: now + CACHE_TTL_MS,
      writtenAt: now,
    };
    emit(
      'CACHE_SERIALIZED',
      withContext(
        context,
        cacheDetails(
          {
            key: CACHE_KEY,
            contents: nextCache.recommendation,
            ageMs: 0,
            expiresAt: nextCache.expiresAt,
            validity: 'valid',
          },
          null,
          {
            operation: 'serialize',
            serializationSuccessful: true,
            parsedRecommendation: fetched.recommendation,
          },
        ),
      ),
    );

    cache = nextCache;
    const written = cacheSnapshot();
    emit(
      'CACHE_WRITE_COMPLETED',
      withContext(
        context,
        cacheDetails(written, null, {
          operation: 'write',
          writeSuccessful: true,
          writeFailureReason: null,
          parsedRecommendation: fetched.recommendation,
        }),
      ),
    );
  }

  emitHydrated();

  /**
   * Resolve content via the deterministic fallback order (fresh API → unexpired
   * cache → null), record it as the cache and the current recommendation,
   * and return whether the value came from a fresh backend response. Never throws.
   */
  async function resolveContent(
    context?: SponsoredProviderRequestContext,
  ): Promise<ResolvedContent> {
    const { fetched, reason } = await fetchRecommendation(emit, recentAdIds, context);
    if (fetched) {
      writeCache(fetched, context);
      current = fetched.recommendation;
      trackingSignatures.set(fetched.recommendation.id, fetched.trackingSignature);
      emit(
        'RECOMMENDATION_SELECTED',
        withContext(context, {
          source: 'backend',
          selectedRecommendationSource: 'backend',
          recommendationId: fetched.recommendation.id,
          destinationUrl: fetched.recommendation.url,
          cacheKey: CACHE_KEY,
          cacheWritten: true,
          storageBackend: CACHE_STORAGE_BACKEND,
          cacheSize: 1,
          cacheValidity: 'valid',
        }),
      );
      return { recommendation: fetched.recommendation, fresh: true, reason: null };
    }

    const snapshot = readCache(context, reason);
    emit('CACHE_LOOKUP', withContext(context, cacheDetails(snapshot, reason)));

    if (snapshot.validity === 'valid' && cache) {
      current = cache.recommendation;
      emit(
        'CACHE_HIT',
        withContext(
          context,
          cacheDetails(snapshot, reason, {
            recommendationId: cache.recommendation.id,
          }),
        ),
      );
      emit(
        'FALLBACK_SELECTED',
        withContext(context, {
          source: 'cache',
          selectedRecommendationSource: 'cache',
          reason: reason ?? 'backend_unavailable',
          fallbackReason: reason ?? 'backend_unavailable',
          recommendationId: cache.recommendation.id,
          cacheKey: CACHE_KEY,
          storageBackend: CACHE_STORAGE_BACKEND,
          cacheSize: 1,
          cacheValidity: 'valid',
        }),
      );
      emit(
        'RECOMMENDATION_SELECTED',
        withContext(context, {
          source: 'cache',
          selectedRecommendationSource: 'cache',
          recommendationId: cache.recommendation.id,
          destinationUrl: cache.recommendation.url,
          cacheKey: CACHE_KEY,
          cacheWritten: false,
          storageBackend: CACHE_STORAGE_BACKEND,
          cacheSize: 1,
          cacheValidity: 'valid',
        }),
      );
      return { recommendation: cache.recommendation, fresh: false, reason };
    }

    current = null;
    emit(
      'CACHE_MISS',
      withContext(
        context,
        cacheDetails(snapshot, reason, {
          cacheMissReason: snapshot.validity === 'expired' ? 'cache_expired' : 'cache_empty',
        }),
      ),
    );
    emit(
      'FALLBACK_SELECTED',
      withContext(context, {
        source: 'none',
        selectedRecommendationSource: 'none',
        reason: reason ?? 'backend_unavailable',
        fallbackReason: reason ?? 'backend_unavailable',
        cacheKey: CACHE_KEY,
        recommendationId: null,
        storageBackend: CACHE_STORAGE_BACKEND,
        cacheSize: snapshot.contents ? 1 : 0,
        cacheValidity: snapshot.validity,
        cacheMissReason: snapshot.validity === 'expired' ? 'cache_expired' : 'cache_empty',
      }),
    );
    return { recommendation: null, fresh: false, reason };
  }

  return {
    resolve(context?: SponsoredProviderRequestContext): Promise<SponsoredRecommendation | null> {
      return resolveContent(context).then(({ recommendation }) => recommendation);
    },

    async refresh(context?: SponsoredProviderRequestContext): Promise<RefreshOutcome> {
      // Throttle to the cache TTL: while the cached recommendation is unexpired,
      // refresh is a no-op — no API call and no content change, so the rendered
      // line never flickers between identical content.
      const snapshot = readCache(context, null);
      emit('CACHE_LOOKUP', withContext(context, cacheDetails(snapshot, null)));
      if (current && snapshot.validity === 'valid' && cache) {
        emit(
          'CACHE_HIT',
          withContext(
            context,
            cacheDetails(snapshot, null, {
              recommendationId: cache.recommendation.id,
            }),
          ),
        );
        return { changed: false, content: current };
      }

      const previousId = current?.id;
      const { recommendation } = await resolveContent(context);
      if (!recommendation) {
        return { changed: false, content: null };
      }
      return { changed: recommendation.id !== previousId, content: recommendation };
    },

    async rotate(context?: SponsoredProviderRequestContext): Promise<RefreshOutcome> {
      const { recommendation, fresh } = await resolveContent(context);
      if (!recommendation) {
        return { changed: false, content: null };
      }
      return { changed: fresh, content: recommendation };
    },

    recordRenderedAd,

    getTrackingSignature(adId: string): string | null {
      return trackingSignatures.get(adId) ?? null;
    },
  };
}
