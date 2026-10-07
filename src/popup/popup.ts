import type {
  AuthState,
  AuthUser,
  BackgroundResponse,
  PopupRequest,
  PopupState,
  PopupStateResponse,
} from '../messages';
import {
  type PopupCache,
  clearPopupCache,
  getPopupCache,
  setPopupCache,
  setUiPreferences,
} from '../storage';

const content = document.getElementById('content') as HTMLElement;

function sendMessage(request: PopupRequest): Promise<BackgroundResponse> {
  return chrome.runtime.sendMessage(request);
}

function getPopupState(): Promise<PopupStateResponse> {
  return chrome.runtime.sendMessage({ type: 'GET_POPUP_STATE' });
}

async function closeAfter(request: PopupRequest): Promise<void> {
  try {
    // Logout clears the cached authenticated view so the next open can never
    // render a stale profile before the backend cookie is confirmed gone.
    if (request.type === 'LOGOUT') {
      await clearPopupCache();
    }
    await sendMessage(request);
  } finally {
    window.close();
  }
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function formatBalance(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    }).format(amount);
  } catch {
    return `${amount.toFixed(4)} ${currency}`;
  }
}

/**
 * Live references to the mutable fields of the logged-in view. Held so a
 * reconciliation can update only the changed text in place (avatar, name, email,
 * balance) instead of tearing down and rebuilding the DOM, which would flicker.
 * Reset whenever a different view is rendered.
 */
interface LoggedInElements {
  avatar: HTMLElement;
  name: HTMLElement;
  email: HTMLElement;
  balance: HTMLElement;
}

let loggedInElements: LoggedInElements | null = null;

function clear(): void {
  loggedInElements = null;
  content.replaceChildren();
}

function renderLoading(): void {
  clear();
  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  content.append(spinner);
}

function renderLoggedOut(): void {
  clear();
  const message = document.createElement('p');
  message.className = 'message';
  message.textContent = 'Please log in to start earning rewards.';

  const button = document.createElement('button');
  button.className = 'button button--primary';
  button.textContent = 'Log In';
  button.addEventListener('click', () => {
    void closeAfter({ type: 'LOGIN' });
  });

  content.append(message, button);
}

function renderError(message: string): void {
  clear();
  const text = document.createElement('p');
  text.className = 'message message--error';
  text.textContent = message;

  const retry = document.createElement('button');
  retry.className = 'button button--secondary';
  retry.textContent = 'Try again';
  retry.addEventListener('click', load);

  content.append(text, retry);
}

function renderLoggedIn(user: AuthUser, balanceLabel: string): void {
  // Reconcile in place when the logged-in view is already mounted: update only
  // the changed text so the popup converges to the live state without a
  // destroy/recreate flicker.
  if (loggedInElements) {
    loggedInElements.avatar.textContent = initials(user.name);
    loggedInElements.name.textContent = user.name;
    loggedInElements.email.textContent = user.email;
    loggedInElements.balance.textContent = balanceLabel;
    return;
  }

  clear();

  const status = document.createElement('p');
  status.className = 'status status--active';
  status.textContent = 'Status: Active';

  const profile = document.createElement('div');
  profile.className = 'profile';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = initials(user.name);

  const details = document.createElement('div');
  details.className = 'profile__details';

  const name = document.createElement('span');
  name.className = 'profile__name';
  name.textContent = user.name;

  const email = document.createElement('span');
  email.className = 'profile__email';
  email.textContent = user.email;

  details.append(name, email);
  profile.append(avatar, details);

  const wallet = document.createElement('div');
  wallet.className = 'wallet';

  const walletLabel = document.createElement('p');
  walletLabel.className = 'wallet__label';
  walletLabel.textContent = 'Available balance';

  const walletBalance = document.createElement('p');
  walletBalance.className = 'wallet__balance';
  walletBalance.textContent = balanceLabel;

  wallet.append(walletLabel, walletBalance);

  const dashboard = document.createElement('button');
  dashboard.className = 'button button--primary';
  dashboard.textContent = 'Go to Dashboard';
  dashboard.addEventListener('click', () => {
    void closeAfter({ type: 'OPEN_DASHBOARD' });
  });

  content.append(status, profile, wallet, dashboard);

  loggedInElements = { avatar, name, email, balance: walletBalance };
}

function render(state: AuthState): void {
  switch (state.status) {
    case 'loading':
      renderLoading();
      break;
    case 'logged_out':
      renderLoggedOut();
      break;
    case 'error':
      renderError(state.message);
      break;
    case 'logged_in':
      renderLoggedIn(
        state.user,
        formatBalance(state.wallet.availableBalance, state.wallet.currency),
      );
      break;
  }
}

function cacheToState(cache: PopupCache): AuthState {
  return cache.authenticated
    ? { status: 'logged_in', user: cache.user, wallet: cache.wallet }
    : { status: 'logged_out' };
}

function stateToCache(state: AuthState): PopupCache | null {
  switch (state.status) {
    case 'logged_in':
      return { authenticated: true, user: state.user, wallet: state.wallet, updatedAt: Date.now() };
    case 'logged_out':
      return { authenticated: false, updatedAt: Date.now() };
    default:
      return null;
  }
}

function popupStateToAuthState(popupState: PopupState): AuthState {
  if (!popupState.isAuthenticated) {
    return { status: 'logged_out' };
  }

  if (popupState.user && popupState.wallet) {
    return { status: 'logged_in', user: popupState.user, wallet: popupState.wallet };
  }

  return { status: 'error', message: 'Your account details could not be loaded.' };
}

/**
 * Gates re-rendering only (the cache is always written with the latest server
 * snapshot regardless). Compares every presentation field the popup renders, so
 * an unchanged view is never re-rendered (no flicker) while any real change to a
 * rendered field triggers an in-place update. When a new rendered field is added
 * (e.g. a reward counter), add it both here and to the renderer together.
 */
function statesEqual(a: AuthState, b: AuthState): boolean {
  if (a.status !== b.status) {
    return false;
  }
  if (a.status === 'logged_in' && b.status === 'logged_in') {
    return (
      a.user.id === b.user.id &&
      a.user.name === b.user.name &&
      a.user.email === b.user.email &&
      a.wallet.availableBalance === b.wallet.availableBalance &&
      a.wallet.currency === b.wallet.currency
    );
  }
  return true;
}

/**
 * Centralized popup timing configuration. One place to tune the popup's
 * freshness UX (when the slow poll starts, its cadence, and the failure backoff
 * schedule) without touching the reconciliation logic.
 *
 * - `delayedPollingStartMs`: the popup must stay continuously open this long
 *   before any background poll starts; a normal short-lived open never polls.
 * - `pollingIntervalMs`: slow-poll cadence once polling has started.
 * - `backoffScheduleMs`: minimum spacing between revalidations after
 *   consecutive failures (1st, 2nd, 3rd+). Reset on the next success.
 */
const POPUP_CONFIG = {
  delayedPollingStartMs: 60_000,
  pollingIntervalMs: 60_000,
  backoffScheduleMs: [30_000, 60_000, 120_000],
} as const;

/**
 * The state currently on screen. Revalidation compares fresh server state
 * against this (not the initial cache) so every cycle reconciles against what
 * the user actually sees. `null` until the first view is rendered.
 */
let displayedState: AuthState | null = null;

function show(state: AuthState): void {
  render(state);
  displayedState = state;
}

/**
 * Serializes revalidations. `isRefreshing` prevents overlapping requests
 * (focus, poll, and open can all fire). `latestRequestId` lets a slower,
 * older response be discarded if a newer refresh has already applied its result.
 */
let isRefreshing = false;
let latestRequestId = 0;

/**
 * Lightweight failure backoff. After consecutive failures, revalidations are
 * spaced by {@link POPUP_CONFIG.backoffScheduleMs} so a backend outage is not
 * hammered by every focus/poll trigger. Any success resets it immediately.
 */
let consecutiveFailures = 0;
let nextAllowedAt = 0;

function recordSuccess(): void {
  consecutiveFailures = 0;
  nextAllowedAt = 0;
}

function recordFailure(): void {
  const schedule = POPUP_CONFIG.backoffScheduleMs;
  const delay = schedule[Math.min(consecutiveFailures, schedule.length - 1)];
  consecutiveFailures += 1;
  nextAllowedAt = Date.now() + delay;
}

/**
 * Revalidate the session and reconcile the popup with the authoritative backend
 * state. Always refreshes the cache on a successful fetch, and re-renders only
 * when a rendered field changed, so an already-correct popup is left untouched.
 * On expiry the Sign in screen is shown; transient errors keep the current view
 * (the cache remains an optimization, never the source of truth).
 *
 * Concurrency-safe: a refresh already in flight is skipped, and a response is
 * applied only when it is still the latest issued request. After repeated
 * failures it is throttled by the backoff schedule.
 */
async function revalidate(): Promise<void> {
  if (isRefreshing || Date.now() < nextAllowedAt) {
    return;
  }
  isRefreshing = true;
  const requestId = ++latestRequestId;

  try {
    const response = await getPopupState();

    if (requestId !== latestRequestId) {
      return;
    }

    if (!response.ok) {
      recordFailure();
      if (!displayedState) {
        renderError(response.message);
      }
      return;
    }

    const state = popupStateToAuthState(response.popupState);

    recordSuccess();

    const nextCache = stateToCache(state);
    if (nextCache) {
      await setPopupCache(nextCache);
    }

    if (!displayedState || !statesEqual(displayedState, state)) {
      show(state);
    }

    if (state.status === 'logged_in') {
      await setUiPreferences({ lastViewedAt: Date.now() });
    }
  } catch (error) {
    if (requestId === latestRequestId) {
      recordFailure();
      if (!displayedState) {
        renderError(
          error instanceof Error ? error.message : 'Unable to reach the extension service.',
        );
      }
    }
  } finally {
    if (requestId === latestRequestId) {
      isRefreshing = false;
    }
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollStartTimer: ReturnType<typeof setTimeout> | null = null;

function isVisible(): boolean {
  return !document.hidden;
}

function stopPoll(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Run the slow poll only while the popup is visible; pause it when hidden. */
function syncPoll(): void {
  if (isVisible()) {
    if (pollTimer === null) {
      pollTimer = setInterval(() => void revalidate(), POPUP_CONFIG.pollingIntervalMs);
    }
  } else {
    stopPoll();
  }
}

/**
 * Arm the poll after the popup has been continuously open for the start delay.
 * Until then, freshness relies on the open-time and focus-driven validations.
 */
function armPoll(): void {
  if (pollStartTimer === null) {
    pollStartTimer = setTimeout(syncPoll, POPUP_CONFIG.delayedPollingStartMs);
  }
}

function teardown(): void {
  stopPoll();
  if (pollStartTimer !== null) {
    clearTimeout(pollStartTimer);
    pollStartTimer = null;
  }
}

// The popup document is destroyed on close, which already stops timers; clearing
// them explicitly avoids a stray cycle during teardown and keeps the "no work
// while closed" guarantee precise.
window.addEventListener('pagehide', teardown);
window.addEventListener('beforeunload', teardown);

// Revalidate once whenever the popup becomes active again, and pause/resume the
// slow poll with visibility.
function handleReactivation(): void {
  if (isVisible()) {
    void revalidate();
  }
  syncPoll();
}

document.addEventListener('visibilitychange', handleReactivation);
window.addEventListener('pageshow', handleReactivation);
window.addEventListener('focus', handleReactivation);

async function load(): Promise<void> {
  const cache = await getPopupCache();

  if (cache) {
    show(cacheToState(cache));
  } else {
    renderLoading();
  }

  await revalidate();

  armPoll();
}

void load();
