import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClickService } from './service';

const VALID_IMPRESSION = {
  impressionId: '11111111-1111-4111-8111-111111111111',
  adId: '22222222-2222-4222-8222-222222222222',
  placementId: 'chatgpt-below-input',
  provider: 'CHATGPT',
  destinationUrl: 'https://advertiser.example/path',
  validAt: 100,
};

describe('ClickService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('crypto', {
      randomUUID: vi
        .fn()
        .mockReturnValueOnce(VALID_IMPRESSION.impressionId)
        .mockReturnValueOnce('33333333-3333-4333-8333-333333333333'),
    });
  });

  it('builds a stable AIRewards redirect hyperlink without opening tabs', () => {
    const service = createClickService({ apiBaseUrl: 'http://localhost:3001' });

    const result = service.buildTrackingLink({
      adId: VALID_IMPRESSION.adId,
      provider: 'CHATGPT',
      destinationUrl: VALID_IMPRESSION.destinationUrl,
    });

    const url = new URL(result.href);
    expect(url.origin).toBe('http://localhost:3001');
    expect(url.pathname).toBe('/v1/clicks');
    expect(url.searchParams.get('impression_id')).toBe(result.impressionId);
    expect(url.searchParams.get('click_id')).toBe(result.clickId);
    expect(url.searchParams.get('ad_id')).toBe(VALID_IMPRESSION.adId);
    expect(url.searchParams.get('provider')).toBe('CHATGPT');
    expect(url.searchParams.get('platform')).toBe('chatgpt');
    expect(url.searchParams.get('destination')).toBe(VALID_IMPRESSION.destinationUrl);
    expect(url.searchParams.get('timestamp')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects direct advertiser destinations that are not HTTPS', () => {
    const service = createClickService({ apiBaseUrl: 'http://localhost:3001' });

    expect(() =>
      service.buildTrackingLink({
        adId: VALID_IMPRESSION.adId,
        provider: 'CHATGPT',
        destinationUrl: 'http://advertiser.example/path',
      }),
    ).toThrow('Destination URL must use HTTPS');
  });

  it('does not depend on chrome tab creation for recommendation clicks', () => {
    const service = createClickService({ apiBaseUrl: 'http://localhost:3001' });
    const chromeMock = { tabs: { create: vi.fn() } };
    vi.stubGlobal('chrome', chromeMock);

    service.buildTrackingLink({
      adId: VALID_IMPRESSION.adId,
      destinationUrl: VALID_IMPRESSION.destinationUrl,
      provider: 'CHATGPT',
    });

    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });
});
