const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const simpleGit = require('simple-git');
const fs = require('fs');
const { spawn } = require('child_process');
const treeKill = require('tree-kill');

let mainWindow;
let currentConfig = {
  githubUrl: '',
  firebaseConfig: '',
  localServerPort: null
};
let repoProcess = null;

// Start Express server ONLY for GET /api/config for the Chrome Extension
const expressApp = express();
// Restrict CORS to chrome extensions (or open for GET only)
expressApp.use(cors({
  origin: '*' // Since it's only GETting config, this is safe from RCE. We removed the POST endpoint.
}));

expressApp.get('/api/config', (req, res) => {
  res.json(currentConfig);
});

expressApp.listen(11454, () => {
  console.log('Extension config server running on port 11454');
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
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
  if (repoProcess) {
    treeKill(repoProcess.pid, 'SIGKILL');
  }
});

const REPO_DIR = path.join(app.getPath('userData'), 'repo_workspace');

ipcMain.handle('start-repo', async (event, { githubUrl, firebaseConfig }) => {
  if (githubUrl) {
    currentConfig.githubUrl = githubUrl;
  }
  if (firebaseConfig) {
    currentConfig.firebaseConfig = firebaseConfig;
  }

  try {
    if (repoProcess) {
      treeKill(repoProcess.pid, 'SIGKILL');
      repoProcess = null;
    }

    if (!githubUrl) {
      event.sender.send('log', 'No GitHub URL provided. Saved config successfully!');
      return { success: true };
    }

    if (fs.existsSync(REPO_DIR)) {
      fs.rmSync(REPO_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(REPO_DIR, { recursive: true });

    const git = simpleGit(REPO_DIR);
    console.log(`Cloning ${githubUrl} into ${REPO_DIR}...`);
    await git.clone(githubUrl, '.');

    // Check for config file
    const configPath = path.join(REPO_DIR, 'ai-annotator-config.json');
    if (fs.existsSync(configPath)) {
      try {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (fileConfig.firebaseConfig) {
           currentConfig.firebaseConfig = typeof fileConfig.firebaseConfig === 'object' ?
                                          JSON.stringify(fileConfig.firebaseConfig) :
                                          fileConfig.firebaseConfig;
        }
        if (fileConfig.githubUrl) {
            currentConfig.githubUrl = fileConfig.githubUrl;
        }
      } catch(e) {
        console.warn('Could not parse ai-annotator-config.json', e);
      }
    }

    // Try to run the project
    if (fs.existsSync(path.join(REPO_DIR, 'package.json'))) {
      const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));

      event.sender.send('log', 'Installing dependencies (this may take a few minutes)...');

      // Use system npm. If the user doesn't have it, we notify them in the UI.
      await new Promise((resolve, reject) => {
        const installProc = spawn('npm', ['install'], { cwd: REPO_DIR, shell: true });
        installProc.on('close', code => {
          if (code === 0) resolve(); else reject(new Error('npm install failed. Ensure Node.js is installed.'));
        });
      });

      event.sender.send('log', 'Starting server...');
      let scriptToRun = 'start';
      if (packageJson.scripts) {
        if (packageJson.scripts.dev) scriptToRun = 'dev';
        else if (packageJson.scripts.start) scriptToRun = 'start';
      }

      repoProcess = spawn('npm', ['run', scriptToRun], { cwd: REPO_DIR, shell: true });

      let portFound = false;
      repoProcess.stdout.on('data', (data) => {
        const output = data.toString();
        // Look for common port patterns
        const portMatch = output.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i) || output.match(/port\s+(\d+)/i);
        if (portMatch && !portFound) {
           portFound = true;
           const port = parseInt(portMatch[1]);
           currentConfig.localServerPort = port;
           event.sender.send('log', `Detected local server on port ${port}. Opening browser...`);

           setTimeout(() => {
              shell.openExternal(`http://localhost:${port}`);
           }, 2000);
        }
      });

      setTimeout(() => {
         if (!portFound) {
            event.sender.send('log', 'Could not automatically detect port. Guessing port 3000...');
            currentConfig.localServerPort = 3000;
            shell.openExternal(`http://localhost:3000`);
         }
      }, 8000);

    } else if (fs.existsSync(path.join(REPO_DIR, 'requirements.txt'))) {
      event.sender.send('log', 'Python requirements.txt found. Starting server...');
      await new Promise((resolve) => {
        const installProc = spawn('pip3', ['install', '-r', 'requirements.txt'], { cwd: REPO_DIR, shell: true });
        installProc.on('close', () => resolve());
      });
      repoProcess = spawn('python3', ['-m', 'http.server', '8000'], { cwd: REPO_DIR, shell: true });
      setTimeout(() => shell.openExternal(`http://localhost:8000`), 2000);
    } else {
      event.sender.send('log', 'Looking for static files...');
      if (fs.existsSync(path.join(REPO_DIR, 'index.html'))) {
          event.sender.send('log', 'index.html found, trying to open it directly.');
          repoProcess = spawn('python3', ['-m', 'http.server', '8000'], { cwd: REPO_DIR, shell: true });
          setTimeout(() => shell.openExternal(`http://localhost:8000`), 2000);
      } else {
        throw new Error('Could not determine how to run the repository.');
      }
    }

    return { success: true };
  } catch (error) {
    console.error(error);
    throw error;
  }
});
