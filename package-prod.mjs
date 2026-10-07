import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

const domainArg = process.argv.find((arg) => arg.startsWith('--domain='));
const targetDomain = domainArg
  ? domainArg.split('=')[1].trim()
  : process.env.AIREWARDS_WEB_APP_URL || process.env.AIREWARDS_API_URL || 'https://airewards.dev';

const origin = targetDomain.startsWith('http') ? targetDomain : `https://${targetDomain}`;

console.log(`[package-prod] Packaging browser extension for production target: ${origin}`);

const env = {
  ...process.env,
  NODE_ENV: 'production',
  AIREWARDS_API_URL: origin,
  AIREWARDS_WEB_APP_URL: origin,
};

execSync('node build.mjs', { cwd: root, env, stdio: 'inherit' });

const manifestPath = join(root, 'dist/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest._airewards_partial_build) {
  console.error('[package-prod] ERROR: manifest has _airewards_partial_build flag set!');
  process.exit(1);
}

const hostname = new URL(origin).hostname;
const hasBackendHostPermission = manifest.host_permissions?.some((p) => p.includes(hostname));
if (!hasBackendHostPermission) {
  console.error(`[package-prod] ERROR: manifest does not grant host_permission for ${origin}!`);
  process.exit(1);
}

execSync('node package.mjs', { cwd: root, env, stdio: 'inherit' });

console.log('[package-prod] SUCCESS: Production extension package ready.');
