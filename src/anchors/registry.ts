import type { Anchor, PageDocument, SupportedPlatform } from '../adapters/types';
import { chatgptAnchorProvider } from './chatgpt';
import { claudeAnchorProvider } from './claude';
import { geminiAnchorProvider } from './gemini';
import { grokAnchorProvider } from './grok';
import { rankAnchors } from './ranking';
import type { AnchorProvider } from './types';
import { acceptValid, validateCandidate } from './validation';

/**
 * Providers indexed by platform. Adding a platform means registering its
 * provider here; the discovery pipeline below is unchanged.
 */
const providers: Record<SupportedPlatform, AnchorProvider> = {
  CHATGPT: chatgptAnchorProvider,
  CLAUDE: claudeAnchorProvider,
  GEMINI: geminiAnchorProvider,
  GROK: grokAnchorProvider,
};

/**
 * Discover, validate, and rank anchors for a platform.
 *
 * Pipeline: provider discovery (read-only) → validation (reject invalid) → keep
 * valid only → rank best-first. Returns ranked, valid anchors. No element is
 * inserted, no style is changed, nothing is persisted, and nothing is sent to
 * the backend.
 */
export function discoverAnchors(platform: SupportedPlatform, document: PageDocument): Anchor[] {
  const provider = providers[platform];
  const validated = provider
    .discover(document)
    .map((candidate) => validateCandidate(platform, candidate));

  return rankAnchors(acceptValid(validated));
}
