import { type PageDocument, Platform, type PlatformAdapter } from './types';

/** Hosts that serve the Claude web app. */
const HOSTS = new Set(['claude.ai']);

/**
 * Claude hard-refreshes existing chats without the `main` landmark. The
 * composer fieldset is the stable readiness boundary shared by `/new` and
 * `/chat/*`.
 */
const COMPOSER_SELECTOR = 'fieldset';

export const claudeAdapter: PlatformAdapter = {
  platform: Platform.CLAUDE,

  detect: (location) => HOSTS.has(location.hostname),

  isReady: (document: PageDocument) =>
    document.readyState !== 'loading' && document.querySelector(COMPOSER_SELECTOR) !== null,
};
