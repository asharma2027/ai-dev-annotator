'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_LOGIN_SHELL_TIMEOUT_MS = 3_000;
const SUPPORTED_LOGIN_SHELLS = new Set([
  'bash',
  'csh',
  'dash',
  'fish',
  'ksh',
  'sh',
  'tcsh',
  'zsh',
]);

function pathTools(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function pathDelimiter(platform) {
  return platform === 'win32' ? ';' : ':';
}

function pathKeys(environment, platform) {
  if (!environment || typeof environment !== 'object') return [];
  return Object.keys(environment).filter((key) => (
    platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH'
  ));
}

function environmentPath(environment, platform) {
  const key = pathKeys(environment, platform)[0];
  return key ? environment[key] : '';
}

function splitPathList(value, platform) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => splitPathList(entry, platform));
  }
  if (typeof value !== 'string') return [];
  return value
    .split(pathDelimiter(platform))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergePathLists(values, platform = process.platform) {
  const tools = pathTools(platform);
  const seen = new Set();
  const entries = [];

  for (const entry of splitPathList(values, platform)) {
    const normalized = tools.normalize(entry);
    const identity = platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(identity)) continue;
    seen.add(identity);
    entries.push(entry);
  }
  return entries.join(pathDelimiter(platform));
}

function absolutePathEntries(value, platform) {
  const tools = pathTools(platform);
  return splitPathList(value, platform).filter((entry) => tools.isAbsolute(entry));
}

function environmentHintDirectories(environment, platform, homeDirectory) {
  const tools = pathTools(platform);
  const hints = [];
  const add = (value) => {
    if (typeof value === 'string' && tools.isAbsolute(value)) hints.push(value);
  };
  const addBin = (value) => {
    if (typeof value === 'string' && tools.isAbsolute(value)) hints.push(tools.join(value, 'bin'));
  };

  add(environment.NVM_BIN);
  add(environment.NVM_SYMLINK);
  add(environment.NVM_HOME);
  add(environment.PNPM_HOME);
  add(environment.FNM_MULTISHELL_PATH);
  addBin(environment.BUN_INSTALL);
  addBin(environment.VOLTA_HOME);
  addBin(environment.npm_config_prefix);

  if (platform === 'win32') {
    add(environment.APPDATA && tools.join(environment.APPDATA, 'npm'));
    add(environment.LOCALAPPDATA && tools.join(environment.LOCALAPPDATA, 'pnpm'));
    add(environment.ProgramFiles && tools.join(environment.ProgramFiles, 'nodejs'));
    add(environment.PROGRAMFILES && tools.join(environment.PROGRAMFILES, 'nodejs'));
    add(environment['ProgramFiles(x86)'] && tools.join(environment['ProgramFiles(x86)'], 'nodejs'));
    add(environment['PROGRAMFILES(X86)'] && tools.join(environment['PROGRAMFILES(X86)'], 'nodejs'));
  }

  if (homeDirectory) {
    add(tools.join(homeDirectory, '.bun', 'bin'));
    add(tools.join(homeDirectory, '.volta', 'bin'));
  }
  return hints;
}

function commonExecutableDirectories(platform, homeDirectory) {
  const tools = pathTools(platform);
  const homePaths = homeDirectory ? [
    tools.join(homeDirectory, '.local', 'bin'),
    tools.join(homeDirectory, '.asdf', 'shims'),
    tools.join(homeDirectory, '.nodenv', 'shims'),
    tools.join(homeDirectory, '.local', 'share', 'pnpm'),
    tools.join(homeDirectory, '.yarn', 'bin'),
    tools.join(homeDirectory, '.config', 'yarn', 'global', 'node_modules', '.bin'),
  ] : [];

  if (platform === 'win32') {
    return homeDirectory ? [
      tools.join(homeDirectory, 'scoop', 'shims'),
      tools.join(homeDirectory, '.bun', 'bin'),
      tools.join(homeDirectory, '.volta', 'bin'),
    ] : [];
  }

  if (platform === 'darwin') {
    return [
      ...homePaths,
      ...(homeDirectory ? [tools.join(homeDirectory, 'Library', 'pnpm')] : []),
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ];
  }

  return [
    ...homePaths,
    ...(homeDirectory ? [tools.join(homeDirectory, '.linuxbrew', 'bin')] : []),
    '/home/linuxbrew/.linuxbrew/bin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/snap/bin',
  ];
}

function compareVersionNamesDescending(left, right) {
  const leftParts = String(left).match(/\d+/g)?.map(Number) || [];
  const rightParts = String(right).match(/\d+/g)?.map(Number) || [];
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (rightParts[index] || 0) - (leftParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return String(right).localeCompare(String(left), undefined, { numeric: true });
}

async function childDirectories(rootDirectory, suffix, fsPromises, tools) {
  try {
    const entries = await fsPromises.readdir(rootDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => typeof entry.isDirectory !== 'function' || entry.isDirectory())
      .map((entry) => typeof entry === 'string' ? entry : entry.name)
      .sort(compareVersionNamesDescending)
      .map((name) => tools.join(rootDirectory, name, ...suffix));
  } catch {
    return [];
  }
}

async function discoverVersionManagerDirectories(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') return [];
  const environment = options.environment || process.env;
  const homeDirectory = options.homeDirectory || os.homedir();
  if (!homeDirectory) return [];
  const fsPromises = options.fsPromises || fs;
  const tools = pathTools(platform);
  const nvmHomes = new Set([
    tools.join(homeDirectory, '.nvm'),
    ...(typeof environment.NVM_DIR === 'string' && tools.isAbsolute(environment.NVM_DIR)
      ? [environment.NVM_DIR]
      : []),
  ]);
  const fnmRoots = new Set([
    tools.join(homeDirectory, '.local', 'share', 'fnm', 'node-versions'),
    ...(platform === 'darwin'
      ? [tools.join(homeDirectory, 'Library', 'Application Support', 'fnm', 'node-versions')]
      : []),
  ]);

  const groups = await Promise.all([
    ...Array.from(nvmHomes, (directory) => (
      childDirectories(tools.join(directory, 'versions', 'node'), ['bin'], fsPromises, tools)
    )),
    ...Array.from(fnmRoots, (directory) => (
      childDirectories(directory, ['installation', 'bin'], fsPromises, tools)
    )),
  ]);
  return groups.flat();
}

function parseLoginShellPath(stdout) {
  if (typeof stdout !== 'string' || stdout.includes('\0')) return '';
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidate = lines.at(-1) || '';
  return candidate.length <= 32_768 ? candidate : '';
}

function discoverLoginShellPath(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') return Promise.resolve('');
  const environment = options.environment || process.env;
  let accountShell = '';
  try {
    accountShell = os.userInfo().shell || '';
  } catch {
    // A valid HOME plus the platform default still provides useful fallbacks.
  }
  const shell = options.shell
    || environment.SHELL
    || accountShell
    || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const tools = pathTools(platform);
  if (!tools.isAbsolute(shell) || !SUPPORTED_LOGIN_SHELLS.has(tools.basename(shell))) {
    return Promise.resolve('');
  }

  const execFileImpl = options.execFile || execFile;
  const timeout = options.timeoutMs ?? DEFAULT_LOGIN_SHELL_TIMEOUT_MS;
  return new Promise((resolve) => {
    execFileImpl(
      shell,
      ['-ilc', 'exec /usr/bin/printenv PATH'],
      {
        encoding: 'utf8',
        env: environment,
        maxBuffer: 64 * 1_024,
        timeout,
        windowsHide: true,
      },
      (error, stdout) => resolve(error ? '' : parseLoginShellPath(stdout)),
    );
  });
}

class ProcessEnvironmentResolver {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.baseEnvironment = { ...(options.baseEnvironment || process.env) };
    this.homeDirectory = options.homeDirectory || os.homedir();
    this.fsPromises = options.fsPromises || fs;
    this.loadLoginShellPath = options.loadLoginShellPath || discoverLoginShellPath;
    this.loginShellTimeoutMs = options.loginShellTimeoutMs ?? DEFAULT_LOGIN_SHELL_TIMEOUT_MS;
    this.baselinePathPromise = null;
  }

  async resolve(overrides = {}) {
    const additions = overrides && typeof overrides === 'object' && !Array.isArray(overrides)
      ? overrides
      : {};
    const environment = { ...this.baseEnvironment, ...additions };
    const overridePath = environmentPath(additions, this.platform);
    const baselinePath = await this._baselinePath();
    const outputKey = pathKeys(additions, this.platform)[0]
      || pathKeys(this.baseEnvironment, this.platform)[0]
      || (this.platform === 'win32' ? 'Path' : 'PATH');

    for (const key of pathKeys(environment, this.platform)) delete environment[key];
    environment[outputKey] = mergePathLists([overridePath, baselinePath], this.platform);
    return environment;
  }

  _baselinePath() {
    if (!this.baselinePathPromise) this.baselinePathPromise = this._buildBaselinePath();
    return this.baselinePathPromise;
  }

  async _buildBaselinePath() {
    const loginShellPathPromise = this.platform === 'win32'
      ? Promise.resolve('')
      : Promise.resolve()
          .then(() => this.loadLoginShellPath({
            environment: this.baseEnvironment,
            platform: this.platform,
            timeoutMs: this.loginShellTimeoutMs,
          }))
          .catch(() => '');
    const [loginShellPath, versionManagerDirectories] = await Promise.all([
      loginShellPathPromise,
      discoverVersionManagerDirectories({
        environment: this.baseEnvironment,
        fsPromises: this.fsPromises,
        homeDirectory: this.homeDirectory,
        platform: this.platform,
      }),
    ]);

    return mergePathLists([
      absolutePathEntries(loginShellPath, this.platform),
      environmentHintDirectories(this.baseEnvironment, this.platform, this.homeDirectory),
      versionManagerDirectories,
      commonExecutableDirectories(this.platform, this.homeDirectory),
      absolutePathEntries(environmentPath(this.baseEnvironment, this.platform), this.platform),
    ], this.platform);
  }
}

module.exports = {
  ProcessEnvironmentResolver,
  absolutePathEntries,
  commonExecutableDirectories,
  discoverLoginShellPath,
  discoverVersionManagerDirectories,
  environmentHintDirectories,
  environmentPath,
  mergePathLists,
  parseLoginShellPath,
  splitPathList,
};
