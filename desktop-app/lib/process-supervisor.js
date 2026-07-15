'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const { ProcessEnvironmentResolver } = require('./process-environment');

const DEFAULT_READINESS_TIMEOUT_MS = 45_000;
const DEFAULT_READINESS_INTERVAL_MS = 200;
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_500;
const DEFAULT_FORCE_KILL_WAIT_MS = 1_000;
const DEFAULT_MAX_LOG_ENTRIES = 500;
const DEFAULT_COMMAND_STABILITY_MS = 500;
const DEFAULT_ATTACHMENT_TIMEOUT_MS = 30_000;

const MIME_TYPES = Object.freeze({
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
});

const SENSITIVE_STATIC_EXTENSIONS = new Set([
  '.env',
  '.jks',
  '.kdbx',
  '.key',
  '.keystore',
  '.ovpn',
  '.p12',
  '.p8',
  '.pem',
  '.pfx',
  '.ppk',
  '.tfstate',
  '.tfvars',
]);

const SENSITIVE_STATIC_FILENAMES = new Set([
  'application_default_credentials.json',
  'auth.json',
  'client-secret.json',
  'client_secret.json',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'private-key.json',
  'private_key.json',
  'secret.json',
  'secrets.json',
  'service-account-key.json',
  'service-account.json',
  'serviceaccountkey.json',
  'wp-config.php',
]);

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function errorMessage(value) {
  if (value == null) return null;
  return value instanceof Error ? value.message : String(value);
}

function makeAbortError() {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function isPathWithin(parentDirectory, candidatePath) {
  const relative = path.relative(path.resolve(parentDirectory), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveServiceDirectory(sourcePath, workingDirectory = '.') {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    throw new TypeError('project.sourcePath must be a non-empty path');
  }

  const root = path.resolve(sourcePath);
  const directory = path.resolve(root, workingDirectory || '.');
  if (!isPathWithin(root, directory)) {
    throw new Error(`Service working directory must stay within the project source path: ${workingDirectory}`);
  }
  return directory;
}

function interpolatePort(template, port) {
  if (template == null || template === '') return null;
  return String(template).replace(/\{\{\s*port\s*\}\}/gi, String(port));
}

function normalizeLoopbackUrl(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === '0.0.0.0') {
    parsed.hostname = '127.0.0.1';
  } else if (hostname === '[::]' || hostname === '::') {
    parsed.hostname = '[::1]';
  }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)) return null;
  return parsed.toString();
}

function stripAnsi(value) {
  // Covers CSI color/control sequences commonly printed by development servers.
  return String(value).replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, '');
}

function extractHttpUrl(output) {
  const clean = stripAnsi(output);
  const matches = clean.match(/https?:\/\/[^\s'"<>]+/gi);
  if (!matches) return null;

  for (const match of matches) {
    const candidate = match.replace(/[),.;!?]+$/g, '');
    const normalized = normalizeLoopbackUrl(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(makeAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(makeAbortError());
    };
    function cleanup() {
      signal?.removeEventListener('abort', onAbort);
    }
    function done() {
      cleanup();
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function probeHttpUrl(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(makeAbortError());

  const normalizedUrl = normalizeLoopbackUrl(url);
  if (!normalizedUrl) return Promise.reject(new Error('Readiness checks only support loopback HTTP URLs'));
  const parsed = new URL(normalizedUrl);

  const transport = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
  if (!transport) return Promise.reject(new Error(`Unsupported readiness URL protocol: ${parsed.protocol}`));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, ready) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(ready);
    };
    const onAbort = () => request.destroy(makeAbortError());
    const request = transport.request(parsed, {
      method: 'GET',
      headers: { Connection: 'close', 'User-Agent': 'AI-Dev-Annotator-Readiness' },
      rejectUnauthorized: parsed.protocol !== 'https:' ? undefined : false,
    }, (response) => {
      const ready = response.statusCode >= 100 && response.statusCode < 500;
      response.resume();
      response.once('end', () => finish(null, ready));
      response.once('error', (error) => finish(error));
    });

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Readiness request timed out after ${timeoutMs}ms`)));
    request.once('error', (error) => finish(error));
    signal?.addEventListener('abort', onAbort, { once: true });
    request.end();
  });
}

async function waitForHttpReady(getUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const signal = options.signal;
  const isExited = options.isExited || (() => false);
  const describeExit = options.describeExit || (() => 'Process exited before becoming ready');
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw makeAbortError();
    if (isExited()) throw new Error(describeExit());

    const candidate = typeof getUrl === 'function' ? getUrl() : getUrl;
    if (candidate) {
      try {
        const remaining = Math.max(1, deadline - Date.now());
        const ready = await probeHttpUrl(candidate, {
          timeoutMs: Math.min(probeTimeoutMs, remaining),
          signal,
        });
        if (ready) return candidate;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        lastError = error;
      }
    }

    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())), signal);
  }

  const suffix = lastError ? ` (${lastError.message})` : '';
  throw new Error(`Service did not become HTTP-ready within ${timeoutMs}ms${suffix}`);
}

function allocateFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Unable to allocate a local port'));
        else resolve(port);
      });
    });
  });
}

function safeRequestPath(rootDirectory, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relativePath = decoded.replace(/^[/\\]+/, '');
  const candidate = path.resolve(rootDirectory, relativePath || '.');
  return isPathWithin(rootDirectory, candidate) ? candidate : null;
}

function isSensitiveStaticPath(rootDirectory, candidatePath) {
  const relative = path.relative(path.resolve(rootDirectory), path.resolve(candidatePath));
  if (!relative) return false;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return true;
  }

  const segments = relative.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) return true;

  const fileName = (segments.at(-1) || '').toLowerCase();
  if (SENSITIVE_STATIC_FILENAMES.has(fileName)) return true;
  if (SENSITIVE_STATIC_EXTENSIONS.has(path.extname(fileName))) return true;
  return /^(?:client[-_]?secrets?|service[-_]?account(?:[-_]?key)?)[-_.].*\.json$/i.test(fileName);
}

async function createStaticFileServer(rootDirectory) {
  const root = await fsp.realpath(rootDirectory);
  const rootStats = await fsp.stat(root);
  if (!rootStats.isDirectory()) throw new Error(`Static service path is not a directory: ${rootDirectory}`);

  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('Allow', 'GET, HEAD');
      response.end('Method Not Allowed');
      return;
    }

    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      let filePath = safeRequestPath(root, requestUrl.pathname);
      if (!filePath || isSensitiveStaticPath(root, filePath)) {
        response.statusCode = 403;
        response.end('Forbidden');
        return;
      }

      let stats = await fsp.stat(filePath);
      if (stats.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        stats = await fsp.stat(filePath);
      }
      const realFilePath = await fsp.realpath(filePath);
      if (
        !isPathWithin(root, realFilePath) ||
        isSensitiveStaticPath(root, realFilePath) ||
        !stats.isFile()
      ) {
        response.statusCode = 403;
        response.end('Forbidden');
        return;
      }

      response.statusCode = 200;
      response.setHeader('Content-Type', MIME_TYPES[path.extname(realFilePath).toLowerCase()] || 'application/octet-stream');
      response.setHeader('Content-Length', stats.size);
      if (request.method === 'HEAD') {
        response.end();
        return;
      }

      const stream = fs.createReadStream(realFilePath);
      stream.once('error', () => {
        if (!response.headersSent) response.statusCode = 500;
        response.end();
      });
      stream.pipe(response);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        response.statusCode = 404;
        response.end('Not Found');
      } else {
        response.statusCode = 500;
        response.end('Internal Server Error');
      }
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  return { server, sockets, rootDirectory: root };
}

function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('Static server did not expose a TCP address'));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function closeStaticServer(resource) {
  if (!resource?.server) return Promise.resolve();
  const { server, sockets } = resource;
  if (!server.listening) {
    for (const socket of sockets || []) socket.destroy();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(finish);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    for (const socket of sockets || []) socket.destroy();
    const timer = setTimeout(finish, 1_000);
    timer.unref?.();
  });
}

function childHasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (didExit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(didExit);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

function runTaskkill(pid, force) {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    let process;
    try {
      process = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    } catch {
      resolve();
      return;
    }
    process.once('error', () => resolve());
    process.once('exit', () => resolve());
  });
}

function signalPosixProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code === 'ESRCH' && !childHasExited(child)) {
      try {
        child.kill(signal);
      } catch (childError) {
        if (childError?.code !== 'ESRCH') throw childError;
      }
    } else if (error?.code !== 'ESRCH') {
      throw error;
    }
  }
}

function isPosixProcessGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForPosixProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPosixProcessGroupAlive(processGroupId)) return true;
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return !isPosixProcessGroupAlive(processGroupId);
}

async function terminateProcessTree(child, options = {}) {
  if (!child?.pid) return;
  const graceMs = options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const forceWaitMs = options.forceWaitMs ?? DEFAULT_FORCE_KILL_WAIT_MS;

  if (process.platform === 'win32') {
    await runTaskkill(child.pid, false);
    if (await waitForChildExit(child, graceMs)) return;
    await runTaskkill(child.pid, true);
    await waitForChildExit(child, forceWaitMs);
    return;
  }

  signalPosixProcessGroup(child, 'SIGTERM');
  if (await waitForPosixProcessGroupExit(child.pid, graceMs)) return;
  signalPosixProcessGroup(child, 'SIGKILL');
  await waitForPosixProcessGroupExit(child.pid, forceWaitMs);
}

function serializeService(service) {
  return {
    id: service.id,
    name: service.name,
    type: service.type,
    primary: service.primary,
    state: service.state,
    status: service.state,
    command: service.command,
    cwd: service.cwd,
    pid: service.pid,
    port: service.port,
    url: service.url,
    timestamps: { ...service.timestamps },
    exitCode: service.exitCode,
    signal: service.signal,
    error: service.error,
  };
}

function serializeRuntime(runtime) {
  if (!runtime) return null;
  return {
    projectId: runtime.projectId,
    projectName: runtime.project.name || runtime.projectId,
    sessionId: runtime.sessionId,
    state: runtime.state,
    status: runtime.state,
    url: runtime.url,
    timestamps: { ...runtime.timestamps },
    stopReason: runtime.stopReason,
    error: runtime.error,
    tabIds: Array.from(runtime.tabIds),
    awaitingTab: runtime.state === 'running'
      && runtime.project.autoStopOnTabClose === true
      && runtime.tabIds.size === 0,
    attachmentDeadlineAt: runtime.attachmentDeadlineAt,
    services: runtime.services.map(serializeService),
  };
}

function createStoppedRuntime(projectId) {
  return {
    projectId: String(projectId),
    projectName: String(projectId),
    sessionId: null,
    state: 'stopped',
    status: 'stopped',
    url: null,
    timestamps: {
      createdAt: null,
      startingAt: null,
      runningAt: null,
      stoppingAt: null,
      stoppedAt: null,
      updatedAt: null,
    },
    stopReason: null,
    error: null,
    tabIds: [],
    awaitingTab: false,
    attachmentDeadlineAt: null,
    services: [],
  };
}

class ProcessSupervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.runtimes = new Map();
    this.sessions = new Map();
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.readinessIntervalMs = options.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.forceKillWaitMs = options.forceKillWaitMs ?? DEFAULT_FORCE_KILL_WAIT_MS;
    this.maxLogEntries = Math.max(1, options.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES);
    this.commandStabilityMs = options.commandStabilityMs ?? DEFAULT_COMMAND_STABILITY_MS;
    this.attachmentTimeoutMs = options.attachmentTimeoutMs ?? DEFAULT_ATTACHMENT_TIMEOUT_MS;
    this.now = options.now || Date.now;
    this.environmentResolver = options.environmentResolver
      || new ProcessEnvironmentResolver(options.processEnvironmentOptions);
  }

  getRuntime(projectId) {
    const normalizedProjectId = String(projectId);
    return serializeRuntime(this.runtimes.get(normalizedProjectId)) || createStoppedRuntime(normalizedProjectId);
  }

  listRuntimes() {
    return Array.from(this.runtimes.values(), serializeRuntime);
  }

  getBySession(sessionId) {
    return serializeRuntime(this.sessions.get(String(sessionId)));
  }

  getLogs(projectId) {
    const runtime = this.runtimes.get(String(projectId));
    return runtime ? runtime.logs.map((entry) => ({ ...entry })) : [];
  }

  startProject(project) {
    this._validateProject(project);
    const projectId = String(project.id);
    const existing = this.runtimes.get(projectId);

    if (existing?.state === 'starting') return existing.startPromise;
    if (existing?.state === 'running') return Promise.resolve(serializeRuntime(existing));
    if (existing?.state === 'stopping') {
      return existing.stopPromise.then(() => this.startProject(project));
    }

    if (existing) this.sessions.delete(existing.sessionId);
    const runtime = this._createRuntime(project);
    this.runtimes.set(projectId, runtime);
    this.sessions.set(runtime.sessionId, runtime);
    this._emitChange(runtime);
    runtime.startPromise = this._startRuntime(runtime);
    return runtime.startPromise;
  }

  stopProject(projectId, reason = 'manual') {
    const runtime = this.runtimes.get(String(projectId));
    if (!runtime) return Promise.resolve(null);
    if (runtime.state === 'stopped' || runtime.state === 'error') {
      return Promise.resolve(serializeRuntime(runtime));
    }
    if (runtime.stopPromise) return runtime.stopPromise;
    return this._stopRuntime(runtime, reason, { finalState: 'stopped' });
  }

  stopAll(reason = 'app-quit') {
    return Promise.all(Array.from(this.runtimes.values(), (runtime) => this.stopProject(runtime.projectId, reason)));
  }

  attachTab(sessionId, tabId) {
    const runtime = this.sessions.get(String(sessionId));
    if (!runtime || !['starting', 'running'].includes(runtime.state) || tabId == null) return null;
    this._clearAttachmentDeadline(runtime);
    runtime.tabIds.add(tabId);
    return this._emitChange(runtime);
  }

  async handleTabClosed(sessionId, tabId) {
    const runtime = this.sessions.get(String(sessionId));
    if (!runtime || !runtime.tabIds.has(tabId)) return runtime ? serializeRuntime(runtime) : null;
    runtime.tabIds.delete(tabId);
    this._emitChange(runtime);
    if (runtime.project.autoStopOnTabClose === true && runtime.tabIds.size === 0) {
      return this.stopProject(runtime.projectId, 'tab-closed');
    }
    return serializeRuntime(runtime);
  }

  _validateProject(project) {
    if (!project || (typeof project.id !== 'string' && typeof project.id !== 'number') || String(project.id).trim() === '') {
      throw new TypeError('project.id must be a non-empty string or number');
    }
    if (typeof project.sourcePath !== 'string' || project.sourcePath.trim() === '') {
      throw new TypeError('project.sourcePath must be a non-empty path');
    }
    if (project.services != null && !Array.isArray(project.services)) {
      throw new TypeError('project.services must be an array');
    }
  }

  _createRuntime(project) {
    const services = project.services?.length ? project.services : [{ id: 'static', name: 'Website', type: 'static', primary: true }];
    const timestamp = this._timestamp();
    const runtime = {
      projectId: String(project.id),
      project: { ...project, services: services.map((service) => ({ ...service })) },
      sessionId: crypto.randomUUID(),
      state: 'starting',
      url: null,
      timestamps: {
        createdAt: timestamp,
        startingAt: timestamp,
        runningAt: null,
        stoppingAt: null,
        stoppedAt: null,
        updatedAt: timestamp,
      },
      stopReason: null,
      error: null,
      tabIds: new Set(),
      logs: [],
      services: [],
      abortController: new AbortController(),
      startPromise: null,
      stopPromise: null,
      failurePromise: null,
      attachmentTimer: null,
      attachmentDeadlineAt: null,
    };

    runtime.services = services.map((service, index) => ({
      config: { ...service },
      id: String(service.id || `service-${index + 1}`),
      name: service.name || `Service ${index + 1}`,
      type: service.type === 'command' || service.command ? 'command' : 'static',
      primary: service.primary === true || (!services.some((item) => item.primary === true) && index === 0),
      state: 'starting',
      command: service.command || null,
      cwd: null,
      pid: null,
      port: null,
      url: null,
      timestamps: {
        createdAt: timestamp,
        startingAt: timestamp,
        runningAt: null,
        stoppingAt: null,
        stoppedAt: null,
        updatedAt: timestamp,
      },
      exitCode: null,
      signal: null,
      error: null,
      child: null,
      staticResource: null,
      expectedExit: false,
      exited: false,
      spawnError: null,
      logBuffers: { stdout: '', stderr: '' },
    }));
    return runtime;
  }

  async _startRuntime(runtime) {
    try {
      await Promise.all(runtime.services.map((service) => this._startService(runtime, service)));
      if (runtime.state !== 'starting') {
        if (runtime.stopPromise) await runtime.stopPromise;
        return serializeRuntime(runtime);
      }
      const failed = runtime.services.find((service) => service.state !== 'running');
      if (failed) throw new Error(`${failed.name} stopped before the project finished starting`);

      runtime.state = 'running';
      runtime.timestamps.runningAt = this._timestamp();
      runtime.url = runtime.services.find((service) => service.primary)?.url || runtime.services.find((service) => service.url)?.url || null;
      this._appendLog(runtime, null, 'system', `Project ready${runtime.url ? ` at ${runtime.url}` : ''}`);
      this._scheduleAttachmentDeadline(runtime);
      return this._emitChange(runtime);
    } catch (value) {
      const error = asError(value);
      if (runtime.state === 'stopping' || runtime.state === 'stopped') {
        if (runtime.stopPromise) await runtime.stopPromise;
        return serializeRuntime(runtime);
      }

      runtime.error = error.message;
      this._appendLog(runtime, null, 'system', `Startup failed: ${error.message}`);
      await this._stopRuntime(runtime, 'start-failed', { finalState: 'error', error });
      error.runtime = serializeRuntime(runtime);
      throw error;
    }
  }

  _startService(runtime, service) {
    return service.type === 'command'
      ? this._startCommandService(runtime, service)
      : this._startStaticService(runtime, service);
  }

  async _startStaticService(runtime, service) {
    service.cwd = resolveServiceDirectory(runtime.project.sourcePath, service.config.workingDirectory);
    service.staticResource = await createStaticFileServer(service.cwd);
    if (runtime.abortController.signal.aborted) {
      await closeStaticServer(service.staticResource);
      throw makeAbortError();
    }

    service.port = await listenOnLoopback(service.staticResource.server);
    service.url = normalizeLoopbackUrl(interpolatePort(service.config.url, service.port)) || `http://127.0.0.1:${service.port}/`;
    this._selectRuntimeUrl(runtime, service);
    this._appendLog(runtime, service, 'system', `Serving ${service.cwd} at ${service.url}`);
    this._emitChange(runtime);

    await waitForHttpReady(() => service.url, {
      timeoutMs: this.readinessTimeoutMs,
      intervalMs: this.readinessIntervalMs,
      probeTimeoutMs: this.probeTimeoutMs,
      signal: runtime.abortController.signal,
    });

    service.state = 'running';
    service.timestamps.runningAt = this._timestamp();
    this._emitChange(runtime);
  }

  async _startCommandService(runtime, service) {
    if (!service.command || typeof service.command !== 'string') {
      throw new Error(`Command service ${service.name} is missing a command`);
    }
    service.cwd = resolveServiceDirectory(runtime.project.sourcePath, service.config.workingDirectory);
    const stats = await fsp.stat(service.cwd);
    if (!stats.isDirectory()) throw new Error(`Service working directory is not a directory: ${service.cwd}`);

    service.port = await allocateFreePort();
    if (runtime.abortController.signal.aborted) throw makeAbortError();
    const hasConfiguredUrl = typeof service.config.url === 'string' && service.config.url.trim() !== '';
    if (hasConfiguredUrl) {
      service.url = normalizeLoopbackUrl(interpolatePort(service.config.url, service.port));
      if (!service.url) throw new Error(`Command service ${service.name} has an invalid HTTP URL`);
    } else {
      service.url = service.primary ? `http://127.0.0.1:${service.port}/` : null;
    }
    this._selectRuntimeUrl(runtime, service);

    const serviceEnvironment = service.config.env && typeof service.config.env === 'object'
      ? service.config.env
      : {};
    const environment = await this.environmentResolver.resolve(serviceEnvironment);
    if (runtime.abortController.signal.aborted) throw makeAbortError();
    environment.HOST = '127.0.0.1';
    environment.PORT = String(service.port);
    const child = spawn(service.command, {
      cwd: service.cwd,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    service.child = child;
    service.pid = child.pid || null;
    this._wireCommandService(runtime, service);
    this._appendLog(runtime, service, 'system', `Started command on reserved port ${service.port}: ${service.command}`);
    this._emitChange(runtime);

    if (!service.primary && !hasConfiguredUrl) {
      await delay(this.commandStabilityMs, runtime.abortController.signal);
      if (service.exited || service.spawnError) {
        throw service.spawnError || new Error(`${service.name} exited before becoming ready`);
      }
      service.state = 'running';
      service.timestamps.runningAt = this._timestamp();
      this._appendLog(runtime, service, 'system', 'Process remained active through its startup check');
      this._emitChange(runtime);
      return;
    }

    await waitForHttpReady(() => service.url, {
      timeoutMs: this.readinessTimeoutMs,
      intervalMs: this.readinessIntervalMs,
      probeTimeoutMs: this.probeTimeoutMs,
      signal: runtime.abortController.signal,
      isExited: () => service.exited || Boolean(service.spawnError),
      describeExit: () => service.spawnError?.message || `${service.name} exited with code ${service.exitCode ?? 'unknown'}${service.signal ? ` (${service.signal})` : ''}`,
    });

    if (service.exited || service.spawnError) {
      throw service.spawnError || new Error(`${service.name} exited before becoming ready`);
    }
    service.state = 'running';
    service.timestamps.runningAt = this._timestamp();
    this._appendLog(runtime, service, 'system', `HTTP readiness check passed at ${service.url}`);
    this._emitChange(runtime);
  }

  _wireCommandService(runtime, service) {
    service.child.stdout?.on('data', (chunk) => this._consumeCommandOutput(runtime, service, 'stdout', chunk));
    service.child.stderr?.on('data', (chunk) => this._consumeCommandOutput(runtime, service, 'stderr', chunk));
    service.child.once('error', (error) => {
      service.spawnError = error;
      service.error = error.message;
      service.state = 'error';
      this._appendLog(runtime, service, 'stderr', error.message);
      this._emitChange(runtime);
      if (runtime.state === 'running') void this._handleUnexpectedExit(runtime, service, error);
    });
    service.child.once('exit', (code, signal) => {
      service.exited = true;
      service.exitCode = code;
      service.signal = signal;
      this._flushCommandOutput(runtime, service);

      if (service.expectedExit || runtime.state === 'stopping' || runtime.state === 'stopped') {
        if (service.state !== 'error') service.state = 'stopped';
        return;
      }

      const error = new Error(`${service.name} exited unexpectedly with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`);
      service.error = error.message;
      service.state = 'error';
      service.timestamps.stoppedAt = this._timestamp();
      this._appendLog(runtime, service, 'stderr', error.message);
      this._emitChange(runtime);
      if (runtime.state === 'running') void this._handleUnexpectedExit(runtime, service, error);
    });
  }

  _consumeCommandOutput(runtime, service, stream, chunk) {
    const text = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (!service.config.url && service.primary) {
      const parsedUrl = extractHttpUrl(`${service.logBuffers[stream]}${text}`);
      if (parsedUrl && parsedUrl !== service.url) {
        service.url = parsedUrl;
        this._selectRuntimeUrl(runtime, service);
        this._emitChange(runtime);
      }
    }

    const combined = `${service.logBuffers[stream]}${text}`;
    const lines = combined.split(/\r?\n/);
    service.logBuffers[stream] = lines.pop() || '';
    for (const line of lines) {
      if (line !== '') this._appendLog(runtime, service, stream, line);
    }
    if (service.logBuffers[stream].length > 8_192) {
      this._appendLog(runtime, service, stream, service.logBuffers[stream]);
      service.logBuffers[stream] = '';
    }
  }

  _flushCommandOutput(runtime, service) {
    for (const stream of ['stdout', 'stderr']) {
      const line = service.logBuffers[stream];
      if (line) this._appendLog(runtime, service, stream, line);
      service.logBuffers[stream] = '';
    }
  }

  async _handleUnexpectedExit(runtime, service, error) {
    if (runtime.failurePromise || runtime.state !== 'running') return runtime.failurePromise;
    runtime.error = errorMessage(error);
    runtime.failurePromise = this._stopRuntime(runtime, 'service-exit', {
      finalState: 'error',
      error,
      failedService: service,
    });
    return runtime.failurePromise;
  }

  _stopRuntime(runtime, reason, options = {}) {
    if (runtime.stopPromise) return runtime.stopPromise;
    const finalState = options.finalState || 'stopped';
    const failureMessage = errorMessage(options.error);
    runtime.stopReason = reason;
    runtime.state = 'stopping';
    runtime.timestamps.stoppingAt = this._timestamp();
    runtime.abortController.abort();
    this._clearAttachmentDeadline(runtime);
    this._appendLog(runtime, null, 'system', `Stopping project (${reason})`);
    this._emitChange(runtime);

    runtime.stopPromise = (async () => {
      const results = await Promise.allSettled(runtime.services.map((service) => this._stopService(runtime, service, options.failedService)));
      const cleanupError = results.find((result) => result.status === 'rejected');
      if (cleanupError && !failureMessage) runtime.error = errorMessage(cleanupError.reason);
      else if (failureMessage) runtime.error = failureMessage;

      runtime.state = finalState === 'error' || cleanupError ? 'error' : 'stopped';
      runtime.timestamps.stoppedAt = this._timestamp();
      this._appendLog(runtime, null, 'system', runtime.state === 'error' ? `Project stopped with error: ${runtime.error}` : 'Project stopped');
      return this._emitChange(runtime);
    })();
    return runtime.stopPromise;
  }

  async _stopService(runtime, service, failedService) {
    if (service.state === 'stopped') return;
    const preserveError = service === failedService || service.state === 'error';
    service.timestamps.stoppingAt = this._timestamp();
    if (!preserveError) service.state = 'stopping';
    service.expectedExit = true;

    if (service.staticResource) {
      await closeStaticServer(service.staticResource);
    }
    if (service.child) {
      await terminateProcessTree(service.child, {
        graceMs: this.shutdownGraceMs,
        forceWaitMs: this.forceKillWaitMs,
      });
    }

    service.timestamps.stoppedAt = this._timestamp();
    service.state = preserveError ? 'error' : 'stopped';
    this._appendLog(runtime, service, 'system', preserveError ? 'Service failed' : 'Service stopped');
  }

  _selectRuntimeUrl(runtime, service) {
    if (service.url && (service.primary || !runtime.url)) runtime.url = service.url;
  }

  _scheduleAttachmentDeadline(runtime) {
    if (runtime.project.autoStopOnTabClose !== true || this.attachmentTimeoutMs <= 0) return;
    this._clearAttachmentDeadline(runtime);
    runtime.attachmentDeadlineAt = new Date(Date.now() + this.attachmentTimeoutMs).toISOString();
    runtime.attachmentTimer = setTimeout(() => {
      runtime.attachmentTimer = null;
      runtime.attachmentDeadlineAt = null;
      if (runtime.state !== 'running' || runtime.tabIds.size > 0) return;
      this._appendLog(runtime, null, 'system', 'No extension test tab attached before the safety deadline');
      void this.stopProject(runtime.projectId, 'tab-not-attached');
    }, this.attachmentTimeoutMs);
    runtime.attachmentTimer.unref?.();
  }

  _clearAttachmentDeadline(runtime) {
    if (runtime.attachmentTimer) clearTimeout(runtime.attachmentTimer);
    runtime.attachmentTimer = null;
    runtime.attachmentDeadlineAt = null;
  }

  _appendLog(runtime, service, stream, message) {
    const text = String(message).trimEnd();
    if (!text) return;
    const entry = {
      timestamp: this._timestamp(),
      projectId: runtime.projectId,
      sessionId: runtime.sessionId,
      serviceId: service?.id || null,
      serviceName: service?.name || null,
      stream,
      message: text,
    };
    runtime.logs.push(entry);
    if (runtime.logs.length > this.maxLogEntries) {
      runtime.logs.splice(0, runtime.logs.length - this.maxLogEntries);
    }
    this.emit('log', { ...entry });
  }

  _emitChange(runtime) {
    runtime.timestamps.updatedAt = this._timestamp();
    for (const service of runtime.services) service.timestamps.updatedAt = runtime.timestamps.updatedAt;
    const serialized = serializeRuntime(runtime);
    this.emit('change', serialized);
    return serialized;
  }

  _timestamp() {
    const value = this.now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }
}

module.exports = ProcessSupervisor;
module.exports.ProcessSupervisor = ProcessSupervisor;
module.exports.allocateFreePort = allocateFreePort;
module.exports.createStaticFileServer = createStaticFileServer;
module.exports.createStoppedRuntime = createStoppedRuntime;
module.exports.extractHttpUrl = extractHttpUrl;
module.exports.interpolatePort = interpolatePort;
module.exports.isSensitiveStaticPath = isSensitiveStaticPath;
module.exports.isPosixProcessGroupAlive = isPosixProcessGroupAlive;
module.exports.isPathWithin = isPathWithin;
module.exports.normalizeLoopbackUrl = normalizeLoopbackUrl;
module.exports.probeHttpUrl = probeHttpUrl;
module.exports.resolveServiceDirectory = resolveServiceDirectory;
module.exports.safeRequestPath = safeRequestPath;
module.exports.serializeRuntime = serializeRuntime;
module.exports.terminateProcessTree = terminateProcessTree;
module.exports.waitForHttpReady = waitForHttpReady;
module.exports.waitForPosixProcessGroupExit = waitForPosixProcessGroupExit;
