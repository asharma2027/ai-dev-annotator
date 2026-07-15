const { spawnSync } = require('child_process');
const path = require('path');
const { createNpmInvocation } = require('./command-runner');

const repositoryRoot = path.resolve(__dirname, '..');

function run(args, cwd = repositoryRoot) {
  const npm = createNpmInvocation(args);
  const result = spawnSync(npm.command, npm.args, { cwd, shell: false, stdio: 'inherit' });
  if (result.error) process.stderr.write(`Could not run npm: ${result.error.message}\n`);
  if (result.status !== 0) process.exit(result.status || 1);
}

run(['ci', '--prefix', 'desktop-app', '--no-audit', '--no-fund']);
run(['run', 'check']);
