import type { ClickService } from '../click/service';
import type { CommandDiagnosticEvent } from '../diagnostics';
import type { BackgroundCommand, BackgroundCommandResponse } from '../messages';
import type { PlacementRequest } from '../placement';
import type { SponsoredProvider, SponsoredRecommendation } from '../sponsored';

/**
 * Render controller.
 *
 * Coordinates rendering only. Per the frozen browser pipeline (SDK → Sponsored
 * Provider → Render Controller → Placement Engine → Layout Strategy → Renderer)
 * it decides only **whether** to render, rerender, or destroy:
 *
 * - {@link RenderController.requestRender}: initial render — ask the
 *   {@link SponsoredProvider} for content and command a render.
 * - {@link RenderController.requestRefresh}: refresh — ask the provider to
 *   re-resolve, and command a render **only when the content actually changed**.
 *   Identical recommendation ids never re-render, so the line never flickers.
 * - {@link RenderController.requestDestroy}: command cleanup.
 *
 * It does NOT call the SDK, own the cache, perform mapping, retry, fallback, or
 * decide refresh **timing** — those belong exclusively to the
 * {@link SponsoredProvider}. It performs no discovery or selection and holds no
 * page state; the caller supplies the selected {@link PlacementRequest}. Footer
 * layout is resolved content-side (where the DOM lives), so the worker stays
 * DOM-free. The renderer never calls the SDK and is unaware of refresh logic.
 *
 * Commands are best-effort: if the content script is unreachable (tab gone, not
 * yet injected, extension reloaded) the send is swallowed so the worker never
 * produces an uncaught rejection. The provider never throws — the UI always
 * receives content and never disappears.
 */
export interface RenderController {
  /** Request that the tab render the recommendation line for the placement. */
  requestRender(tabId: number, placement: PlacementRequest): Promise<boolean>;
  /**
   * Ask the provider to refresh and re-render the placement only when the
   * recommendation content has actually changed. A no-op (no command sent) when
   * the content is unchanged, so the rendered line never flickers during a
   * refresh and is never removed mid-refresh.
   */
  requestRefresh(tabId: number, placement: PlacementRequest): Promise<boolean>;
  /** Request scheduled rotation for a long-lived rendered placement. */
  requestRotation(tabId: number, placement: PlacementRequest): Promise<boolean>;
  /** Request that the tab remove the recommendation line, restoring the page. */
  requestDestroy(tabId: number): Promise<void>;
}

export interface RenderControllerOptions {
  readonly onDiagnosticEvent?: (event: CommandDiagnosticEvent) => void;
  readonly getImpressionDurationMs?: () => number;
}

async function sendCommandToTab(
  tabId: number,
  command: BackgroundCommand,
): Promise<BackgroundCommandResponse | null> {
  try {
    return (await chrome.tabs.sendMessage(tabId, command)) as BackgroundCommandResponse;
  } catch {
    return null;
  }
}

export function createRenderController(
  provider: SponsoredProvider,
  clickService?: ClickService,
  options: RenderControllerOptions = {},
): RenderController {
  const generations = new Map<number, number>();

  chrome.tabs.onRemoved.addListener((tabId) => {
    generations.delete(tabId);
  });

  function nextGeneration(tabId: number): number {
    const next = (generations.get(tabId) ?? 0) + 1;
    generations.set(tabId, next);
    return next;
  }

  function isValid(tabId: number, gen: number): boolean {
    return generations.get(tabId) === gen;
  }

  async function commandRender(
    tabId: number,
    placement: PlacementRequest,
    content: SponsoredRecommendation,
    gen: number,
    reason: 'initial' | 'refresh' | 'rotation',
    diagnostics: readonly CommandDiagnosticEvent[],
  ): Promise<boolean> {
    if (!isValid(tabId, gen)) {
      emit(
        renderSkippedEvent(placement, reason, 'stale_generation', {
          recommendationState: 'stale',
          adId: content.id,
        }),
      );
      return false;
    }
    const tracking = clickService
      ? clickService.buildTrackingLink({
          adId: content.id,
          destinationUrl: content.url,
          provider: placement.platform,
        })
      : { href: content.url, impressionId: '' };
    const commandCreated = emit(
      diagnosticEvent('RENDER_COMMAND_CREATED', placement, reason, {
        placementId: placement.anchor.id,
        adId: content.id,
        impressionId: tracking.impressionId,
        href: tracking.href,
      }),
    );
    const renderCommandDiagnostics = [
      ...diagnostics,
      commandCreated,
      diagnosticEvent('BACKGROUND_SENT_RENDER', placement, reason, {
        adId: content.id,
        impressionId: tracking.impressionId,
        href: tracking.href,
      }),
    ];
    const response = await sendCommandToTab(tabId, {
      type: 'RENDER_RECOMMENDATION',
      reason,
      placement,
      content,
      tracking: {
        href: tracking.href,
        impressionId: tracking.impressionId,
      },
      impressionDurationMs: options.getImpressionDurationMs?.() ?? 5_000,
      diagnostics: renderCommandDiagnostics,
    });
    const rendered = response?.ok === true && response.rendered;
    if (rendered) {
      provider.recordRenderedAd?.(content.id);
    }
    return rendered;
  }

  function diagnosticEvent(
    name: CommandDiagnosticEvent['name'],
    placement: PlacementRequest,
    reason: 'initial' | 'refresh' | 'rotation',
    details?: Record<string, unknown>,
  ): CommandDiagnosticEvent {
    return {
      name,
      timestamp: new Date().toISOString(),
      provider: placement.platform,
      details: {
        reason,
        selectedAnchor: placement.anchor.id,
        ...details,
      },
    };
  }

  function emit(event: CommandDiagnosticEvent): CommandDiagnosticEvent {
    options.onDiagnosticEvent?.(event);
    return event;
  }

  function providerContext(
    placement: PlacementRequest,
    reason: 'initial' | 'refresh' | 'rotation',
  ) {
    return {
      provider: placement.platform,
      pathname: null,
      placementId: placement.anchor.id,
      reason,
    } as const;
  }

  function renderSkippedEvent(
    placement: PlacementRequest,
    reason: 'initial' | 'refresh' | 'rotation',
    failureReason: 'provider_returned_null' | 'unchanged_recommendation' | 'stale_generation',
    details?: Record<string, unknown>,
  ): CommandDiagnosticEvent {
    return diagnosticEvent('RENDER_SKIPPED', placement, reason, {
      placementId: placement.anchor.id,
      failureReason,
      ...details,
    });
  }

  return {
    async requestRender(tabId, placement) {
      const gen = nextGeneration(tabId);
      const diagnostics = [
        emit(diagnosticEvent('BACKGROUND_STARTED_RECOMMENDATION_FETCH', placement, 'initial')),
      ];
      const content = await provider.resolve(providerContext(placement, 'initial'));
      const completed = emit(
        diagnosticEvent('BACKGROUND_FETCH_COMPLETED', placement, 'initial', {
          adId: content?.id ?? null,
          changed: content !== null,
        }),
      );
      diagnostics.push(completed);
      if (!content) {
        emit(
          renderSkippedEvent(placement, 'initial', 'provider_returned_null', {
            recommendationState: 'null',
            adId: null,
          }),
        );
        return false;
      }
      return commandRender(tabId, placement, content, gen, 'initial', diagnostics);
    },

    async requestRefresh(tabId, placement) {
      const gen = nextGeneration(tabId);
      const diagnostics = [
        emit(diagnosticEvent('BACKGROUND_STARTED_RECOMMENDATION_FETCH', placement, 'refresh')),
      ];
      const { changed, content } = await provider.refresh(providerContext(placement, 'refresh'));
      const completed = emit(
        diagnosticEvent('BACKGROUND_FETCH_COMPLETED', placement, 'refresh', {
          adId: content?.id ?? null,
          changed,
        }),
      );
      diagnostics.push(completed);
      // Re-render only on a genuine content change. When unchanged, send no
      // command at all: the existing line stays in place untouched (no flicker,
      // never removed mid-refresh).
      if (!changed || !content) {
        emit(
          renderSkippedEvent(
            placement,
            'refresh',
            content ? 'unchanged_recommendation' : 'provider_returned_null',
            {
              recommendationState: content ? 'unchanged' : 'null',
              adId: content?.id ?? null,
            },
          ),
        );
        return false;
      }
      return commandRender(tabId, placement, content, gen, 'refresh', diagnostics);
    },

    async requestRotation(tabId, placement) {
      const gen = nextGeneration(tabId);
      const diagnostics = [
        emit(diagnosticEvent('BACKGROUND_STARTED_RECOMMENDATION_FETCH', placement, 'rotation')),
      ];
      const { changed, content } = await provider.rotate(providerContext(placement, 'rotation'));
      const completed = emit(
        diagnosticEvent('BACKGROUND_FETCH_COMPLETED', placement, 'rotation', {
          adId: content?.id ?? null,
          changed,
        }),
      );
      diagnostics.push(completed);
      if (!changed || !content) {
        emit(
          renderSkippedEvent(
            placement,
            'rotation',
            content ? 'unchanged_recommendation' : 'provider_returned_null',
            {
              recommendationState: content ? 'unchanged' : 'null',
              adId: content?.id ?? null,
            },
          ),
        );
        return false;
      }
      return commandRender(tabId, placement, content, gen, 'rotation', diagnostics);
    },

    async requestDestroy(tabId) {
      nextGeneration(tabId);
      await sendCommandToTab(tabId, { type: 'DESTROY_RECOMMENDATION' });
    },
  };
}
