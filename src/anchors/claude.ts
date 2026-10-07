import { Platform } from '../adapters/types';
import { type LandmarkRule, discoverFromLandmarks } from './discovery';
import type { AnchorProvider } from './types';

/**
 * Stable structural landmarks for Claude. The composer (`fieldset`, which wraps
 * Claude's input) is the most stable surface; the conversation root (`main`) is
 * broader and scores lower. Selectors are content-agnostic; no business text is
 * read.
 */
const RULES: readonly LandmarkRule[] = [
  { id: 'claude-below-input', selector: 'fieldset', position: 'below_input', confidence: 0.8 },
  { id: 'claude-above-input', selector: 'fieldset', position: 'above_input', confidence: 0.7 },
  { id: 'claude-end-of-thread', selector: 'main', position: 'end_of_thread', confidence: 0.5 },
];

export const claudeAnchorProvider: AnchorProvider = {
  platform: Platform.CLAUDE,
  discover: (document) => discoverFromLandmarks(document, RULES),
};
