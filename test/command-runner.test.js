'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createNpmInvocation,
  resolveElectronExecutable,
  resolveNpmCliPath,
} = require('../scripts/command-runner');

test('Windows npm invocation runs npm-cli.js directly without joining arguments', () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe';
  const npmCliPath = 'C:\\Tools & More\\npm\\bin\\npm-cli.js';
  const invocation = createNpmInvocation(['ci', '--prefix', 'site & calc'], {
    env: { npm_execpath: npmCliPath },
    execPath,
    existsSync: (candidate) => candidate === npmCliPath,
    platform: 'win32',
    realpathSync: (candidate) => candidate,
  });

  assert.equal(invocation.command, execPath);
  assert.deepEqual(invocation.args, [npmCliPath, 'ci', '--prefix', 'site & calc']);
});

test('Windows npm lookup falls back to the CLI installed beside Node.js', () => {
  const expected = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  const actual = resolveNpmCliPath({
    env: {},
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    existsSync: (candidate) => candidate === expected,
    platform: 'win32',
    realpathSync: (candidate) => candidate,
  });

  assert.equal(actual, expected);
});

test('npm lookup follows a sibling launcher symlink without executing a shell', () => {
  const npmCliPath = '/opt/tools/lib/node_modules/npm/bin/npm-cli.js';
  const actual = resolveNpmCliPath({
    env: {},
    execPath: '/opt/tools/bin/node',
    existsSync: (candidate) => candidate === npmCliPath,
    platform: 'darwin',
    realpathSync: (candidate) => candidate === '/opt/tools/bin/npm' ? npmCliPath : candidate,
  });

  assert.equal(actual, npmCliPath);
});

test('Electron lookup returns the native Windows executable, not a cmd shim', () => {
  const executable = 'C:\\repo\\desktop-app\\node_modules\\electron\\dist\\electron.exe';
  const actual = resolveElectronExecutable('C:\\repo\\desktop-app', {
    existsSync: (candidate) => candidate === executable,
    loadModule: () => executable,
    platform: 'win32',
    resolveModule: () => 'C:\\repo\\desktop-app\\node_modules\\electron\\index.js',
  });

  assert.equal(actual, executable);
});

test('Electron lookup refuses Windows command shims', () => {
  assert.throws(() => resolveElectronExecutable('C:\\repo\\desktop-app', {
    existsSync: () => true,
    loadModule: () => 'C:\\repo\\desktop-app\\node_modules\\.bin\\electron.cmd',
    platform: 'win32',
    resolveModule: () => 'C:\\repo\\desktop-app\\node_modules\\electron\\index.js',
  }), /shell script/);
});
