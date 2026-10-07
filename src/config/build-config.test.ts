import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface BuildMetadata {
  apiBaseUrl: string;
  webAppUrl: string;
  buildMode: 'development' | 'production';
  diagnosticsEnabled: boolean;
  extensionVersion: string;
  buildId: string;
  builtAt: string;
}

interface ManifestTemplate {
  version: string;
  host_permissions?: string[];
  icons?: Record<string, string>;
  action: Record<string, unknown>;
  content_scripts: Array<{ js: string[]; matches?: string[]; run_at: string }>;
  _airewards_partial_build?: boolean;
}

interface BuildConfigModule {
  RUNTIME_ICON_FILES: string[];
  resolveApiBaseUrl(env: Record<string, string | undefined>): string;
  resolveWebAppUrl(env: Record<string, string | undefined>): string;
  assertProductionArtifactSafety(metadata: BuildMetadata, artifacts: Record<string, string>): void;
  resolveBuildMetadata(env: Record<string, string | undefined>): BuildMetadata;
  resolveHostPermissions(metadata: Pick<BuildMetadata, 'apiBaseUrl' | 'webAppUrl'>): string[];
  resolveDashboardBridgeMatches(metadata: Pick<BuildMetadata, 'webAppUrl'>): string[];
  buildManifest(template: ManifestTemplate, metadata: BuildMetadata): ManifestTemplate;
  extractHttpsOrigins(source: string): string[];
  matchesHostPermission(origin: string, pattern: string): boolean;
  isPartialBuild(metadata: Pick<BuildMetadata, 'buildMode' | 'apiBaseUrl' | 'webAppUrl'>): boolean;
  buildDefineValues(metadata: {
    apiBaseUrl: string;
    buildMode: 'development' | 'production';
    diagnosticsEnabled: boolean;
    extensionVersion: string;
    buildId: string;
    builtAt: string;
  }): Record<string, string>;
}

async function loadBuildConfig(): Promise<BuildConfigModule> {
  const moduleUrl = new URL('../../build-config.mjs', import.meta.url).href;
  return (await import(moduleUrl)) as BuildConfigModule;
}

describe('browser extension build configuration', () => {
  it('defaults local development builds to the local API origin', async () => {
    const { resolveApiBaseUrl } = await loadBuildConfig();

    expect(resolveApiBaseUrl({ NODE_ENV: 'development' })).toBe('http://localhost:3001');
  });

  it('takes production origins from the environment and ships none by default', async () => {
    const { resolveApiBaseUrl, resolveWebAppUrl } = await loadBuildConfig();

    // Origins are injected at build time (CF-3): a production build without
    // them resolves to an empty origin instead of a hardcoded host, so a dead
    // deployment URL can never be baked in again. The production safety check
    // treats that as a failure rather than silently shipping it.
    expect(
      resolveApiBaseUrl({ NODE_ENV: 'production', AIREWARDS_API_URL: 'https://api.example.com' }),
    ).toBe('https://api.example.com');
    expect(resolveApiBaseUrl({ NODE_ENV: 'production' })).toBe('');
    expect(
      resolveWebAppUrl({
        NODE_ENV: 'production',
        AIREWARDS_WEB_APP_URL: 'https://dashboard.example.com',
      }),
    ).toBe('https://dashboard.example.com');
    expect(resolveWebAppUrl({ NODE_ENV: 'production' })).toBe('');
  });

  it('normalizes the configured API origin and rejects non-http origins', async () => {
    const { resolveApiBaseUrl, resolveWebAppUrl } = await loadBuildConfig();

    expect(
      resolveApiBaseUrl({
        NODE_ENV: 'production',
        AIREWARDS_API_URL: 'https://api.airewards.dev/',
      }),
    ).toBe('https://api.airewards.dev');

    expect(() =>
      resolveApiBaseUrl({
        NODE_ENV: 'production',
        AIREWARDS_API_URL: 'chrome-extension://abc',
      }),
    ).toThrow('AIREWARDS_API_URL must be an http(s) origin');

    expect(
      resolveWebAppUrl({
        NODE_ENV: 'production',
        AIREWARDS_WEB_APP_URL: 'https://app.airewards.dev/',
      }),
    ).toBe('https://app.airewards.dev');
  });

  it('enables diagnostics only for development builds', async () => {
    const { resolveBuildMetadata } = await loadBuildConfig();

    expect(resolveBuildMetadata({ NODE_ENV: 'development' }).diagnosticsEnabled).toBe(true);
    expect(
      resolveBuildMetadata({
        NODE_ENV: 'production',
        AIREWARDS_API_URL: 'https://api.airewards.dev',
      }).diagnosticsEnabled,
    ).toBe(false);
  });

  it('injects runtime metadata needed to detect stale unpacked extension assets', async () => {
    const { buildDefineValues, resolveBuildMetadata } = await loadBuildConfig();

    const metadata = resolveBuildMetadata({
      NODE_ENV: 'development',
      AIREWARDS_EXTENSION_VERSION: '0.1.0-test',
      AIREWARDS_BUILD_ID: 'build-test-1',
      AIREWARDS_BUILT_AT: '2026-06-28T12:00:00.000Z',
    });

    expect(metadata).toMatchObject({
      apiBaseUrl: 'http://localhost:3001',
      webAppUrl: 'http://localhost:3001',
      buildMode: 'development',
      diagnosticsEnabled: true,
      extensionVersion: '0.1.0-test',
      buildId: 'build-test-1',
      builtAt: '2026-06-28T12:00:00.000Z',
    });

    expect(buildDefineValues(metadata)).toEqual({
      __AIREWARDS_API_URL__: JSON.stringify('http://localhost:3001'),
      __AIREWARDS_WEB_APP_URL__: JSON.stringify('http://localhost:3001'),
      __AIREWARDS_BUILD_MODE__: JSON.stringify('development'),
      __AIREWARDS_DIAGNOSTICS_ENABLED__: JSON.stringify(true),
      __AIREWARDS_EXTENSION_VERSION__: JSON.stringify('0.1.0-test'),
      __AIREWARDS_BUILD_ID__: JSON.stringify('build-test-1'),
      __AIREWARDS_BUILT_AT__: JSON.stringify('2026-06-28T12:00:00.000Z'),
    });
  });

  it('keeps production build definitions free of localhost when an API origin is configured', async () => {
    const { buildDefineValues, resolveBuildMetadata } = await loadBuildConfig();

    const metadata = resolveBuildMetadata({
      NODE_ENV: 'production',
      AIREWARDS_API_URL: 'https://api.airewards.dev',
      AIREWARDS_EXTENSION_VERSION: '0.1.0',
      AIREWARDS_BUILD_ID: 'prod-build-1',
      AIREWARDS_BUILT_AT: '2026-06-28T12:00:00.000Z',
    });

    const serialized = JSON.stringify(buildDefineValues(metadata));
    expect(serialized).toContain('https://api.airewards.dev');
    expect(serialized).not.toContain('localhost');
    expect(metadata.diagnosticsEnabled).toBe(false);
  });

  it('rejects unsafe production executable artifacts', async () => {
    const { assertProductionArtifactSafety, resolveBuildMetadata } = await loadBuildConfig();
    const metadata = resolveBuildMetadata({
      NODE_ENV: 'production',
      AIREWARDS_API_URL: 'https://api.airewards.dev',
    });

    expect(() =>
      assertProductionArtifactSafety(metadata, {
        'background.js': 'const apiBaseUrl = "https://api.airewards.dev";',
        'content.js': 'export const ok = true;',
        'manifest.json': '{"host_permissions":["https://api.airewards.dev/*"]}',
      }),
    ).not.toThrow();

    expect(() =>
      assertProductionArtifactSafety(metadata, {
        'background.js': 'const apiBaseUrl = "http://localhost:3001";',
      }),
    ).toThrow('Production browser extension artifact contains forbidden runtime marker');

    expect(() =>
      assertProductionArtifactSafety(metadata, {
        'background.js': 'const href = "https://airewards.example/?ad_id=placeholder";',
      }),
    ).toThrow('Production browser extension artifact contains forbidden runtime marker');

    expect(() =>
      assertProductionArtifactSafety(metadata, {
        'content.js': 'window.__airewardsDebug = {};',
      }),
    ).toThrow('Production browser extension artifact contains forbidden runtime marker');

    expect(() =>
      assertProductionArtifactSafety(metadata, {
        'background.js': 'console.log("debug");',
      }),
    ).toThrow('Production browser extension artifact contains forbidden runtime marker');

    expect(() =>
      assertProductionArtifactSafety(metadata, {
        'content.js': 'publishDebugState();',
      }),
    ).toThrow('Production browser extension artifact contains forbidden runtime marker');
  });
});

describe('build-time manifest origins', () => {
  const baseMetadata = {
    apiBaseUrl: 'https://api.airewards.dev',
    webAppUrl: 'https://app.airewards.dev',
    buildMode: 'production' as const,
    diagnosticsEnabled: false,
    extensionVersion: '1.0.0',
    buildId: 'prod-build-1',
    builtAt: '2026-07-31T12:00:00.000Z',
  };

  const template = {
    version: '1.0.0',
    action: { default_popup: 'popup.html', default_title: 'AIRewards' },
    content_scripts: [
      { js: ['content.js'], run_at: 'document_idle' },
      { js: ['dashboard-bridge.js'], run_at: 'document_idle' },
    ],
  };

  it('keeps every origin literal out of the static manifest template', async () => {
    const manifestUrl = new URL('../../public/manifest.json', import.meta.url);
    const source = await readFile(manifestUrl, 'utf8');

    expect(source).not.toContain('http://');
    expect(source).not.toContain('https://');
    expect(source).not.toContain('herokuapp.com');
    expect(source).not.toContain('localhost');
    expect(JSON.parse(source).host_permissions).toBeUndefined();
  });

  it('derives host permissions from both backend origins and de-duplicates them', async () => {
    const { resolveHostPermissions } = await loadBuildConfig();

    expect(resolveHostPermissions(baseMetadata)).toEqual([
      '*://*.chatgpt.com/*',
      '*://*.chat.openai.com/*',
      '*://*.claude.ai/*',
      '*://*.gemini.google.com/*',
      '*://*.grok.com/*',
      'https://api.airewards.dev/*',
      'https://app.airewards.dev/*',
    ]);

    // A single shared origin must not produce a duplicate permission entry.
    expect(
      resolveHostPermissions({
        apiBaseUrl: 'https://dashboard.example.com',
        webAppUrl: 'https://dashboard.example.com',
      }),
    ).toEqual([
      '*://*.chatgpt.com/*',
      '*://*.chat.openai.com/*',
      '*://*.claude.ai/*',
      '*://*.gemini.google.com/*',
      '*://*.grok.com/*',
      'https://dashboard.example.com/*',
    ]);
  });

  it('narrows the dashboard bridge to the exact web origin for the build', async () => {
    const { resolveDashboardBridgeMatches } = await loadBuildConfig();

    expect(
      resolveDashboardBridgeMatches({
        webAppUrl: 'https://dashboard.example.com',
      }),
    ).toEqual(['https://dashboard.example.com/*', '*://*.airewards.dev/*']);

    // Development keeps loopback access, because loopback is the dev web origin.
    expect(resolveDashboardBridgeMatches({ webAppUrl: 'http://localhost:3001' })).toEqual([
      'http://localhost/*',
      '*://*.airewards.dev/*',
    ]);
  });

  it('injects version, icons and both content script match lists into the shipped manifest', async () => {
    const { buildManifest, RUNTIME_ICON_FILES } = await loadBuildConfig();

    const manifest = buildManifest(template, baseMetadata);

    expect(manifest.version).toBe('1.0.0');
    expect(manifest.icons).toEqual({
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    });
    expect(manifest.action.default_icon).toEqual(manifest.icons);
    expect(RUNTIME_ICON_FILES).toEqual([
      'icons/icon-16.png',
      'icons/icon-32.png',
      'icons/icon-48.png',
      'icons/icon-128.png',
    ]);
    expect(RUNTIME_ICON_FILES.join(' ')).not.toContain('store-');

    expect(manifest.content_scripts[0]?.matches).toEqual([
      '*://*.chatgpt.com/*',
      '*://*.chat.openai.com/*',
      '*://*.claude.ai/*',
      '*://*.gemini.google.com/*',
      '*://*.grok.com/*',
    ]);
    expect(manifest.content_scripts[1]?.matches).toEqual([
      'https://app.airewards.dev/*',
      '*://*.airewards.dev/*',
    ]);
  });

  it('leaves no herokuapp wildcard or loopback origin in a production manifest', async () => {
    const { buildManifest } = await loadBuildConfig();

    const serialized = JSON.stringify(
      buildManifest(template, {
        ...baseMetadata,
        apiBaseUrl: 'https://dashboard.example.com',
        webAppUrl: 'https://dashboard.example.com',
      }),
    );

    expect(serialized).not.toContain('localhost');
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('*.herokuapp.com');
  });

  it('refuses to build a manifest for an unrecognised content script', async () => {
    const { buildManifest } = await loadBuildConfig();

    expect(() =>
      buildManifest(
        { ...template, content_scripts: [{ js: ['surprise.js'], run_at: 'document_idle' }] },
        baseMetadata,
      ),
    ).toThrow('No build-time match patterns are defined for content script surprise.js');
  });
});

describe('partial build with no configured backend origin (CF-6)', () => {
  const productionEmptyOrigins = {
    apiBaseUrl: '',
    webAppUrl: '',
    buildMode: 'production' as const,
    diagnosticsEnabled: false,
    extensionVersion: '1.0.0',
    buildId: 'ci-build-1',
    builtAt: '2026-08-23T00:00:00.000Z',
  };

  const partialTemplate = {
    version: '1.0.0',
    action: { default_popup: 'popup.html', default_title: 'AIRewards' },
    content_scripts: [
      { js: ['content.js'], run_at: 'document_idle' },
      { js: ['dashboard-bridge.js'], run_at: 'document_idle' },
    ],
  };

  it('does not throw when both backend origins are empty', async () => {
    const { resolveHostPermissions, resolveDashboardBridgeMatches } = await loadBuildConfig();

    expect(() => resolveHostPermissions(productionEmptyOrigins)).not.toThrow();
    expect(() => resolveDashboardBridgeMatches(productionEmptyOrigins)).not.toThrow();
  });

  it('omits backend host permissions when both origins are empty', async () => {
    const { resolveHostPermissions } = await loadBuildConfig();

    // Only the AI platform match patterns remain — the empty backend origins
    // are dropped instead of crashing new URL('').
    expect(resolveHostPermissions(productionEmptyOrigins)).toEqual([
      '*://*.chatgpt.com/*',
      '*://*.chat.openai.com/*',
      '*://*.claude.ai/*',
      '*://*.gemini.google.com/*',
      '*://*.grok.com/*',
    ]);
  });

  it('omits the dashboard bridge web origin when webAppUrl is empty', async () => {
    const { resolveDashboardBridgeMatches } = await loadBuildConfig();

    expect(resolveDashboardBridgeMatches(productionEmptyOrigins)).toEqual([
      '*://*.airewards.dev/*',
    ]);
  });

  it('still ships a manifest, but marks it as a partial build', async () => {
    const { buildManifest, isPartialBuild } = await loadBuildConfig();

    expect(isPartialBuild(productionEmptyOrigins)).toBe(true);

    const manifest = buildManifest(partialTemplate, productionEmptyOrigins);
    expect(manifest._airewards_partial_build).toBe(true);
    expect(manifest.host_permissions).toEqual([
      '*://*.chatgpt.com/*',
      '*://*.chat.openai.com/*',
      '*://*.claude.ai/*',
      '*://*.gemini.google.com/*',
      '*://*.grok.com/*',
    ]);
  });

  it('only marks a partial build when both origins are empty in production', async () => {
    const { isPartialBuild } = await loadBuildConfig();

    expect(
      isPartialBuild({ ...productionEmptyOrigins, apiBaseUrl: 'https://api.airewards.dev' }),
    ).toBe(false);
    expect(
      isPartialBuild({ ...productionEmptyOrigins, webAppUrl: 'https://app.airewards.dev' }),
    ).toBe(false);
    expect(isPartialBuild({ ...productionEmptyOrigins, buildMode: 'development' })).toBe(false);
  });

  it('accepts a partial build whose bundles reference only AI platform origins', async () => {
    const { assertProductionArtifactSafety } = await loadBuildConfig();

    // The AI platform matches come from the manifest's own host_permissions;
    // the partial build has no backend permissions and no backend literals in
    // the bundles, so the bundle origin coverage check passes.
    expect(() =>
      assertProductionArtifactSafety(productionEmptyOrigins, {
        'background.js': 'fetch("https://chatgpt.com/api/test");',
        'content.js': 'const home = "https://claude.ai/";',
        'manifest.json': JSON.stringify({
          host_permissions: [
            '*://*.chatgpt.com/*',
            '*://*.chat.openai.com/*',
            '*://*.claude.ai/*',
            '*://*.gemini.google.com/*',
            '*://*.grok.com/*',
          ],
        }),
      }),
    ).not.toThrow();
  });
});

describe('bundle origin host-permission coverage', () => {
  const metadata = {
    apiBaseUrl: 'https://api.airewards.dev',
    webAppUrl: 'https://api.airewards.dev',
    buildMode: 'production' as const,
    diagnosticsEnabled: false,
    extensionVersion: '1.0.0',
    buildId: 'prod-build-1',
    builtAt: '2026-07-31T12:00:00.000Z',
  };

  it('extracts every distinct https origin from bundle text', async () => {
    const { extractHttpsOrigins } = await loadBuildConfig();

    expect(
      extractHttpsOrigins(
        'fetch("https://api.airewards.dev/v1/ads/current?platform=cli");' +
          'const w="https://app.airewards.dev/dashboard";' +
          'const again="https://api.airewards.dev/v1/impressions";',
      ),
    ).toEqual(['https://api.airewards.dev', 'https://app.airewards.dev']);

    expect(extractHttpsOrigins('export const ok = true;')).toEqual([]);
  });

  it('honours wildcard subdomains, exact hosts and scheme wildcards when matching', async () => {
    const { matchesHostPermission } = await loadBuildConfig();

    expect(matchesHostPermission('https://chatgpt.com', '*://*.chatgpt.com/*')).toBe(true);
    expect(matchesHostPermission('https://www.chatgpt.com', '*://*.chatgpt.com/*')).toBe(true);
    expect(matchesHostPermission('https://notchatgpt.com', '*://*.chatgpt.com/*')).toBe(false);
    expect(matchesHostPermission('https://chatgpt.com.evil.test', '*://*.chatgpt.com/*')).toBe(
      false,
    );

    expect(matchesHostPermission('https://api.airewards.dev', 'https://api.airewards.dev/*')).toBe(
      true,
    );
    expect(
      matchesHostPermission('https://other.airewards.dev', 'https://api.airewards.dev/*'),
    ).toBe(false);

    // An https origin is not covered by an http-only permission.
    expect(matchesHostPermission('https://api.airewards.dev', 'http://api.airewards.dev/*')).toBe(
      false,
    );
  });

  it('accepts a production build whose bundle origins are all granted', async () => {
    const { assertProductionArtifactSafety } = await loadBuildConfig();

    expect(() =>
      assertProductionArtifactSafety(metadata, {
        'background.js': 'fetch("https://api.airewards.dev/v1/ads/current");',
        'content.js': 'const home = "https://chatgpt.com/";',
        'dashboard-bridge.js': 'export const ok = true;',
        'manifest.json': JSON.stringify({
          host_permissions: ['*://*.chatgpt.com/*', 'https://api.airewards.dev/*'],
        }),
      }),
    ).not.toThrow();
  });

  it('throws when a bundle calls an origin the manifest does not grant', async () => {
    const { assertProductionArtifactSafety } = await loadBuildConfig();

    // This is exactly the Sprint 136 ship-stopper: bundles built against the web
    // proxy origin while the manifest only granted the direct API origin.
    expect(() =>
      assertProductionArtifactSafety(metadata, {
        'background.js': 'fetch("https://dashboard.example.com/v1/ads/current");',
        'manifest.json': JSON.stringify({
          host_permissions: ['https://api.example.com/*'],
        }),
      }),
    ).toThrow(
      'Production browser extension artifact background.js calls https://dashboard.example.com but no manifest host permission covers it',
    );
  });

  it('does not let a declarative manifest origin satisfy an executable bundle', async () => {
    const { assertProductionArtifactSafety } = await loadBuildConfig();

    // The manifest itself is not an executable bundle, so origins that appear
    // only in its match patterns are never scanned as bundle references.
    expect(() =>
      assertProductionArtifactSafety(metadata, {
        'popup.js': 'const url = "https://ungranted.airewards.test/x";',
        'manifest.json': JSON.stringify({
          host_permissions: ['https://api.airewards.dev/*'],
        }),
      }),
    ).toThrow('calls https://ungranted.airewards.test but no manifest host permission covers it');
  });

  it('rejects a production build whose manifest declares no host permissions', async () => {
    const { assertProductionArtifactSafety } = await loadBuildConfig();

    expect(() =>
      assertProductionArtifactSafety(metadata, {
        'background.js': 'fetch("https://api.airewards.dev/v1/ads/current");',
        'manifest.json': JSON.stringify({ name: 'AIRewards' }),
      }),
    ).toThrow('Production browser extension manifest.json declares no host_permissions');
  });

  it('rejects bundle origins when no manifest artifact is available to check against', async () => {
    const { assertProductionArtifactSafety } = await loadBuildConfig();

    expect(() =>
      assertProductionArtifactSafety(metadata, {
        'background.js': 'fetch("https://api.airewards.dev/v1/ads/current");',
      }),
    ).toThrow('no manifest.json artifact was provided to verify them against');
  });

  it('skips origin coverage entirely for development builds', async () => {
    const { assertProductionArtifactSafety } = await loadBuildConfig();

    expect(() =>
      assertProductionArtifactSafety(
        { ...metadata, buildMode: 'development', diagnosticsEnabled: true },
        {
          'background.js': 'fetch("https://ungranted.airewards.test/x");',
          'manifest.json': JSON.stringify({ host_permissions: [] }),
        },
      ),
    ).not.toThrow();
  });
});
