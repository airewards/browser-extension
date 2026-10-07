import { type PageDocument, Platform, type PlatformAdapter } from './types';

const HOSTS = new Set(['grok.com', 'www.grok.com']);
const ROOT_SELECTOR = 'main';
const COMPOSER_SELECTORS = [
  'textarea[aria-label="Ask Grok anything"]',
  '[role="textbox"][aria-label="Ask Grok anything"]',
];

export const grokAdapter: PlatformAdapter = {
  platform: Platform.GROK,

  detect: (location) => HOSTS.has(location.hostname),

  isReady: (document: PageDocument) =>
    document.readyState !== 'loading' &&
    document.querySelector(ROOT_SELECTOR) !== null &&
    COMPOSER_SELECTORS.some((selector) => document.querySelector(selector) !== null),
};
