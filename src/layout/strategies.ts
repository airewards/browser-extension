import type { Anchor, SupportedPlatform } from '../adapters/types';
import type { LayoutDocument, LayoutPlan, LayoutStrategy } from './types';

/**
 * Platform footer layout strategies.
 *
 * Each strategy adapts the one-line recommendation to its platform's available
 * footer space beneath the composer, placing it adjacent to (never over) any
 * first-party disclaimer. Strategies are pure and read-only: they resolve a
 * stable landmark and return a {@link LayoutPlan}, inserting nothing.
 *
 * Anchor positions map to footer-oriented placements:
 * - `below_input` / `above_input`: relative to the composer `form`/`fieldset`.
 * - `end_of_thread`: the conversation `main` footer region.
 * The preferred placement is the reserved footer space beneath the composer.
 */

const THREAD_SELECTOR = 'main';
const composerSelectors: Record<SupportedPlatform, readonly string[]> = {
  CHATGPT: ['form'],
  CLAUDE: ['fieldset', 'form'],
  GEMINI: ['[role="textbox"][aria-label="Enter a prompt for Gemini"]'],
  GROK: [
    'form',
    'textarea[aria-label="Ask Grok anything"]',
    '[role="textbox"][aria-label="Ask Grok anything"]',
  ],
};

function resolveComposerSelector(
  platform: SupportedPlatform,
  document: LayoutDocument,
): string | null {
  return composerSelectors[platform].find((selector) => document.querySelector(selector)) ?? null;
}

function footerPlan(
  platform: SupportedPlatform,
  anchor: Anchor,
  disclaimerPresent: boolean,
  document: LayoutDocument,
): LayoutPlan | null {
  switch (anchor.position) {
    case 'below_input':
      // Reserved footer space directly beneath the composer (preferred).
      return composerPlan(platform, document, 'afterend', disclaimerPresent);
    case 'above_input':
      return composerPlan(platform, document, 'beforebegin', disclaimerPresent);
    case 'end_of_thread':
      // Empty footer region at the end of the conversation.
      return { landmarkSelector: THREAD_SELECTOR, insertion: 'beforeend', disclaimerPresent };
  }
}

function composerPlan(
  platform: SupportedPlatform,
  document: LayoutDocument,
  insertion: LayoutPlan['insertion'],
  disclaimerPresent: boolean,
): LayoutPlan | null {
  const landmarkSelector = resolveComposerSelector(platform, document);
  return landmarkSelector ? { landmarkSelector, insertion, disclaimerPresent } : null;
}

/**
 * ChatGPT renders a first-party disclaimer ("ChatGPT can make mistakes...") in
 * the footer beneath the composer. The line is placed in the same footer space,
 * adjacent to it; the disclaimer is never removed, hidden, or altered.
 */
export function chatgptLayoutStrategy(): LayoutStrategy {
  return {
    platform: 'CHATGPT',
    plan(anchor, document: LayoutDocument) {
      return footerPlan('CHATGPT', anchor, true, document);
    },
  };
}

/**
 * Claude's composer footer is used for the recommendation line. Claude does not
 * expose a persistent first-party disclaimer in this region, so the available
 * footer spacing is used directly.
 */
export function claudeLayoutStrategy(): LayoutStrategy {
  return {
    platform: 'CLAUDE',
    plan(anchor, document: LayoutDocument) {
      return footerPlan('CLAUDE', anchor, false, document);
    },
  };
}

export function geminiLayoutStrategy(): LayoutStrategy {
  return {
    platform: 'GEMINI',
    plan(anchor, document: LayoutDocument) {
      return footerPlan('GEMINI', anchor, true, document);
    },
  };
}

export function grokLayoutStrategy(): LayoutStrategy {
  return {
    platform: 'GROK',
    plan(anchor, document: LayoutDocument) {
      return footerPlan('GROK', anchor, false, document);
    },
  };
}

/** Every layout strategy, keyed by the platform it serves. */
export const layoutStrategies: Record<SupportedPlatform, LayoutStrategy> = {
  CHATGPT: chatgptLayoutStrategy(),
  CLAUDE: claudeLayoutStrategy(),
  GEMINI: geminiLayoutStrategy(),
  GROK: grokLayoutStrategy(),
};
