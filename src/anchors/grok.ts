import { Platform } from '../adapters/types';
import { type LandmarkRule, discoverFromLandmarks } from './discovery';
import type { AnchorProvider } from './types';

const COMPOSER_SELECTOR =
  'textarea[aria-label="Ask Grok anything"], [role="textbox"][aria-label="Ask Grok anything"]';

const RULES: readonly LandmarkRule[] = [
  { id: 'grok-below-input', selector: COMPOSER_SELECTOR, position: 'below_input', confidence: 0.8 },
  { id: 'grok-above-input', selector: COMPOSER_SELECTOR, position: 'above_input', confidence: 0.7 },
  { id: 'grok-end-of-thread', selector: 'main', position: 'end_of_thread', confidence: 0.5 },
];

export const grokAnchorProvider: AnchorProvider = {
  platform: Platform.GROK,
  discover: (document) => discoverFromLandmarks(document, RULES),
};
