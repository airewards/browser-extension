import { describe, expect, it, vi } from 'vitest';
import { Platform } from '../adapters/types';
import type { Anchor } from '../adapters/types';
import { planLayout } from './engine';

describe('layout strategies', () => {
  it('uses the observed Grok textarea composer when no form landmark is available', () => {
    const querySelector = vi.fn((selector: string) =>
      selector === 'textarea[aria-label="Ask Grok anything"]' ? ({} as Element) : null,
    );
    const anchor: Anchor = {
      id: 'grok-below-input',
      platform: Platform.GROK,
      position: 'below_input',
      confidence: 0.8,
      status: 'valid',
    };

    const request = planLayout(
      { platform: Platform.GROK, anchor },
      {
        id: 'ad-1',
        sponsor: 'Sponsored',
        message: 'Ship reliable AI workflows',
        url: 'https://advertiser.example/path',
      },
      { querySelector },
      {
        href: 'http://localhost:3001/v1/clicks?click_id=click-1',
        impressionId: '11111111-1111-4111-8111-111111111111',
      },
    );

    expect(request?.layout.landmarkSelector).toBe('textarea[aria-label="Ask Grok anything"]');
    expect(request?.layout.insertion).toBe('afterend');
  });
});
