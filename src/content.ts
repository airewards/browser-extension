import { resolveAdapter } from './adapters';
import { discoverAnchors } from './anchors';
import {
  getDebugState,
  incrementDebugCounter,
  recordBackgroundMessage,
  recordClickEvent,
  recordCommandLifecycleEvents,
  recordContentMessage,
  recordLifecycleEvent,
  recordMessageEvent,
  recordPageLifecycleEvent,
  replaceActiveTimer,
  setDebugState,
} from './diagnostics';
import { planLayout } from './layout';
import type {
  BackgroundCommand,
  BackgroundCommandResponse,
  ContentScriptRequest,
  ContentScriptResponse,
} from './messages';
import { createRecommendationRenderer } from './renderers';
import { type VisibilityTracker, createVisibilityTracker } from './tracking/visibility';

/**
 * Content script: platform identification and read-only page analysis, plus the
 * renderer lifecycle.
 *
 * On load it connects to the worker, reports the platform (URL only), reports
 * readiness once the page mounts, then discovers and reports candidate anchors.
 * Detection, readiness, and discovery are read-only (stable landmarks only,
 * never business content) and never mutate the DOM.
 *
 * Separately, it listens for worker commands to render or destroy the one-line
 * Sponsored Recommendation. It resolves the platform's footer layout (the layout
 * strategy lives here, where the DOM exists) and renders via the renderer layer.
 * Rendering is additive, Shadow-DOM isolated, and fully reversible; it never
 * overwrites, removes, hides, or modifies page nodes or first-party disclaimers,
 * never touches existing handlers. DOM replacement recovery uses scoped
 * MutationObservers outside the renderer.
 *
 * All worker communication is best-effort: any failure (worker asleep, port
 * disconnected, timeout, extension context invalidated) is handled gracefully
 * and never throws an uncaught rejection or logs an error to the page console.
 */

const HANDSHAKE_TIMEOUT_MS = 5_000;
const ATTENTION_IDLE_TIMEOUT_MS = 60_000;
const ATTENTION_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;

/** Bounded, read-only readiness polling: avoids hanging on pages that never mount. */
const READINESS_POLL_INTERVAL_MS = 250;
const READINESS_TIMEOUT_MS = 15_000;

interface ContentRuntime {
  teardown(): void;
}

declare global {
  interface Window {
    __airewardsContentRuntime?: ContentRuntime;
  }
}

try {
  window.__airewardsContentRuntime?.teardown();
} catch {
  // Best-effort: a stale runtime must never prevent the fresh content script
  // from installing its own listeners after an extension reload or reinjection.
}

getDebugState();
recordLifecycleEvent('CONTENT_SCRIPT_LOADED', null);
recordPageLifecycleEvent('CONTENT_SCRIPT_LOADED', { readyState: document.readyState });

let disposed = false;
const cleanupCallbacks: Array<() => void> = [];

function registerCleanup(cleanup: () => void): void {
  cleanupCallbacks.push(cleanup);
}

function removeDocumentListener(type: string, listener: EventListener): void {
  try {
    document.removeEventListener(type, listener);
  } catch {
    // Best-effort cleanup only; content scripts must never disrupt host pages.
  }
}

function removeWindowListener(type: string, listener: EventListener): void {
  try {
    window.removeEventListener(type, listener);
  } catch {
    // Best-effort cleanup only; content scripts must never disrupt host pages.
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Background worker did not respond in time')),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function sendToBackground(
  request: ContentScriptRequest,
): Promise<ContentScriptResponse | null> {
  const provider =
    'platform' in request && typeof request.platform === 'string'
      ? request.platform
      : (getDebugState()?.provider ?? null);
  recordContentMessage(request.type, provider, {
    requestType: request.type,
  });
  try {
    const response = (await withTimeout(
      chrome.runtime.sendMessage(request),
      HANDSHAKE_TIMEOUT_MS,
    )) as ContentScriptResponse | undefined;

    recordBackgroundMessage(request.type, provider, {
      requestType: request.type,
      ok: response?.ok ?? null,
      acknowledged: response && 'acknowledged' in response ? response.acknowledged : null,
    });
    if (response?.ok === true && response.events) {
      recordCommandLifecycleEvents(response.events);
    }

    return response ?? null;
  } catch {
    // sendMessage rejects when the worker is unreachable or the extension
    // context was invalidated (e.g. the extension was reloaded). The content
    // script stays inert rather than disrupting the host page.
    return null;
  }
}

/**
 * Resolve once the adapter reports the page is ready, or `false` if it does not
 * become ready within the timeout. Polling is read-only (structural checks only)
 * and self-terminating, so an unsupported layout or a page that never mounts can
 * never hang or spam the console.
 */
function waitForReady(isReady: () => boolean, isCurrent: () => boolean): Promise<boolean> {
  if (!isCurrent()) {
    return Promise.resolve(false);
  }

  if (isReady()) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    const interval = setInterval(() => {
      if (!isCurrent()) {
        clearInterval(interval);
        resolve(false);
      } else if (isReady()) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() >= deadline) {
        clearInterval(interval);
        resolve(false);
      }
    }, READINESS_POLL_INTERVAL_MS);
  });
}

let readinessObserver: MutationObserver | null = null;

function stopReadinessObserver(): void {
  readinessObserver?.disconnect();
  readinessObserver = null;
  setDebugState({ observerState: 'disconnected', observerActive: false });
}

function observeReadiness(isReady: () => boolean, onReady: () => void): void {
  stopReadinessObserver();

  const root = document.body ?? document.documentElement;
  if (!root) {
    return;
  }

  readinessObserver = new MutationObserver(() => {
    recordPageLifecycleEvent('MutationObserver:readiness', {
      readyState: document.readyState,
    });
    if (!isReady()) {
      return;
    }

    stopReadinessObserver();
    onReady();
  });

  readinessObserver.observe(root, { childList: true, subtree: true });
  setDebugState({ observerState: 'readiness', observerActive: true });
}

function staleGenerationDetails(generation: number): Record<string, unknown> {
  return {
    generation,
    currentGeneration: connectionGeneration,
    href: window.location.href,
  };
}

function isCurrentGeneration(generation: number): boolean {
  return !disposed && generation === connectionGeneration;
}

async function reportReadyAndAnchors(
  adapter: NonNullable<ReturnType<typeof resolveAdapter>>,
  generation: number,
): Promise<void> {
  if (!isCurrentGeneration(generation)) {
    recordPageLifecycleEvent('ready:stale', staleGenerationDetails(generation));
    return;
  }

  recordLifecycleEvent('PAGE_READY', adapter.platform);
  await sendToBackground({ type: 'PAGE_READY', platform: adapter.platform });

  if (!isCurrentGeneration(generation)) {
    recordPageLifecycleEvent('anchor-discovery:stale', staleGenerationDetails(generation));
    return;
  }

  // Discover candidate anchors (read-only) and report the ranked, validated
  // result. This locates *where* an advertisement could go; it inserts nothing,
  // changes no styles, and renders nothing.
  recordLifecycleEvent('ANCHOR_DISCOVERY_STARTED', adapter.platform);
  const anchors = discoverAnchors(adapter.platform, document);
  recordLifecycleEvent('ANCHORS_FOUND', adapter.platform, {
    anchorCount: anchors.length,
    anchors: anchors.map((anchor) => ({
      id: anchor.id,
      position: anchor.position,
      confidence: anchor.confidence,
      status: anchor.status,
    })),
    selectedAnchor: anchors[0]?.id ?? null,
  });
  setDebugState({
    anchorCount: anchors.length,
    selectedAnchor: anchors[0]?.id ?? null,
  });

  await sendToBackground({
    type: 'ANCHORS_DISCOVERED',
    platform: adapter.platform,
    anchors,
  });
}

async function connect(): Promise<void> {
  if (disposed) {
    return;
  }

  connectionGeneration += 1;
  const generation = connectionGeneration;
  stopReadinessObserver();
  incrementDebugCounter('connectAttempts');
  const adapter = resolveAdapter(window.location);
  recordLifecycleEvent('PROVIDER_DETECTED', adapter?.platform ?? 'UNKNOWN');
  recordLifecycleEvent('CONNECT_STARTED', adapter?.platform ?? 'UNKNOWN', {
    readyState: document.readyState,
  });
  const handshake = await sendToBackground({ type: 'CONTENT_SCRIPT_READY' });

  if (!handshake || !handshake.ok) {
    // Connectivity could not be established. The script stays idle rather than
    // disrupting the host page; no DOM work depends on this in the current sprint.
    return;
  }

  if (!isCurrentGeneration(generation)) {
    recordPageLifecycleEvent('connect:stale', staleGenerationDetails(generation));
    return;
  }

  recordMessageEvent('BACKGROUND_HANDSHAKE_OK', adapter?.platform ?? 'UNKNOWN');
  recordLifecycleEvent('CONNECT_FINISHED', adapter?.platform ?? 'UNKNOWN', {
    hasDiagnostics: Boolean(handshake.diagnostics),
  });

  // Report the platform for this tab, derived from the URL only. Unsupported
  // domains report UNKNOWN so the worker has a consistent view of every tab.
  await sendToBackground({
    type: 'PLATFORM_DETECTED',
    platform: adapter?.platform ?? 'UNKNOWN',
  });

  // Unsupported pages have no readiness lifecycle and are ignored from here.
  if (!adapter) {
    return;
  }

  // Wait (read-only) for the platform's root to mount, then report readiness.
  // Delayed initialization is absorbed by polling; an unsupported layout that
  // never mounts simply times out without reporting and without errors.
  const ready = await waitForReady(
    () => adapter.isReady(document),
    () => isCurrentGeneration(generation),
  );

  if (!isCurrentGeneration(generation)) {
    recordPageLifecycleEvent('readiness:stale', staleGenerationDetails(generation));
    return;
  }

  if (!ready) {
    recordLifecycleEvent('WAIT_TIMEOUT', adapter.platform);
    recordLifecycleEvent('FALLBACK_OBSERVER_STARTED', adapter.platform);
    observeReadiness(
      () => isCurrentGeneration(generation) && adapter.isReady(document),
      () => {
        if (!isCurrentGeneration(generation)) {
          recordPageLifecycleEvent('fallback:stale', staleGenerationDetails(generation));
          return;
        }
        recordLifecycleEvent('FALLBACK_TRIGGERED', adapter.platform);
        void reportReadyAndAnchors(adapter, generation);
      },
    );
    return;
  }

  await reportReadyAndAnchors(adapter, generation);
}

// One renderer per tab. It owns the single recommendation-line node and its
// reversible lifecycle; nothing here renders until the worker commands it.
const renderer = createRecommendationRenderer();

// The rendered command identity currently verified in the DOM. Includes the
// impression id so scheduled rotation can refresh a same-ad native link while
// duplicate delivery of the exact same command remains idempotent.
let lastRenderedKey: string | null = null;
let currentCommand: Extract<BackgroundCommand, { type: 'RENDER_RECOMMENDATION' }> | null = null;
let recoveryObserver: MutationObserver | null = null;
let visibilityTracker: VisibilityTracker | null = null;
let impressionReported = false;
let lastKnownUrl = window.location.href;
let attentionIdle = false;
let attentionTimer: ReturnType<typeof setTimeout> | null = null;
let lastAttentionActive: boolean | null = null;
let connectionGeneration = 0;

function conversationId(): string | null {
  return window.location.pathname || null;
}

function stopRecovery(): void {
  recoveryObserver?.disconnect();
  recoveryObserver = null;
  setDebugState({ observerActive: false });
}

function stopTracking(): void {
  visibilityTracker?.disconnect();
  visibilityTracker = null;
  replaceActiveTimer('impression_visibility', false);
}

function resetLifecycleState(): void {
  stopTracking();
  impressionReported = false;
}

function pageCanReceiveAttention(): boolean {
  return (
    !attentionIdle &&
    !document.hidden &&
    document.visibilityState === 'visible' &&
    document.hasFocus()
  );
}

function reportAttention(): void {
  const active = pageCanReceiveAttention();
  if (active === lastAttentionActive) {
    return;
  }

  lastAttentionActive = active;
  void sendToBackground({ type: 'ATTENTION_STATE', active });
}

function clearAttentionTimer(): void {
  if (attentionTimer !== null) {
    clearTimeout(attentionTimer);
    attentionTimer = null;
    replaceActiveTimer('attention_idle', false);
  }
}

function armAttentionTimer(): void {
  clearAttentionTimer();
  attentionTimer = setTimeout(() => {
    attentionIdle = true;
    reportAttention();
    replaceActiveTimer('attention_idle', false);
  }, ATTENTION_IDLE_TIMEOUT_MS);
  replaceActiveTimer('attention_idle', true);
}

function markAttentionActivity(): void {
  attentionIdle = false;
  armAttentionTimer();
  reportAttention();
}

function installAttentionHooks(): void {
  for (const eventType of ATTENTION_EVENTS) {
    window.addEventListener(eventType, markAttentionActivity, { passive: true });
    registerCleanup(() => removeWindowListener(eventType, markAttentionActivity));
  }
  document.addEventListener('visibilitychange', reportAttention);
  window.addEventListener('focus', reportAttention);
  window.addEventListener('blur', reportAttention);
  registerCleanup(() => removeDocumentListener('visibilitychange', reportAttention));
  registerCleanup(() => removeWindowListener('focus', reportAttention));
  registerCleanup(() => removeWindowListener('blur', reportAttention));
  registerCleanup(clearAttentionTimer);
  armAttentionTimer();
  reportAttention();
}

function renderKey(command: Extract<BackgroundCommand, { type: 'RENDER_RECOMMENDATION' }>): string {
  return `${command.content.id}:${command.tracking.impressionId}`;
}

function handleRouteChange(): void {
  if (disposed) {
    return;
  }

  const currentUrl = window.location.href;
  if (currentUrl === lastKnownUrl) {
    recordPageLifecycleEvent('routechange:ignored', { currentUrl });
    return;
  }

  recordPageLifecycleEvent('routechange', {
    from: lastKnownUrl,
    to: currentUrl,
  });
  lastKnownUrl = currentUrl;
  renderer.destroy();
  currentCommand = null;
  lastRenderedKey = null;
  stopRecovery();
  resetLifecycleState();
  void connect();
}

function installNavigationHooks(): void {
  const historyState = window.history;

  const patch = (method: 'pushState' | 'replaceState'): void => {
    const original = historyState[method];
    if (typeof original !== 'function') {
      return;
    }

    const patchedHistoryMethod = function patchedHistoryMethod(
      ...args: Parameters<typeof historyState.pushState>
    ) {
      const result = original.apply(historyState, args);
      recordPageLifecycleEvent(`history:${method}`, {
        target: typeof args[2] === 'string' ? args[2] : null,
      });
      handleRouteChange();
      return result;
    } as typeof original;

    historyState[method] = patchedHistoryMethod;
    registerCleanup(() => {
      if (historyState[method] === patchedHistoryMethod) {
        historyState[method] = original;
      }
    });
  };

  patch('pushState');
  patch('replaceState');

  const onPopstate = (): void => {
    recordPageLifecycleEvent('popstate');
    handleRouteChange();
  };
  const onHashchange = (): void => {
    recordPageLifecycleEvent('hashchange');
    handleRouteChange();
  };

  window.addEventListener('popstate', onPopstate);
  window.addEventListener('hashchange', onHashchange);
  registerCleanup(() => removeWindowListener('popstate', onPopstate));
  registerCleanup(() => removeWindowListener('hashchange', onHashchange));
}

function startRecovery(): void {
  stopRecovery();
  const root = document.body ?? document.documentElement;
  if (!root) {
    return;
  }

  recoveryObserver = new MutationObserver(() => {
    if (disposed) {
      return;
    }
    recordPageLifecycleEvent('MutationObserver:recovery', {
      rendered: renderer.isRendered(),
      hasCurrentCommand: currentCommand !== null,
    });
    if (!renderer.isRendered() && currentCommand) {
      renderRecommendation(currentCommand, false);
    }
  });
  recoveryObserver.observe(root, {
    childList: true,
    subtree: true,
  });
  setDebugState({ observerState: 'active', observerActive: true });
}

function installPageLifecycleDiagnostics(): void {
  const onDOMContentLoaded = (): void => {
    recordPageLifecycleEvent('DOMContentLoaded', { readyState: document.readyState });
  };
  const onLoad = (): void => {
    recordPageLifecycleEvent('load', { readyState: document.readyState });
  };
  const onPageshow = (event: PageTransitionEvent): void => {
    recordPageLifecycleEvent('pageshow', {
      persisted: event.persisted,
      readyState: document.readyState,
    });
  };
  const onVisibilityChange = (): void => {
    recordPageLifecycleEvent('visibilitychange', {
      hidden: document.hidden,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
    });
  };

  document.addEventListener('DOMContentLoaded', onDOMContentLoaded);
  window.addEventListener('load', onLoad);
  window.addEventListener('pageshow', onPageshow);
  document.addEventListener('visibilitychange', onVisibilityChange);
  registerCleanup(() => removeDocumentListener('DOMContentLoaded', onDOMContentLoaded));
  registerCleanup(() => removeWindowListener('load', onLoad));
  registerCleanup(() => removeWindowListener('pageshow', onPageshow as EventListener));
  registerCleanup(() => removeDocumentListener('visibilitychange', onVisibilityChange));
}

function startTracking(
  command: Extract<BackgroundCommand, { type: 'RENDER_RECOMMENDATION' }>,
): void {
  const host = renderer.getHost();
  if (!host) return;

  const { content, placement } = command;
  const placementId = placement.anchor.id;

  visibilityTracker?.disconnect();
  visibilityTracker = null;
  replaceActiveTimer('impression_visibility', false);

  if (impressionReported) {
    return;
  }

  const startedAt = Date.now();
  visibilityTracker = createVisibilityTracker({
    element: host,
    durationMs: command.impressionDurationMs,
    onVisible: () => {
      if (impressionReported) {
        return;
      }
      impressionReported = true;
      void sendToBackground({
        type: 'VALID_IMPRESSION',
        adId: content.id,
        impressionId: command.tracking.impressionId,
        placementId,
        provider: placement.platform,
        conversationId: conversationId(),
        destinationUrl: content.url,
        viewedAt: startedAt,
        durationMs: command.impressionDurationMs,
      });
      setDebugState({ lastImpressionId: command.tracking.impressionId });
      replaceActiveTimer('impression_visibility', false);
    },
  });
  replaceActiveTimer('impression_visibility', true);
}

function clickIdFromHref(href: string): string | null {
  try {
    return new URL(href).searchParams.get('click_id');
  } catch {
    return null;
  }
}

function renderRecommendation(
  command: Extract<BackgroundCommand, { type: 'RENDER_RECOMMENDATION' }>,
  resetLifecycle: boolean,
): boolean {
  if (resetLifecycle) {
    resetLifecycleState();
  }

  incrementDebugCounter('renderAttempts');
  const renderTarget = command.placement.anchor.id;
  recordLifecycleEvent('RENDER_STARTED', command.placement.platform, {
    adId: command.content.id,
    reason: command.reason ?? 'initial',
    impressionId: command.tracking.impressionId,
    selectedAnchor: renderTarget,
  });
  setDebugState({
    renderTarget,
    selectedAnchor: renderTarget,
    controllerState: 'rendering',
  });

  const request = planLayout(command.placement, command.content, document, command.tracking);
  const rendered = request ? renderer.rerender(request) : false;

  if (rendered) {
    lastRenderedKey = renderKey(command);
    currentCommand = command;
    startRecovery();
    startTracking(command);
    const clickId = clickIdFromHref(command.tracking.href);
    setDebugState({
      provider: command.placement.platform,
      recommendationState: 'rendered',
      rotationState: 'rendered',
      lastRenderedHref: command.tracking.href,
      lastDestinationUrl: command.content.url,
      lastImpressionId: command.tracking.impressionId,
      lastClickId: clickId,
      renderTarget: request?.layout.landmarkSelector ?? renderTarget,
      controllerState: 'rendered',
    });
    if (command.reason === 'rotation') {
      recordLifecycleEvent('ROTATION_STARTED', command.placement.platform, {
        impressionId: command.tracking.impressionId,
      });
    }
    recordLifecycleEvent('RENDER_COMPLETED', command.placement.platform, {
      adId: command.content.id,
      href: command.tracking.href,
      impressionId: command.tracking.impressionId,
      destinationUrl: command.content.url,
      selectedAnchor: command.placement.anchor.id,
      renderTarget: request?.layout.landmarkSelector ?? null,
      rendered: true,
    });
    recordClickEvent('TRACKING_LINK_RENDERED', {
      provider: command.placement.platform,
      apiBaseUrl: getDebugState()?.apiBaseUrl,
      href: command.tracking.href,
      clickId,
      impressionId: command.tracking.impressionId,
      destinationUrl: command.content.url,
    });
    if (command.reason === 'rotation') {
      recordLifecycleEvent('ROTATION_STOPPED', command.placement.platform, {
        impressionId: command.tracking.impressionId,
        rendered: true,
      });
    }
  } else {
    if (resetLifecycle) {
      lastRenderedKey = null;
      currentCommand = null;
      stopRecovery();
    }
    stopTracking();
    setDebugState({
      recommendationState: 'failed',
      rotationState: 'idle',
      renderTarget,
      controllerState: 'failed',
    });
    recordLifecycleEvent('RENDER_COMPLETED', command.placement.platform, {
      adId: command.content.id,
      impressionId: command.tracking.impressionId,
      selectedAnchor: command.placement.anchor.id,
      renderTarget: request?.layout.landmarkSelector ?? null,
      rendered: false,
    });
    if (command.reason === 'rotation') {
      recordLifecycleEvent('ROTATION_STOPPED', command.placement.platform, {
        impressionId: command.tracking.impressionId,
        rendered: false,
      });
    }
  }

  return rendered;
}

function handleCommand(command: BackgroundCommand): BackgroundCommandResponse {
  if (disposed) {
    return { ok: false, message: 'Content script runtime disposed' };
  }

  switch (command.type) {
    case 'RENDER_RECOMMENDATION': {
      recordCommandLifecycleEvents(command.diagnostics ?? []);
      recordMessageEvent('CONTENT_RECEIVED_RENDER', command.placement.platform, {
        reason: command.reason ?? 'initial',
        adId: command.content.id,
        impressionId: command.tracking.impressionId,
        selectedAnchor: command.placement.anchor.id,
      });
      // Same render command already inserted and still in the live DOM — idempotent no-op.
      // No re-render, no event, no flicker.
      if (renderKey(command) === lastRenderedKey && renderer.isRendered()) {
        return { ok: true, rendered: true };
      }

      // The layout strategy lives here, where the DOM exists: resolve the
      // platform's footer layout for the selected placement, then render the
      // generic one-line recommendation with the real backend content the render
      // controller already resolved (fresh API data → cache). The content script
      // never calls the SDK and never picks the content; it only places and
      // renders. The layout sits in adjacent footer space and never modifies any
      // first-party disclaimer. No safe footer placement → render nothing.
      const rendered = renderRecommendation(command, true);

      return { ok: true, rendered };
    }
    case 'DESTROY_RECOMMENDATION':
      renderer.destroy();
      lastRenderedKey = null;
      currentCommand = null;
      stopRecovery();
      stopTracking();
      setDebugState({
        recommendationState: 'destroyed',
        rotationState: 'idle',
        controllerState: 'destroyed',
      });
      return { ok: true, rendered: false };
  }
}

// Listen for worker -> content commands (render / destroy recommendation). Every
// branch resolves synchronously to a typed response and never throws, so the
// worker never sees a dropped channel or an uncaught rejection.
function handleRuntimeMessage(
  command: BackgroundCommand,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: BackgroundCommandResponse) => void,
): boolean {
  try {
    sendResponse(handleCommand(command));
  } catch (error) {
    sendResponse({
      ok: false,
      message: error instanceof Error ? error.message : 'Recommendation command failed',
    });
  }
  return false;
}

function teardownContentRuntime(): void {
  if (disposed) {
    return;
  }

  disposed = true;
  connectionGeneration += 1;
  stopReadinessObserver();
  renderer.destroy();
  lastRenderedKey = null;
  currentCommand = null;
  stopRecovery();
  resetLifecycleState();
  clearAttentionTimer();

  for (const cleanup of cleanupCallbacks.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // Best-effort cleanup only.
    }
  }

  if (window.__airewardsContentRuntime?.teardown === teardownContentRuntime) {
    window.__airewardsContentRuntime = undefined;
  }
}

chrome.runtime.onMessage.addListener(handleRuntimeMessage);
registerCleanup(() => {
  try {
    chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
  } catch {
    // MV3 exposes removeListener, but tests and stale contexts may not.
  }
});

window.__airewardsContentRuntime = { teardown: teardownContentRuntime };

void connect();
installPageLifecycleDiagnostics();
installNavigationHooks();
installAttentionHooks();
