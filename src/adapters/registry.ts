import { chatgptAdapter } from './chatgpt';
import { claudeAdapter } from './claude';
import { geminiAdapter } from './gemini';
import { grokAdapter } from './grok';
import { type PageLocation, Platform, type PlatformAdapter } from './types';

/**
 * The ordered list of supported adapters. Adding a platform means appending its
 * adapter here; detection and readiness need no other change.
 */
export const adapters: readonly PlatformAdapter[] = [
  chatgptAdapter,
  claudeAdapter,
  geminiAdapter,
  grokAdapter,
];

/**
 * Return the adapter for a location using URL information only, or `null` for
 * unsupported domains.
 */
export function resolveAdapter(location: PageLocation): PlatformAdapter | null {
  return adapters.find((adapter) => adapter.detect(location)) ?? null;
}

/**
 * Identify the platform for a location using URL information only. Returns
 * `Platform.UNKNOWN` for unsupported domains and pages.
 */
export function detectPlatform(location: PageLocation): Platform {
  return resolveAdapter(location)?.platform ?? Platform.UNKNOWN;
}
