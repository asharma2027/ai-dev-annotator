const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const requestedScope = process.argv[2] || 'all';
const scopes = requestedScope === 'all'
  ? ['extension', 'desktop', 'worker']
  : [requestedScope.replace(/^--/, '')];

const requiredFiles = {
  desktop: [
    'desktop-app/build/icon.png',
    'desktop-app/main.js',
    'desktop-app/preload.js',
    'desktop-app/lib/api-server.js',
    'desktop-app/lib/process-environment.js',
    'desktop-app/lib/process-supervisor.js',
    'desktop-app/lib/project-detector.js',
    'desktop-app/lib/project-store.js',
    'desktop-app/ui/index.html',
    'desktop-app/ui/pending-changes.js',
    'desktop-app/ui/styles.css',
    'desktop-app/ui/app.js',
    'desktop-app/ui/pending-changes.js',
    'desktop-app/package.json',
  ],
  extension: ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js', 'styles.css'],
  worker: ['infra/worker/package.json', 'infra/worker/src/index.js', 'infra/worker/wrangler.toml'],
};

const javascriptFiles = {
  desktop: [
    'desktop-app/main.js',
    'desktop-app/preload.js',
    'desktop-app/lib/api-server.js',
    'desktop-app/lib/process-environment.js',
    'desktop-app/lib/process-supervisor.js',
    'desktop-app/lib/project-detector.js',
    'desktop-app/lib/project-store.js',
    'desktop-app/ui/app.js',
    'scripts/command-runner.js',
    'scripts/start-desktop.js',
    'scripts/setup-codex.js',
  ],
  extension: ['background.js', 'content.js', 'popup.js'],
  worker: ['infra/worker/src/index.js'],
};

for (const scope of scopes) {
  if (!requiredFiles[scope]) fail(`Unknown validation scope: ${scope}`);
  for (const relativePath of requiredFiles[scope]) {
    if (!fs.existsSync(path.join(repositoryRoot, relativePath))) fail(`Missing required file: ${relativePath}`);
  }
  for (const relativePath of javascriptFiles[scope]) checkJavaScript(relativePath);
}

if (scopes.includes('extension')) validateManifest();
if (scopes.includes('desktop')) validateDesktopPackage();
if (scopes.includes('worker')) JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'infra/worker/package.json'), 'utf8'));

process.stdout.write(`Validated ${scopes.join(', ')}.\n`);

function checkJavaScript(relativePath) {
  const result = spawnSync(process.execPath, ['--check', relativePath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) fail(result.stderr || `JavaScript check failed: ${relativePath}`);
}

function validateManifest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3) fail('manifest.json must remain Manifest V3.');
  if (!manifest.background || manifest.background.service_worker !== 'background.js') {
    fail('manifest.json must register background.js as its service worker.');
  }
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes('storage')) {
    fail('manifest.json must retain the storage permission.');
  }
}

function validateDesktopPackage() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'desktop-app/package.json'), 'utf8'));
  if (packageJson.main !== 'main.js') fail('desktop-app/package.json must point to main.js.');
  if (!packageJson.build || !packageJson.build.mac || !packageJson.build.win) {
    fail('Desktop packaging must define both macOS and Windows targets.');
  }
  const macArchitectures = targetArchitectures(packageJson.build.mac.target);
  const windowsArchitectures = targetArchitectures(packageJson.build.win.target);
  if (!macArchitectures.has('universal')) fail('macOS packaging must include the universal architecture.');
  if (!windowsArchitectures.has('x64')) fail('Windows packaging must include the x64 architecture.');
}

function targetArchitectures(targets) {
  const architectures = new Set();
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!target || typeof target !== 'object' || !Array.isArray(target.arch)) continue;
    for (const architecture of target.arch) architectures.add(architecture);
  }
  return architectures;
}

function fail(message) {
  process.stderr.write(`${String(message).trim()}\n`);
  process.exit(1);
}
