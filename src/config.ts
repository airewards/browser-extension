/**
 * Extension runtime configuration.
 *
 * The API and web app origins are injected at build time (see build.mjs). No
 * secrets are ever bundled into the extension; only public origins are needed.
 *
 * @airewards/config is intentionally not used here: it depends on Node's fs and
 * dotenv to load the server-side .env, which is neither available nor appropriate
 * in a browser environment.
 */
declare const __AIREWARDS_API_URL__: string;
declare const __AIREWARDS_WEB_APP_URL__: string;
declare const __AIREWARDS_BUILD_MODE__: 'development' | 'production';
declare const __AIREWARDS_DIAGNOSTICS_ENABLED__: boolean;
declare const __AIREWARDS_EXTENSION_VERSION__: string;
declare const __AIREWARDS_BUILD_ID__: string;
declare const __AIREWARDS_BUILT_AT__: string;

export const config = {
  apiBaseUrl: __AIREWARDS_API_URL__,
  webAppUrl: __AIREWARDS_WEB_APP_URL__,
  buildMode: __AIREWARDS_BUILD_MODE__,
  diagnosticsEnabled: __AIREWARDS_DIAGNOSTICS_ENABLED__,
  extensionVersion: __AIREWARDS_EXTENSION_VERSION__,
  buildId: __AIREWARDS_BUILD_ID__,
  builtAt: __AIREWARDS_BUILT_AT__,
} as const;
