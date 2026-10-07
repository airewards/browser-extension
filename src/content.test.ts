import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Anchor, Platform } from './adapters/types';
import type {
  BackgroundCommand,
  BackgroundCommandResponse,
  ContentScriptRequest,
  ContentScriptResponse,
} from './messages';

type ObserverInstance = {
  callback: MutationCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

type TestHost = HTMLElement & {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
};

type VisibilityTrackerProbe = {
  options: {
    element: Element;
    durationMs: number;
    onVisible: () => void;
  };
  disconnect: ReturnType<typeof vi.fn>;
};

type RuntimeMessageListener = (
  command: BackgroundCommand,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: BackgroundCommandResponse) => void,
) => boolean | undefined;

type ListenerRegistry = Map<string, Set<EventListener>>;

const shared = vi.hoisted(() => {
  const renderState = { rendered: false };
  const hostState = {
    current: null as TestHost | null,
    hosts: [] as TestHost[],
  };
  const observerInstances: ObserverInstance[] = [];
  const visibilityTrackerInstances: VisibilityTrackerProbe[] = [];
  const sendMessage = vi.fn(
    async (_message?: ContentScriptRequest): Promise<ContentScriptResponse> => ({
      ok: true,
      acknowledged: true,
    }),
  );
  const planLayout = vi.fn();
  const discoverAnchors = vi.fn();
  const resolveAdapter = vi.fn();
  const disconnectVisibility = vi.fn();
  const createVisibilityTracker = vi.fn((options: VisibilityTrackerProbe['options']) => {
    const tracker = { options, disconnect: disconnectVisibility };
    visibilityTrackerInstances.push(tracker);
    return { disconnect: tracker.disconnect };
  });
  const listenerState = {
    listener: null as RuntimeMessageListener | null,
    listeners: [] as RuntimeMessageListener[],
    addListener: vi.fn((listener: RuntimeMessageListener) => {
      listenerState.listener = listener;
      listenerState.listeners.push(listener);
    }),
    removeListener: vi.fn((listener: RuntimeMessageListener) => {
      listenerState.listeners = listenerState.listeners.filter(
        (registered) => registered !== listener,
      );
      listenerState.listener = listenerState.listeners.at(-1) ?? null;
    }),
  };
  const windowListeners: ListenerRegistry = new Map();
  const documentListeners: ListenerRegistry = new Map();
  const renderer = {
    render: vi.fn(),
    destroy: vi.fn(() => {
      renderState.rendered = false;
      hostState.current = null;
    }),
    rerender: vi.fn(() => {
      renderState.rendered = true;
      const host = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as TestHost;
      hostState.current = host;
      hostState.hosts.push(host);
      return true;
    }),
    isRendered: vi.fn(() => renderState.rendered),
    getHost: vi.fn(() => (renderState.rendered ? hostState.current : null)),
  };

  return {
    renderState,
    hostState,
    observerInstances,
    visibilityTrackerInstances,
    sendMessage,
    planLayout,
    discoverAnchors,
    resolveAdapter,
    disconnectVisibility,
    createVisibilityTracker,
    listenerState,
    windowListeners,
    documentListeners,
    renderer,
  };
});

const READINESS_POLL_TICK_MS = 250;

class TestMutationObserver {
  callback: MutationCallback;
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(callback: MutationCallback) {
    this.callback = callback;
    shared.observerInstances.push(this);
  }
}

function addListener(registry: ListenerRegistry, type: string, listener: EventListener): void {
  const listeners = registry.get(type) ?? new Set<EventListener>();
  listeners.add(listener);
  registry.set(type, listeners);
}

function removeListener(registry: ListenerRegistry, type: string, listener: EventListener): void {
  registry.get(type)?.delete(listener);
}

function listenerCount(registry: ListenerRegistry, type: string): number {
  return registry.get(type)?.size ?? 0;
}

vi.mock('./adapters', () => ({
  resolveAdapter: shared.resolveAdapter,
}));

vi.mock('./anchors', () => ({
  discoverAnchors: shared.discoverAnchors,
}));

vi.mock('./layout', () => ({
  planLayout: shared.planLayout,
}));

vi.mock('./renderers', () => ({
  createRecommendationRenderer: () => shared.renderer,
}));

vi.mock('./tracking/visibility', () => ({
  createVisibilityTracker: shared.createVisibilityTracker,
}));

vi.mock('./config', () => ({
  config: {
    apiBaseUrl: 'http://localhost:3001',
    buildMode: 'development',
    diagnosticsEnabled: true,
    extensionVersion: '0.1.0-test',
    buildId: 'test-build-id',
    builtAt: '2026-06-28T12:00:00.000Z',
  },
}));

function setEnvironment(): void {
  shared.renderState.rendered = false;
  shared.hostState.current = null;
  shared.hostState.hosts.length = 0;
  shared.observerInstances.length = 0;
  shared.visibilityTrackerInstances.length = 0;
  shared.sendMessage.mockReset().mockResolvedValue({ ok: true, acknowledged: true });
  shared.planLayout.mockReset();
  shared.discoverAnchors.mockReset();
  shared.resolveAdapter.mockReset();
  shared.disconnectVisibility.mockReset();
  shared.createVisibilityTracker
    .mockReset()
    .mockImplementation((options: VisibilityTrackerProbe['options']) => {
      const tracker = { options, disconnect: shared.disconnectVisibility };
      shared.visibilityTrackerInstances.push(tracker);
      return { disconnect: tracker.disconnect };
    });
  shared.listenerState.listener = null;
  shared.listenerState.listeners.length = 0;
  shared.listenerState.addListener.mockClear();
  shared.listenerState.removeListener.mockClear();
  shared.windowListeners.clear();
  shared.documentListeners.clear();
  shared.renderer.render.mockReset();
  shared.renderer.destroy.mockClear().mockImplementation(() => {
    shared.renderState.rendered = false;
  });
  shared.renderer.rerender.mockClear().mockImplementation(() => {
    shared.renderState.rendered = true;
    const host = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as TestHost;
    shared.hostState.current = host;
    shared.hostState.hosts.push(host);
    return true;
  });
  shared.renderer.isRendered.mockClear().mockImplementation(() => shared.renderState.rendered);
  shared.renderer.getHost
    .mockClear()
    .mockImplementation(() => (shared.renderState.rendered ? shared.hostState.current : null));

  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: shared.sendMessage,
      onMessage: {
        addListener: shared.listenerState.addListener,
        removeListener: shared.listenerState.removeListener,
      },
    },
  });
  vi.stubGlobal('window', {
    location: { hostname: 'chatgpt.com', href: 'https://chatgpt.com/c/one', pathname: '/c/one' },
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      addListener(shared.windowListeners, type, listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      removeListener(shared.windowListeners, type, listener);
    }),
    dispatchEvent: vi.fn(),
    history: {
      pushState: vi.fn(),
      replaceState: vi.fn(),
    },
  });
  vi.stubGlobal('document', {
    body: {},
    documentElement: {},
    hidden: false,
    visibilityState: 'visible',
    hasFocus: vi.fn(() => true),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      addListener(shared.documentListeners, type, listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      removeListener(shared.documentListeners, type, listener);
    }),
    querySelector: vi.fn(() => ({})),
    readyState: 'complete',
  });
  vi.stubGlobal('MutationObserver', TestMutationObserver);
  Reflect.deleteProperty(globalThis, '__airewardsDebug');
}

async function loadContentModule(): Promise<void> {
  vi.resetModules();
  setEnvironment();
  shared.resolveAdapter.mockReturnValue({
    platform: Platform.CHATGPT,
    detect: vi.fn(() => true),
    isReady: vi.fn(() => true),
  });
  shared.discoverAnchors.mockReturnValue([]);
  shared.planLayout.mockReturnValue({
    platform: Platform.CHATGPT,
    layout: {
      landmarkSelector: 'main',
      insertion: 'beforeend',
      disclaimerPresent: true,
    },
    content: {
      id: 'ad-1',
      sponsor: 'Sponsored',
      message: 'Write with confidence',
      url: 'https://example.com',
    },
    tracking: {
      href: 'http://localhost:3001/v1/clicks?click_id=click-1',
      impressionId: '11111111-1111-4111-8111-111111111111',
    },
  });

  await import('./content');
}

async function dispatch(command: BackgroundCommand): Promise<BackgroundCommandResponse> {
  const listener = shared.listenerState.listener;
  if (!listener) {
    throw new Error('content script listener was not registered');
  }

  return await new Promise<BackgroundCommandResponse>((resolve) => {
    listener(command, { tab: { id: 1 } } as chrome.runtime.MessageSender, resolve);
  });
}

function renderedNotificationCount(): number {
  const calls = shared.sendMessage.mock.calls as unknown as Array<[{ type?: string }]>;
  return calls.filter(([message]) => message.type === 'VALID_IMPRESSION').length;
}

function validImpressionCount(): number {
  const calls = shared.sendMessage.mock.calls as unknown as Array<[{ type?: string }]>;
  return calls.filter(([message]) => message.type === 'VALID_IMPRESSION').length;
}

function tracking(
  id = '1',
): Extract<BackgroundCommand, { type: 'RENDER_RECOMMENDATION' }>['tracking'] {
  const impressionId =
    id === '2' ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111';
  return {
    href: `http://localhost:3001/v1/clicks?click_id=click-${id}`,
    impressionId,
  };
}

describe('content script recovery', () => {
  beforeEach(async () => {
    await loadContentModule();
  });

  it('re-renders when the host page removes the rendered recommendation', async () => {
    const command: BackgroundCommand = {
      type: 'RENDER_RECOMMENDATION',
      placement: {
        platform: Platform.CHATGPT,
        anchor: {
          id: 'chatgpt-below-input',
          platform: Platform.CHATGPT,
          position: 'below_input',
          confidence: 0.8,
          status: 'valid',
        },
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com',
      },
      tracking: tracking(),
      impressionDurationMs: 5_000,
    };

    const firstResponse = await dispatch(command);
    expect(firstResponse).toEqual({ ok: true, rendered: true });
    expect(shared.renderer.rerender).toHaveBeenCalledTimes(1);
    expect(shared.observerInstances).toHaveLength(1);
    expect(shared.observerInstances[0]?.observe).toHaveBeenCalled();
    expect(renderedNotificationCount()).toBe(0);

    shared.renderState.rendered = false;
    shared.observerInstances[0]?.callback(
      [],
      shared.observerInstances[0] as unknown as MutationObserver,
    );

    expect(shared.renderer.rerender).toHaveBeenCalledTimes(2);
    expect(shared.renderState.rendered).toBe(true);
    expect(renderedNotificationCount()).toBe(0);
  });

  it('stops recovery when the recommendation is destroyed', async () => {
    const command: BackgroundCommand = {
      type: 'RENDER_RECOMMENDATION',
      placement: {
        platform: Platform.CHATGPT,
        anchor: {
          id: 'chatgpt-below-input',
          platform: Platform.CHATGPT,
          position: 'below_input',
          confidence: 0.8,
          status: 'valid',
        },
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com',
      },
      tracking: tracking(),
      impressionDurationMs: 5_000,
    };

    await dispatch(command);
    const destroyResponse = await dispatch({ type: 'DESTROY_RECOMMENDATION' });

    expect(destroyResponse).toEqual({ ok: true, rendered: false });
    expect(shared.renderer.destroy).toHaveBeenCalledTimes(1);
    expect(shared.observerInstances[0]?.disconnect).toHaveBeenCalledTimes(1);

    shared.observerInstances[0]?.callback(
      [],
      shared.observerInstances[0] as unknown as MutationObserver,
    );

    expect(shared.renderer.rerender).toHaveBeenCalledTimes(1);
  });

  it('does not report an impression immediately after rendering', async () => {
    const command: BackgroundCommand = {
      type: 'RENDER_RECOMMENDATION',
      placement: {
        platform: Platform.CHATGPT,
        anchor: {
          id: 'chatgpt-below-input',
          platform: Platform.CHATGPT,
          position: 'below_input',
          confidence: 0.8,
          status: 'valid',
        },
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com',
      },
      tracking: tracking(),
      impressionDurationMs: 5_000,
    };

    await dispatch(command);

    expect(renderedNotificationCount()).toBe(0);
    expect(validImpressionCount()).toBe(0);
  });

  it('restarts visibility tracking on the recovered host when replacement happens before a valid impression', async () => {
    const command: BackgroundCommand = {
      type: 'RENDER_RECOMMENDATION',
      placement: {
        platform: Platform.CHATGPT,
        anchor: {
          id: 'chatgpt-below-input',
          platform: Platform.CHATGPT,
          position: 'below_input',
          confidence: 0.8,
          status: 'valid',
        },
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com',
      },
      tracking: tracking(),
      impressionDurationMs: 5_000,
    };

    await dispatch(command);
    expect(shared.createVisibilityTracker).toHaveBeenCalledTimes(1);

    shared.renderState.rendered = false;
    shared.observerInstances[0]?.callback(
      [],
      shared.observerInstances[0] as unknown as MutationObserver,
    );

    expect(shared.disconnectVisibility).toHaveBeenCalledTimes(1);
    expect(shared.createVisibilityTracker).toHaveBeenCalledTimes(2);
    shared.visibilityTrackerInstances[1]?.options.onVisible();
    expect(validImpressionCount()).toBe(1);
  });

  it('recovers the same native link without attaching click handlers or sending a second valid impression', async () => {
    const command: BackgroundCommand = {
      type: 'RENDER_RECOMMENDATION',
      placement: {
        platform: Platform.CHATGPT,
        anchor: {
          id: 'chatgpt-below-input',
          platform: Platform.CHATGPT,
          position: 'below_input',
          confidence: 0.8,
          status: 'valid',
        },
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com',
      },
      tracking: tracking(),
      impressionDurationMs: 5_000,
    };

    await dispatch(command);
    shared.visibilityTrackerInstances[0]?.options.onVisible();
    expect(validImpressionCount()).toBe(1);

    shared.renderState.rendered = false;
    shared.observerInstances[0]?.callback(
      [],
      shared.observerInstances[0] as unknown as MutationObserver,
    );

    const recoveredHost = shared.hostState.hosts[1];
    expect(recoveredHost?.addEventListener).not.toHaveBeenCalled();
    expect(shared.createVisibilityTracker).toHaveBeenCalledTimes(1);
    expect(validImpressionCount()).toBe(1);
  });

  it('starts a fresh visibility lifecycle when rotation renders a new recommendation', async () => {
    const firstCommand: BackgroundCommand = {
      type: 'RENDER_RECOMMENDATION',
      placement: {
        platform: Platform.CHATGPT,
        anchor: {
          id: 'chatgpt-below-input',
          platform: Platform.CHATGPT,
          position: 'below_input',
          confidence: 0.8,
          status: 'valid',
        },
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com/one',
      },
      tracking: tracking('1'),
      impressionDurationMs: 5_000,
    };
    const secondCommand: BackgroundCommand = {
      ...firstCommand,
      reason: 'rotation',
      content: {
        id: 'ad-2',
        sponsor: 'Sponsored',
        message: 'Ship with confidence',
        url: 'https://example.com/two',
      },
      tracking: tracking('2'),
      impressionDurationMs: 5_000,
    };

    await dispatch(firstCommand);
    shared.visibilityTrackerInstances[0]?.options.onVisible();

    await dispatch(secondCommand);
    shared.visibilityTrackerInstances[1]?.options.onVisible();

    expect(shared.disconnectVisibility).toHaveBeenCalledTimes(1);
    expect(shared.createVisibilityTracker).toHaveBeenCalledTimes(2);
    expect(validImpressionCount()).toBe(2);
    const validMessages = (
      shared.sendMessage.mock.calls as unknown as Array<[ContentScriptRequest]>
    )
      .map(([message]) => message)
      .filter(
        (message): message is Extract<ContentScriptRequest, { type: 'VALID_IMPRESSION' }> =>
          message.type === 'VALID_IMPRESSION',
      );
    expect(validMessages.map((message) => message.adId)).toEqual(['ad-1', 'ad-2']);
    expect(validMessages.map((message) => message.impressionId)).toEqual([
      tracking('1').impressionId,
      tracking('2').impressionId,
    ]);
    expect(window.__airewardsDebug?.lifecycleEvents.map((event) => event.name)).toContain(
      'ROTATION_STOPPED',
    );
  });

  it('replaces the native tracking link and restarts the impression lifecycle when rotation reuses the same ad id', async () => {
    const firstCommand: BackgroundCommand = {
      type: 'RENDER_RECOMMENDATION',
      placement: {
        platform: Platform.CHATGPT,
        anchor: {
          id: 'chatgpt-below-input',
          platform: Platform.CHATGPT,
          position: 'below_input',
          confidence: 0.8,
          status: 'valid',
        },
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com/one',
      },
      tracking: tracking('1'),
      impressionDurationMs: 5_000,
    };
    const rotatedCommand: BackgroundCommand = {
      ...firstCommand,
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com/one',
      },
      tracking: tracking('2'),
      impressionDurationMs: 5_000,
    };

    await dispatch(firstCommand);
    shared.visibilityTrackerInstances[0]?.options.onVisible();

    await dispatch(rotatedCommand);
    shared.visibilityTrackerInstances[1]?.options.onVisible();

    expect(shared.renderer.rerender).toHaveBeenCalledTimes(2);
    expect(shared.disconnectVisibility).toHaveBeenCalledTimes(1);
    expect(shared.createVisibilityTracker).toHaveBeenCalledTimes(2);
    expect(validImpressionCount()).toBe(2);
  });

  it('keeps the current render command when a transient recovery render fails', async () => {
    const command: BackgroundCommand = {
      type: 'RENDER_RECOMMENDATION',
      placement: {
        platform: Platform.CHATGPT,
        anchor: {
          id: 'chatgpt-below-input',
          platform: Platform.CHATGPT,
          position: 'below_input',
          confidence: 0.8,
          status: 'valid',
        },
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com',
      },
      tracking: tracking(),
      impressionDurationMs: 5_000,
    };

    await dispatch(command);
    expect(shared.observerInstances).toHaveLength(1);

    shared.renderState.rendered = false;
    shared.renderer.rerender.mockReturnValueOnce(false).mockImplementation(() => {
      shared.renderState.rendered = true;
      const host = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as TestHost;
      shared.hostState.current = host;
      shared.hostState.hosts.push(host);
      return true;
    });

    shared.observerInstances[0]?.callback(
      [],
      shared.observerInstances[0] as unknown as MutationObserver,
    );
    shared.observerInstances[0]?.callback(
      [],
      shared.observerInstances[0] as unknown as MutationObserver,
    );

    expect(shared.renderer.rerender).toHaveBeenCalledTimes(3);
    expect(shared.renderState.rendered).toBe(true);
    expect(shared.observerInstances[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('re-runs detection and discovery after SPA history navigation', async () => {
    const listeners = new Map<string, EventListener>();
    const pushState = vi.fn();

    vi.resetModules();
    setEnvironment();
    vi.stubGlobal('window', {
      location: { hostname: 'chatgpt.com', href: 'https://chatgpt.com/c/one', pathname: '/c/one' },
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      dispatchEvent: vi.fn(),
      history: {
        pushState,
        replaceState: vi.fn(),
      },
    });
    shared.resolveAdapter.mockReturnValue({
      platform: Platform.CHATGPT,
      detect: vi.fn(() => true),
      isReady: vi.fn(() => true),
    });
    shared.discoverAnchors.mockReturnValue([]);

    await import('./content');

    expect(shared.sendMessage).toHaveBeenCalledWith({
      type: 'PLATFORM_DETECTED',
      platform: Platform.CHATGPT,
    });
    await vi.waitFor(() => expect(shared.sendMessage).toHaveBeenCalledTimes(5));

    (window.location as Location).href = 'https://chatgpt.com/c/two';
    (window.location as Location).pathname = '/c/two';

    window.history.pushState({}, '', '/c/two');
    await Promise.resolve();

    expect(pushState).toHaveBeenCalledWith({}, '', '/c/two');
    await vi.waitFor(() => expect(shared.sendMessage).toHaveBeenCalledTimes(9));
    expect(shared.sendMessage).toHaveBeenNthCalledWith(6, { type: 'CONTENT_SCRIPT_READY' });
    expect(shared.sendMessage).toHaveBeenNthCalledWith(7, {
      type: 'PLATFORM_DETECTED',
      platform: Platform.CHATGPT,
    });
    expect(shared.sendMessage).toHaveBeenNthCalledWith(8, {
      type: 'PAGE_READY',
      platform: Platform.CHATGPT,
    });
    expect(shared.sendMessage).toHaveBeenNthCalledWith(9, {
      type: 'ANCHORS_DISCOVERED',
      platform: Platform.CHATGPT,
      anchors: [],
    });
  });

  it('ignores stale readiness callbacks from a previous SPA conversation', async () => {
    vi.useFakeTimers();
    let firstConversationReady = false;
    const pushState = vi.fn();

    vi.resetModules();
    setEnvironment();
    vi.stubGlobal('window', {
      location: { hostname: 'chatgpt.com', href: 'https://chatgpt.com/c/one', pathname: '/c/one' },
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      history: {
        pushState,
        replaceState: vi.fn(),
      },
    });
    shared.resolveAdapter
      .mockReturnValueOnce({
        platform: Platform.CHATGPT,
        detect: vi.fn(() => true),
        isReady: vi.fn(() => firstConversationReady),
      })
      .mockReturnValue({
        platform: Platform.CHATGPT,
        detect: vi.fn(() => true),
        isReady: vi.fn(() => true),
      });
    shared.discoverAnchors.mockReturnValue([]);

    await import('./content');
    await vi.waitFor(() =>
      expect(shared.sendMessage).toHaveBeenCalledWith({
        type: 'PLATFORM_DETECTED',
        platform: Platform.CHATGPT,
      }),
    );

    (window.location as Location).href = 'https://chatgpt.com/c/two';
    (window.location as Location).pathname = '/c/two';
    window.history.pushState({}, '', '/c/two');

    await vi.waitFor(() => {
      const messages = (shared.sendMessage.mock.calls as unknown as Array<[ContentScriptRequest]>)
        .map(([message]) => message)
        .filter((message) => message.type === 'ANCHORS_DISCOVERED');
      expect(messages).toHaveLength(1);
    });

    firstConversationReady = true;
    await vi.advanceTimersByTimeAsync(READINESS_POLL_TICK_MS);
    await Promise.resolve();

    const lifecycleMessages = (
      shared.sendMessage.mock.calls as unknown as Array<[ContentScriptRequest]>
    )
      .map(([message]) => message)
      .filter((message) => message.type === 'PAGE_READY' || message.type === 'ANCHORS_DISCOVERED');

    expect(lifecycleMessages).toEqual([
      { type: 'PAGE_READY', platform: Platform.CHATGPT },
      { type: 'ANCHORS_DISCOVERED', platform: Platform.CHATGPT, anchors: [] },
    ]);
    expect(window.__airewardsDebug?.pageLifecycleEvents.map((event) => event.name)).toContain(
      'readiness:stale',
    );
  });

  it('continues Claude /chat readiness recovery after a hard-refresh readiness timeout', async () => {
    vi.useFakeTimers();
    const mutationObservers = shared.observerInstances;
    let claudeReady = false;
    const claudeAnchors: Anchor[] = [
      {
        id: 'claude-below-input',
        platform: Platform.CLAUDE,
        position: 'below_input',
        confidence: 0.8,
        status: 'valid',
      },
    ];

    vi.resetModules();
    setEnvironment();
    vi.stubGlobal('window', {
      location: {
        hostname: 'claude.ai',
        href: 'https://claude.ai/chat/thread-1',
        pathname: '/chat/thread-1',
      },
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      history: {
        pushState: vi.fn(() => undefined),
        replaceState: vi.fn(),
      },
    });
    shared.resolveAdapter.mockReturnValue({
      platform: Platform.CLAUDE,
      detect: vi.fn(() => true),
      isReady: vi.fn(() => claudeReady),
    });
    shared.discoverAnchors.mockReturnValue(claudeAnchors);

    await import('./content');
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(shared.sendMessage).toHaveBeenCalledWith({
      type: 'PLATFORM_DETECTED',
      platform: Platform.CLAUDE,
    });
    expect(
      (shared.sendMessage.mock.calls as unknown as Array<[ContentScriptRequest]>).some(
        ([message]) => message.type === 'PAGE_READY',
      ),
    ).toBe(false);

    claudeReady = true;
    mutationObservers.at(-1)?.callback([], mutationObservers.at(-1) as unknown as MutationObserver);

    await vi.waitFor(() =>
      expect(shared.sendMessage).toHaveBeenCalledWith({
        type: 'ANCHORS_DISCOVERED',
        platform: Platform.CLAUDE,
        anchors: claudeAnchors,
      }),
    );
    expect(shared.sendMessage).toHaveBeenCalledWith({
      type: 'PAGE_READY',
      platform: Platform.CLAUDE,
    });
    expect(window.__airewardsDebug?.lifecycleEvents.map((event) => event.name)).toEqual([
      'CONTENT_SCRIPT_LOADED',
      'PROVIDER_DETECTED',
      'CONNECT_STARTED',
      'BACKGROUND_HANDSHAKE_OK',
      'CONNECT_FINISHED',
      'WAIT_TIMEOUT',
      'FALLBACK_OBSERVER_STARTED',
      'FALLBACK_TRIGGERED',
      'PAGE_READY',
      'ANCHOR_DISCOVERY_STARTED',
      'ANCHORS_FOUND',
    ]);
  });

  it('records the complete Claude hard-refresh render pipeline through render completion', async () => {
    const claudeAnchors: Anchor[] = [
      {
        id: 'claude-below-input',
        platform: Platform.CLAUDE,
        position: 'below_input',
        confidence: 0.8,
        status: 'valid',
      },
    ];

    vi.resetModules();
    setEnvironment();
    vi.stubGlobal('window', {
      location: {
        hostname: 'claude.ai',
        href: 'https://claude.ai/chat/thread-1',
        pathname: '/chat/thread-1',
      },
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      history: {
        pushState: vi.fn(),
        replaceState: vi.fn(),
      },
    });
    shared.resolveAdapter.mockReturnValue({
      platform: Platform.CLAUDE,
      detect: vi.fn(() => true),
      isReady: vi.fn(() => true),
    });
    shared.sendMessage.mockImplementation(async (message?: ContentScriptRequest) => {
      if (message?.type === 'PAGE_READY') {
        return {
          ok: true,
          acknowledged: true,
          events: [
            {
              name: 'BACKGROUND_RECEIVED_PAGE_READY',
              timestamp: '2026-06-28T12:00:00.500Z',
              provider: Platform.CLAUDE,
              details: { tabId: 1 },
            },
          ],
        } satisfies ContentScriptResponse;
      }

      return { ok: true, acknowledged: true } satisfies ContentScriptResponse;
    });
    shared.discoverAnchors.mockReturnValue(claudeAnchors);
    shared.planLayout.mockReturnValue({
      platform: Platform.CLAUDE,
      layout: {
        landmarkSelector: 'fieldset',
        insertion: 'afterend',
        disclaimerPresent: false,
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com',
      },
      tracking: tracking(),
      impressionDurationMs: 5_000,
    });

    await import('./content');
    await vi.waitFor(() =>
      expect(shared.sendMessage).toHaveBeenCalledWith({
        type: 'ANCHORS_DISCOVERED',
        platform: Platform.CLAUDE,
        anchors: claudeAnchors,
      }),
    );

    await dispatch({
      type: 'RENDER_RECOMMENDATION',
      reason: 'initial',
      placement: {
        platform: Platform.CLAUDE,
        anchor: claudeAnchors[0],
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com',
      },
      tracking: tracking(),
      impressionDurationMs: 5_000,
      diagnostics: [
        {
          name: 'BACKGROUND_STARTED_RECOMMENDATION_FETCH',
          timestamp: '2026-06-28T12:00:01.000Z',
          provider: Platform.CLAUDE,
          details: { reason: 'initial' },
        },
        {
          name: 'BACKGROUND_FETCH_COMPLETED',
          timestamp: '2026-06-28T12:00:02.000Z',
          provider: Platform.CLAUDE,
          details: { reason: 'initial', adId: 'ad-1' },
        },
        {
          name: 'BACKGROUND_SENT_RENDER',
          timestamp: '2026-06-28T12:00:03.000Z',
          provider: Platform.CLAUDE,
          details: { reason: 'initial', adId: 'ad-1' },
        },
      ],
    });

    expect(window.__airewardsDebug?.lifecycleEvents.map((event) => event.name)).toEqual([
      'CONTENT_SCRIPT_LOADED',
      'PROVIDER_DETECTED',
      'CONNECT_STARTED',
      'BACKGROUND_HANDSHAKE_OK',
      'CONNECT_FINISHED',
      'PAGE_READY',
      'BACKGROUND_RECEIVED_PAGE_READY',
      'ANCHOR_DISCOVERY_STARTED',
      'ANCHORS_FOUND',
      'BACKGROUND_STARTED_RECOMMENDATION_FETCH',
      'BACKGROUND_FETCH_COMPLETED',
      'BACKGROUND_SENT_RENDER',
      'CONTENT_RECEIVED_RENDER',
      'RENDER_STARTED',
      'RENDER_COMPLETED',
    ]);
    expect(window.__airewardsDebug).toMatchObject({
      provider: Platform.CLAUDE,
      pathname: '/chat/thread-1',
      anchorCount: 1,
      connectAttempts: 1,
      renderAttempts: 1,
      observerActive: true,
      controllerState: 'rendered',
      lastSuccessfulRender: expect.objectContaining({ name: 'RENDER_COMPLETED' }),
      lastRenderCommand: expect.objectContaining({ name: 'CONTENT_RECEIVED_RENDER' }),
      lastBackgroundMessage: expect.objectContaining({ name: 'CONTENT_RECEIVED_RENDER' }),
      lastAnchorDiscovery: expect.objectContaining({ name: 'ANCHORS_FOUND' }),
      lastConnect: expect.objectContaining({ name: 'CONNECT_FINISHED' }),
    });
    expect(window.__airewardsDebug?.messageEvents.map((event) => event.name)).toEqual([
      'BACKGROUND_HANDSHAKE_OK',
      'BACKGROUND_RECEIVED_PAGE_READY',
      'BACKGROUND_STARTED_RECOMMENDATION_FETCH',
      'BACKGROUND_FETCH_COMPLETED',
      'BACKGROUND_SENT_RENDER',
      'CONTENT_RECEIVED_RENDER',
    ]);
  });

  it('cleans up stale readiness observers before repeated Claude refresh recovery attempts', async () => {
    vi.useFakeTimers();
    const claudeReady = false;

    vi.resetModules();
    setEnvironment();
    vi.stubGlobal('window', {
      location: {
        hostname: 'claude.ai',
        href: 'https://claude.ai/chat/thread-1',
        pathname: '/chat/thread-1',
      },
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      history: {
        pushState: vi.fn(),
        replaceState: vi.fn(),
      },
    });
    shared.resolveAdapter.mockReturnValue({
      platform: Platform.CLAUDE,
      detect: vi.fn(() => true),
      isReady: vi.fn(() => claudeReady),
    });
    shared.discoverAnchors.mockReturnValue([]);

    await import('./content');
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    const firstReadinessObserver = shared.observerInstances.at(-1);
    expect(firstReadinessObserver?.observe).toHaveBeenCalledTimes(1);

    (window.location as Location).href = 'https://claude.ai/chat/thread-2';
    (window.location as Location).pathname = '/chat/thread-2';
    window.history.pushState({}, '', '/chat/thread-2');
    expect(firstReadinessObserver?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('tears down the current rendered recommendation before SPA rediscovery', async () => {
    const pushState = vi.fn();

    vi.resetModules();
    setEnvironment();
    vi.stubGlobal('window', {
      location: { hostname: 'chatgpt.com', href: 'https://chatgpt.com/c/one', pathname: '/c/one' },
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      history: {
        pushState,
        replaceState: vi.fn(),
      },
    });
    shared.resolveAdapter.mockReturnValue({
      platform: Platform.CHATGPT,
      detect: vi.fn(() => true),
      isReady: vi.fn(() => true),
    });
    shared.discoverAnchors.mockReturnValue([]);
    shared.planLayout.mockReturnValue({
      platform: Platform.CHATGPT,
      layout: {
        landmarkSelector: 'main',
        insertion: 'beforeend',
        disclaimerPresent: true,
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com',
      },
      tracking: tracking(),
      impressionDurationMs: 5_000,
    });

    await import('./content');
    await vi.waitFor(() => expect(shared.sendMessage).toHaveBeenCalledTimes(5));

    await dispatch({
      type: 'RENDER_RECOMMENDATION',
      placement: {
        platform: Platform.CHATGPT,
        anchor: {
          id: 'chatgpt-below-input',
          platform: Platform.CHATGPT,
          position: 'below_input',
          confidence: 0.8,
          status: 'valid',
        },
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com',
      },
      tracking: tracking(),
      impressionDurationMs: 5_000,
    });

    expect(shared.renderer.rerender).toHaveBeenCalledTimes(1);

    (window.location as Location).href = 'https://chatgpt.com/c/two';
    (window.location as Location).pathname = '/c/two';
    window.history.pushState({}, '', '/c/two');
    await vi.waitFor(() => expect(shared.renderer.destroy).toHaveBeenCalledTimes(1));

    expect(shared.observerInstances[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(shared.disconnectVisibility).toHaveBeenCalledTimes(1);
  });

  it('tears down the previous runtime before a repeated content script boot', async () => {
    vi.useFakeTimers();

    await dispatch({
      type: 'RENDER_RECOMMENDATION',
      placement: {
        platform: Platform.CHATGPT,
        anchor: {
          id: 'chatgpt-below-input',
          platform: Platform.CHATGPT,
          position: 'below_input',
          confidence: 0.8,
          status: 'valid',
        },
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com',
      },
      tracking: tracking(),
      impressionDurationMs: 5_000,
    });

    expect(shared.listenerState.listeners).toHaveLength(1);
    expect(listenerCount(shared.windowListeners, 'focus')).toBe(1);
    expect(listenerCount(shared.documentListeners, 'visibilitychange')).toBe(2);
    expect(window.__airewardsDebug?.activeTimers).toEqual([
      'attention_idle',
      'impression_visibility',
    ]);

    vi.resetModules();
    await import('./content');

    expect(shared.listenerState.addListener).toHaveBeenCalledTimes(2);
    expect(shared.listenerState.removeListener).toHaveBeenCalledTimes(1);
    expect(shared.listenerState.listeners).toHaveLength(1);
    expect(shared.renderer.destroy).toHaveBeenCalledTimes(1);
    expect(shared.disconnectVisibility).toHaveBeenCalledTimes(1);
    expect(listenerCount(shared.windowListeners, 'focus')).toBe(1);
    expect(listenerCount(shared.documentListeners, 'visibilitychange')).toBe(2);
    expect(window.__airewardsDebug?.activeTimers).toEqual(['attention_idle']);
  });

  it('still boots when the previous runtime teardown throws', async () => {
    vi.resetModules();
    setEnvironment();
    const staleTeardown = vi.fn(() => {
      throw new Error('stale runtime failed during teardown');
    });
    window.__airewardsContentRuntime = { teardown: staleTeardown };
    shared.resolveAdapter.mockReturnValue({
      platform: Platform.CHATGPT,
      detect: vi.fn(() => true),
      isReady: vi.fn(() => true),
    });
    shared.discoverAnchors.mockReturnValue([]);

    await import('./content');

    expect(staleTeardown).toHaveBeenCalledTimes(1);
    expect(shared.listenerState.listeners).toHaveLength(1);
    expect(window.__airewardsContentRuntime?.teardown).not.toBe(staleTeardown);
  });

  it('keeps duplicate render command delivery idempotent across render, impression, and native link state', async () => {
    const command: BackgroundCommand = {
      type: 'RENDER_RECOMMENDATION',
      placement: {
        platform: Platform.CHATGPT,
        anchor: {
          id: 'chatgpt-below-input',
          platform: Platform.CHATGPT,
          position: 'below_input',
          confidence: 0.8,
          status: 'valid',
        },
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com',
      },
      tracking: tracking(),
      impressionDurationMs: 5_000,
    };

    await dispatch(command);
    await dispatch(command);
    shared.visibilityTrackerInstances[0]?.options.onVisible();
    shared.visibilityTrackerInstances[0]?.options.onVisible();

    expect(shared.renderer.rerender).toHaveBeenCalledTimes(1);
    expect(shared.createVisibilityTracker).toHaveBeenCalledTimes(1);
    expect(validImpressionCount()).toBe(1);
    expect(window.__airewardsDebug?.lastRenderedHref).toBe(
      'http://localhost:3001/v1/clicks?click_id=click-1',
    );
  });

  it('exposes development-only runtime diagnostics for stale extension asset detection', async () => {
    await dispatch({
      type: 'RENDER_RECOMMENDATION',
      placement: {
        platform: Platform.CHATGPT,
        anchor: {
          id: 'chatgpt-below-input',
          platform: Platform.CHATGPT,
          position: 'below_input',
          confidence: 0.8,
          status: 'valid',
        },
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Write with confidence',
        url: 'https://example.com',
      },
      tracking: tracking(),
      impressionDurationMs: 5_000,
    });

    const debug = window.__airewardsDebug;
    expect(debug).toMatchObject({
      provider: Platform.CHATGPT,
      apiBaseUrl: 'http://localhost:3001',
      extensionVersion: '0.1.0-test',
      buildMode: 'development',
      buildId: 'test-build-id',
      builtAt: '2026-06-28T12:00:00.000Z',
      lastRenderedHref: 'http://localhost:3001/v1/clicks?click_id=click-1',
      lastDestinationUrl: 'https://example.com',
      lastImpressionId: tracking().impressionId,
      recommendationState: 'rendered',
      observerState: 'active',
      rotationState: 'rendered',
    });
    expect(debug?.activeTimers).toEqual(['attention_idle', 'impression_visibility']);
    expect(debug?.lastClickId).toBe('click-1');
    expect(debug?.lastLifecycleEvent?.name).toBe('RENDER_COMPLETED');
    expect(debug?.lifecycleEvents.map((event) => event.name)).toContain('RENDER_COMPLETED');
    expect(debug?.clickEvents.at(-1)).toMatchObject({
      name: 'TRACKING_LINK_RENDERED',
      apiBaseUrl: 'http://localhost:3001',
      href: 'http://localhost:3001/v1/clicks?click_id=click-1',
      impressionId: tracking().impressionId,
      clickId: 'click-1',
      destinationUrl: 'https://example.com',
    });
  });
});
