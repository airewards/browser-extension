import { describe, expect, it, vi } from 'vitest';
import { detectPlatform, resolveAdapter } from './registry';
import { type PageDocument, Platform } from './types';

function location(hostname: string): Location {
  return { hostname } as Location;
}

function documentWith(selector: string): PageDocument {
  return {
    readyState: 'complete',
    querySelector: vi.fn((candidate: string) =>
      candidate === 'main' || candidate === selector ? ({} as Element) : null,
    ),
    querySelectorAll: vi.fn(
      () => ({ length: 0, item: () => null }) as unknown as NodeListOf<Element>,
    ),
  };
}

const documentWithOnlyMain: PageDocument = {
  readyState: 'complete',
  querySelector: vi.fn((candidate: string) => (candidate === 'main' ? ({} as Element) : null)),
  querySelectorAll: vi.fn(
    () => ({ length: 0, item: () => null }) as unknown as NodeListOf<Element>,
  ),
};

function documentWithSelectors(selectors: readonly string[]): PageDocument {
  return {
    readyState: 'complete',
    querySelector: vi.fn((candidate: string) =>
      selectors.includes(candidate) ? ({} as Element) : null,
    ),
    querySelectorAll: vi.fn(
      () => ({ length: 0, item: () => null }) as unknown as NodeListOf<Element>,
    ),
  };
}

describe('platform registry', () => {
  it.each([
    ['chatgpt.com', Platform.CHATGPT],
    ['chat.openai.com', Platform.CHATGPT],
    ['claude.ai', Platform.CLAUDE],
    ['gemini.google.com', Platform.GEMINI],
    ['grok.com', Platform.GROK],
    ['www.grok.com', Platform.GROK],
  ])('detects %s as %s', (host, platform) => {
    expect(detectPlatform(location(host))).toBe(platform);
  });

  it('uses the observed Gemini textbox as a readiness landmark', () => {
    const adapter = resolveAdapter(location('gemini.google.com'));
    expect(
      adapter?.isReady(documentWith('[role="textbox"][aria-label="Enter a prompt for Gemini"]')),
    ).toBe(true);
  });

  it('waits for Claude composer readiness instead of treating the shell main as ready', () => {
    const adapter = resolveAdapter(location('claude.ai'));

    expect(adapter?.isReady(documentWithOnlyMain)).toBe(false);
    expect(adapter?.isReady(documentWithSelectors(['fieldset']))).toBe(true);
  });

  it('uses the observed Grok textarea as a readiness landmark', () => {
    const adapter = resolveAdapter(location('grok.com'));
    expect(adapter?.isReady(documentWith('textarea[aria-label="Ask Grok anything"]'))).toBe(true);
  });
});
