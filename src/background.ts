import { Platform as PlatformId } from './adapters/types';
import type { Anchor, Platform, SupportedPlatform } from './adapters/types';
import { createClickService } from './click/service';
import { config } from './config';
import { createRenderController } from './controllers';
import type { CommandDiagnosticEvent } from './diagnostics';
import { createImpressionService } from './impression';
import type {
  AuthState,
  ContentScriptRequest,
  ContentScriptResponse,
  ExtensionRequest,
  HealthCheckResponse,
  PopupRequest,
  PopupResponse,
  PopupState,
  PopupStateResponse,
} from './messages';

import { type PlacementRequest, createPlacementEngine } from './placement';
import { sdk } from './sdk';
import { type SponsoredProviderDiagnosticEvent, createSponsoredProvider } from './sponsored';

/**
 * Background service worker.
 *
 * Owns the single SDK instance and all session logic. The popup communicates
 * with it via typed messages (see messages.ts). Authentication relies entirely
 * on the backend's HttpOnly session cookie:
 *
 * - Login: open the web app GitHub OAuth sign-in page in a tab. After the user
 *   authorizes, the backend sets the HttpOnly session cookie on the API origin.
 * - Session restoration: the cookie persists across browser restarts, so the
 *   auth state is re-derived by calling GET /v1/user on demand.
 * - Logout: call the backend sign-out endpoint, which clears the cookie.
 *
 * The worker never stores or reads any token.
 */

let impressionDurationMs = 5_000;

async function resolveAuthState(): Promise<AuthState> {
  try {
    const userResponse = await sdk.v1.user.$get();

    if (userResponse.status === 401) {
      return { status: 'logged_out' };
    }

    const userBody = await userResponse.json();
    impressionDurationMs = userBody.data.impressionDurationMs;

    const walletResponse = await sdk.v1.wallet.$get();

    if (walletResponse.status === 401) {
      return { status: 'error', message: `Failed to load wallet (${walletResponse.status})` };
    }

    const walletBody = await walletResponse.json();

    return { status: 'logged_in', user: userBody.data, wallet: walletBody.data };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network error';
    return { status: 'error', message };
  }
}

async function openLogin(): Promise<void> {
  await chrome.tabs.create({ url: `${config.webAppUrl}/login` });
}

async function openDashboard(): Promise<void> {
  await chrome.tabs.create({ url: config.webAppUrl });
}

async function logout(): Promise<void> {
  // The signout action requires a CSRF token. The backend's signin/signout pages
  // handle the CSRF flow; opening the sign-out page lets the backend clear the
  // HttpOnly cookie it owns.
  await chrome.tabs.create({ url: `${config.webAppUrl}/api/auth/signout` });
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

async function handlePopupRequest(message: PopupRequest): Promise<PopupResponse> {
  try {
    switch (message.type) {
      case 'GET_POPUP_STATE':
        // This branch is handled by handlePopupStateRequest so its response
        // retains the compact contract consumed by the popup.
        return { ok: false, message: 'Invalid popup state request route.' };
      case 'GET_AUTH_STATE':
        return { ok: true, state: await resolveAuthState() };
      case 'LOGIN':
        await openLogin();
        return { ok: true, state: { status: 'loading' } };
      case 'OPEN_DASHBOARD':
        await openDashboard();
        return { ok: true, state: { status: 'loading' } };
      case 'LOGOUT':
        await logout();
        return { ok: true, state: { status: 'logged_out' } };
    }
  } catch (error) {
    return { ok: false, message: toMessage(error) };
  }
}

async function handlePopupStateRequest(): Promise<PopupStateResponse> {
  const state = await resolveAuthState();

  if (state.status === 'logged_in') {
    const popupState: PopupState = {
      isAuthenticated: true,
      user: state.user,
      wallet: state.wallet,
    };
    return { ok: true, popupState };
  }

  if (state.status === 'logged_out') {
    return { ok: true, popupState: { isAuthenticated: false } };
  }

  return {
    ok: false,
    message: state.status === 'error' ? state.message : 'Unable to load popup state.',
  };
}

/**
 * Runtime record of the platform and readiness detected for each tab. This is
 * rebuilt as content scripts report in and cleared when tabs close. The rendered
 * placement is also mirrored in chrome.storage.session so MV3 alarm wakeups can
 * rotate an already-rendered active tab after the service worker sleeps. Nothing
 * is sent to the backend or used for business logic.
 */
interface TabState {
  platform: Platform;
  ready: boolean;
  attentionActive: boolean;
  /** Ranked, validated candidate anchors last reported for the tab. */
  anchors: Anchor[];
  /**
   * The placement the tab last rendered, if any. Retained so the recommendation
   * can be refreshed in place (re-rendered only when the content changes)
   * without re-running discovery. Presentation state only.
   */
  placement?: PlacementRequest;
}

const tabStates = new Map<number, TabState>();
const activeTabsByWindow = new Map<number, number>();
let activeTabId: number | null = null;
let focusedWindowId: number | null = null;
const RETAINED_TAB_STATES_KEY = 'airewardsRenderedTabStates';
const MAX_BACKGROUND_EVENTS = 100;
let retainedTabStatesUpdate: Promise<void> = Promise.resolve();
const backgroundEvents: CommandDiagnosticEvent[] = [];
const recommendationEvents: SponsoredProviderDiagnosticEvent[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedPlatform(value: unknown): value is SupportedPlatform {
  return (
    value === PlatformId.CHATGPT ||
    value === PlatformId.CLAUDE ||
    value === PlatformId.GEMINI ||
    value === PlatformId.GROK
  );
}

function isAnchorPosition(value: unknown): value is Anchor['position'] {
  return value === 'above_input' || value === 'below_input' || value === 'end_of_thread';
}

function isAnchorStatus(value: unknown): value is Anchor['status'] {
  return value === 'valid' || value === 'rejected';
}

function isAnchor(value: unknown): value is Anchor {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    isSupportedPlatform(value.platform) &&
    isAnchorPosition(value.position) &&
    typeof value.confidence === 'number' &&
    Number.isFinite(value.confidence) &&
    isAnchorStatus(value.status)
  );
}

function isPlacementRequest(value: unknown): value is PlacementRequest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isSupportedPlatform(value.platform) &&
    isAnchor(value.anchor) &&
    value.anchor.platform === value.platform
  );
}

function isRetainedTabState(value: unknown): value is TabState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isSupportedPlatform(value.platform) &&
    typeof value.ready === 'boolean' &&
    typeof value.attentionActive === 'boolean' &&
    Array.isArray(value.anchors) &&
    value.anchors.every(isAnchor) &&
    (!('placement' in value) ||
      value.placement === undefined ||
      (isPlacementRequest(value.placement) && value.placement.platform === value.platform))
  );
}

function storageSessionGet(key: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.get(key, (items) => {
        resolve(items as Record<string, unknown>);
      });
    } catch {
      resolve({});
    }
  });
}

function storageSessionSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.set(items, resolve);
    } catch {
      resolve();
    }
  });
}

async function readRetainedTabStates(): Promise<Record<string, TabState>> {
  const stored = await storageSessionGet(RETAINED_TAB_STATES_KEY);
  const retained = stored[RETAINED_TAB_STATES_KEY];
  if (!isRecord(retained)) {
    return {};
  }

  const states: Record<string, TabState> = {};
  for (const [tabId, state] of Object.entries(retained)) {
    if (/^\d+$/.test(tabId) && isRetainedTabState(state)) {
      states[tabId] = state;
    }
  }
  return states;
}

async function writeRetainedTabStates(states: Record<string, TabState>): Promise<void> {
  await storageSessionSet({ [RETAINED_TAB_STATES_KEY]: states });
}

async function updateRetainedTabStates(
  updater: (states: Record<string, TabState>) => void,
): Promise<void> {
  const update = retainedTabStatesUpdate
    .catch(() => undefined)
    .then(async () => {
      const states = await readRetainedTabStates();
      updater(states);
      await writeRetainedTabStates(states);
    });

  retainedTabStatesUpdate = update;
  await update;
}

async function retainTabState(tabId: number, state: TabState): Promise<void> {
  await updateRetainedTabStates((states) => {
    states[String(tabId)] = state;
  });
}

async function clearRetainedTabState(tabId: number): Promise<void> {
  await updateRetainedTabStates((states) => {
    delete states[String(tabId)];
  });
}

async function hydrateTabState(tabId: number): Promise<TabState | undefined> {
  const existing = tabStates.get(tabId);
  if (existing) {
    return existing;
  }

  await retainedTabStatesUpdate.catch(() => undefined);
  const states = await readRetainedTabStates();
  const retained = states[String(tabId)];
  if (!retained) {
    return undefined;
  }

  tabStates.set(tabId, retained);
  return retained;
}

function stateCanRotate(state: TabState | undefined): state is TabState & {
  placement: PlacementRequest;
} {
  return state?.ready === true && state.attentionActive === true && state.placement !== undefined;
}

function backgroundEvent(
  name: CommandDiagnosticEvent['name'],
  provider: Platform | 'UNKNOWN' | null,
  details?: Record<string, unknown>,
): CommandDiagnosticEvent {
  return {
    name,
    timestamp: new Date().toISOString(),
    provider,
    ...(details ? { details } : {}),
  };
}

function recordBackgroundEvent(
  name: CommandDiagnosticEvent['name'],
  provider: Platform | 'UNKNOWN' | null,
  details?: Record<string, unknown>,
): CommandDiagnosticEvent {
  const event = backgroundEvent(name, provider, details);
  if (config.diagnosticsEnabled) {
    backgroundEvents.push(event);
    if (backgroundEvents.length > MAX_BACKGROUND_EVENTS) {
      backgroundEvents.splice(0, backgroundEvents.length - MAX_BACKGROUND_EVENTS);
    }
  }
  return event;
}

function recordRecommendationEvent(event: SponsoredProviderDiagnosticEvent): void {
  if (!config.diagnosticsEnabled) {
    return;
  }

  recommendationEvents.push(event);
  if (recommendationEvents.length > MAX_BACKGROUND_EVENTS) {
    recommendationEvents.splice(0, recommendationEvents.length - MAX_BACKGROUND_EVENTS);
  }
}

/**
 * Name of the periodic alarm that drives the cache-expiry refresh trigger. MV3
 * service workers sleep, so a self-terminating timer is unreliable; an alarm is
 * the supported way to wake the worker on a schedule.
 */
const REFRESH_ALARM = 'airewards-recommendation-refresh';

/**
 * How often the worker asks the provider to refresh the active tab. The provider
 * throttles to the cache TTL, so a poll finer than the TTL never causes an API
 * call more often than the TTL — it simply lets the worker re-check shortly
 * after the cache expires.
 */
const REFRESH_ALARM_PERIOD_MINUTES = 1;

/**
 * Periodic alarm that evicts expired queue items and old sent-cache entries.
 * Runs every 10 minutes — well within the 5-minute tracking-signature TTL so
 * expired items are cleaned up promptly without hammering storage.
 */
const SWEEP_ALARM = 'airewards-impression-sweep';
const SWEEP_ALARM_PERIOD_MINUTES = 10;

/**
 * Resolves recommendation content for the browser. The single component allowed
 * to communicate with the SDK for recommendation content: it owns the SDK
 * request, structural mapping, cache, retry, and fallback, and returns only a
 * SponsoredRecommendation.
 */
const sponsoredProvider = createSponsoredProvider({
  onDiagnosticEvent: recordRecommendationEvent,
});

/**
 * Owns the impression lifecycle: deduplication, persistent queue, retry with
 * exponential backoff, and offline handling. The only component that calls
 * the v2 challenge/evidence/complete lifecycle. Never touches the renderer or content script.
 */
const impressionService = createImpressionService(sponsoredProvider);
const clickService = createClickService({ apiBaseUrl: config.apiBaseUrl });

/**
 * Coordinates rendering. The worker never sends renderer commands directly — it
 * routes every render/destroy through this controller, so anchor discovery is
 * fully decoupled from rendering. The controller asks the sponsored provider for
 * content; it never calls the SDK itself.
 */
const renderController = createRenderController(sponsoredProvider, clickService, {
  getImpressionDurationMs: () => impressionDurationMs,
  onDiagnosticEvent(event) {
    if (!config.diagnosticsEnabled) {
      return;
    }
    backgroundEvents.push(event);
    if (backgroundEvents.length > MAX_BACKGROUND_EVENTS) {
      backgroundEvents.splice(0, backgroundEvents.length - MAX_BACKGROUND_EVENTS);
    }
  },
});

/**
 * Converts the tab's ranked, validated anchors into a browser-only
 * {@link PlacementRequest}. Discovery hands ranked anchors to the engine; the
 * engine selects the placement; the controller renders it. The engine owns the
 * selection decision so neither discovery nor the worker chooses anchors
 * directly.
 */
const placementEngine = createPlacementEngine();

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  if (activeTabId === tabId) {
    activeTabId = null;
  }
  for (const [windowId, activeId] of activeTabsByWindow) {
    if (activeId === tabId) {
      activeTabsByWindow.delete(windowId);
    }
  }
  void clearRetainedTabState(tabId);
});

/**
 * Refresh the recommendation for a tab in place. The render controller asks the
 * provider to re-resolve (throttled to the cache TTL) and re-renders only when
 * the content actually changed, so an unchanged recommendation never flickers
 * and is never removed mid-refresh. A no-op for tabs that have no current
 * placement or are not ready.
 */
function refreshTab(tabId: number): void {
  const state = tabStates.get(tabId);
  if (state?.ready && state.placement) {
    void renderController.requestRefresh(tabId, state.placement);
    return;
  }

  void hydrateTabState(tabId).then((hydrated) => {
    if (hydrated?.ready && hydrated.placement) {
      void renderController.requestRefresh(tabId, hydrated.placement);
    }
  });
}

function rotateTab(tabId: number): void {
  if (tabId !== activeTabId) {
    return;
  }

  const state = tabStates.get(tabId);
  if (stateCanRotate(state)) {
    recordBackgroundEvent('BACKGROUND_STARTED_ROTATION_FETCH', state.platform, {
      tabId,
      placementId: state.placement.anchor.id,
      hydrated: false,
    });
    void Promise.resolve(renderController.requestRotation(tabId, state.placement)).then(
      (rendered) => {
        recordBackgroundEvent('BACKGROUND_ROTATION_FETCH_COMPLETED', state.platform, {
          tabId,
          placementId: state.placement.anchor.id,
          rendered,
        });
      },
    );
    return;
  }

  void hydrateTabState(tabId).then((hydrated) => {
    if (stateCanRotate(hydrated)) {
      recordBackgroundEvent('BACKGROUND_STARTED_ROTATION_FETCH', hydrated.platform, {
        tabId,
        placementId: hydrated.placement.anchor.id,
        hydrated: true,
      });
      void Promise.resolve(renderController.requestRotation(tabId, hydrated.placement)).then(
        (rendered) => {
          recordBackgroundEvent('BACKGROUND_ROTATION_FETCH_COMPLETED', hydrated.platform, {
            tabId,
            placementId: hydrated.placement.anchor.id,
            rendered,
          });
        },
      );
    }
  });
}

function rotateRenderedTabs(): void {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const tab = tabs[0];
    const tabId = tab?.id;
    if (tabId !== undefined) {
      activeTabId = tabId;
      if (tab.windowId !== undefined) {
        focusedWindowId = tab.windowId;
        activeTabsByWindow.set(tab.windowId, tabId);
      }
      rotateTab(tabId);
    }
  });
}

function backgroundDiagnostics(): ContentScriptResponse {
  if (!config.diagnosticsEnabled) {
    return { ok: true, acknowledged: true };
  }

  return {
    ok: true,
    acknowledged: true,
    diagnostics: {
      apiBaseUrl: config.apiBaseUrl,
      buildMode: config.buildMode,
      diagnosticsEnabled: config.diagnosticsEnabled,
      extensionVersion: config.extensionVersion,
      buildId: config.buildId,
      builtAt: config.builtAt,
      rotationEvents: backgroundEvents,
      recommendationEvents,
      tabs: [...tabStates.entries()].map(([tabId, state]) => ({
        tabId,
        platform: state.platform,
        ready: state.ready,
        attentionActive: state.attentionActive,
        anchorCount: state.anchors.length,
        hasPlacement: state.placement !== undefined,
      })),
    },
  };
}

// Track both activation and window focus. A tab may be active inside an
// unfocused window, so only the active tab in the focused window is eligible
// for impression recording or rotation.
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  activeTabsByWindow.set(windowId, tabId);
  if (focusedWindowId === windowId) {
    activeTabId = tabId;
    refreshTab(tabId);
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    focusedWindowId = null;
    activeTabId = null;
    return;
  }

  focusedWindowId = windowId;
  const knownActiveTabId = activeTabsByWindow.get(windowId);
  if (knownActiveTabId !== undefined) {
    activeTabId = knownActiveTabId;
    refreshTab(knownActiveTabId);
    return;
  }

  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    if (focusedWindowId !== windowId) {
      return;
    }
    const tabId = tabs[0]?.id;
    activeTabId = tabId ?? null;
    if (tabId !== undefined) {
      activeTabsByWindow.set(windowId, tabId);
      refreshTab(tabId);
    }
  });
});

// Refresh on extension start (browser launch / extension enabled / update), so a
// reactivated worker delivers current content to whatever tab is in focus.
function refreshActiveTab(): void {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const tab = tabs[0];
    const tabId = tab?.id;
    if (tabId !== undefined) {
      activeTabId = tabId;
      if (tab.windowId !== undefined) {
        focusedWindowId = tab.windowId;
        activeTabsByWindow.set(tab.windowId, tabId);
      }
      refreshTab(tabId);
    }
  });
}

refreshActiveTab();

chrome.runtime.onStartup.addListener(() => {
  refreshActiveTab();
  // Flush any impressions that were queued before the browser shut down.
  void impressionService.flush();
});

chrome.runtime.onInstalled.addListener(() => {
  refreshActiveTab();
  void impressionService.flush();
});

// Flush queued impressions when the browser comes back online after being
// offline. The service worker may have been sleeping; the online event wakes it.
self.addEventListener('online', () => {
  void impressionService.flush();
});

// Rotation trigger: a periodic alarm wakes the worker to rotate the active,
// focused, attention-active tab with a retained rendered placement.
//
// Guard with chrome.alarms.get before creating: the MV3 service worker
// re-executes its module on every wake, so an unconditional create() would reset
// the alarm's timer on each wake and prevent it from ever firing reliably.
chrome.alarms.get(REFRESH_ALARM, (existing) => {
  if (!existing) {
    chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_ALARM_PERIOD_MINUTES });
    recordBackgroundEvent('ROTATION_TIMER_STARTED', null, {
      alarm: REFRESH_ALARM,
      periodInMinutes: REFRESH_ALARM_PERIOD_MINUTES,
    });
  }
});

// Periodic sweep: evict expired queue items and old sent-cache entries so
// chrome.storage.local never grows without bound.
chrome.alarms.get(SWEEP_ALARM, (existing) => {
  if (!existing) {
    chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: SWEEP_ALARM_PERIOD_MINUTES });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) {
    recordBackgroundEvent('ROTATION_TIMER_FIRED', null, {
      alarm: alarm.name,
    });
    rotateRenderedTabs();
  }
  if (alarm.name === SWEEP_ALARM) {
    void impressionService.sweep();
  }
});

function handleContentScriptRequest(
  message: ContentScriptRequest,
  sender: chrome.runtime.MessageSender,
): ContentScriptResponse {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'CONTENT_SCRIPT_READY':
      // Connectivity handshake only.
      return { ok: true, acknowledged: true };
    case 'GET_DEBUG_STATE':
      return backgroundDiagnostics();
    case 'PLATFORM_DETECTED':
      // Record the platform for this tab. A tab refresh or in-app navigation
      // re-runs detection and resets readiness and anchors for the new load. Any
      // recommendation line from a prior page is torn down so nothing lingers
      // across navigations.
      if (tabId !== undefined) {
        const state = {
          platform: message.platform,
          ready: false,
          attentionActive: true,
          anchors: [],
        };
        tabStates.set(tabId, state);
        void clearRetainedTabState(tabId);
        void renderController.requestDestroy(tabId);
      }
      return { ok: true, acknowledged: true };
    case 'PAGE_READY':
      // Mark the tab's page as ready, preserving any anchors and placement
      // already reported.
      if (tabId !== undefined) {
        const previous = tabStates.get(tabId);
        const state = {
          platform: message.platform,
          ready: true,
          attentionActive: previous?.attentionActive ?? true,
          anchors: previous?.anchors ?? [],
          placement: previous?.placement,
        };
        tabStates.set(tabId, state);
        if (state.placement) {
          void retainTabState(tabId, state);
        }
      }
      return {
        ok: true,
        acknowledged: true,
        events: [
          backgroundEvent('BACKGROUND_RECEIVED_PAGE_READY', message.platform, {
            tabId,
          }),
        ],
      };
    case 'ANCHORS_DISCOVERED':
      // Store the discovered anchors for this tab in memory only, then build a
      // placement and *request* a render through the controller. Discovery does
      // not render directly and does not pick the anchor: it hands the ranked
      // anchors to the placement engine, which selects the placement, and the
      // controller owns the rendering decision. Not an advertisement, not
      // persisted, and not sent to the backend. The content script, not
      // discovery, owns DOM-replacement recovery for the renderer lifecycle.
      if (tabId !== undefined) {
        const previous = tabStates.get(tabId);
        const ready = previous?.ready ?? true;
        const placement = ready ? placementEngine.plan(message.platform, message.anchors) : null;
        const state = {
          platform: message.platform,
          ready,
          attentionActive: previous?.attentionActive ?? true,
          anchors: message.anchors,
          placement: placement ?? undefined,
        };
        tabStates.set(tabId, state);
        if (state.placement) {
          void retainTabState(tabId, state);
        } else {
          void clearRetainedTabState(tabId);
        }

        // SPA navigation re-runs discovery and arrives here, so an initial
        // render after navigation also delivers fresh content. The placement is
        // retained so later refresh and rotation triggers can re-render in
        // place without re-discovering.
        if (placement) {
          void resolveAuthState().then(() => renderController.requestRender(tabId, placement));
        }
      }
      return { ok: true, acknowledged: true };
    case 'ATTENTION_STATE':
      if (tabId !== undefined) {
        const previous = tabStates.get(tabId);
        if (previous) {
          tabStates.set(tabId, { ...previous, attentionActive: message.active });
          void retainTabState(tabId, { ...previous, attentionActive: message.active });
        }
      }
      return { ok: true, acknowledged: true };
    case 'VALID_IMPRESSION':
      // The content script confirmed the recommendation satisfied the visibility
      // lifecycle. Delegate to the impression service, which owns deduplication,
      // queuing, retry, and the API call.
      if (tabId === undefined || tabId !== activeTabId) {
        return {
          ok: false,
          message: 'Impression rejected because the tab is not active and focused.',
        };
      }

      if (tabId !== undefined) {
        void impressionService.record({
          adId: message.adId,
          impressionId: message.impressionId,
          placementId: message.placementId,
          tabId,
          provider: message.provider,
          conversationId: message.conversationId,
          destinationUrl: message.destinationUrl,
          viewedAt: message.viewedAt,
          durationMs: message.durationMs,
        });
      }
      return { ok: true, acknowledged: true };
  }
}

function isPopupRequest(message: ExtensionRequest): message is PopupRequest {
  return (
    message.type === 'GET_POPUP_STATE' ||
    message.type === 'GET_AUTH_STATE' ||
    message.type === 'LOGIN' ||
    message.type === 'OPEN_DASHBOARD' ||
    message.type === 'LOGOUT'
  );
}

/**
 * Health-check from the dashboard status bridge. Side-effect free: it never
 * touches the SDK, storage, or tab state. Its only job is to prove the worker
 * is awake and report the running extension version.
 */
function handleHealthCheck(): HealthCheckResponse {
  return { ok: true, backgroundAwake: true, version: config.extensionVersion };
}

/**
 * Single message hub. The popup and the content script both send here; messages
 * are routed by `type`. Returning `true` keeps the channel open for the async
 * response. Every branch resolves to a typed response and never throws, so the
 * sender never sees an uncaught rejection or a dropped channel.
 */
chrome.runtime.onMessage.addListener(
  (
    message: ExtensionRequest,
    sender,
    sendResponse: (
      response: PopupResponse | PopupStateResponse | ContentScriptResponse | HealthCheckResponse,
    ) => void,
  ) => {
    if (isPopupRequest(message)) {
      const response =
        message.type === 'GET_POPUP_STATE'
          ? handlePopupStateRequest()
          : handlePopupRequest(message);
      response.then(sendResponse, (error) =>
        sendResponse({ ok: false, message: toMessage(error) }),
      );
      return true;
    }

    if (message.type === 'AIREWARDS_HEALTH_CHECK') {
      sendResponse(handleHealthCheck());
      return true;
    }

    try {
      sendResponse(handleContentScriptRequest(message, sender));
    } catch (error) {
      sendResponse({ ok: false, message: toMessage(error) });
    }
    return true;
  },
);
