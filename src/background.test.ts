import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from './adapters/types';
import type { Anchor } from './adapters/types';
import type { ContentScriptRequest, ContentScriptResponse, ExtensionRequest } from './messages';

const shared = vi.hoisted(() => {
  const placement = {
    platform: 'CHATGPT',
    anchor: {
      id: 'chatgpt-below-input',
      platform: 'CHATGPT',
      position: 'below_input',
      confidence: 0.8,
      status: 'valid',
    },
  };

  return {
    activeTabId: 1,
    messageListener: null as
      | ((
          message: ContentScriptRequest,
          sender: chrome.runtime.MessageSender,
          sendResponse: (response: ContentScriptResponse) => void,
        ) => boolean | undefined)
      | null,
    alarmListener: null as ((alarm: chrome.alarms.Alarm) => void) | null,
    removedListener: null as ((tabId: number) => void) | null,
    activatedListener: null as ((activeInfo: chrome.tabs.TabActiveInfo) => void) | null,
    focusChangedListener: null as ((windowId: number) => void) | null,
    requestRender: vi.fn(),
    requestRefresh: vi.fn(),
    requestRotation: vi.fn(),
    requestDestroy: vi.fn(),
    providerDiagnosticHandler: null as
      | ((event: { name: string; timestamp: string }) => void)
      | null,
    impressionRecord: vi.fn(),
    impressionFlush: vi.fn(),
    impressionSweep: vi.fn(),
    placementPlan: vi.fn(() => placement),
    placement,
    sessionStorage: {} as Record<string, unknown>,
  };
});

vi.mock('./config', () => ({
  config: {
    apiBaseUrl: 'http://localhost:3001',
    webAppUrl: 'http://localhost:3001',
    buildMode: 'development',
    diagnosticsEnabled: true,
    extensionVersion: '0.1.0-test',
    buildId: 'test-build-id',
    builtAt: '2026-06-28T12:00:00.000Z',
  },
}));

vi.mock('./sdk', () => ({
  sdk: {
    v1: {
      user: { $get: vi.fn() },
      wallet: { $get: vi.fn() },
    },
  },
}));

vi.mock('./sponsored', () => ({
  createSponsoredProvider: vi.fn(
    (options?: { onDiagnosticEvent?: (event: { name: string; timestamp: string }) => void }) => {
      shared.providerDiagnosticHandler = options?.onDiagnosticEvent ?? null;
      return {
        resolve: vi.fn(),
        refresh: vi.fn(),
        rotate: vi.fn(),
        getTrackingSignature: vi.fn(),
      };
    },
  ),
}));

vi.mock('./impression', () => ({
  createImpressionService: vi.fn(() => ({
    record: shared.impressionRecord,
    flush: shared.impressionFlush,
    sweep: shared.impressionSweep,
  })),
}));

vi.mock('./click/service', () => ({
  createClickService: vi.fn(() => ({
    buildTrackingLink: vi.fn(),
  })),
}));

vi.mock('./controllers', () => ({
  createRenderController: vi.fn(() => ({
    requestRender: shared.requestRender,
    requestRefresh: shared.requestRefresh,
    requestRotation: shared.requestRotation,
    requestDestroy: shared.requestDestroy,
  })),
}));

vi.mock('./placement', () => ({
  createPlacementEngine: vi.fn(() => ({
    plan: shared.placementPlan,
  })),
}));

function installChromeMock(): void {
  shared.messageListener = null;
  shared.alarmListener = null;
  shared.removedListener = null;
  shared.activatedListener = null;
  shared.focusChangedListener = null;

  vi.stubGlobal('chrome', {
    tabs: {
      create: vi.fn(),
      query: vi.fn((_query: chrome.tabs.QueryInfo, callback: (tabs: chrome.tabs.Tab[]) => void) => {
        callback([{ id: shared.activeTabId } as chrome.tabs.Tab]);
      }),
      onRemoved: {
        addListener: vi.fn((listener) => {
          shared.removedListener = listener;
        }),
      },
      onActivated: {
        addListener: vi.fn((listener) => {
          shared.activatedListener = listener;
        }),
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: {
        addListener: vi.fn((listener) => {
          shared.focusChangedListener = listener;
        }),
      },
    },
    runtime: {
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((listener) => {
          shared.messageListener = listener;
        }),
      },
    },
    alarms: {
      get: vi.fn((_name: string, callback: (alarm?: chrome.alarms.Alarm) => void) =>
        callback(undefined),
      ),
      create: vi.fn(),
      onAlarm: {
        addListener: vi.fn((listener) => {
          shared.alarmListener = listener;
        }),
      },
    },
    storage: {
      session: {
        get: vi.fn((key: string, callback: (items: Record<string, unknown>) => void) => {
          callback({ [key]: shared.sessionStorage[key] });
        }),
        set: vi.fn((items: Record<string, unknown>, callback?: () => void) => {
          Object.assign(shared.sessionStorage, items);
          callback?.();
        }),
        remove: vi.fn((key: string, callback?: () => void) => {
          delete shared.sessionStorage[key];
          callback?.();
        }),
      },
    },
  });
  vi.stubGlobal('self', { addEventListener: vi.fn() });
}

async function loadBackground(): Promise<void> {
  vi.resetModules();
  installChromeMock();
  await import('./background');
}

function sendContent(
  message: ContentScriptRequest | { type: 'ATTENTION_STATE'; active: boolean },
  tabId: number,
): ContentScriptResponse {
  const listener = shared.messageListener;
  if (!listener) throw new Error('background listener missing');
  let response: ContentScriptResponse | null = null;
  listener(
    message as ContentScriptRequest,
    { tab: { id: tabId } } as chrome.runtime.MessageSender,
    (value) => {
      response = value;
    },
  );
  if (!response) throw new Error('background response missing');
  return response;
}

function sendExtension(message: ExtensionRequest, tabId = 1): ContentScriptResponse {
  const listener = shared.messageListener;
  if (!listener) throw new Error('background listener missing');
  let response: ContentScriptResponse | null = null;
  listener(
    message as ContentScriptRequest,
    { tab: { id: tabId } } as chrome.runtime.MessageSender,
    (value) => {
      response = value as ContentScriptResponse;
    },
  );
  if (!response) throw new Error('background response missing');
  return response;
}

function reportRenderableTab(tabId: number): void {
  const anchors: Anchor[] = [
    {
      id: 'chatgpt-below-input',
      platform: Platform.CHATGPT,
      position: 'below_input',
      confidence: 0.8,
      status: 'valid',
    },
  ];

  sendContent({ type: 'PLATFORM_DETECTED', platform: Platform.CHATGPT }, tabId);
  sendContent({ type: 'PAGE_READY', platform: Platform.CHATGPT }, tabId);
  sendContent({ type: 'ANCHORS_DISCOVERED', platform: Platform.CHATGPT, anchors }, tabId);
}

describe('background rotation eligibility', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    shared.activeTabId = 1;
    shared.sessionStorage = {};
    await loadBackground();
  });

  it('rotates only the active tab in the focused window', () => {
    reportRenderableTab(1);
    reportRenderableTab(2);
    shared.activeTabId = 2;

    shared.alarmListener?.({ name: 'airewards-recommendation-refresh' } as chrome.alarms.Alarm);

    expect(shared.requestRotation).toHaveBeenCalledTimes(1);
    expect(shared.requestRotation).toHaveBeenCalledWith(2, shared.placement);
  });

  it('does not rotate an idle tab', () => {
    reportRenderableTab(1);
    sendContent({ type: 'ATTENTION_STATE', active: false }, 1);

    shared.alarmListener?.({ name: 'airewards-recommendation-refresh' } as chrome.alarms.Alarm);

    expect(shared.requestRotation).not.toHaveBeenCalled();
  });

  it('rejects an impression from an inactive tab', () => {
    const response = sendContent(
      {
        type: 'VALID_IMPRESSION',
        adId: 'ad-1',
        impressionId: 'impression-1',
        placementId: 'chatgpt-below-input',
        provider: Platform.CHATGPT,
        conversationId: null,
        destinationUrl: 'https://example.com',
        viewedAt: Date.now(),
        durationMs: 5_000,
      },
      2,
    );

    expect(response).toEqual({
      ok: false,
      message: 'Impression rejected because the tab is not active and focused.',
    });
    expect(shared.impressionRecord).not.toHaveBeenCalled();
  });

  it('clears impression eligibility when Chrome loses window focus', () => {
    shared.focusChangedListener?.(-1);

    const response = sendContent(
      {
        type: 'VALID_IMPRESSION',
        adId: 'ad-1',
        impressionId: 'impression-1',
        placementId: 'chatgpt-below-input',
        provider: Platform.CHATGPT,
        conversationId: null,
        destinationUrl: 'https://example.com',
        viewedAt: Date.now(),
        durationMs: 5_000,
      },
      1,
    );

    expect(response.ok).toBe(false);
    expect(shared.impressionRecord).not.toHaveBeenCalled();
  });

  it('rotates after a service worker restart by hydrating the retained placement', async () => {
    reportRenderableTab(1);
    shared.requestRotation.mockClear();

    await loadBackground();
    shared.alarmListener?.({ name: 'airewards-recommendation-refresh' } as chrome.alarms.Alarm);

    await vi.waitFor(() =>
      expect(shared.requestRotation).toHaveBeenCalledWith(1, shared.placement),
    );
  });

  it('continues rotating on repeated alarm wakeups after hydrating retained placement', async () => {
    reportRenderableTab(1);
    shared.requestRotation.mockClear();

    await loadBackground();
    shared.alarmListener?.({ name: 'airewards-recommendation-refresh' } as chrome.alarms.Alarm);
    await vi.waitFor(() => expect(shared.requestRotation).toHaveBeenCalledTimes(1));

    await loadBackground();
    shared.alarmListener?.({ name: 'airewards-recommendation-refresh' } as chrome.alarms.Alarm);
    await vi.waitFor(() => expect(shared.requestRotation).toHaveBeenCalledTimes(2));

    await loadBackground();
    shared.alarmListener?.({ name: 'airewards-recommendation-refresh' } as chrome.alarms.Alarm);
    await vi.waitFor(() => expect(shared.requestRotation).toHaveBeenCalledTimes(3));

    expect(shared.requestRotation).toHaveBeenNthCalledWith(1, 1, shared.placement);
    expect(shared.requestRotation).toHaveBeenNthCalledWith(2, 1, shared.placement);
    expect(shared.requestRotation).toHaveBeenNthCalledWith(3, 1, shared.placement);

    const response = sendExtension({ type: 'GET_DEBUG_STATE' } as ExtensionRequest);
    expect(response.ok && response.diagnostics?.rotationEvents.map((event) => event.name)).toEqual([
      'ROTATION_TIMER_STARTED',
      'ROTATION_TIMER_FIRED',
      'BACKGROUND_STARTED_ROTATION_FETCH',
      'BACKGROUND_ROTATION_FETCH_COMPLETED',
    ]);
  });

  it('retains only the rendered placement state needed for rotation wakeups', async () => {
    reportRenderableTab(1);

    await vi.waitFor(() =>
      expect(shared.sessionStorage.airewardsRenderedTabStates).toEqual({
        '1': {
          platform: Platform.CHATGPT,
          ready: true,
          attentionActive: true,
          anchors: [shared.placement.anchor],
          placement: shared.placement,
        },
      }),
    );
  });

  it('clears retained placement state when a tab closes', async () => {
    reportRenderableTab(1);
    await vi.waitFor(() => expect(shared.sessionStorage.airewardsRenderedTabStates).toBeDefined());

    shared.removedListener?.(1);

    await vi.waitFor(() => expect(shared.sessionStorage.airewardsRenderedTabStates).toEqual({}));
  });

  it('reports development diagnostics for the running service worker configuration', () => {
    reportRenderableTab(1);

    const response = sendExtension({ type: 'GET_DEBUG_STATE' } as ExtensionRequest);

    expect(response).toEqual({
      ok: true,
      acknowledged: true,
      diagnostics: {
        apiBaseUrl: 'http://localhost:3001',
        buildMode: 'development',
        diagnosticsEnabled: true,
        extensionVersion: '0.1.0-test',
        buildId: 'test-build-id',
        builtAt: '2026-06-28T12:00:00.000Z',
        rotationEvents: expect.any(Array),
        recommendationEvents: expect.any(Array),
        tabs: [
          {
            tabId: 1,
            platform: Platform.CHATGPT,
            ready: true,
            attentionActive: true,
            anchorCount: 1,
            hasPlacement: true,
          },
        ],
      },
    });
  });

  it('returns a timestamped PAGE_READY boundary diagnostic', () => {
    sendContent({ type: 'PLATFORM_DETECTED', platform: Platform.CLAUDE }, 1);

    const response = sendContent({ type: 'PAGE_READY', platform: Platform.CLAUDE }, 1);

    expect(response).toMatchObject({
      ok: true,
      acknowledged: true,
      events: [
        {
          name: 'BACKGROUND_RECEIVED_PAGE_READY',
          provider: Platform.CLAUDE,
          details: { tabId: 1 },
        },
      ],
    });
    expect(response.ok && response.events?.[0]?.timestamp).toEqual(expect.any(String));
  });

  it('reports provider request diagnostics through the development debug state', () => {
    shared.providerDiagnosticHandler?.({
      name: 'FALLBACK_SELECTED',
      timestamp: '2026-06-28T12:00:00.000Z',
    });

    const response = sendExtension({ type: 'GET_DEBUG_STATE' } as ExtensionRequest);

    expect(response.ok && response.diagnostics?.recommendationEvents).toEqual([
      {
        name: 'FALLBACK_SELECTED',
        timestamp: '2026-06-28T12:00:00.000Z',
      },
    ]);
  });
});
