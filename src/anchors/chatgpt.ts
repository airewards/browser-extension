import { Platform } from '../adapters/types';
import { type LandmarkRule, discoverFromLandmarks } from './discovery';
import type { AnchorProvider } from './types';

/**
 * Stable structural landmarks for ChatGPT. Each rule maps a presence check to a
 * candidate position and a confidence reflecting how stable the landmark is.
 *
 * - The composer form (`form`) is the most stable surface; placements relative
 *   to it score highest.
 * - The conversation thread root (`main`) is always present once mounted but is
 *   broader, so an end-of-thread placement scores lower.
 *
 * Selectors are intentionally coarse and content-agnostic; no business text is
 * read.
 */
const RULES: readonly LandmarkRule[] = [
  { id: 'chatgpt-below-input', selector: 'form', position: 'below_input', confidence: 0.8 },
  { id: 'chatgpt-above-input', selector: 'form', position: 'above_input', confidence: 0.7 },
  { id: 'chatgpt-end-of-thread', selector: 'main', position: 'end_of_thread', confidence: 0.5 },
];

export const chatgptAnchorProvider: AnchorProvider = {
  platform: Platform.CHATGPT,
  discover: (document) => discoverFromLandmarks(document, RULES),
};
