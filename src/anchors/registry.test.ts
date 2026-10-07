import { describe, expect, it } from 'vitest';
import { type PageDocument, Platform } from '../adapters/types';
import { discoverAnchors } from './registry';

const documentMock: PageDocument = {
  readyState: 'complete',
  querySelector: () => ({}) as Element,
  querySelectorAll: () => ({ length: 0, item: () => null }) as unknown as NodeListOf<Element>,
};

describe('discoverAnchors', () => {
  it.each([Platform.CHATGPT, Platform.CLAUDE, Platform.GEMINI, Platform.GROK])(
    'prefers footer placement for %s',
    (platform) => {
      const anchors = discoverAnchors(platform, documentMock);

      expect(anchors[0]).toMatchObject({
        position: 'below_input',
        status: 'valid',
      });
    },
  );

  it('uses the observed Grok textarea as the preferred footer anchor', () => {
    const document: PageDocument = {
      readyState: 'complete',
      querySelector: (selector: string) =>
        selector === 'main' ||
        selector
          .split(',')
          .map((part) => part.trim())
          .includes('textarea[aria-label="Ask Grok anything"]')
          ? ({} as Element)
          : null,
      querySelectorAll: () => ({ length: 0, item: () => null }) as unknown as NodeListOf<Element>,
    };

    const anchors = discoverAnchors(Platform.GROK, document);

    expect(anchors[0]).toMatchObject({
      id: 'grok-below-input',
      position: 'below_input',
      status: 'valid',
    });
  });
});
