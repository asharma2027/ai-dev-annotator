'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProcessEnvironmentResolver,
  discoverLoginShellPath,
  mergePathLists,
  splitPathList,
} = require('../desktop-app/lib/process-environment');

test('puts an explicit service PATH before the login-shell and packaged-app fallbacks', async () => {
  let shellLoads = 0;
  const resolver = new ProcessEnvironmentResolver({
    platform: 'darwin',
    homeDirectory: '/Users/example',
    baseEnvironment: {
      PATH: '/usr/bin:/bin',
      SHELL: '/bin/zsh',
    },
    loadLoginShellPath: async () => {
      shellLoads += 1;
      return '/Users/example/.nvm/current/bin:/opt/homebrew/bin:/usr/bin';
    },
  });

  const first = await resolver.resolve({ CUSTOM_SETTING: 'enabled', PATH: '/project/bin:/opt/homebrew/bin' });
  const second = await resolver.resolve();
  const entries = splitPathList(first.PATH, 'darwin');

  assert.equal(first.CUSTOM_SETTING, 'enabled');
  assert.deepEqual(entries.slice(0, 4), [
    '/project/bin',
    '/opt/homebrew/bin',
    '/Users/example/.nvm/current/bin',
    '/usr/bin',
  ]);
  assert.ok(entries.includes('/Users/example/.bun/bin'));
  assert.ok(entries.includes('/usr/local/bin'));
  assert.equal(entries.filter((entry) => entry === '/opt/homebrew/bin').length, 1);
  assert.ok(second.PATH.includes('/Users/example/.nvm/current/bin'));
  assert.equal(shellLoads, 1, 'login-shell discovery should be cached per desktop session');
});

test('falls back to the newest installed nvm and fnm versions when shell discovery is unavailable', async (t) => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'annotator-path-home-'));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const nvmRoot = path.join(homeDirectory, '.nvm', 'versions', 'node');
  const fnmRoot = path.join(homeDirectory, '.local', 'share', 'fnm', 'node-versions');
  await Promise.all([
    fs.mkdir(path.join(nvmRoot, 'v18.20.5', 'bin'), { recursive: true }),
    fs.mkdir(path.join(nvmRoot, 'v22.14.0', 'bin'), { recursive: true }),
    fs.mkdir(path.join(fnmRoot, 'v20.18.3', 'installation', 'bin'), { recursive: true }),
  ]);

  const resolver = new ProcessEnvironmentResolver({
    platform: 'darwin',
    homeDirectory,
    baseEnvironment: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    loadLoginShellPath() {
      throw new Error('shell startup failed');
    },
  });
  const entries = splitPathList((await resolver.resolve()).PATH, 'darwin');
  const nvm22 = path.join(nvmRoot, 'v22.14.0', 'bin');
  const nvm18 = path.join(nvmRoot, 'v18.20.5', 'bin');
  const fnm20 = path.join(fnmRoot, 'v20.18.3', 'installation', 'bin');

  assert.ok(entries.indexOf(nvm22) < entries.indexOf(nvm18));
  assert.ok(entries.includes(fnm20));
  assert.ok(entries.indexOf(nvm18) < entries.indexOf('/usr/local/bin'));
});

test('uses Windows PATH casing and common package-manager locations without duplicates', async () => {
  const resolver = new ProcessEnvironmentResolver({
    platform: 'win32',
    homeDirectory: 'C:\\Users\\Ada',
    baseEnvironment: {
      Path: 'C:\\Windows\\System32',
      APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
    },
    loadLoginShellPath: async () => {
      throw new Error('Windows must not invoke a login shell');
    },
  });

  const environment = await resolver.resolve({
    PATH: 'D:\\project-tools;c:\\windows\\system32',
  });
  const entries = splitPathList(environment.PATH, 'win32');

  assert.equal(environment.Path, undefined);
  assert.deepEqual(entries.slice(0, 2), ['D:\\project-tools', 'c:\\windows\\system32']);
  assert.ok(entries.includes('C:\\Users\\Ada\\AppData\\Roaming\\npm'));
  assert.ok(entries.includes('C:\\Users\\Ada\\AppData\\Local\\pnpm'));
  assert.ok(entries.includes('C:\\Program Files\\nodejs'));
  assert.equal(entries.filter((entry) => entry.toLowerCase() === 'c:\\windows\\system32').length, 1);
});

test('reads the final PATH line from a supported login shell and rejects unknown executables', async () => {
  let invocation = null;
  const discovered = await discoverLoginShellPath({
    platform: 'darwin',
    environment: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
    execFile(command, args, options, callback) {
      invocation = { command, args, options };
      callback(null, 'startup banner\n/Users/example/.bun/bin:/opt/homebrew/bin:/usr/bin\n', '');
    },
  });

  assert.equal(discovered, '/Users/example/.bun/bin:/opt/homebrew/bin:/usr/bin');
  assert.equal(invocation.command, '/bin/zsh');
  assert.deepEqual(invocation.args, ['-ilc', 'exec /usr/bin/printenv PATH']);
  assert.equal(invocation.options.timeout, 3_000);

  let called = false;
  const rejected = await discoverLoginShellPath({
    platform: 'darwin',
    shell: '/tmp/not-a-shell',
    execFile() {
      called = true;
    },
  });
  assert.equal(rejected, '');
  assert.equal(called, false);
});

test('PATH merging drops empty entries and deduplicates Windows paths case-insensitively', () => {
  assert.equal(
    mergePathLists(['C:\\Tools;;C:\\Windows', 'c:\\tools;D:\\Bin'], 'win32'),
    'C:\\Tools;C:\\Windows;D:\\Bin',
  );
});
