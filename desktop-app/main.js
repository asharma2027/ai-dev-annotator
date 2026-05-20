const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const simpleGit = require('simple-git');
const fs = require('fs');
const { spawn } = require('child_process');
const treeKill = require('tree-kill');

const CONFIG_FILE = path.join(app.getPath('userData'), 'annotator-setup.json');
const REPO_DIR = path.join(app.getPath('userData'), 'repo_workspace');
const SETUP_PORT = 11454;
const REPO_CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_COLORS = ['#2563eb', '#059669', '#dc2626', '#7c3aed', '#ea580c', '#0891b2', '#be123c'];

let mainWindow;
let repoProcess = null;
let repoUpdateTimer = null;
let repoUpdateInFlight = false;

function randomReviewerName() {
  return `Reviewer ${Math.floor(1000 + Math.random() * 9000)}`;
}

function normalizeConfig(config = {}) {
  return {
    githubUrl: typeof config.githubUrl === 'string' ? config.githubUrl : '',
    firebaseConfig: typeof config.firebaseConfig === 'string' ? config.firebaseConfig : '',
    username: typeof config.username === 'string' && config.username.trim()
      ? config.username.trim()
      : randomReviewerName(),
    userColor: typeof config.userColor === 'string' && /^#[0-9a-f]{6}$/i.test(config.userColor)
      ? config.userColor
      : DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)],
    localServerPort: Number.isInteger(config.localServerPort) ? config.localServerPort : null,
    repoStatus: {
      currentCommit: '',
      shortCommit: '',
      branch: '',
      commitMessage: '',
      commitDate: '',
      checkedAt: '',
      updatedAt: '',
      error: null,
      ...(config.repoStatus && typeof config.repoStatus === 'object' ? config.repoStatus : {}),
    },
  };
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    }
  } catch (err) {
    console.warn('Could not load setup config:', err);
  }
  const config = normalizeConfig();
  saveConfig(config);
  return config;
}

function saveConfig(config = currentConfig) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalizeConfig(config), null, 2));
}

let currentConfig = loadConfig();

function publicConfig() {
  return {
    githubUrl: currentConfig.githubUrl,
    firebaseConfig: currentConfig.firebaseConfig,
    username: currentConfig.username,
    userColor: currentConfig.userColor,
    localServerPort: currentConfig.localServerPort,
    repoStatus: currentConfig.repoStatus,
  };
}

function sendLog(message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('log', message);
}

function broadcastConfig() {
  saveConfig();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-updated', publicConfig());
  }
}

const expressApp = express();
expressApp.use(cors({ origin: '*' }));

expressApp.get('/api/config', (req, res) => {
  res.json(publicConfig());
});

expressApp.get('/api/site-version', (req, res) => {
  res.json({
    githubUrl: currentConfig.githubUrl,
    localServerPort: currentConfig.localServerPort,
    ...currentConfig.repoStatus,
  });
});

expressApp.listen(SETUP_PORT, () => {
  console.log(`Extension setup server running on port ${SETUP_PORT}`);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 720,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  clearInterval(repoUpdateTimer);
  if (repoProcess) treeKill(repoProcess.pid, 'SIGKILL');
});

ipcMain.handle('get-config', async () => publicConfig());

ipcMain.handle('start-repo', async (event, setup) => {
  currentConfig.githubUrl = typeof setup.githubUrl === 'string' ? setup.githubUrl.trim() : currentConfig.githubUrl;
  currentConfig.firebaseConfig = typeof setup.firebaseConfig === 'string' ? setup.firebaseConfig.trim() : currentConfig.firebaseConfig;
  currentConfig.username = typeof setup.username === 'string' && setup.username.trim()
    ? setup.username.trim()
    : currentConfig.username || randomReviewerName();
  currentConfig.userColor = typeof setup.userColor === 'string' && /^#[0-9a-f]{6}$/i.test(setup.userColor)
    ? setup.userColor
    : currentConfig.userColor;
  broadcastConfig();

  if (setup.saveOnly) {
    sendLog('Setup saved.');
    return { success: true };
  }

  if (!currentConfig.githubUrl) {
    sendLog('Setup saved. Add a GitHub repo when you want the desktop app to run the site.');
    return { success: true };
  }

  try {
    sendLog('Preparing repository...');
    const git = await ensureRepo(currentConfig.githubUrl);
    await applyRepoConfigFile();
    await updateRepoStatus(git);
    await installAndStartRepo();
    startRepoUpdateChecks();
    return { success: true };
  } catch (error) {
    currentConfig.repoStatus = {
      ...currentConfig.repoStatus,
      error: error.message,
      checkedAt: new Date().toISOString(),
    };
    broadcastConfig();
    console.error(error);
    throw error;
  }
});

function parseGithubRepo(githubUrl) {
  if (!githubUrl) return null;
  const value = String(githubUrl).trim();
  const sshMatch = value.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (sshMatch) return sshMatch[1].toLowerCase();
  try {
    const url = new URL(value);
    if (!/github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`.toLowerCase();
  } catch (_err) {
    const match = value.match(/github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?(?:[#?].*)?$/i);
    return match ? match[1].toLowerCase() : null;
  }
}

function sameGithubRepo(a, b) {
  const repoA = parseGithubRepo(a);
  const repoB = parseGithubRepo(b);
  return !!repoA && !!repoB && repoA === repoB;
}

function hasGitRepo() {
  return fs.existsSync(path.join(REPO_DIR, '.git'));
}

async function ensureRepo(githubUrl) {
  fs.mkdirSync(path.dirname(REPO_DIR), { recursive: true });
  if (hasGitRepo()) {
    const git = simpleGit(REPO_DIR);
    const origin = await git.remote(['get-url', 'origin']).catch(() => '');
    if (sameGithubRepo(origin, githubUrl)) {
      sendLog('Using existing checkout.');
      await git.fetch();
      await pullCurrentBranch(git);
      return git;
    }
    sendLog('Repository changed. Creating a fresh checkout.');
    await stopRepoProcess();
    fs.rmSync(REPO_DIR, { recursive: true, force: true });
  }

  fs.mkdirSync(REPO_DIR, { recursive: true });
  sendLog(`Cloning ${githubUrl}...`);
  const git = simpleGit(REPO_DIR);
  await git.clone(githubUrl, '.');
  return git;
}

async function pullCurrentBranch(git) {
  const branch = await git.branch();
  if (!branch.current) return false;
  const before = await git.revparse(['HEAD']).catch(() => '');
  await git.pull('origin', branch.current);
  const after = await git.revparse(['HEAD']).catch(() => '');
  return before.trim() !== after.trim();
}

async function applyRepoConfigFile() {
  const configPath = path.join(REPO_DIR, 'ai-annotator-config.json');
  if (!fs.existsSync(configPath)) return;
  try {
    const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!currentConfig.firebaseConfig && fileConfig.firebaseConfig) {
      currentConfig.firebaseConfig = typeof fileConfig.firebaseConfig === 'object'
        ? JSON.stringify(fileConfig.firebaseConfig)
        : String(fileConfig.firebaseConfig);
    }
    if (!currentConfig.githubUrl && fileConfig.githubUrl) currentConfig.githubUrl = String(fileConfig.githubUrl);
    if (!currentConfig.username && fileConfig.username) currentConfig.username = String(fileConfig.username);
    if (!currentConfig.userColor && /^#[0-9a-f]{6}$/i.test(fileConfig.userColor || '')) {
      currentConfig.userColor = fileConfig.userColor;
    }
    broadcastConfig();
  } catch (err) {
    sendLog('Could not parse ai-annotator-config.json.');
    console.warn('Could not parse ai-annotator-config.json', err);
  }
}

async function updateRepoStatus(git = simpleGit(REPO_DIR), extra = {}) {
  if (!hasGitRepo()) return;
  const branch = await git.branch().catch(() => ({ current: '' }));
  const latest = await git.log({ maxCount: 1 }).then(log => log.latest).catch(() => null);
  const hash = latest?.hash || await git.revparse(['HEAD']).catch(() => '');
  currentConfig.repoStatus = {
    ...currentConfig.repoStatus,
    currentCommit: String(hash || '').trim(),
    shortCommit: String(hash || '').trim().slice(0, 7),
    branch: branch.current || currentConfig.repoStatus.branch || '',
    commitMessage: latest?.message || currentConfig.repoStatus.commitMessage || '',
    commitDate: latest?.date || currentConfig.repoStatus.commitDate || '',
    updatedAt: new Date().toISOString(),
    error: null,
    ...extra,
  };
  broadcastConfig();
}

async function stopRepoProcess() {
  if (!repoProcess) return;
  const pid = repoProcess.pid;
  repoProcess = null;
  await new Promise(resolve => treeKill(pid, 'SIGKILL', () => resolve()));
}

function runCommand(command, args, cwd, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, shell: true });
    proc.stdout.on('data', data => sendLog(data.toString().trimEnd()));
    proc.stderr.on('data', data => sendLog(data.toString().trimEnd()));
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}.`));
    });
  });
}

async function installAndStartRepo({ openBrowser = true } = {}) {
  await stopRepoProcess();

  if (fs.existsSync(path.join(REPO_DIR, 'package.json'))) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
    const hasLockfile = fs.existsSync(path.join(REPO_DIR, 'package-lock.json'));
    const installArgs = hasLockfile ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
    sendLog(`Installing dependencies with npm ${installArgs[0]}...`);
    try {
      await runCommand('npm', installArgs, REPO_DIR, `npm ${installArgs[0]}`);
    } catch (err) {
      if (!hasLockfile) throw err;
      sendLog('npm ci failed. Falling back to npm install...');
      await runCommand('npm', ['install', '--no-audit', '--no-fund'], REPO_DIR, 'npm install');
    }

    const scriptToRun = packageJson.scripts?.dev ? 'dev' : (packageJson.scripts?.start ? 'start' : null);
    if (!scriptToRun) throw new Error('package.json does not define a dev or start script.');
    sendLog(`Starting website with npm run ${scriptToRun}...`);
    repoProcess = spawn('npm', ['run', scriptToRun], { cwd: REPO_DIR, shell: true });
    watchServerProcess(repoProcess, 3000, { openBrowser });
    return;
  }

  if (fs.existsSync(path.join(REPO_DIR, 'requirements.txt'))) {
    sendLog('Installing Python requirements...');
    await runCommand('pip3', ['install', '-r', 'requirements.txt'], REPO_DIR, 'pip install');
    sendLog('Starting Python static server on port 8000...');
    repoProcess = spawn('python3', ['-m', 'http.server', '8000'], { cwd: REPO_DIR, shell: true });
    currentConfig.localServerPort = 8000;
    broadcastConfig();
    if (openBrowser) setTimeout(() => shell.openExternal('http://localhost:8000'), 1200);
    return;
  }

  if (fs.existsSync(path.join(REPO_DIR, 'index.html'))) {
    sendLog('Starting static server on port 8000...');
    repoProcess = spawn('python3', ['-m', 'http.server', '8000'], { cwd: REPO_DIR, shell: true });
    currentConfig.localServerPort = 8000;
    broadcastConfig();
    if (openBrowser) setTimeout(() => shell.openExternal('http://localhost:8000'), 1200);
    return;
  }

  throw new Error('Could not determine how to run the repository.');
}

function watchServerProcess(proc, fallbackPort, { openBrowser = true } = {}) {
  let portFound = false;
  const handleOutput = data => {
    const output = data.toString();
    if (output.trim()) sendLog(output.trimEnd());
    const portMatch =
      output.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i) ||
      output.match(/port\s+(\d+)/i) ||
      output.match(/Local:\s+.*:(\d+)/i);
    if (portMatch && !portFound) {
      portFound = true;
      const port = parseInt(portMatch[1], 10);
      currentConfig.localServerPort = port;
      broadcastConfig();
      sendLog(`Website running on http://localhost:${port}`);
      if (openBrowser) setTimeout(() => shell.openExternal(`http://localhost:${port}`), 1000);
    }
  };

  proc.stdout.on('data', handleOutput);
  proc.stderr.on('data', handleOutput);
  proc.on('close', code => {
    if (repoProcess === proc) repoProcess = null;
    sendLog(`Website process exited with code ${code}.`);
  });

  setTimeout(() => {
    if (!portFound) {
      currentConfig.localServerPort = fallbackPort;
      broadcastConfig();
      sendLog(`Could not detect the dev server port. Using http://localhost:${fallbackPort}.`);
      if (openBrowser) shell.openExternal(`http://localhost:${fallbackPort}`);
    }
  }, 8000);
}

function startRepoUpdateChecks() {
  clearInterval(repoUpdateTimer);
  repoUpdateTimer = setInterval(checkForRepoUpdate, REPO_CHECK_INTERVAL_MS);
}

async function checkForRepoUpdate() {
  if (repoUpdateInFlight || !currentConfig.githubUrl || !hasGitRepo()) return;
  repoUpdateInFlight = true;
  try {
    const git = simpleGit(REPO_DIR);
    const branch = await git.branch();
    if (!branch.current) return;
    await git.fetch();
    const localHead = (await git.revparse(['HEAD'])).trim();
    const remoteHead = (await git.revparse([`origin/${branch.current}`])).trim();
    currentConfig.repoStatus = {
      ...currentConfig.repoStatus,
      checkedAt: new Date().toISOString(),
      remoteCommit: remoteHead,
      error: null,
    };
    broadcastConfig();
    if (localHead === remoteHead) return;

    sendLog(`New GitHub version found (${remoteHead.slice(0, 7)}). Updating website...`);
    await git.pull('origin', branch.current);
    await applyRepoConfigFile();
    await updateRepoStatus(git, { remoteCommit: remoteHead, checkedAt: new Date().toISOString() });
    await installAndStartRepo({ openBrowser: false });
  } catch (err) {
    currentConfig.repoStatus = {
      ...currentConfig.repoStatus,
      checkedAt: new Date().toISOString(),
      error: err.message,
    };
    broadcastConfig();
    sendLog(`Update check failed: ${err.message}`);
  } finally {
    repoUpdateInFlight = false;
  }
}
