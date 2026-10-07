import { type PageDocument, Platform, type PlatformAdapter } from './types';

/** Hosts that serve the ChatGPT web app. */
const HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

/**
 * Stable structural root for the ChatGPT app. The `main` landmark is present
 * only once the SPA has mounted, so its existence is a reliable, non-brittle
 * readiness signal that does not depend on conversation content.
 */
const ROOT_SELECTOR = 'main';

export const chatgptAdapter: PlatformAdapter = {
  platform: Platform.CHATGPT,

  detect: (location) => HOSTS.has(location.hostname),

  isReady: (document: PageDocument) =>
    document.readyState !== 'loading' && document.querySelector(ROOT_SELECTOR) !== null,
};
