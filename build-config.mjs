const DEFAULT_LOCAL_API_BASE_URL = 'http://localhost:3001';
const DEFAULT_LOCAL_WEB_APP_URL = 'http://localhost:3001';
// The extension calls the web dashboard origin, which proxies /v1/* and
// /api/auth/* to the Hono API (Next.js rewrites). Serving the API through the web
// origin makes the Auth.js session cookie first-party, so the extension sends it
// natively and avoids the cross-origin cookie/CORS failure that prompted Sprint
// 109.3.
// Production origins come from the environment so no hostname lives in source;
// a deployment move is an env change at extension build time. Workers Builds CI
// does not set these vars (CF-6), so a build with neither variable produces a
// "partial" manifest: the AI platform host permissions still ship so the
// recommendation feature works, but no backend host permissions are added. The
// manifest is flagged with `_airewards_partial_build: true` so the artifact is
// visibly not shippable, and the build itself passes so the monorepo's Worker
// deploy is not blocked by a build the Worker does not need.
const PRODUCTION_API_BASE_URL = process.env.AIREWARDS_API_URL ?? '';
const PRODUCTION_WEB_APP_URL = process.env.AIREWARDS_WEB_APP_URL ?? '';
const PRODUCTION_FORBIDDEN_RUNTIME_MARKERS = [
  'localhost',
  '127.0.0.1',
  'airewards.example',
  'ad_id=placeholder',
  'id=placeholder',
  '"placeholder"',
  "'placeholder'",
  '__airewardsDebug',
  'airewards:debug-state',
  'console.log',
  'console.debug',
  'publishDebugState',
];

/**
 * AI assistant surfaces the recommendation content script runs on. This is the
 * single source of truth for both `host_permissions` and the content script's
 * `matches`, so the two can never drift apart.
 */
const AI_PLATFORM_MATCH_PATTERNS = [
  '*://*.chatgpt.com/*',
  '*://*.chat.openai.com/*',
  '*://*.claude.ai/*',
  '*://*.gemini.google.com/*',
  '*://*.grok.com/*',
];

/** Production dashboard domain the status bridge may also run on. */
const AIREWARDS_DASHBOARD_MATCH_PATTERN = '*://*.airewards.dev/*';

/** Runtime icon files, keyed by the size Chrome requests them at. */
const RUNTIME_ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

/**
 * Runtime icon paths, relative to the extension root. `store-*.png` is Chrome Web
 * Store listing art and is deliberately absent: it is never copied into `dist/`
 * and never packaged.
 */
export const RUNTIME_ICON_FILES = Object.values(RUNTIME_ICONS);

export function resolveBuildMode(env = process.env) {
  return env.NODE_ENV === 'production' ? 'production' : 'development';
}

export function resolveApiBaseUrl(env = process.env) {
  return resolveOrigin({
    configured: env.AIREWARDS_API_URL,
    developmentDefault: DEFAULT_LOCAL_API_BASE_URL,
    productionDefault: PRODUCTION_API_BASE_URL,
    variableName: 'AIREWARDS_API_URL',
    env,
  });
}

export function resolveWebAppUrl(env = process.env) {
  return resolveOrigin({
    configured: env.AIREWARDS_WEB_APP_URL,
    developmentDefault: DEFAULT_LOCAL_WEB_APP_URL,
    productionDefault: PRODUCTION_WEB_APP_URL,
    variableName: 'AIREWARDS_WEB_APP_URL',
    env,
  });
}

function resolveOrigin({ configured, developmentDefault, productionDefault, variableName, env }) {
  const value = configured?.trim();

  if (!value) {
    return resolveBuildMode(env) === 'production' ? productionDefault : developmentDefault;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${variableName} must be an http(s) origin`);
  }

  return url.origin;
}

export function resolveBuildMetadata(env = process.env) {
  const buildMode = resolveBuildMode(env);
  const builtAt = env.AIREWARDS_BUILT_AT?.trim() || new Date().toISOString();
  const buildId = env.AIREWARDS_BUILD_ID?.trim() || `${buildMode}:${builtAt}`;
  const extensionVersion = env.AIREWARDS_EXTENSION_VERSION?.trim() || '1.0.0';

  return {
    apiBaseUrl: resolveApiBaseUrl(env),
    webAppUrl: resolveWebAppUrl(env),
    buildMode,
    diagnosticsEnabled: buildMode === 'development',
    extensionVersion,
    buildId,
    builtAt,
  };
}

export function buildDefineValues(metadata) {
  return {
    __AIREWARDS_API_URL__: JSON.stringify(metadata.apiBaseUrl),
    __AIREWARDS_WEB_APP_URL__: JSON.stringify(metadata.webAppUrl),
    __AIREWARDS_BUILD_MODE__: JSON.stringify(metadata.buildMode),
    __AIREWARDS_DIAGNOSTICS_ENABLED__: JSON.stringify(metadata.diagnosticsEnabled),
    __AIREWARDS_EXTENSION_VERSION__: JSON.stringify(metadata.extensionVersion),
    __AIREWARDS_BUILD_ID__: JSON.stringify(metadata.buildId),
    __AIREWARDS_BUILT_AT__: JSON.stringify(metadata.builtAt),
  };
}

/**
 * Convert an origin into a Chrome match pattern. Chrome match patterns cannot
 * carry a port, and a portless host pattern already matches every port, so the
 * port is dropped rather than encoded.
 *
 * An empty origin (no AIREWARDS_API_URL/AIREWARDS_WEB_APP_URL on a CI build)
 * has no host to grant access to, so it returns `null` and the caller skips
 * it. Calling `new URL('')` would throw `ERR_INVALID_URL` and crash every
 * CI build that has not configured these variables yet.
 */
function originToMatchPattern(origin) {
  if (!origin) {
    return null;
  }
  const { protocol, hostname } = new URL(origin);
  return `${protocol}//${hostname}/*`;
}

/**
 * Host permissions for a build: the AI platform surfaces plus every origin the
 * extension actually calls. `apiBaseUrl` and `webAppUrl` are the same origin
 * today; both are derived and de-duplicated so splitting them later cannot
 * silently drop a permission. Empty origins are dropped: a CI build with no
 * configured backend produces a manifest with only the AI platform permissions
 * and a `_airewards_partial_build` flag — see `buildManifest`.
 */
export function resolveHostPermissions(metadata) {
  const backendPatterns = new Set(
    [metadata.apiBaseUrl, metadata.webAppUrl]
      .map(originToMatchPattern)
      .filter((pattern) => pattern !== null),
  );

  return [...AI_PLATFORM_MATCH_PATTERNS, ...backendPatterns];
}

/**
 * Origins the dashboard status bridge runs on: the exact web app origin for this
 * build plus the production dashboard domain. Development builds resolve
 * `webAppUrl` to loopback, so loopback access is a property of the development
 * origin rather than a hardcoded pattern, and production output carries neither
 * loopback nor a `*.herokuapp.com` wildcard. Empty origins are dropped for the
 * same reason as `resolveHostPermissions`.
 */
export function resolveDashboardBridgeMatches(metadata) {
  const webPattern = originToMatchPattern(metadata.webAppUrl);
  return [
    ...new Set(
      webPattern === null
        ? [AIREWARDS_DASHBOARD_MATCH_PATTERN]
        : [webPattern, AIREWARDS_DASHBOARD_MATCH_PATTERN],
    ),
  ];
}

function resolveContentScriptMatches(scriptFiles, metadata) {
  if (scriptFiles.includes('content.js')) {
    return [...AI_PLATFORM_MATCH_PATTERNS];
  }

  if (scriptFiles.includes('dashboard-bridge.js')) {
    return resolveDashboardBridgeMatches(metadata);
  }

  throw new Error(
    `No build-time match patterns are defined for content script ${scriptFiles.join(', ')}`,
  );
}

/**
 * True when a production build is missing one or both backend origins. Such
 * a build still produces a manifest — so the AI platform features keep
 * working in dev — but the manifest is marked with `_airewards_partial_build`
 * so the artifact is visibly not shippable and the monorepo's Worker deploy
 * is not blocked by an extension build the Worker does not need.
 */
export function isPartialBuild(metadata) {
  return metadata.buildMode === 'production' && !metadata.apiBaseUrl && !metadata.webAppUrl;
}

/**
 * Produce the shipped manifest from the static template in `public/manifest.json`.
 * Every origin — host permissions and both content script match lists — is
 * injected here from build metadata, so no origin literal lives in the template.
 * A partial build (no backend origins in production) sets a non-standard
 * `_airewards_partial_build` field so the artifact cannot be mistaken for a
 * shippable extension.
 */
export function buildManifest(template, metadata) {
  const manifest = structuredClone(template);

  manifest.version = metadata.extensionVersion;
  manifest.host_permissions = resolveHostPermissions(metadata);
  manifest.icons = { ...RUNTIME_ICONS };
  manifest.action = { ...manifest.action, default_icon: { ...RUNTIME_ICONS } };

  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
    throw new Error('public/manifest.json must declare at least one content script');
  }

  manifest.content_scripts = manifest.content_scripts.map((entry) => ({
    ...entry,
    matches: resolveContentScriptMatches(entry.js ?? [], metadata),
  }));

  if (isPartialBuild(metadata)) {
    manifest._airewards_partial_build = true;
  }

  return manifest;
}

/** Files whose contents Chrome executes, as opposed to declarative manifests. */
const EXECUTABLE_BUNDLE_PATTERN = /\.js$/;

/** Scheme, host and optional port of an https reference inside bundle text. */
const HTTPS_ORIGIN_PATTERN = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d+)?/gi;

export function extractHttpsOrigins(source) {
  const origins = new Set();

  for (const [reference] of source.matchAll(HTTPS_ORIGIN_PATTERN)) {
    origins.add(new URL(reference).origin);
  }

  return [...origins].sort();
}

const MATCH_PATTERN_PATTERN = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/*]+)\/.*$/;

/** Does `origin` fall inside a Chrome match pattern, wildcard subdomains included? */
export function matchesHostPermission(origin, pattern) {
  const parsed = MATCH_PATTERN_PATTERN.exec(pattern);

  if (!parsed) {
    return false;
  }

  const [, scheme, host] = parsed;
  const { protocol, hostname } = new URL(origin);

  if (scheme === '*') {
    if (protocol !== 'http:' && protocol !== 'https:') {
      return false;
    }
  } else if (`${scheme}:` !== protocol) {
    return false;
  }

  if (host === '*') {
    return true;
  }

  if (host.startsWith('*.')) {
    const suffix = host.slice(2).toLowerCase();
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }

  return hostname === host.toLowerCase();
}

function readManifestHostPermissions(manifestSource) {
  let manifest;
  try {
    manifest = JSON.parse(manifestSource);
  } catch {
    throw new Error('Production browser extension manifest.json artifact is not valid JSON');
  }

  if (!Array.isArray(manifest.host_permissions)) {
    throw new Error('Production browser extension manifest.json declares no host_permissions');
  }

  return manifest.host_permissions;
}

/**
 * Every https origin an executable bundle references must be covered by a
 * `host_permissions` match pattern. Without this, a build can ship bundles that
 * call an origin Chrome will not grant access to — every request fails at
 * runtime while the build passes green.
 *
 * Partial builds (no AIREWARDS_API_URL/AIREWARDS_WEB_APP_URL) only have AI
 * platform host permissions. If a partial build's bundles reference any
 * non-AI-platform origin the build is producing a not-shipping-ready artifact
 * AND a host-permissions mismatch at the same time; the existing per-origin
 * error names the offending URL so the build cannot silently look valid.
 */
function assertBundleOriginsArePermitted(artifacts) {
  const references = Object.entries(artifacts)
    .filter(([fileName]) => EXECUTABLE_BUNDLE_PATTERN.test(fileName))
    .flatMap(([fileName, source]) =>
      extractHttpsOrigins(source).map((origin) => ({ fileName, origin })),
    );

  if (references.length === 0) {
    return;
  }

  const manifestSource = artifacts['manifest.json'];

  if (manifestSource === undefined) {
    throw new Error(
      'Production browser extension bundles reference https origins but no manifest.json artifact was provided to verify them against',
    );
  }

  const hostPermissions = readManifestHostPermissions(manifestSource);

  for (const { fileName, origin } of references) {
    const permitted = hostPermissions.some((pattern) => matchesHostPermission(origin, pattern));

    if (!permitted) {
      throw new Error(
        `Production browser extension artifact ${fileName} calls ${origin} but no manifest host permission covers it`,
      );
    }
  }
}

export function assertProductionArtifactSafety(metadata, artifacts) {
  if (metadata.buildMode !== 'production') {
    return;
  }

  for (const [fileName, source] of Object.entries(artifacts)) {
    for (const marker of PRODUCTION_FORBIDDEN_RUNTIME_MARKERS) {
      if (source.includes(marker)) {
        throw new Error(
          `Production browser extension artifact contains forbidden runtime marker "${marker}" in ${fileName}`,
        );
      }
    }
  }

  assertBundleOriginsArePermitted(artifacts);
}
