'use strict';

const fs = require('node:fs');
const path = require('node:path');

function pathImplementation(platform) {
  return platform === 'win32' ? path.win32 : path;
}

function resolveNpmCliPath(options = {}) {
  const env = options.env || process.env;
  const execPath = options.execPath || process.execPath;
  const existsSync = options.existsSync || fs.existsSync;
  const realpathSync = options.realpathSync || fs.realpathSync;
  const pathApi = pathImplementation(options.platform || process.platform);
  const candidates = [];

  if (env.npm_execpath && pathApi.basename(env.npm_execpath).toLowerCase() === 'npm-cli.js') {
    candidates.push(env.npm_execpath);
  }

  const nodeExecutables = [execPath];
  try {
    nodeExecutables.push(realpathSync(execPath));
  } catch {
    // The original executable path still covers normal Node installations.
  }

  for (const nodeExecutable of nodeExecutables) {
    const binaryDirectory = pathApi.dirname(nodeExecutable);
    for (const npmLauncher of ['npm', 'npm.cmd'].map((name) => pathApi.join(binaryDirectory, name))) {
      try {
        const resolvedLauncher = realpathSync(npmLauncher);
        if (pathApi.basename(resolvedLauncher).toLowerCase() === 'npm-cli.js') {
          candidates.push(resolvedLauncher);
        }
      } catch {
        // npm may not have a launcher beside this copy of Node.
      }
    }
    candidates.push(
      pathApi.join(binaryDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      pathApi.join(binaryDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      pathApi.join(binaryDirectory, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
  }

  const npmCliPath = [...new Set(candidates)].find((candidate) => existsSync(candidate));
  if (!npmCliPath) {
    throw new Error('Could not locate npm-cli.js. Install npm alongside Node.js and try again.');
  }
  return npmCliPath;
}

function createNpmInvocation(args, options = {}) {
  const command = options.execPath || process.execPath;
  return {
    args: [resolveNpmCliPath(options), ...args],
    command,
  };
}

function resolveElectronExecutable(desktopDirectory, options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = pathImplementation(platform);
  const existsSync = options.existsSync || fs.existsSync;
  const resolveModule = options.resolveModule || require.resolve;
  const loadModule = options.loadModule || require;
  const electronEntry = resolveModule('electron', { paths: [desktopDirectory] });
  const executable = loadModule(electronEntry);

  if (typeof executable !== 'string' || !pathApi.isAbsolute(executable)) {
    throw new Error('The Electron package did not provide an absolute executable path.');
  }
  if (/\.(?:cmd|bat)$/i.test(executable)) {
    throw new Error('The Electron package resolved to a shell script instead of its executable.');
  }
  if (!existsSync(executable)) {
    throw new Error(`Electron executable is missing: ${executable}`);
  }
  return executable;
}

module.exports = {
  createNpmInvocation,
  resolveElectronExecutable,
  resolveNpmCliPath,
};
