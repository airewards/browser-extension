import { config } from './config';
import type { HealthCheckRequest, HealthCheckResponse } from './messages';

/**
 * Dashboard status bridge.
 *
 * A dedicated, lightweight content script that runs ONLY on the AIRewards web
 * dashboard origins (see manifest.json). It lets the dashboard detect whether
 * the extension is installed, running, and its background worker is awake,
 * without any popup or backend round-trip.
 *
 * Protocol (all over window.postMessage, scoped to the page's own origin):
 *   dashboard -> bridge : { type: 'AIREWARDS_PING' }
 *   bridge    -> dashboard: { type: 'AIREWARDS_PONG', installed, version, backgroundAwake }
 *
 * Security posture:
 * - Only messages whose `source` is this exact window and whose `type` is the
 *   exact allowlisted value are handled. This ignores React devtools, third-
 *   party widgets, and any cross-window/iframe postMessage traffic.
 * - Replies are posted to `window.location.origin` (never '*'), so health data
 *   is never broadcast cross-origin.
 * - The bridge carries no session, auth, wallet, or user data — only a version
 *   string and a boolean proving the worker is awake.
 */

const PING_TYPE = 'AIREWARDS_PING';
const PONG_TYPE = 'AIREWARDS_PONG';

/** How long to wait for the background worker before declaring it asleep. */
const WORKER_TIMEOUT_MS = 1_500;

function isPing(value: unknown): value is { type: typeof PING_TYPE } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === PING_TYPE
  );
}

/**
 * Ask the background worker to confirm it is awake. Resolves `false` if the
 * worker is unreachable (asleep, crashed, or extension reloaded) or does not
 * answer within {@link WORKER_TIMEOUT_MS}, so the dashboard still gets a PONG
 * rather than a silent hang.
 */
function pingBackground(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (awake: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(awake);
      }
    };

    const timer = setTimeout(() => finish(false), WORKER_TIMEOUT_MS);

    try {
      const message: HealthCheckRequest = { type: 'AIREWARDS_HEALTH_CHECK' };
      chrome.runtime.sendMessage(message, (response: HealthCheckResponse | undefined) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          finish(false);
          return;
        }
        finish(response?.ok === true && response.backgroundAwake === true);
      });
    } catch {
      clearTimeout(timer);
      finish(false);
    }
  });
}

window.addEventListener('message', (event: MessageEvent) => {
  // Ignore anything not sent by this same window (devtools, iframes, other
  // scripts) and anything that is not our exact ping type.
  if (event.source !== window) {
    return;
  }
  if (!isPing(event.data)) {
    return;
  }

  void pingBackground().then((backgroundAwake) => {
    window.postMessage(
      {
        type: PONG_TYPE,
        installed: true,
        version: config.extensionVersion,
        backgroundAwake,
      },
      window.location.origin,
    );
  });
});
