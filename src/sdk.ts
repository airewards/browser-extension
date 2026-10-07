import { config } from './config';

/**
 * Native, standalone API client for the AIRewards browser extension.
 * Sends credentials: 'include' with all requests to forward the backend's
 * HttpOnly session cookie without storing tokens or secrets in extension storage.
 */
export const sdk = {
  v1: {
    ads: {
      current: {
        $get: async (opts?: { query?: Record<string, string | undefined> }) => {
          const url = new URL('/v1/ads/current', config.apiBaseUrl);
          if (opts?.query) {
            for (const [k, v] of Object.entries(opts.query)) {
              if (v !== undefined) url.searchParams.set(k, v);
            }
          }
          const res = await fetch(url.toString(), { credentials: 'include' });
          return { status: res.status, json: async () => res.json() };
        },
      },
    },
    user: {
      $get: async () => {
        const res = await fetch(`${config.apiBaseUrl}/v1/user`, { credentials: 'include' });
        return { status: res.status, json: async () => res.json() };
      },
    },
    wallet: {
      $get: async () => {
        const res = await fetch(`${config.apiBaseUrl}/v1/wallet`, { credentials: 'include' });
        return { status: res.status, json: async () => res.json() };
      },
    },
    devices: {
      register: {
        $post: async (opts: { json: unknown }) => {
          const res = await fetch(`${config.apiBaseUrl}/v1/devices/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts.json),
            credentials: 'include',
          });
          return { status: res.status, json: async () => res.json() };
        },
      },
    },
  },
  v2: {
    impressions: {
      challenges: {
        $post: async (opts: { json: unknown }) => {
          const res = await fetch(`${config.apiBaseUrl}/v2/impressions/challenges`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts.json),
            credentials: 'include',
          });
          return { status: res.status, json: async () => res.json() };
        },
      },
      ':impressionId': {
        heartbeats: {
          $post: async (opts: { param: { impressionId: string }; json: unknown }) => {
            const res = await fetch(
              `${config.apiBaseUrl}/v2/impressions/${encodeURIComponent(opts.param.impressionId)}/heartbeats`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(opts.json),
                credentials: 'include',
              },
            );
            return { status: res.status, json: async () => res.json() };
          },
        },
        complete: {
          $post: async (opts: { param: { impressionId: string }; json: unknown }) => {
            const res = await fetch(
              `${config.apiBaseUrl}/v2/impressions/${encodeURIComponent(opts.param.impressionId)}/complete`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(opts.json),
                credentials: 'include',
              },
            );
            return { status: res.status, json: async () => res.json() };
          },
        },
      },
    },
  },
};
