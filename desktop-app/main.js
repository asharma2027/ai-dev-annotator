const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const simpleGit = require('simple-git');
const fs = require('fs');
const { spawn } = require('child_process');
const treeKill = require('tree-kill');

const isWindows = process.platform === 'win32';
const PYTHON_BIN = isWindows ? 'python' : 'python3';

const CONFIG_FILE = path.join(app.getPath('userData'), 'annotator-setup.json');
const REPO_DIR = path.join(app.getPath('userData'), 'repo_workspace');
const REPO_CONFIG_FILE = path.join(REPO_DIR, 'ai-annotator-config.json');
const TEST_IDENTITIES_FILE = path.join(app.getPath('userData'), 'testing-window-identities.json');
const SETUP_PORT = 11454;
const REPO_CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_COLORS = ['#2563eb', '#059669', '#dc2626', '#7c3aed', '#ea580c', '#0891b2', '#be123c'];
const EXTENSION_DEBUG_EVENT_LIMIT = 200;

let mainWindow;
let setupServer = null;
let repoProcess = null;
let repoUpdateTimer = null;
let repoUpdateInFlight = false;
let extensionDebugEvents = [];

function randomReviewerName() {
  return `Reviewer ${Math.floor(1000 + Math.random() * 9000)}`;
}

function parseLenientJsonObject(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const candidates = [raw];
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_err) {}
  }

  for (const candidate of candidates) {
    const normalized = candidate
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/,\s*([}\]])/g, '$1');
    try {
      const parsed = JSON.parse(normalized);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_err) {}
  }

  return null;
}

function completeFirebaseConfig(config) {
  const completed = { ...(config || {}) };
  if (!completed.databaseURL && completed.projectId) {
    completed.databaseURL = `https://${completed.projectId}-default-rtdb.firebaseio.com`;
  }
  return completed;
}

function normalizeFirebaseConfigText(value, { allowBlank = true } = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (allowBlank) return '';
    throw new Error('Firebase config JSON is required.');
  }
  const parsed = parseLenientJsonObject(raw);
  if (!parsed) {
    throw new Error('Firebase config must be a valid JSON object. You can paste either the JSON object or the Firebase config snippet from Firebase.');
  }
  return JSON.stringify(completeFirebaseConfig(parsed), null, 2);
}

function safeNormalizeFirebaseConfigText(value) {
  try {
    return normalizeFirebaseConfigText(value);
  } catch (_err) {
    return String(value || '').trim();
  }
}

function firebaseConfigForRepoFile(value) {
  const normalized = normalizeFirebaseConfigText(value);
  return normalized ? JSON.parse(normalized) : '';
}

function repoConfigToSetupConfig(fileConfig = {}) {
  const setup = {};
  if (typeof fileConfig.githubUrl === 'string') setup.githubUrl = fileConfig.githubUrl.trim();
  const firebaseConfig = fileConfig.firebaseConfig || fileConfig.firebase;
  if (firebaseConfig) {
    setup.firebaseConfig = typeof firebaseConfig === 'object'
      ? JSON.stringify(completeFirebaseConfig(firebaseConfig), null, 2)
      : normalizeFirebaseConfigText(firebaseConfig);
  }
  if (typeof fileConfig.username === 'string') setup.username = fileConfig.username.trim();
  if (typeof fileConfig.userColor === 'string') setup.userColor = fileConfig.userColor.trim();
  return setup;
}

function readRepoConfigFile() {
  if (!fs.existsSync(REPO_CONFIG_FILE)) return null;
  try {
    return repoConfigToSetupConfig(JSON.parse(fs.readFileSync(REPO_CONFIG_FILE, 'utf8')));
  } catch (err) {
    console.warn('Could not parse ai-annotator-config.json', err);
    return null;
  }
}

function mergeMissingConfig(base = {}, fallback = {}) {
  const merged = { ...base };
  ['githubUrl', 'firebaseConfig', 'username', 'userColor'].forEach((key) => {
    if (!merged[key] && fallback[key]) merged[key] = fallback[key];
  });
  return merged;
}

function normalizeConfig(config = {}) {
  return {
    githubUrl: typeof config.githubUrl === 'string' ? config.githubUrl : '',
    firebaseConfig: typeof config.firebaseConfig === 'string' ? safeNormalizeFirebaseConfigText(config.firebaseConfig) : '',
    username: typeof config.username === 'string' && config.username.trim()
      ? config.username.trim()
      : randomReviewerName(),
    userColor: typeof config.userColor === 'string' && /^#[0-9a-f]{6}$/i.test(config.userColor)
      ? config.userColor
      : DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)],
    testingMode: config.testingMode !== false,
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
  let rawConfig = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      rawConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('Could not load setup config:', err);
  }
  const repoConfig = readRepoConfigFile();
  const config = normalizeConfig(repoConfig ? mergeMissingConfig(rawConfig, repoConfig) : rawConfig);
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
    testingMode: currentConfig.testingMode,
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
expressApp.use(express.json({ limit: '1mb' }));

function normalizeTestIdentity(identity = {}) {
  const username = typeof identity.username === 'string' ? identity.username.trim() : '';
  if (!username) return null;
  return {
    username,
    userColor: typeof identity.userColor === 'string' && /^#[0-9a-f]{6}$/i.test(identity.userColor)
      ? identity.userColor
      : '#2563eb',
    assignedAt: typeof identity.assignedAt === 'string' && identity.assignedAt
      ? identity.assignedAt
      : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeTestingWindowIdentities(value = {}) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  Object.entries(value).forEach(([windowId, identity]) => {
    const normalized = normalizeTestIdentity(identity);
    if (normalized) out[String(windowId)] = normalized;
  });
  return out;
}

function readTestingWindowIdentities() {
  if (!fs.existsSync(TEST_IDENTITIES_FILE)) return {};
  try {
    return normalizeTestingWindowIdentities(JSON.parse(fs.readFileSync(TEST_IDENTITIES_FILE, 'utf8')));
  } catch (err) {
    console.warn('Could not parse testing-window-identities.json', err);
    return {};
  }
}

function writeTestingWindowIdentities(identities) {
  const normalized = normalizeTestingWindowIdentities(identities);
  fs.mkdirSync(path.dirname(TEST_IDENTITIES_FILE), { recursive: true });
  fs.writeFileSync(TEST_IDENTITIES_FILE, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function setTestingWindowIdentity(windowId, identity) {
  const id = Number(windowId);
  if (!Number.isInteger(id)) throw new Error('Window id is required.');
  const normalized = normalizeTestIdentity(identity);
  if (!normalized) throw new Error('Display name is required.');
  const identities = readTestingWindowIdentities();
  identities[String(id)] = normalized;
  writeTestingWindowIdentities(identities);
  sendLog(`Assigned testing window ${id} to ${normalized.username}.`);
  return normalized;
}

function clearTestingWindowIdentity(windowId) {
  const id = Number(windowId);
  if (!Number.isInteger(id)) throw new Error('Window id is required.');
  const identities = readTestingWindowIdentities();
  if (identities[String(id)]) {
    delete identities[String(id)];
    writeTestingWindowIdentities(identities);
    sendLog(`Cleared testing identity for window ${id}.`);
  }
}

function safeParseFirebaseConfig(value) {
  try {
    const parsed = parseLenientJsonObject(value);
    if (!parsed) return { configured: false };
    const completed = completeFirebaseConfig(parsed);
    return {
      configured: true,
      projectId: completed.projectId || '',
      databaseURL: completed.databaseURL || '',
      authDomain: completed.authDomain || '',
      appIdSuffix: completed.appId ? String(completed.appId).slice(-8) : '',
      hasApiKey: !!completed.apiKey,
    };
  } catch (err) {
    return {
      configured: !!String(value || '').trim(),
      error: err.message,
    };
  }
}

function appendExtensionDebugEvent(raw = {}) {
  const event = {
    at: new Date().toISOString(),
    scope: typeof raw.scope === 'string' && raw.scope ? raw.scope : 'extension',
    message: typeof raw.message === 'string' && raw.message ? raw.message : 'debug event',
    level: typeof raw.level === 'string' && raw.level ? raw.level : 'info',
    details: raw.details && typeof raw.details === 'object' ? raw.details : {},
  };
  extensionDebugEvents.push(event);
  if (extensionDebugEvents.length > EXTENSION_DEBUG_EVENT_LIMIT) {
    extensionDebugEvents = extensionDebugEvents.slice(-EXTENSION_DEBUG_EVENT_LIMIT);
  }
  sendLog(`[Extension:${event.level}] ${event.scope} - ${event.message}`);
  return event;
}

function desktopDiagnostics() {
  const repoConfigExists = fs.existsSync(REPO_CONFIG_FILE);
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    setupPort: SETUP_PORT,
    configPath: CONFIG_FILE,
    repoDir: REPO_DIR,
    repoConfigPath: REPO_CONFIG_FILE,
    repoConfigExists,
    repoWorkspaceExists: hasGitRepo(),
    repoProcess: repoProcess ? { pid: repoProcess.pid } : null,
    currentConfig: {
      githubUrl: currentConfig.githubUrl,
      username: currentConfig.username,
      userColor: currentConfig.userColor,
      testingMode: currentConfig.testingMode,
      localServerPort: currentConfig.localServerPort,
      firebase: safeParseFirebaseConfig(currentConfig.firebaseConfig),
      repoStatus: currentConfig.repoStatus,
    },
    testingWindowIdentities: readTestingWindowIdentities(),
    extensionDebugEvents: extensionDebugEvents.slice(-80),
  };
}

expressApp.get('/api/config', (req, res) => {
  res.json(publicConfig());
});

expressApp.get('/api/testing-identities', (req, res) => {
  res.json({
    ok: true,
    source: 'desktop-app',
    identities: readTestingWindowIdentities(),
    checkedAt: new Date().toISOString(),
  });
});

expressApp.put('/api/testing-identities/:windowId', (req, res) => {
  try {
    const identity = setTestingWindowIdentity(req.params.windowId, req.body || {});
    res.json({ ok: true, source: 'desktop-app', identity });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

expressApp.delete('/api/testing-identities/:windowId', (req, res) => {
  try {
    clearTestingWindowIdentity(req.params.windowId);
    res.json({ ok: true, source: 'desktop-app' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

expressApp.post('/api/debug-events', (req, res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [req.body || {}];
    const accepted = events.map(appendExtensionDebugEvent);
    res.json({ ok: true, accepted: accepted.length });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

expressApp.get('/api/diagnostics', (req, res) => {
  res.json(desktopDiagnostics());
});

expressApp.get('/api/site-version', (req, res) => {
  res.json({
    githubUrl: currentConfig.githubUrl,
    localServerPort: currentConfig.localServerPort,
    ...currentConfig.repoStatus,
  });
});

function startSetupServer() {
  setupServer = expressApp.listen(SETUP_PORT, () => {
    console.log(`Extension setup server running on port ${SETUP_PORT}`);
  });

  setupServer.on('error', (error) => {
    const message = error.code === 'EADDRINUSE'
      ? `The desktop setup server could not start because port ${SETUP_PORT} is already in use. Close the other desktop app instance or free that port, then run npm start again.`
      : `The desktop setup server could not start: ${error.message}`;

    console.error(message);
    sendLog(message);
    app.whenReady().then(() => {
      dialog.showErrorBox('Desktop App Startup Failed', message);
      app.quit();
    });
  });
}

startSetupServer();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 720,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
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
  if (setupServer) setupServer.close();
  if (repoProcess) treeKill(repoProcess.pid, 'SIGKILL');
});

ipcMain.handle('get-config', async () => publicConfig());
ipcMain.handle('get-diagnostics', async () => desktopDiagnostics());

ipcMain.handle('setup-github-repo', async (event, githubUrl) => {
  const nextGithubUrl = typeof githubUrl === 'string' ? githubUrl.trim() : '';
  if (!nextGithubUrl) throw new Error('GitHub repository is required.');
  if (!parseGithubRepo(nextGithubUrl)) {
    throw new Error('Enter a valid GitHub repository URL, such as https://github.com/username/repo.');
  }

  const previousConfig = {
    ...currentConfig,
    repoStatus: { ...(currentConfig.repoStatus || {}) },
  };

  try {
    currentConfig.githubUrl = nextGithubUrl;
    currentConfig.localServerPort = null;
    sendLog('Checking repository setup...');
    const git = await ensureRepo(nextGithubUrl);
    await applyRepoConfigFile();
    await updateRepoStatus(git, { checkedAt: new Date().toISOString() });
    if (currentConfig.firebaseConfig) {
      sendLog('Using Firebase config from ai-annotator-config.json.');
    } else {
      sendLog('No Firebase config found in ai-annotator-config.json. You can add one from the setup menu.');
    }
    return publicConfig();
  } catch (error) {
    currentConfig = normalizeConfig({
      ...previousConfig,
      repoStatus: {
        ...(previousConfig.repoStatus || {}),
        error: error.message,
        checkedAt: new Date().toISOString(),
      },
    });
    broadcastConfig();
    console.error(error);
    throw error;
  }
});

ipcMain.handle('start-repo', async (event, setup) => {
  currentConfig.githubUrl = typeof setup.githubUrl === 'string' ? setup.githubUrl.trim() : currentConfig.githubUrl;
  if (typeof setup.firebaseConfig === 'string') {
    currentConfig.firebaseConfig = normalizeFirebaseConfigText(setup.firebaseConfig);
  }
  currentConfig.username = typeof setup.username === 'string' && setup.username.trim()
    ? setup.username.trim()
    : currentConfig.username || randomReviewerName();
  currentConfig.userColor = typeof setup.userColor === 'string' && /^#[0-9a-f]{6}$/i.test(setup.userColor)
    ? setup.userColor
    : currentConfig.userColor;
  if (typeof setup.testingMode === 'boolean') {
    currentConfig.testingMode = setup.testingMode;
  }
  broadcastConfig();

  if (setup.saveOnly) {
    if (await repoWorkspaceMatchesGithubUrl()) {
      await applyRepoConfigFile();
      await writeRepoConfigFile();
    } else if (currentConfig.githubUrl) {
      sendLog('Setup saved. The repository config file will be written after you start this repository.');
    }
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
    await writeRepoConfigFile();
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

async function repoWorkspaceMatchesGithubUrl() {
  if (!hasGitRepo() || !currentConfig.githubUrl) return false;
  const git = simpleGit(REPO_DIR);
  const origin = await git.remote(['get-url', 'origin']).catch(() => '');
  return sameGithubRepo(origin, currentConfig.githubUrl);
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
  const fileConfig = readRepoConfigFile();
  if (!fileConfig) {
    if (fs.existsSync(REPO_CONFIG_FILE)) sendLog('Could not parse ai-annotator-config.json.');
    return;
  }
  currentConfig = normalizeConfig(mergeMissingConfig(currentConfig, fileConfig));
  broadcastConfig();
}

async function writeRepoConfigFile() {
  if (!fs.existsSync(REPO_DIR)) return false;
  let existing = {};
  const existed = fs.existsSync(REPO_CONFIG_FILE);
  if (existed) {
    try {
      existing = JSON.parse(fs.readFileSync(REPO_CONFIG_FILE, 'utf8'));
    } catch (err) {
      existing = {};
      sendLog('Replacing unreadable ai-annotator-config.json with the current setup.');
      console.warn('Could not parse ai-annotator-config.json', err);
    }
  }

  const repoConfig = {
    ...existing,
    githubUrl: currentConfig.githubUrl,
    firebaseConfig: firebaseConfigForRepoFile(currentConfig.firebaseConfig),
    username: currentConfig.username,
    userColor: currentConfig.userColor,
  };

  if (!repoConfig.firebaseConfig) delete repoConfig.firebaseConfig;
  if (!repoConfig.githubUrl) delete repoConfig.githubUrl;
  if (!repoConfig.username) delete repoConfig.username;
  if (!repoConfig.userColor) delete repoConfig.userColor;

  try {
    fs.mkdirSync(REPO_DIR, { recursive: true });
    fs.writeFileSync(REPO_CONFIG_FILE, `${JSON.stringify(repoConfig, null, 2)}\n`);
    sendLog(`${existed ? 'Updated' : 'Created'} ai-annotator-config.json.`);
    return true;
  } catch (err) {
    sendLog('Could not write ai-annotator-config.json.');
    console.warn('Could not write ai-annotator-config.json', err);
    throw err;
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

function chromeLaunchAttempts(url) {
  const chromeArgs = ['--new-window', url];

  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(app.getPath('home'), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ];
    const installedChrome = candidates
      .filter(candidate => fs.existsSync(candidate))
      .map(command => ({ command, args: chromeArgs }));

    return [
      ...installedChrome,
      { command: 'open', args: ['-a', 'Google Chrome', '--args', ...chromeArgs], waitForExit: true },
    ];
  }

  if (process.platform === 'win32') {
    const candidates = [
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    const installedChrome = candidates
      .filter(candidate => candidate && fs.existsSync(candidate))
      .map(command => ({ command, args: chromeArgs }));
    return [
      ...installedChrome,
      { command: 'chrome.exe', args: chromeArgs },
    ];
  }

  return [
    { command: 'google-chrome', args: chromeArgs },
    { command: 'google-chrome-stable', args: chromeArgs },
    { command: 'chromium', args: chromeArgs },
    { command: 'chromium-browser', args: chromeArgs },
  ];
}

function launchDetached(command, args, { waitForExit = false } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const proc = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    const settle = ok => {
      if (settled) return;
      settled = true;
      if (ok) proc.unref();
      resolve(ok);
    };

    proc.once('error', () => settle(false));

    if (waitForExit) {
      proc.once('close', code => settle(code === 0));
      setTimeout(() => settle(true), 2000);
    } else {
      proc.once('spawn', () => settle(true));
    }
  });
}

async function openWebsiteInChromeWindow(url) {
  for (const attempt of chromeLaunchAttempts(url)) {
    if (await launchDetached(attempt.command, attempt.args, { waitForExit: attempt.waitForExit })) {
      sendLog('Opened website in a new Chrome window.');
      return true;
    }
  }

  sendLog('Could not launch Chrome directly. Opening website with the system browser instead.');
  try {
    await shell.openExternal(url);
  } catch (err) {
    sendLog(`Could not open website automatically: ${err.message}`);
  }
  return false;
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
    await runCommand(PYTHON_BIN, ['-m', 'pip', 'install', '-r', 'requirements.txt'], REPO_DIR, 'pip install');
    sendLog('Starting Python static server on port 8000...');
    repoProcess = spawn(PYTHON_BIN, ['-m', 'http.server', '8000'], { cwd: REPO_DIR, shell: true });
    currentConfig.localServerPort = 8000;
    broadcastConfig();
    if (openBrowser) setTimeout(() => openWebsiteInChromeWindow('http://localhost:8000'), 1200);
    return;
  }

  if (fs.existsSync(path.join(REPO_DIR, 'index.html'))) {
    sendLog('Starting static server on port 8000...');
    repoProcess = spawn(PYTHON_BIN, ['-m', 'http.server', '8000'], { cwd: REPO_DIR, shell: true });
    currentConfig.localServerPort = 8000;
    broadcastConfig();
    if (openBrowser) setTimeout(() => openWebsiteInChromeWindow('http://localhost:8000'), 1200);
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
      if (openBrowser) setTimeout(() => openWebsiteInChromeWindow(`http://localhost:${port}`), 1000);
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
      if (openBrowser) openWebsiteInChromeWindow(`http://localhost:${fallbackPort}`);
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
