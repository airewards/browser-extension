import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeElement {
  className = '';
  textContent = '';
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(readonly tagName: string) {}

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
}

const shared = vi.hoisted(() => ({
  cache: null as unknown,
  content: null as FakeElement | null,
  sendMessage: vi.fn(),
  setPopupCache: vi.fn(),
  setUiPreferences: vi.fn(),
  clearPopupCache: vi.fn(),
}));

vi.mock('../storage', () => ({
  clearPopupCache: (...args: unknown[]) => shared.clearPopupCache(...args),
  getPopupCache: vi.fn(async () => shared.cache),
  setPopupCache: (...args: unknown[]) => shared.setPopupCache(...args),
  setUiPreferences: (...args: unknown[]) => shared.setUiPreferences(...args),
}));

function installDom(): void {
  const content = new FakeElement('div');
  shared.content = content;

  vi.stubGlobal('document', {
    hidden: false,
    getElementById: vi.fn((id: string) => (id === 'content' ? content : null)),
    createElement: vi.fn((tagName: string) => new FakeElement(tagName)),
    addEventListener: vi.fn(),
  });

  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    close: vi.fn(),
  });

  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: (...args: unknown[]) => shared.sendMessage(...args),
    },
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function collectText(element: FakeElement): string {
  return [element.textContent, ...element.children.map(collectText)].filter(Boolean).join(' ');
}

describe('popup wallet freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
    vi.resetModules();
    vi.clearAllMocks();
    installDom();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('revalidates a fresh cached wallet on open and renders sub-cent impression credits', async () => {
    const user = {
      id: 'user-1',
      name: 'Alice',
      email: 'alice@example.com',
    };

    shared.cache = {
      authenticated: true,
      user,
      wallet: { availableBalance: 0, pendingBalance: 0, currency: 'USD' },
      updatedAt: Date.now(),
    };
    shared.sendMessage.mockResolvedValue({
      ok: true,
      popupState: {
        isAuthenticated: true,
        user,
        wallet: { availableBalance: 0.001, pendingBalance: 0, currency: 'USD' },
      },
    });

    await import('./popup');
    await flushMicrotasks();

    expect(shared.sendMessage).toHaveBeenCalledWith({ type: 'GET_POPUP_STATE' });
    expect(shared.setPopupCache).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticated: true,
        wallet: expect.objectContaining({ availableBalance: 0.001 }),
      }),
    );
    expect(collectText(shared.content as FakeElement)).toContain('0.0010');
  });

  it('reconciles reopened cached state to the latest wallet API balance', async () => {
    const user = {
      id: 'user-1',
      name: 'Alice',
      email: 'alice@example.com',
    };

    shared.cache = {
      authenticated: true,
      user,
      wallet: { availableBalance: 0.001, pendingBalance: 0, currency: 'USD' },
      updatedAt: Date.now(),
    };
    shared.sendMessage.mockResolvedValue({
      ok: true,
      popupState: {
        isAuthenticated: true,
        user,
        wallet: { availableBalance: 0.003, pendingBalance: 0, currency: 'USD' },
      },
    });

    await import('./popup');
    await flushMicrotasks();

    expect(collectText(shared.content as FakeElement)).toContain('0.0030');
    expect(shared.setPopupCache).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticated: true,
        wallet: expect.objectContaining({ availableBalance: 0.003 }),
      }),
    );
  });
});
