'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_MANAGERS = [
  { name: 'pnpm', lockfiles: ['pnpm-lock.yaml'] },
  { name: 'yarn', lockfiles: ['yarn.lock'] },
  { name: 'bun', lockfiles: ['bun.lock', 'bun.lockb'] },
  { name: 'npm', lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'] },
];

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function validateSourcePath(sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
    throw new TypeError('sourcePath must be a non-empty string');
  }
  if (!path.isAbsolute(sourcePath)) {
    throw new Error('sourcePath must be an absolute path');
  }

  let stats;
  try {
    stats = fs.statSync(sourcePath);
  } catch (error) {
    throw new Error(`sourcePath does not exist: ${sourcePath}`, { cause: error });
  }
  if (!stats.isDirectory()) {
    throw new Error(`sourcePath must point to a directory: ${sourcePath}`);
  }
}

function detectPackageManager(sourcePath, packageJson, warnings) {
  const detected = PACKAGE_MANAGERS.filter((candidate) =>
    candidate.lockfiles.some((lockfile) => isFile(path.join(sourcePath, lockfile))),
  );

  if (detected.length > 1) {
    warnings.push(
      `Multiple package-manager lockfiles were found; using ${detected[0].name}.`,
    );
  }
  if (detected.length > 0) return detected[0].name;

  const declared =
    packageJson && typeof packageJson.packageManager === 'string'
      ? packageJson.packageManager.split('@')[0].trim().toLowerCase()
      : '';
  if (PACKAGE_MANAGERS.some((candidate) => candidate.name === declared)) {
    warnings.push(
      `No ${declared} lockfile was found; using the packageManager declared in package.json.`,
    );
    return declared;
  }

  warnings.push('No package-manager lockfile was found; using npm.');
  return 'npm';
}

function readPackageJson(sourcePath, warnings) {
  const packagePath = path.join(sourcePath, 'package.json');
  if (!isFile(packagePath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('the root value is not an object');
    }
    return parsed;
  } catch (error) {
    warnings.push(`package.json could not be read: ${error.message}`);
    return null;
  }
}

function detectScriptName(packageJson) {
  if (!packageJson.scripts || typeof packageJson.scripts !== 'object') return '';
  if (Array.isArray(packageJson.scripts)) return '';
  if (typeof packageJson.scripts.dev === 'string' && packageJson.scripts.dev.trim()) {
    return 'dev';
  }
  if (typeof packageJson.scripts.start === 'string' && packageJson.scripts.start.trim()) {
    return 'start';
  }
  return '';
}

function commandService(command, needsConfiguration = false) {
  const service = {
    type: 'command',
    name: 'Website',
    workingDirectory: '.',
    primary: true,
    url: '',
    command,
  };
  if (needsConfiguration) service.needsConfiguration = true;
  return service;
}

function staticService() {
  return {
    type: 'static',
    name: 'Website',
    workingDirectory: '.',
    primary: true,
    url: '',
    command: '',
  };
}

/**
 * Inspect a source directory and return an editable launch plan for the UI.
 * Detection is intentionally conservative: it only chooses well-known package
 * scripts or an index.html entry point and never executes project code.
 */
function detectProjectPlan(sourcePath) {
  validateSourcePath(sourcePath);

  const warnings = [];
  const packageJson = readPackageJson(sourcePath, warnings);
  const packageName =
    packageJson && typeof packageJson.name === 'string' && packageJson.name.trim()
      ? packageJson.name.trim().slice(0, 120)
      : path.basename(path.normalize(sourcePath)) || 'Website';

  if (packageJson) {
    const scriptName = detectScriptName(packageJson);

    if (scriptName) {
      const manager = detectPackageManager(sourcePath, packageJson, warnings);
      return {
        name: packageName,
        services: [commandService(`${manager} run ${scriptName}`)],
        warnings,
      };
    }
  }

  if (isFile(path.join(sourcePath, 'index.html'))) {
    return {
      name: packageName,
      services: [staticService()],
      warnings,
    };
  }

  warnings.push(
    'No package.json dev/start script or index.html was detected. Configure a start command before launching.',
  );
  return {
    name: packageName,
    services: [commandService('', true)],
    warnings,
  };
}

module.exports = {
  detectProjectPlan,
};
