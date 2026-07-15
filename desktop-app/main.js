const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { createApiServer } = require('./lib/api-server');
const { ProcessSupervisor } = require('./lib/process-supervisor');
const { ProjectStore } = require('./lib/project-store');

const DASHBOARD_HOST = '127.0.0.1';
const DASHBOARD_PORT = 11454;

let apiServer;
let allowWindowClose = false;
let closeIntent = null;
let closeRequestTimer;
let dashboardToken;
let dashboardUrl;
let mainWindow;
let projectStore;
let shutdownComplete = false;
let shutdownPromise;
let supervisor;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusDashboardWindow);
  app.whenReady().then(startApplication).catch(handleStartupFailure);
}

async function startApplication() {
  app.setName('AI Annotator Home');
  dashboardToken = crypto.randomBytes(32).toString('hex');

  const statePath = path.join(app.getPath('userData'), 'dashboard-state.json');
  projectStore = new ProjectStore(statePath);
  projectStore.load();
  supervisor = new ProcessSupervisor();

  apiServer = createApiServer({
    dashboardToken,
    extensionToken: projectStore.getExtensionToken(),
    host: DASHBOARD_HOST,
    openSession: openTestSession,
    port: DASHBOARD_PORT,
    projectStore,
    supervisor,
    uiDirectory: path.join(__dirname, 'ui'),
  });
  const address = await apiServer.start();
  dashboardUrl = address.url;

  registerIpcHandlers();
  createDashboardWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createDashboardWindow();
    else focusDashboardWindow();
  });
}

function createDashboardWindow() {
  allowWindowClose = false;
  mainWindow = new BrowserWindow({
    backgroundColor: '#f4f1ea',
    height: 820,
    icon: path.join(__dirname, 'build', 'icon.png'),
    minHeight: 650,
    minWidth: 920,
    show: false,
    title: 'AI Annotator Home',
    width: 1220,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isDashboardUrl(url)) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (allowWindowClose || shutdownComplete) return;
    event.preventDefault();
    requestRendererClose('window');
  });
  mainWindow.on('closed', () => {
    allowWindowClose = false;
    mainWindow = null;
  });
  mainWindow.loadURL(dashboardUrl);
}

function registerIpcHandlers() {
  ipcMain.handle('dashboard:get-token', (event) => {
    assertTrustedIpcSender(event);
    return dashboardToken;
  });

  ipcMain.handle('dashboard:choose-folder', async (event) => {
    assertTrustedIpcSender(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a website project folder',
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.on('dashboard:close-prepared', (event, result) => {
    assertTrustedIpcSender(event);
    if (!closeIntent) return;
    const intent = closeIntent;
    closeIntent = null;
    clearTimeout(closeRequestTimer);
    if (result?.ready !== true) {
      focusDashboardWindow();
      return;
    }
    if (intent === 'quit') {
      beginShutdown();
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    allowWindowClose = true;
    mainWindow.close();
  });

}

function assertTrustedIpcSender(event) {
  const senderUrl = event.senderFrame && event.senderFrame.url;
  if (!senderUrl || !isDashboardUrl(senderUrl)) throw new Error('Untrusted dashboard request.');
}

function isDashboardUrl(urlValue) {
  try {
    return new URL(urlValue).origin === dashboardUrl;
  } catch (_error) {
    return false;
  }
}

function isSafeExternalUrl(urlValue) {
  try {
    const protocol = new URL(urlValue).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch (_error) {
    return false;
  }
}

function focusDashboardWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function openTestSession(runtime) {
  const sessionId = encodeURIComponent(runtime.sessionId);
  const ticket = encodeURIComponent(apiServer.createLaunchTicket(runtime.sessionId));
  const launchUrl = `${dashboardUrl}/launch/${sessionId}?ticket=${ticket}`;
  const openedInChrome = await openInChrome(launchUrl);
  if (!openedInChrome) await shell.openExternal(launchUrl);
}

async function openInChrome(url) {
  const attempts = chromeLaunchAttempts(url);
  for (const attempt of attempts) {
    if (await launchDetached(attempt.command, attempt.args)) return true;
  }
  return false;
}

function chromeLaunchAttempts(url) {
  const chromeArgs = ['--new-window', url];
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(app.getPath('home'), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ]
      .filter((candidate) => fs.existsSync(candidate))
      .map((command) => ({ args: chromeArgs, command }));
  }

  if (process.platform === 'win32') {
    const candidates = [
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return candidates
      .filter((candidate) => candidate && fs.existsSync(candidate))
      .map((command) => ({ args: chromeArgs, command }));
  }

  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map((command) => ({
    args: chromeArgs,
    command,
  }));
}

function launchDetached(command, args) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, {
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
    const finish = (success) => {
      if (settled) return;
      settled = true;
      if (success) child.unref();
      resolve(success);
    };
    child.once('error', () => finish(false));
    child.once('spawn', () => finish(true));
    setTimeout(() => finish(false), 2500).unref();
  });
}

function handleStartupFailure(error) {
  const message = error && error.code === 'EADDRINUSE'
    ? `AI Annotator Home could not start because local port ${DASHBOARD_PORT} is already in use. Close the other app using that port and try again.`
    : `AI Annotator Home could not start: ${error.message}`;
  dialog.showErrorBox('AI Annotator Home', message);
  app.quit();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownPromise) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    requestRendererClose('quit');
    return;
  }
  beginShutdown();
});

function requestRendererClose(intent) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (intent === 'quit') beginShutdown();
    return;
  }
  if (closeIntent) {
    if (intent === 'quit') closeIntent = 'quit';
    return;
  }
  closeIntent = intent;
  mainWindow.webContents.send('dashboard:prepare-close');
  clearTimeout(closeRequestTimer);
  closeRequestTimer = setTimeout(() => {
    if (!closeIntent) return;
    closeIntent = null;
    focusDashboardWindow();
    mainWindow.webContents.send('dashboard:close-cancelled');
    void dialog.showMessageBox(mainWindow, {
      buttons: ['Keep editing'],
      message: 'AI Annotator Home could not confirm that your project changes were saved.',
      detail: 'The window stayed open. Save your changes and try again.',
      type: 'warning',
    });
  }, 15_000);
  closeRequestTimer.unref?.();
}

function beginShutdown() {
  if (shutdownPromise) return shutdownPromise;
  clearTimeout(closeRequestTimer);
  closeIntent = null;
  shutdownPromise = shutdownApplication().finally(() => {
    shutdownComplete = true;
    app.exit(0);
  });
  return shutdownPromise;
}

async function shutdownApplication() {
  if (supervisor) await supervisor.stopAll('app-quit');
  if (apiServer) await apiServer.stop();
}

process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
