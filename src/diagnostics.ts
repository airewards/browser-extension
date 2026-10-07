import type { SupportedPlatform } from './adapters/types';
import { config } from './config';

export type LifecycleEventName =
  | 'CONTENT_SCRIPT_LOADED'
  | 'PROVIDER_DETECTED'
  | 'CONNECT_STARTED'
  | 'CONNECT_FINISHED'
  | 'PAGE_READY'
  | 'ANCHOR_DISCOVERY_STARTED'
  | 'ANCHORS_FOUND'
  | 'RECOMMENDATION_FETCH_STARTED'
  | 'RECOMMENDATION_FETCH_COMPLETED'
  | 'RENDER_STARTED'
  | 'RENDER_COMPLETED'
  | 'ROTATION_STARTED'
  | 'ROTATION_STOPPED'
  | 'WAIT_TIMEOUT'
  | 'FALLBACK_OBSERVER_STARTED'
  | 'FALLBACK_TRIGGERED';

export type MessageEventName =
  | 'BACKGROUND_HANDSHAKE_OK'
  | 'BACKGROUND_RECEIVED_PAGE_READY'
  | 'ROTATION_TIMER_STARTED'
  | 'ROTATION_TIMER_FIRED'
  | 'BACKGROUND_STARTED_ROTATION_FETCH'
  | 'BACKGROUND_ROTATION_FETCH_COMPLETED'
  | 'BACKGROUND_STARTED_RECOMMENDATION_FETCH'
  | 'BACKGROUND_FETCH_COMPLETED'
  | 'RENDER_COMMAND_CREATED'
  | 'RENDER_SKIPPED'
  | 'BACKGROUND_SENT_RENDER'
  | 'CONTENT_RECEIVED_RENDER';

export type DiagnosticEventName = LifecycleEventName | MessageEventName;

export type ClickEventName =
  | 'TRACKING_LINK_RENDERED'
  | 'BROWSER_NAVIGATION_START'
  | 'REQUEST_DISPATCHED'
  | 'RESPONSE_RECEIVED'
  | 'REDIRECT_RECEIVED'
  | 'NAVIGATION_COMPLETE';

export interface DiagnosticEvent {
  readonly name: DiagnosticEventName;
  readonly timestamp: string;
  readonly url: string;
  readonly pathname: string;
  readonly provider: SupportedPlatform | 'UNKNOWN' | null;
  readonly conversationId: string | null;
  readonly anchorCount: number;
  readonly selectedAnchor: string | null;
  readonly renderTarget: string | null;
  readonly recommendationState: AIRewardsDebugState['recommendationState'];
  readonly details?: Record<string, unknown>;
}

export interface PageLifecycleDiagnosticEvent {
  readonly name: string;
  readonly timestamp: string;
  readonly url: string;
  readonly pathname: string;
  readonly conversationId: string | null;
  readonly details?: Record<string, unknown>;
}

export interface CommandDiagnosticEvent {
  readonly name: DiagnosticEventName;
  readonly timestamp: string;
  readonly provider: SupportedPlatform | 'UNKNOWN' | null;
  readonly details?: Record<string, unknown>;
}

export interface TransportDiagnosticEvent {
  readonly timestamp: string;
  readonly url: string;
  readonly pathname: string;
  readonly provider: SupportedPlatform | 'UNKNOWN' | null;
  readonly conversationId: string | null;
  readonly messageType: string;
  readonly direction: 'content-to-background' | 'background-to-content';
  readonly details?: Record<string, unknown>;
}

export interface DiagnosticClickEvent {
  readonly name: ClickEventName;
  readonly timestamp: string;
  readonly url: string;
  readonly provider: SupportedPlatform | 'UNKNOWN' | null;
  readonly conversationId: string | null;
  readonly pathname: string;
  readonly apiBaseUrl?: string;
  readonly href?: string;
  readonly clickId?: string | null;
  readonly impressionId?: string | null;
  readonly destinationUrl?: string | null;
  readonly responseStatus?: number;
  readonly redirectLocation?: string | null;
  readonly error?: string;
}

export interface AIRewardsDebugState {
  provider: SupportedPlatform | 'UNKNOWN' | null;
  pathname: string;
  apiBaseUrl: string;
  extensionVersion: string;
  buildMode: 'development' | 'production';
  buildId: string;
  builtAt: string;
  recommendationState: 'idle' | 'rendered' | 'destroyed' | 'failed';
  observerState: 'idle' | 'readiness' | 'active' | 'disconnected';
  rotationState: 'idle' | 'rendered' | 'rotating';
  activeTimers: string[];
  lastImpressionId: string | null;
  lastClickId: string | null;
  lastRenderedHref: string | null;
  lastDestinationUrl: string | null;
  lastLifecycleEvent: DiagnosticEvent | null;
  lastPageLifecycleEvent: PageLifecycleDiagnosticEvent | null;
  lastSuccessfulRender: DiagnosticEvent | null;
  lastRenderCommand: DiagnosticEvent | null;
  lastBackgroundMessage: TransportDiagnosticEvent | DiagnosticEvent | null;
  lastContentMessage: TransportDiagnosticEvent | DiagnosticEvent | null;
  lastAnchorDiscovery: DiagnosticEvent | null;
  lastConnect: DiagnosticEvent | null;
  anchorCount: number;
  selectedAnchor: string | null;
  renderTarget: string | null;
  renderAttempts: number;
  connectAttempts: number;
  observerActive: boolean;
  controllerState:
    | 'idle'
    | 'connecting'
    | 'connected'
    | 'ready'
    | 'discovering'
    | 'rendering'
    | 'rendered'
    | 'destroyed'
    | 'failed'
    | 'rotating';
  lifecycleEvents: DiagnosticEvent[];
  messageEvents: DiagnosticEvent[];
  pageLifecycleEvents: PageLifecycleDiagnosticEvent[];
  clickEvents: DiagnosticClickEvent[];
}

declare global {
  interface Window {
    __airewardsDebug?: AIRewardsDebugState;
  }
}

const MAX_EVENTS = 100;

function currentTimestamp(): string {
  return new Date().toISOString();
}

function currentUrl(): string {
  return globalThis.window?.location?.href ?? '';
}

function currentPathname(): string {
  return globalThis.window?.location?.pathname ?? '';
}

function currentConversationId(): string | null {
  return globalThis.window?.location?.pathname || null;
}

function trimEvents<T>(events: T[]): void {
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
}

export function diagnosticsEnabled(): boolean {
  return config.diagnosticsEnabled === true;
}

export function getDebugState(): AIRewardsDebugState | null {
  if (!diagnosticsEnabled() || typeof window === 'undefined') {
    return null;
  }

  if (!window.__airewardsDebug) {
    window.__airewardsDebug = {
      provider: null,
      pathname: currentPathname(),
      apiBaseUrl: config.apiBaseUrl,
      extensionVersion: config.extensionVersion,
      buildMode: config.buildMode,
      buildId: config.buildId,
      builtAt: config.builtAt,
      recommendationState: 'idle',
      observerState: 'idle',
      rotationState: 'idle',
      activeTimers: [],
      lastImpressionId: null,
      lastClickId: null,
      lastRenderedHref: null,
      lastDestinationUrl: null,
      lastLifecycleEvent: null,
      lastPageLifecycleEvent: null,
      lastSuccessfulRender: null,
      lastRenderCommand: null,
      lastBackgroundMessage: null,
      lastContentMessage: null,
      lastAnchorDiscovery: null,
      lastConnect: null,
      anchorCount: 0,
      selectedAnchor: null,
      renderTarget: null,
      renderAttempts: 0,
      connectAttempts: 0,
      observerActive: false,
      controllerState: 'idle',
      lifecycleEvents: [],
      messageEvents: [],
      pageLifecycleEvents: [],
      clickEvents: [],
    };
  }

  window.__airewardsDebug.pathname = currentPathname();

  return window.__airewardsDebug;
}

export function setDebugState(update: Partial<AIRewardsDebugState>): void {
  const state = getDebugState();
  if (!state) {
    return;
  }
  Object.assign(state, update);
}

function isMessageEventName(name: DiagnosticEventName): name is MessageEventName {
  return (
    name === 'BACKGROUND_HANDSHAKE_OK' ||
    name === 'BACKGROUND_RECEIVED_PAGE_READY' ||
    name === 'ROTATION_TIMER_STARTED' ||
    name === 'ROTATION_TIMER_FIRED' ||
    name === 'BACKGROUND_STARTED_ROTATION_FETCH' ||
    name === 'BACKGROUND_ROTATION_FETCH_COMPLETED' ||
    name === 'BACKGROUND_STARTED_RECOMMENDATION_FETCH' ||
    name === 'BACKGROUND_FETCH_COMPLETED' ||
    name === 'RENDER_COMMAND_CREATED' ||
    name === 'RENDER_SKIPPED' ||
    name === 'BACKGROUND_SENT_RENDER' ||
    name === 'CONTENT_RECEIVED_RENDER'
  );
}

function createDiagnosticEvent(
  name: DiagnosticEventName,
  provider: SupportedPlatform | 'UNKNOWN' | null,
  details?: Record<string, unknown>,
  options?: { timestamp?: string },
): DiagnosticEvent | null {
  const state = getDebugState();
  if (!state) {
    return null;
  }

  return {
    name,
    timestamp: options?.timestamp ?? currentTimestamp(),
    url: currentUrl(),
    pathname: currentPathname(),
    provider,
    conversationId: currentConversationId(),
    anchorCount: state.anchorCount,
    selectedAnchor:
      typeof details?.selectedAnchor === 'string' ? details.selectedAnchor : state.selectedAnchor,
    renderTarget:
      typeof details?.renderTarget === 'string' ? details.renderTarget : state.renderTarget,
    recommendationState: state.recommendationState,
    ...(details ? { details } : {}),
  };
}

function applyDiagnosticState(event: DiagnosticEvent): void {
  const state = getDebugState();
  if (!state) {
    return;
  }

  state.provider = event.provider;
  state.pathname = event.pathname;
  state.lastLifecycleEvent = event;
  if (event.name === 'CONNECT_STARTED') {
    state.lastConnect = event;
    state.controllerState = 'connecting';
  }
  if (event.name === 'CONNECT_FINISHED') {
    state.lastConnect = event;
    state.controllerState = 'connected';
  }
  if (event.name === 'BACKGROUND_HANDSHAKE_OK') {
    state.lastBackgroundMessage = event;
    state.controllerState = 'connected';
  }
  if (event.name === 'PAGE_READY') {
    state.controllerState = 'ready';
  }
  if (event.name === 'BACKGROUND_RECEIVED_PAGE_READY') {
    state.lastBackgroundMessage = event;
  }
  if (event.name === 'ANCHOR_DISCOVERY_STARTED') {
    state.controllerState = 'discovering';
  }
  if (event.name === 'ANCHORS_FOUND') {
    state.lastAnchorDiscovery = event;
    state.controllerState = 'ready';
    const count = event.details?.anchorCount ?? event.details?.count;
    if (typeof count === 'number') {
      state.anchorCount = count;
    }
  }
  if (event.name === 'BACKGROUND_STARTED_RECOMMENDATION_FETCH') {
    state.lastBackgroundMessage = event;
  }
  if (event.name === 'BACKGROUND_STARTED_ROTATION_FETCH') {
    state.lastBackgroundMessage = event;
  }
  if (event.name === 'BACKGROUND_FETCH_COMPLETED') {
    state.lastBackgroundMessage = event;
  }
  if (event.name === 'RENDER_COMMAND_CREATED') {
    state.lastBackgroundMessage = event;
  }
  if (event.name === 'RENDER_SKIPPED') {
    state.lastBackgroundMessage = event;
    state.controllerState = 'failed';
  }
  if (event.name === 'BACKGROUND_ROTATION_FETCH_COMPLETED') {
    state.lastBackgroundMessage = event;
  }
  if (event.name === 'BACKGROUND_SENT_RENDER') {
    state.lastBackgroundMessage = event;
    state.lastRenderCommand = event;
  }
  if (event.name === 'CONTENT_RECEIVED_RENDER') {
    state.lastBackgroundMessage = event;
    state.lastRenderCommand = event;
  }
  if (event.name === 'RENDER_STARTED') {
    state.controllerState = 'rendering';
  }
  if (event.name === 'RENDER_COMPLETED') {
    const rendered = event.details?.rendered;
    if (rendered === true) {
      state.lastSuccessfulRender = event;
      state.controllerState = 'rendered';
    } else if (rendered === false) {
      state.controllerState = 'failed';
    }
  }
  if (event.name === 'ROTATION_STARTED') {
    state.controllerState = 'rotating';
    state.rotationState = 'rotating';
  }
  if (event.name === 'ROTATION_STOPPED') {
    if (state.recommendationState === 'rendered') {
      state.controllerState = 'rendered';
      state.rotationState = 'rendered';
    } else {
      state.controllerState = 'failed';
      state.rotationState = 'idle';
    }
  }
  state.lifecycleEvents.push(event);
  trimEvents(state.lifecycleEvents);
  if (isMessageEventName(event.name)) {
    state.messageEvents.push(event);
    trimEvents(state.messageEvents);
  }
}

export function recordLifecycleEvent(
  name: LifecycleEventName,
  provider: SupportedPlatform | 'UNKNOWN' | null,
  details?: Record<string, unknown>,
  options?: { timestamp?: string },
): void {
  const event = createDiagnosticEvent(name, provider, details, options);
  if (!event) {
    return;
  }

  applyDiagnosticState(event);
}

export function recordMessageEvent(
  name: MessageEventName,
  provider: SupportedPlatform | 'UNKNOWN' | null,
  details?: Record<string, unknown>,
  options?: { timestamp?: string },
): void {
  const event = createDiagnosticEvent(name, provider, details, options);
  if (!event) {
    return;
  }

  applyDiagnosticState(event);
}

export function recordCommandLifecycleEvents(events: readonly CommandDiagnosticEvent[]): void {
  for (const event of events) {
    if (isMessageEventName(event.name)) {
      recordMessageEvent(event.name, event.provider, event.details, { timestamp: event.timestamp });
    } else {
      recordLifecycleEvent(event.name, event.provider, event.details, {
        timestamp: event.timestamp,
      });
    }
  }
}

export function recordContentMessage(
  messageType: string,
  provider: SupportedPlatform | 'UNKNOWN' | null,
  details?: Record<string, unknown>,
): void {
  const state = getDebugState();
  if (!state) {
    return;
  }

  state.lastContentMessage = {
    timestamp: currentTimestamp(),
    url: currentUrl(),
    pathname: currentPathname(),
    provider,
    conversationId: currentConversationId(),
    messageType,
    direction: 'content-to-background',
    ...(details ? { details } : {}),
  };
}

export function recordBackgroundMessage(
  messageType: string,
  provider: SupportedPlatform | 'UNKNOWN' | null,
  details?: Record<string, unknown>,
): void {
  const state = getDebugState();
  if (!state) {
    return;
  }

  state.lastBackgroundMessage = {
    timestamp: currentTimestamp(),
    url: currentUrl(),
    pathname: currentPathname(),
    provider,
    conversationId: currentConversationId(),
    messageType,
    direction: 'background-to-content',
    ...(details ? { details } : {}),
  };
}

export function recordPageLifecycleEvent(name: string, details?: Record<string, unknown>): void {
  const state = getDebugState();
  if (!state) {
    return;
  }

  const event: PageLifecycleDiagnosticEvent = {
    name,
    timestamp: currentTimestamp(),
    url: currentUrl(),
    pathname: currentPathname(),
    conversationId: currentConversationId(),
    ...(details ? { details } : {}),
  };

  state.pathname = event.pathname;
  state.lastPageLifecycleEvent = event;
  state.pageLifecycleEvents.push(event);
  trimEvents(state.pageLifecycleEvents);
}

export function recordClickEvent(
  name: ClickEventName,
  input: Omit<DiagnosticClickEvent, 'name' | 'timestamp' | 'url' | 'pathname' | 'conversationId'>,
): void {
  const state = getDebugState();
  if (!state) {
    return;
  }

  const event: DiagnosticClickEvent = {
    name,
    timestamp: currentTimestamp(),
    url: currentUrl(),
    conversationId: currentConversationId(),
    ...input,
    pathname: currentPathname(),
  };

  state.clickEvents.push(event);
  trimEvents(state.clickEvents);
}

export function incrementDebugCounter(field: 'connectAttempts' | 'renderAttempts'): void {
  const state = getDebugState();
  if (!state) {
    return;
  }

  state[field] += 1;
}

export function replaceActiveTimer(timerName: string, active: boolean): void {
  const state = getDebugState();
  if (!state) {
    return;
  }

  const timers = new Set(state.activeTimers);
  if (active) {
    timers.add(timerName);
  } else {
    timers.delete(timerName);
  }
  state.activeTimers = [...timers].sort();
}
