import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from '../adapters/types';
import type { ClickService } from '../click/service';
import type { SponsoredProvider } from '../sponsored';
import { createRenderController } from './render-controller';

const sendMessage = vi.fn();
const onRemovedAddListener = vi.fn();

vi.stubGlobal('chrome', {
  tabs: {
    sendMessage,
    onRemoved: { addListener: onRemovedAddListener },
  },
});

describe('render controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessage.mockResolvedValue({ ok: true, rendered: true });
  });

  it('adds AIRewards click tracking metadata to render commands', async () => {
    const provider: SponsoredProvider = {
      resolve: vi.fn().mockResolvedValue({
        id: '22222222-2222-4222-8222-222222222222',
        sponsor: 'Sponsored',
        message: 'Ship reliable AI workflows',
        url: 'https://advertiser.example/path',
      }),
      refresh: vi.fn(),
      rotate: vi.fn(),
      recordRenderedAd: vi.fn(),
      getTrackingSignature: vi.fn(),
    };
    const clickService: ClickService = {
      buildTrackingLink: vi.fn().mockReturnValue({
        href: 'http://localhost:3001/v1/clicks?click_id=click-1&impression_id=11111111-1111-4111-8111-111111111111',
        impressionId: '11111111-1111-4111-8111-111111111111',
        clickId: '33333333-3333-4333-8333-333333333333',
      }),
    };

    const controller = createRenderController(provider, clickService);
    await controller.requestRender(1, {
      platform: Platform.CHATGPT,
      anchor: {
        id: 'chatgpt-below-input',
        platform: Platform.CHATGPT,
        position: 'below_input',
        confidence: 0.8,
        status: 'valid',
      },
    });

    expect(clickService.buildTrackingLink).toHaveBeenCalledWith({
      adId: '22222222-2222-4222-8222-222222222222',
      destinationUrl: 'https://advertiser.example/path',
      provider: Platform.CHATGPT,
    });
    expect(provider.recordRenderedAd).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
    expect(sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: 'RENDER_RECOMMENDATION',
        reason: 'initial',
        tracking: {
          href: 'http://localhost:3001/v1/clicks?click_id=click-1&impression_id=11111111-1111-4111-8111-111111111111',
          impressionId: '11111111-1111-4111-8111-111111111111',
        },
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ name: 'BACKGROUND_STARTED_RECOMMENDATION_FETCH' }),
          expect.objectContaining({ name: 'BACKGROUND_FETCH_COMPLETED' }),
          expect.objectContaining({ name: 'BACKGROUND_SENT_RENDER' }),
        ]),
      }),
    );
  });

  it('rotates by asking the provider for uncached content and rendering changed recommendations', async () => {
    const provider: SponsoredProvider = {
      resolve: vi.fn(),
      refresh: vi.fn(),
      rotate: vi.fn().mockResolvedValue({
        changed: true,
        content: {
          id: '22222222-2222-4222-8222-222222222222',
          sponsor: 'Sponsored',
          message: 'Ship reliable AI workflows',
          url: 'https://advertiser.example/path',
        },
      }),
      getTrackingSignature: vi.fn(),
    };
    const clickService: ClickService = {
      buildTrackingLink: vi.fn().mockReturnValue({
        href: 'http://localhost:3001/v1/clicks?click_id=click-1&impression_id=11111111-1111-4111-8111-111111111111',
        impressionId: '11111111-1111-4111-8111-111111111111',
        clickId: '33333333-3333-4333-8333-333333333333',
      }),
    };

    const controller = createRenderController(provider, clickService);
    await controller.requestRotation(1, {
      platform: Platform.CHATGPT,
      anchor: {
        id: 'chatgpt-below-input',
        platform: Platform.CHATGPT,
        position: 'below_input',
        confidence: 0.8,
        status: 'valid',
      },
    });

    expect(provider.rotate).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'RENDER_RECOMMENDATION', reason: 'rotation' }),
    );
  });

  it('does not send a render command when no backend recommendation is available', async () => {
    const provider: SponsoredProvider = {
      resolve: vi.fn().mockResolvedValue(null),
      refresh: vi.fn(),
      rotate: vi.fn(),
      getTrackingSignature: vi.fn(),
    };
    const clickService: ClickService = {
      buildTrackingLink: vi.fn(),
    };

    const controller = createRenderController(provider, clickService);
    const rendered = await controller.requestRender(1, {
      platform: Platform.CLAUDE,
      anchor: {
        id: 'claude-below-input',
        platform: Platform.CLAUDE,
        position: 'below_input',
        confidence: 0.8,
        status: 'valid',
      },
    });

    expect(rendered).toBe(false);
    expect(provider.resolve).toHaveBeenCalledWith({
      provider: Platform.CLAUDE,
      pathname: null,
      placementId: 'claude-below-input',
      reason: 'initial',
    });
    expect(clickService.buildTrackingLink).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('records why a render command was skipped when the provider returns null', async () => {
    const events: Array<{ name: string; details?: Record<string, unknown> }> = [];
    const provider: SponsoredProvider = {
      resolve: vi.fn().mockResolvedValue(null),
      refresh: vi.fn(),
      rotate: vi.fn(),
      getTrackingSignature: vi.fn(),
    };
    const controller = createRenderController(provider, undefined, {
      onDiagnosticEvent(event) {
        events.push(event);
      },
    });

    await expect(
      controller.requestRender(1, {
        platform: Platform.CHATGPT,
        anchor: {
          id: 'chatgpt-below-input',
          platform: Platform.CHATGPT,
          position: 'below_input',
          confidence: 0.8,
          status: 'valid',
        },
      }),
    ).resolves.toBe(false);

    expect(events).toEqual([
      expect.objectContaining({ name: 'BACKGROUND_STARTED_RECOMMENDATION_FETCH' }),
      expect.objectContaining({
        name: 'BACKGROUND_FETCH_COMPLETED',
        details: expect.objectContaining({ adId: null, changed: false }),
      }),
      expect.objectContaining({
        name: 'RENDER_SKIPPED',
        details: expect.objectContaining({
          failureReason: 'provider_returned_null',
          recommendationState: 'null',
          placementId: 'chatgpt-below-input',
        }),
      }),
    ]);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
