#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'desktop-app');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const electronBin = path.join(
  desktopDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);

const healthCheckScript = `
const fs = require('fs');
const path = require('path');
const modules = ['electron', 'express', 'cors', 'simple-git', 'tree-kill'];
for (const mod of modules) {
  require.resolve(mod);
  require(mod);
}
fs.readFileSync(path.join(process.cwd(), 'main.js'), 'utf8');
fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
`;

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: desktopDir,
    stdio: 'inherit',
    shell: false,
    ...options,
  });
}

function checkDesktopInstall(timeoutMs = 8000) {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const child = spawn(process.execPath, ['-e', healthCheckScript], {
      cwd: desktopDir,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false,
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        reason: `dependency health check timed out after ${timeoutMs / 1000}s`,
      });
    }, timeoutMs);

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      finish({ ok: false, reason: error.message });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      if (code === 0) {
        finish({ ok: true });
        return;
      }

      const details = stderr.trim();
      finish({
        ok: false,
        reason: details || `health check exited with ${signal || `code ${code}`}`,
      });
    });
  });
}

function installDesktopDependencies() {
  const lockfile = path.join(desktopDir, 'package-lock.json');
  const preferredArgs = fs.existsSync(lockfile)
    ? ['ci', '--no-audit', '--no-fund']
    : ['install', '--no-audit', '--no-fund'];

  console.warn(`Desktop dependencies are not usable; running npm ${preferredArgs[0]} in desktop-app...`);
  let result = run(npmCmd, preferredArgs);
  if (result.status === 0) return true;

  if (preferredArgs[0] === 'ci') {
    console.warn('npm ci failed; falling back to npm install...');
    result = run(npmCmd, ['install', '--no-audit', '--no-fund']);
    return result.status === 0;
  }

  return false;
}

function launchElectron() {
  if (!fs.existsSync(electronBin)) {
    console.error(`Electron binary was not found at ${electronBin}`);
    process.exit(1);
  }

  const child = spawn(electronBin, ['.'], {
    cwd: desktopDir,
    stdio: 'inherit',
    shell: false,
  });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  child.on('error', (error) => {
    console.error(`Could not launch Electron: ${error.message}`);
    process.exit(1);
  });

  child.on('close', (code, signal) => {
    if (signal) {
      console.error(`${electronBin} exited with signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
}

async function main() {
  if (!fs.existsSync(path.join(desktopDir, 'package.json'))) {
    console.error(`Desktop app package.json was not found at ${desktopDir}`);
    process.exit(1);
  }

  let health = await checkDesktopInstall();
  if (!health.ok) {
    console.warn(`Desktop dependency health check failed: ${health.reason}`);
    if (!installDesktopDependencies()) {
      console.error('Could not install desktop dependencies.');
      process.exit(1);
    }

    health = await checkDesktopInstall();
    if (!health.ok) {
      console.error(`Desktop dependencies are still not usable: ${health.reason}`);
      process.exit(1);
    }
  }

  launchElectron();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
