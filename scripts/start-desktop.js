const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createNpmInvocation, resolveElectronExecutable } = require('./command-runner');

const repositoryRoot = path.resolve(__dirname, '..');
const desktopDirectory = path.join(repositoryRoot, 'desktop-app');

function installDesktopDependencies() {
  const hasLockfile = fs.existsSync(path.join(desktopDirectory, 'package-lock.json'));
  const args = hasLockfile
    ? ['ci', '--no-audit', '--no-fund']
    : ['install', '--no-audit', '--no-fund'];
  const npm = createNpmInvocation(args);
  process.stdout.write('Preparing AI Annotator Home for first launch…\n');
  const result = spawnSync(npm.command, npm.args, {
    cwd: desktopDirectory,
    shell: false,
    stdio: 'inherit',
  });
  if (result.error) process.stderr.write(`Could not run npm: ${result.error.message}\n`);
  if (result.status !== 0) process.exit(result.status || 1);
}

function findElectronExecutable() {
  try {
    return resolveElectronExecutable(desktopDirectory);
  } catch {
    installDesktopDependencies();
    return resolveElectronExecutable(desktopDirectory);
  }
}

const desktopProcess = spawn(findElectronExecutable(), ['.'], {
  cwd: desktopDirectory,
  shell: false,
  stdio: 'inherit',
});

desktopProcess.on('error', (error) => {
  process.stderr.write(`Could not launch AI Annotator Home: ${error.message}\n`);
  process.exitCode = 1;
});
desktopProcess.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code || 0;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!desktopProcess.killed) desktopProcess.kill(signal);
  });
}
