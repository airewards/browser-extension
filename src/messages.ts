import type { User, Wallet } from './types';
import type { Anchor, Platform, SupportedPlatform } from './adapters/types';
import type { CommandDiagnosticEvent } from './diagnostics';
import type { PlacementRequest } from './placement';
import type { SponsoredProviderDiagnosticEvent, SponsoredRecommendation } from './sponsored';

/**
 * Typed message contracts for the extension.
 *
 * The background service worker is the single hub: the popup and the content
 * script communicate only with the worker, never with each other and never with
 * the API directly. Every message has exactly one definition here; none are
 * duplicated across entry points.
 *
 * Message `type` values are unique across all contracts so the worker can route
 * a single `onMessage` stream by `type` with exhaustiveness checking.
 */

// --- Popup <-> Background ---------------------------------------------------

export type PopupRequest =
  | { type: 'GET_POPUP_STATE' }
  | { type: 'GET_AUTH_STATE' }
  | { type: 'LOGIN' }
  | { type: 'OPEN_DASHBOARD' }
  | { type: 'LOGOUT' };

/** The popup's compact, API-derived authentication state. */
export interface PopupState {
  readonly isAuthenticated: boolean;
  readonly user?: AuthUser;
  readonly wallet?: Wallet;
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'logged_out' }
  | { status: 'logged_in'; user: AuthUser; wallet: Wallet }
  | { status: 'error'; message: string };

/** The subset of the user profile returned by GET /v1/user. */
export type AuthUser = Pick<User, 'id' | 'name' | 'email'> & {
  readonly impressionDurationMs: number;
};

export type PopupResponse = { ok: true; state: AuthState } | { ok: false; message: string };

export type PopupStateResponse =
  | { ok: true; popupState: PopupState }
  | { ok: false; message: string };

/** @deprecated Use {@link PopupResponse}. Retained as an alias for callers. */
export type BackgroundResponse = PopupResponse;

// --- Content Script <-> Background ------------------------------------------

/**
 * Content-script messages.
 *
 * - `CONTENT_SCRIPT_READY`: connectivity handshake; carries no page data.
 * - `PLATFORM_DETECTED`: reports which supported platform the tab is on, derived
 *   from URL information only.
 * - `PAGE_READY`: reports that the detected platform's page has finished
 *   initializing (required root elements exist). Only sent for a supported
 *   platform, so it carries a {@link SupportedPlatform}.
 * - `ANCHORS_DISCOVERED`: reports the ranked, validated candidate anchors found
 *   on the page. Read-only discovery result only; no element is ever inserted,
 *   no style is changed, and the DOM is never mutated. Only sent for a supported
 *   platform, so it carries a {@link SupportedPlatform}.
 * - `VALID_IMPRESSION`: emitted by the content script only after the rendered
 *   recommendation is continuously eligible for the configured visibility
 *   window. The renderer never calls the backend; the background records the
 *   impression.
 * - `ATTENTION_STATE`: reports whether the tab may currently qualify for
 *   impressions and long-session rotation. It is lifecycle state only, not an
 *   analytics event.
 */
export type ContentScriptRequest =
  | { type: 'CONTENT_SCRIPT_READY' }
  | { type: 'GET_DEBUG_STATE' }
  | { type: 'PLATFORM_DETECTED'; platform: Platform }
  | { type: 'PAGE_READY'; platform: SupportedPlatform }
  | { type: 'ANCHORS_DISCOVERED'; platform: SupportedPlatform; anchors: Anchor[] }
  | { type: 'ATTENTION_STATE'; active: boolean }
  | {
      type: 'VALID_IMPRESSION';
      adId: string;
      impressionId: string;
      placementId: string;
      provider: SupportedPlatform;
      conversationId: string | null;
      destinationUrl: string;
      viewedAt: number;
      durationMs: number;
    };

export type ContentScriptResponse =
  | {
      ok: true;
      acknowledged: true;
      diagnostics?: BackgroundDiagnostics;
      events?: readonly CommandDiagnosticEvent[];
    }
  | { ok: false; message: string };

export interface BackgroundDiagnostics {
  readonly apiBaseUrl: string;
  readonly buildMode: 'development' | 'production';
  readonly diagnosticsEnabled: boolean;
  readonly extensionVersion: string;
  readonly buildId: string;
  readonly builtAt: string;
  readonly rotationEvents: readonly CommandDiagnosticEvent[];
  readonly recommendationEvents: readonly SponsoredProviderDiagnosticEvent[];
  readonly tabs: Array<{
    readonly tabId: number;
    readonly platform: Platform;
    readonly ready: boolean;
    readonly attentionActive: boolean;
    readonly anchorCount: number;
    readonly hasPlacement: boolean;
  }>;
}

// --- Background -> Content Script -------------------------------------------

/**
 * Commands the worker sends to a content script (the reverse direction of
 * {@link ContentScriptRequest}). These drive the renderer lifecycle only.
 *
 * - `RENDER_RECOMMENDATION`: render the one-line Sponsored Recommendation for the
 *   selected {@link PlacementRequest}, using the already-resolved
 *   {@link SponsoredRecommendation} content the render controller supplies. The
 *   worker selects the placement and the render controller resolves real backend
 *   content (fresh API data → cache). The content script (which owns the DOM)
 *   resolves only the platform footer layout and renders the line. The renderer
 *   never calls the SDK. The content is a structural projection of the backend
 *   Ad and carries no campaign/advertiser/reward/impression/`tracking_signature`
 *   data.
 * - `DESTROY_RECOMMENDATION`: remove the line, restoring the page exactly.
 */
export type BackgroundCommand =
  | {
      type: 'RENDER_RECOMMENDATION';
      reason?: 'initial' | 'refresh' | 'rotation' | 'recovery';
      placement: PlacementRequest;
      content: SponsoredRecommendation;
      tracking: {
        href: string;
        impressionId: string;
      };
      impressionDurationMs: number;
      diagnostics?: readonly CommandDiagnosticEvent[];
    }
  | { type: 'DESTROY_RECOMMENDATION' };

export type BackgroundCommandResponse =
  | { ok: true; rendered: boolean }
  | { ok: false; message: string };

// --- Dashboard Bridge <-> Background ----------------------------------------

/**
 * Health-check message sent by the dashboard status bridge content script.
 * It carries no page data and asks the worker only to confirm it is awake.
 */
export type HealthCheckRequest = { type: 'AIREWARDS_HEALTH_CHECK' };

export type HealthCheckResponse =
  | { ok: true; backgroundAwake: true; version: string }
  | { ok: false; message: string };

// --- Aggregate --------------------------------------------------------------

/** Every message the background worker can receive. */
export type ExtensionRequest = PopupRequest | ContentScriptRequest | HealthCheckRequest;
