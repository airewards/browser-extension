import type { SupportedPlatform } from '../adapters/types';

export interface ClickService {
  buildTrackingLink(input: BuildTrackingLinkInput): TrackingLink;
}

export interface BuildTrackingLinkInput {
  readonly adId: string;
  readonly destinationUrl: string;
  readonly provider: SupportedPlatform;
}

export interface TrackingLink {
  readonly href: string;
  readonly impressionId: string;
  readonly clickId: string;
}

export interface ClickServiceOptions {
  readonly apiBaseUrl: string;
}

function buildClickId(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackUuid();
}

function fallbackUuid(): string {
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (char) =>
    (Number(char) ^ ((Math.random() * 16) >> (Number(char) / 4))).toString(16),
  );
}

export function createClickService({ apiBaseUrl }: ClickServiceOptions): ClickService {
  return {
    buildTrackingLink({ adId, destinationUrl, provider }: BuildTrackingLinkInput): TrackingLink {
      const destination = new URL(destinationUrl);
      if (destination.protocol !== 'https:') {
        throw new Error('Destination URL must use HTTPS');
      }

      const impressionId = buildClickId();
      const clickId = buildClickId();

      const url = new URL('/v1/clicks', apiBaseUrl);
      url.searchParams.set('click_id', clickId);
      url.searchParams.set('impression_id', impressionId);
      url.searchParams.set('ad_id', adId);
      url.searchParams.set('provider', provider);
      url.searchParams.set('platform', provider.toLowerCase() as Lowercase<typeof provider>);
      url.searchParams.set('destination', destination.toString());
      url.searchParams.set('timestamp', new Date().toISOString());

      return { href: url.toString(), impressionId, clickId };
    },
  };
}
