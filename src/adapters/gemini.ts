import { type PageDocument, Platform, type PlatformAdapter } from './types';

const HOSTS = new Set(['gemini.google.com']);
const ROOT_SELECTOR = 'main';
const COMPOSER_SELECTOR = '[role="textbox"][aria-label="Enter a prompt for Gemini"]';

export const geminiAdapter: PlatformAdapter = {
  platform: Platform.GEMINI,

  detect: (location) => HOSTS.has(location.hostname),

  isReady: (document: PageDocument) =>
    document.readyState !== 'loading' &&
    document.querySelector(ROOT_SELECTOR) !== null &&
    document.querySelector(COMPOSER_SELECTOR) !== null,
};
