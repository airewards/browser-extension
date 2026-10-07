/**
 * Non-sensitive UI preference and presentation-state storage.
 *
 * chrome.storage.local is used ONLY for UI preferences and non-sensitive
 * extension state. Credentials (JWTs, OAuth tokens, session cookies, secrets)
 * are NEVER stored here. The session lives exclusively in the backend's HttpOnly
 * cookie, which extension JavaScript cannot read (ADR 0013, ADR 0014).
 */

import type { Wallet } from './types';
import type { AuthUser } from './messages';

export interface UiPreferences {
  lastViewedAt: number | null;
}

const DEFAULT_PREFERENCES: UiPreferences = {
  lastViewedAt: null,
};

const STORAGE_KEY = 'uiPreferences';

export async function getUiPreferences(): Promise<UiPreferences> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_PREFERENCES, ...stored[STORAGE_KEY] };
}

export async function setUiPreferences(preferences: Partial<UiPreferences>): Promise<void> {
  const current = await getUiPreferences();
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...current, ...preferences } });
}

/**
 * Cached popup presentation state.
 *
 * Lets the popup render the last known authenticated view instantly while the
 * background session is revalidated. This is presentation state only: the user
 * profile and wallet already returned by the API for display. It is NOT a
 * session and grants no access — every request still depends on the backend's
 * HttpOnly cookie, so a stale cache can render but can never authenticate. No
 * token or credential is ever stored here (ADR 0013, ADR 0014).
 */
export type PopupCache =
  | { authenticated: true; user: AuthUser; wallet: Wallet; updatedAt: number }
  | { authenticated: false; updatedAt: number };

const POPUP_CACHE_KEY = 'popupCache';
const DEVICE_FINGERPRINT_KEY = 'deviceFingerprint';

export async function getPopupCache(): Promise<PopupCache | null> {
  const stored = await chrome.storage.local.get(POPUP_CACHE_KEY);
  return (stored[POPUP_CACHE_KEY] as PopupCache | undefined) ?? null;
}

export async function setPopupCache(cache: PopupCache): Promise<void> {
  await chrome.storage.local.set({ [POPUP_CACHE_KEY]: cache });
}

export async function clearPopupCache(): Promise<void> {
  await chrome.storage.local.remove(POPUP_CACHE_KEY);
}

function createDeviceFingerprint(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `browser-extension:${random}`;
}

export async function getOrCreateDeviceFingerprint(): Promise<string> {
  const stored = await chrome.storage.local.get(DEVICE_FINGERPRINT_KEY);
  const existing = stored[DEVICE_FINGERPRINT_KEY];
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }

  const fingerprint = createDeviceFingerprint();
  await chrome.storage.local.set({ [DEVICE_FINGERPRINT_KEY]: fingerprint });
  return fingerprint;
}
