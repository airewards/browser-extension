import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';
import {
  RUNTIME_ICON_FILES,
  assertProductionArtifactSafety,
  buildDefineValues,
  buildManifest,
  resolveBuildMetadata,
} from './build-config.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const outdir = join(root, 'dist');
const watch = process.argv.includes('--watch');

const buildMetadata = resolveBuildMetadata(process.env);

const diagnosticsAliasPlugin = {
  name: 'airewards-diagnostics-alias',
  setup(build) {
    build.onResolve({ filter: /^\.\/diagnostics$/ }, (args) => {
      if (buildMetadata.diagnosticsEnabled || args.importer !== join(root, 'src/content.ts')) {
        return undefined;
      }

      return {
        path: join(root, 'src/diagnostics.disabled.ts'),
      };
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    background: join(root, 'src/background.ts'),
    popup: join(root, 'src/popup/popup.ts'),
    content: join(root, 'src/content.ts'),
    'dashboard-bridge': join(root, 'src/dashboard-bridge.ts'),
  },

  outdir,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
  define: buildDefineValues(buildMetadata),
  plugins: [diagnosticsAliasPlugin],
};

function copyStatic() {
  const template = JSON.parse(readFileSync(join(root, 'public/manifest.json'), 'utf8'));
  const manifest = buildManifest(template, buildMetadata);
  writeFileSync(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(join(root, 'public/popup.html'), join(outdir, 'popup.html'));
  cpSync(join(root, 'src/popup/popup.css'), join(outdir, 'popup.css'));

  // Copied file by file rather than as a directory: public/icons also holds the
  // Chrome Web Store listing art (store-512.png, store-1024.png), which must not
  // reach dist/ or the store package.
  mkdirSync(join(outdir, 'icons'), { recursive: true });
  for (const iconFile of RUNTIME_ICON_FILES) {
    cpSync(join(root, 'public', iconFile), join(outdir, iconFile));
  }
}

function writeBuildDiagnostics() {
  const files = [
    'background.js',
    'content.js',
    'dashboard-bridge.js',
    'popup.js',
    'manifest.json',
    ...RUNTIME_ICON_FILES,
  ];

  const bundleHashes = Object.fromEntries(
    files.map((file) => {
      const bytes = readFileSync(join(outdir, file));
      return [file, createHash('sha256').update(bytes).digest('hex')];
    }),
  );

  writeFileSync(
    join(outdir, 'airewards-build.json'),
    `${JSON.stringify(
      {
        ...buildMetadata,
        hostPermissions: JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8'))
          .host_permissions,
        bundleHashes,
      },
      null,
      2,
    )}\n`,
  );
}

function assertBuildSafety() {
  const executableFiles = [
    'background.js',
    'content.js',
    'dashboard-bridge.js',
    'popup.js',
    'manifest.json',
  ];

  const artifacts = Object.fromEntries(
    executableFiles.map((file) => [file, readFileSync(join(outdir, file), 'utf8')]),
  );

  assertProductionArtifactSafety(buildMetadata, artifacts);
}

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  copyStatic();
  writeBuildDiagnostics();
  console.log('Watching for changes...');
} else {
  await build(options);
  copyStatic();
  assertBuildSafety();
  writeBuildDiagnostics();
}
