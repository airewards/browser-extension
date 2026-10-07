import { Platform } from '../adapters/types';
import { type LandmarkRule, discoverFromLandmarks } from './discovery';
import type { AnchorProvider } from './types';

const COMPOSER_SELECTOR = '[role="textbox"][aria-label="Enter a prompt for Gemini"]';

const RULES: readonly LandmarkRule[] = [
  {
    id: 'gemini-below-input',
    selector: COMPOSER_SELECTOR,
    position: 'below_input',
    confidence: 0.8,
  },
  {
    id: 'gemini-above-input',
    selector: COMPOSER_SELECTOR,
    position: 'above_input',
    confidence: 0.7,
  },
  { id: 'gemini-end-of-thread', selector: 'main', position: 'end_of_thread', confidence: 0.5 },
];

export const geminiAnchorProvider: AnchorProvider = {
  platform: Platform.GEMINI,
  discover: (document) => discoverFromLandmarks(document, RULES),
};
