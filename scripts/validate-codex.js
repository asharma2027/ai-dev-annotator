#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const knownArgs = new Set(['--all', '--extension', '--desktop', '--worker']);
const unknownArgs = [...args].filter((arg) => !knownArgs.has(arg));

let failures = 0;
let warnings = 0;

if (unknownArgs.length) {
  fail(`Unknown option(s): ${unknownArgs.join(', ')}`);
}

const runAll = args.size === 0 || args.has('--all');
const shouldRunExtension = runAll || args.has('--extension');
const shouldRunDesktop = runAll || args.has('--desktop');
const shouldRunWorker = runAll || args.has('--worker');

function fullPath(file) {
  return path.join(repoRoot, file);
}

function pass(message) {
  console.log(`ok - ${message}`);
}

function warn(message) {
  warnings += 1;
  console.warn(`warn - ${message}`);
}

function fail(message) {
  failures += 1;
  console.error(`fail - ${message}`);
}

function readText(file) {
  return fs.readFileSync(fullPath(file), 'utf8');
}

function tryReadText(file) {
  try {
    const text = readText(file);
    if (!text.trim()) return { ok: false, reason: 'file is empty or not locally readable' };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function checkExists(file) {
  if (!fs.existsSync(fullPath(file))) {
    fail(`${file} is missing`);
    return false;
  }
  pass(`${file} exists`);
  return true;
}

function checkReadable(file) {
  const result = tryReadText(file);
  if (!result.ok) {
    fail(`${file} is not readable: ${result.reason}`);
    return null;
  }
  pass(`${file} is readable`);
  return result.text;
}

function checkJson(file) {
  const text = checkReadable(file);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    pass(`${file} parses as JSON`);
    return parsed;
  } catch (error) {
    fail(`${file} does not parse as JSON: ${error.message}`);
    return null;
  }
}

function checkNodeSyntax(file) {
  if (!checkExists(file)) return;
  const result = spawnSync(process.execPath, ['--check', fullPath(file)], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.status === 0) {
    pass(`${file} has valid JavaScript syntax`);
    return;
  }

  const details = (result.stderr || result.stdout || '').trim();
  fail(`${file} failed node --check${details ? `: ${details}` : ''}`);
}

function checkManifest() {
  const manifest = checkJson('manifest.json');
  if (!manifest) return;

  const required = ['manifest_version', 'name', 'version', 'background', 'action', 'content_scripts'];
  for (const key of required) {
    if (manifest[key] === undefined) fail(`manifest.json is missing ${key}`);
    else pass(`manifest.json includes ${key}`);
  }

  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  for (const entry of contentScripts) {
    for (const script of entry.js || []) checkExists(script);
  }

  if (manifest.background && manifest.background.service_worker) {
    checkExists(manifest.background.service_worker);
  }

  if (manifest.action && manifest.action.default_popup) {
    checkExists(manifest.action.default_popup);
  }

  const iconFiles = Object.values(manifest.icons || {});
  for (const iconFile of iconFiles) checkExists(iconFile);
}

function validateExtension() {
  console.log('\nExtension checks');
  checkManifest();
  ['background.js', 'content.js', 'popup.js'].forEach(checkNodeSyntax);
  ['popup.html', 'styles.css'].forEach(checkReadable);
}

function validateDesktop() {
  console.log('\nDesktop app checks');
  checkJson('desktop-app/package.json');
  checkReadable('desktop-app/index.html');
  checkNodeSyntax('desktop-app/main.js');
  checkNodeSyntax('scripts/start-desktop.js');
  checkExists('desktop-app/package-lock.json');
}

function validateWorker() {
  console.log('\nCloudflare Worker checks');
  if (!fs.existsSync(fullPath('infra/worker'))) {
    warn('infra/worker is missing; skipping worker checks');
    return;
  }

  checkReadable('infra/worker/wrangler.toml');

  const packageResult = tryReadText('infra/worker/package.json');
  if (packageResult.ok) {
    try {
      JSON.parse(packageResult.text);
      pass('infra/worker/package.json parses as JSON');
    } catch (error) {
      fail(`infra/worker/package.json does not parse as JSON: ${error.message}`);
    }
  } else if (args.has('--worker')) {
    fail(`infra/worker/package.json is not readable: ${packageResult.reason}`);
  } else {
    warn(`Skipping worker package.json validation: ${packageResult.reason}`);
  }

  const workerSource = 'infra/worker/src/index.js';
  const sourceResult = tryReadText(workerSource);
  if (sourceResult.ok) {
    checkNodeSyntax(workerSource);
  } else if (args.has('--worker')) {
    fail(`${workerSource} is not readable: ${sourceResult.reason}`);
  } else {
    warn(`Skipping worker source validation: ${sourceResult.reason}`);
  }
}

if (shouldRunExtension) validateExtension();
if (shouldRunDesktop) validateDesktop();
if (shouldRunWorker) validateWorker();

console.log(`\nValidation complete: ${failures} failure(s), ${warnings} warning(s).`);
process.exit(failures === 0 ? 0 : 1);
