import { describe, expect, it, vi } from 'vitest';
import { Platform } from '../adapters/types';
import type { RenderRequest } from '../layout';
import { createRecommendationRenderer } from './recommendation';

class FakeShadowRoot {
  children: FakeElement[] = [];

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
}

class FakeElement {
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  className = '';
  isConnected = false;
  shadow: FakeShadowRoot | null = null;
  textContent = '';

  constructor(readonly tagName: string) {}

  href = '';

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  attachShadow(): FakeShadowRoot {
    this.shadow = new FakeShadowRoot();
    return this.shadow;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  remove(): void {
    this.isConnected = false;
  }
}

describe('recommendation renderer', () => {
  it('inherits the host page foreground color after resetting shadow host styles', () => {
    const insertedNodes: FakeElement[] = [];
    const landmark = {
      insertAdjacentElement: vi.fn((_position: InsertPosition, node: FakeElement) => {
        node.isConnected = true;
        insertedNodes.push(node);
        return node;
      }),
    };

    vi.stubGlobal('document', {
      createElement: (tagName: string) => new FakeElement(tagName),
      querySelector: (selector: string) => (selector === 'form' ? landmark : null),
    });

    const request: RenderRequest = {
      platform: Platform.CLAUDE,
      layout: {
        landmarkSelector: 'form',
        insertion: 'beforebegin',
        disclaimerPresent: false,
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Build production-grade apps with Postgres',
        url: 'https://example.com',
      },
      tracking: {
        href: 'http://localhost:3001/v1/clicks?click_id=click-1',
        impressionId: '11111111-1111-4111-8111-111111111111',
      },
    };

    expect(createRecommendationRenderer().render(request)).toBe(true);

    const host = insertedNodes[0];
    const style = host?.shadow?.children.find((child) => child.tagName === 'style');

    expect(style?.textContent).toContain(':host { all: initial; color: inherit; }');
    expect(style?.textContent).toContain('color: currentColor;');
  });

  it('renders the recommendation as a browser-native hyperlink to the tracking endpoint', () => {
    const insertedNodes: FakeElement[] = [];
    const landmark = {
      insertAdjacentElement: vi.fn((_position: InsertPosition, node: FakeElement) => {
        node.isConnected = true;
        insertedNodes.push(node);
        return node;
      }),
    };

    vi.stubGlobal('document', {
      createElement: (tagName: string) => new FakeElement(tagName),
      querySelector: (selector: string) => (selector === 'form' ? landmark : null),
    });

    const trackingUrl = 'http://localhost:3001/v1/clicks?click_id=click-1';
    const request: RenderRequest = {
      platform: Platform.CHATGPT,
      layout: {
        landmarkSelector: 'form',
        insertion: 'afterend',
        disclaimerPresent: true,
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Build production-grade apps with Postgres',
        url: 'https://advertiser.example/path',
      },
      tracking: {
        href: trackingUrl,
        impressionId: '11111111-1111-4111-8111-111111111111',
      },
    };

    expect(createRecommendationRenderer().render(request)).toBe(true);

    const host = insertedNodes[0];
    const link = host?.shadow?.children.find((child) => child.tagName === 'a');

    expect(link).toBeDefined();
    expect(link?.attributes.get('href')).toBe(trackingUrl);
    // Opens in a new tab so the user keeps their AI conversation, with
    // noopener/noreferrer to prevent reverse tabnabbing and referrer leakage.
    expect(link?.attributes.get('target')).toBe('_blank');
    expect(link?.attributes.get('rel')).toBe('noopener noreferrer');
    expect(link?.children.some((child) => child.textContent.includes('advertiser.example'))).toBe(
      false,
    );
  });

  it('removes stale AIRewards-marked hosts before rendering a fresh recommendation', () => {
    const insertedNodes: FakeElement[] = [];
    const orphan = new FakeElement('div');
    orphan.setAttribute('data-airewards-recommendation', '');
    orphan.isConnected = true;
    const landmark = {
      insertAdjacentElement: vi.fn((_position: InsertPosition, node: FakeElement) => {
        node.isConnected = true;
        insertedNodes.push(node);
        return node;
      }),
    };

    vi.stubGlobal('document', {
      createElement: (tagName: string) => new FakeElement(tagName),
      querySelector: (selector: string) => (selector === 'form' ? landmark : null),
      querySelectorAll: (selector: string) =>
        selector === '[data-airewards-recommendation]' ? [orphan] : [],
    });

    const request: RenderRequest = {
      platform: Platform.CHATGPT,
      layout: {
        landmarkSelector: 'form',
        insertion: 'afterend',
        disclaimerPresent: true,
      },
      content: {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Build production-grade apps with Postgres',
        url: 'https://advertiser.example/path',
      },
      tracking: {
        href: 'http://localhost:3001/v1/clicks?click_id=click-1',
        impressionId: '11111111-1111-4111-8111-111111111111',
      },
    };

    expect(createRecommendationRenderer().render(request)).toBe(true);

    expect(orphan.isConnected).toBe(false);
    expect(insertedNodes).toHaveLength(1);
  });
});
