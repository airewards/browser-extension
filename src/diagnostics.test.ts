import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  diagnosticsEnabled: true,
  appendedScripts: [] as Array<{ textContent: string; remove: ReturnType<typeof vi.fn> }>,
  createdElements: [] as string[],
  dispatchedEvents: [] as CustomEvent<string>[],
}));

vi.mock('./config', () => ({
  config: {
    apiBaseUrl: 'http://localhost:3001',
    buildMode: 'development',
    get diagnosticsEnabled() {
      return shared.diagnosticsEnabled;
    },
    extensionVersion: '0.1.0-test',
    buildId: 'test-build-id',
    builtAt: '2026-06-28T12:00:00.000Z',
  },
}));

function installWindow(): void {
  const windowMock = {
    location: { href: 'https://chatgpt.com/c/one', pathname: '/c/one' },
    __airewardsDebug: undefined,
    dispatchEvent: vi.fn((event: CustomEvent<string>) => {
      shared.dispatchedEvents.push(event);
      return true;
    }),
  };
  vi.stubGlobal('window', windowMock);
  vi.stubGlobal(
    'CustomEvent',
    class TestCustomEvent<T> {
      constructor(
        readonly type: string,
        readonly init: CustomEventInit<T>,
      ) {}
      get detail(): T | undefined {
        return this.init.detail;
      }
    },
  );
  vi.stubGlobal('document', {
    documentElement: {
      appendChild: vi.fn((script) => {
        shared.appendedScripts.push(script);
      }),
    },
    createElement: vi.fn((tagName: string) => {
      shared.createdElements.push(tagName);
      return { textContent: '', remove: vi.fn() };
    }),
  });
}

describe('development diagnostics', () => {
  beforeEach(() => {
    vi.resetModules();
    shared.diagnosticsEnabled = true;
    shared.appendedScripts.length = 0;
    shared.createdElements.length = 0;
    shared.dispatchedEvents.length = 0;
    installWindow();
  });

  it('publishes an extension-context debug snapshot without injecting inline scripts', async () => {
    const { recordLifecycleEvent, recordMessageEvent, recordPageLifecycleEvent } = await import(
      './diagnostics'
    );

    recordLifecycleEvent('CONTENT_SCRIPT_LOADED', null);
    recordMessageEvent('BACKGROUND_HANDSHAKE_OK', 'CHATGPT');
    recordPageLifecycleEvent('pageshow', { persisted: false });

    expect(window.__airewardsDebug?.apiBaseUrl).toBe('http://localhost:3001');
    expect(shared.createdElements).not.toContain('script');
    expect(shared.appendedScripts).toHaveLength(0);
    expect(shared.dispatchedEvents).toHaveLength(0);
    expect(window.__airewardsDebug).toMatchObject({
      apiBaseUrl: 'http://localhost:3001',
      buildMode: 'development',
      lifecycleEvents: [{ name: 'CONTENT_SCRIPT_LOADED' }, { name: 'BACKGROUND_HANDSHAKE_OK' }],
      messageEvents: [{ name: 'BACKGROUND_HANDSHAKE_OK' }],
      pageLifecycleEvents: [{ name: 'pageshow' }],
    });
  });

  it('does not expose diagnostics when disabled by the build', async () => {
    shared.diagnosticsEnabled = false;
    const { recordLifecycleEvent } = await import('./diagnostics');

    recordLifecycleEvent('CONTENT_SCRIPT_LOADED', null);

    expect(window.__airewardsDebug).toBeUndefined();
    expect(shared.appendedScripts).toHaveLength(0);
    expect(shared.createdElements).toHaveLength(0);
    expect(shared.dispatchedEvents).toHaveLength(0);
  });
});
