const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { detectProjectPlan } = require('./project-detector');

const MAX_BODY_BYTES = 1024 * 1024;
const EXTENSION_CHALLENGE_CONTEXT = 'ai-dev-annotator-desktop-v1:';
const LAUNCH_TICKET_TTL_MS = 90_000;
const MAX_LAUNCH_TICKETS = 128;
const DEFAULT_EXTENSION_LEASE_TIMEOUT_MS = 150_000;
const DEFAULT_EXTENSION_LEASE_CHECK_MS = 15_000;
const DEFAULT_EXTENSION_RESUME_GRACE_MS = 75_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const STATIC_CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function createApiServer(options) {
  const {
    dashboardToken,
    extensionLeaseCheckMs = DEFAULT_EXTENSION_LEASE_CHECK_MS,
    extensionLeaseTimeoutMs = DEFAULT_EXTENSION_LEASE_TIMEOUT_MS,
    extensionResumeGraceMs = DEFAULT_EXTENSION_RESUME_GRACE_MS,
    extensionToken,
    host = '127.0.0.1',
    openSession,
    port = 11454,
    projectStore,
    supervisor,
    uiDirectory,
  } = options;

  const eventClients = new Set();
  const launchTickets = new Map();
  const storedAnnotationSync = projectStore.getAnnotationSnapshotStatus();
  const extensionState = {
    annotationSync: storedAnnotationSync,
    connected: false,
    extensionId: '',
    lastSeen: '',
    version: '',
  };

  function publish(payload) {
    const message = `data: ${JSON.stringify(payload)}\n\n`;
    for (const response of eventClients) {
      try {
        response.write(message);
      } catch (_error) {
        eventClients.delete(response);
      }
    }
  }

  function pruneLaunchTickets() {
    const now = Date.now();
    for (const [ticket, entry] of launchTickets) {
      if (entry.expiresAt <= now) launchTickets.delete(ticket);
    }
    while (launchTickets.size >= MAX_LAUNCH_TICKETS) {
      launchTickets.delete(launchTickets.keys().next().value);
    }
  }

  function createLaunchTicket(sessionId) {
    const runtime = supervisor.getBySession(sessionId);
    if (!runtime || runtime.status !== 'running') {
      throw new Error('A launch ticket requires a running test session.');
    }
    pruneLaunchTickets();
    const ticket = crypto.randomBytes(32).toString('hex');
    launchTickets.set(ticket, {
      expiresAt: Date.now() + LAUNCH_TICKET_TTL_MS,
      sessionId: String(sessionId),
    });
    return ticket;
  }

  function getLaunchTicket(ticket, sessionId, consume = false) {
    pruneLaunchTickets();
    const entry = launchTickets.get(String(ticket));
    if (!entry || entry.sessionId !== String(sessionId) || entry.expiresAt <= Date.now()) return null;
    if (consume) launchTickets.delete(String(ticket));
    return entry;
  }

  supervisor.on('change', (runtime) => {
    publish({ type: 'runtime', projectId: runtime.projectId, runtime });
  });
  supervisor.on('log', (entry) => {
    publish({ type: 'log', projectId: entry.projectId, entry });
  });

  const server = http.createServer(async (request, response) => {
    setSecurityHeaders(response);

    try {
      if (!isAllowedHost(request.headers.host, port)) {
        sendJson(response, 403, { error: 'Invalid local host.' });
        return;
      }

      const requestUrl = new URL(request.url || '/', `http://${host}:${port}`);
      if (await serveStaticRoute(request, response, requestUrl, uiDirectory)) return;
      if (await serveLaunchRoute(request, response, requestUrl, supervisor, getLaunchTicket)) return;
      if (serveExtensionChallenge(request, response, requestUrl, extensionToken)) return;
      if (await serveExtensionPair(request, response, requestUrl, {
        extensionState,
        extensionToken,
        getLaunchTicket,
        publish,
        supervisor,
      })) return;

      if (!requestUrl.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }

      if (requestUrl.pathname.startsWith('/api/extension/')) {
        if (!isAuthorizedExtensionRequest(request, extensionToken)) {
          sendJson(response, 401, { error: 'Extension bridge authorization failed.' });
          return;
        }
        await handleExtensionRoute({
          extensionState,
          projectStore,
          publish,
          request,
          requestUrl,
          response,
          supervisor,
        });
        return;
      }

      const eventToken = requestUrl.pathname === '/api/events' ? requestUrl.searchParams.get('token') : '';
      if (getBearerToken(request) !== dashboardToken && eventToken !== dashboardToken) {
        sendJson(response, 401, { error: 'Dashboard authorization failed.' });
        return;
      }

      await handleDashboardRoute({
        eventClients,
        extensionState,
        openSession,
        projectStore,
        publish,
        request,
        requestUrl,
        response,
        supervisor,
      });
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      sendJson(response, statusCode, {
        error: statusCode >= 500 ? 'The local dashboard hit an unexpected error.' : error.message,
        detail: statusCode >= 500 ? error.message : undefined,
      });
    }
  });

  const keepAliveTimer = setInterval(() => {
    for (const response of eventClients) {
      try {
        response.write(': keep-alive\n\n');
      } catch (_error) {
        eventClients.delete(response);
      }
    }
  }, 25000);
  keepAliveTimer.unref();

  let lastExtensionLeaseCheck = Date.now();
  let extensionLeaseGraceUntil = 0;
  const extensionLeaseTimer = setInterval(() => {
    const now = Date.now();
    const checkDelay = now - lastExtensionLeaseCheck;
    lastExtensionLeaseCheck = now;
    if (checkDelay > Math.max(extensionLeaseCheckMs * 3, 30_000)) {
      extensionLeaseGraceUntil = now + extensionResumeGraceMs;
      return;
    }
    if (now < extensionLeaseGraceUntil) return;
    const lastSeen = Date.parse(extensionState.lastSeen || '');
    if (!Number.isFinite(lastSeen) || now - lastSeen <= extensionLeaseTimeoutMs) return;
    for (const runtime of supervisor.listRuntimes()) {
      if (runtime.status !== 'running' || runtime.tabIds.length === 0) continue;
      const project = projectStore.getProject(runtime.projectId);
      if (project?.autoStopOnTabClose === true) {
        void supervisor.stopProject(runtime.projectId, 'extension-disconnected');
      }
    }
  }, Math.max(10, extensionLeaseCheckMs));
  extensionLeaseTimer.unref();

  server.on('close', () => {
    clearInterval(keepAliveTimer);
    clearInterval(extensionLeaseTimer);
    for (const response of eventClients) response.end();
    eventClients.clear();
  });

  return {
    createLaunchTicket,
    extensionState,
    publish,
    server,
    start() {
      return new Promise((resolve, reject) => {
        const handleError = (error) => {
          server.off('listening', handleListening);
          reject(error);
        };
        const handleListening = () => {
          server.off('error', handleError);
          resolve({ host, port, url: `http://${host}:${port}` });
        };
        server.once('error', handleError);
        server.once('listening', handleListening);
        server.listen(port, host);
      });
    },
    stop() {
      return new Promise((resolve) => {
        launchTickets.clear();
        clearInterval(keepAliveTimer);
        clearInterval(extensionLeaseTimer);
        if (!server.listening) {
          resolve();
          return;
        }
        for (const response of eventClients) response.end();
        eventClients.clear();
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
  };
}

async function handleDashboardRoute(context) {
  const {
    eventClients,
    extensionState,
    openSession,
    projectStore,
    publish,
    request,
    requestUrl,
    response,
    supervisor,
  } = context;
  const { method = 'GET' } = request;
  const pathname = requestUrl.pathname;

  if (method === 'GET' && pathname === '/api/events') {
    response.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    });
    response.write(': connected\n\n');
    eventClients.add(response);
    request.on('close', () => eventClients.delete(response));
    return;
  }

  if (method === 'GET' && pathname === '/api/bootstrap') {
    sendJson(response, 200, {
      extension: publicExtensionState(extensionState),
      platform: process.platform,
      projects: projectStore.listProjects().map((project) => buildProjectListItem(projectStore, supervisor, project)),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/projects') {
    requireJsonRequest(request);
    const input = await readJsonBody(request);
    const detected = detectProjectPlan(input.sourcePath);
    const project = projectStore.createProject({
      ...input,
      name: input.name || detected.name,
      services: Array.isArray(input.services) && input.services.length ? input.services : detected.services,
    });
    publish({ type: 'projects', action: 'created', projectId: project.id });
    sendJson(response, 201, buildProjectDetail(projectStore, supervisor, project));
    return;
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)(?:\/(start|stop|open))?$/);
  if (!projectMatch) {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }

  const [, projectId, action] = projectMatch;
  const project = projectStore.getProject(projectId);
  if (!project) {
    sendJson(response, 404, { error: 'Project not found.' });
    return;
  }

  if (method === 'GET' && !action) {
    sendJson(response, 200, buildProjectDetail(projectStore, supervisor, project));
    return;
  }

  if (method === 'PATCH' && !action) {
    requireJsonRequest(request);
    const patch = await readJsonBody(request);
    const updatedProject = projectStore.updateProject(projectId, patch);
    publish({ type: 'projects', action: 'updated', projectId });
    sendJson(response, 200, buildProjectDetail(projectStore, supervisor, updatedProject));
    return;
  }

  if (method === 'DELETE' && !action) {
    const runtime = supervisor.getRuntime(projectId);
    if (runtime.status !== 'stopped' && runtime.status !== 'error') {
      throw createHttpError(409, 'Stop this project before deleting it.');
    }
    projectStore.deleteProject(projectId);
    publish({ type: 'projects', action: 'deleted', projectId });
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method !== 'POST' || !action) {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }

  if (action === 'start') {
    if (project.services.some((service) => service.needsConfiguration || (service.type === 'command' && !service.command))) {
      throw createHttpError(409, 'Add a start command in Run plan before launching this project.');
    }
    const runtime = await supervisor.startProject(project);
    if (runtime.status === 'running' && runtime.sessionId && runtime.url) {
      projectStore.recordRuntimeOrigin(projectId, runtime.url);
      try {
        await openSession(runtime);
      } catch (_error) {
        await supervisor.stopProject(projectId, 'browser-launch-failed');
        throw createHttpError(502, 'The website started, but its test tab could not be opened. All services were stopped.');
      }
    }
    sendJson(response, 200, buildProjectDetail(projectStore, supervisor, projectStore.getProject(projectId)));
    return;
  }

  if (action === 'stop') {
    await supervisor.stopProject(projectId, 'manual');
    sendJson(response, 200, buildProjectDetail(projectStore, supervisor, project));
    return;
  }

  if (action === 'open') {
    const runtime = supervisor.getRuntime(projectId);
    if (runtime.status !== 'running' || !runtime.url || !runtime.sessionId) {
      throw createHttpError(409, 'Run the project before opening its test page.');
    }
    await openSession(runtime);
    sendJson(response, 200, { ok: true, runtime });
  }
}

async function handleExtensionRoute(context) {
  const {
    extensionState,
    projectStore,
    publish,
    request,
    requestUrl,
    response,
    supervisor,
  } = context;
  const { method = 'GET' } = request;
  const pathname = requestUrl.pathname;

  markExtensionSeen(extensionState, request);

  if (method === 'GET' && pathname === '/api/extension/sessions') {
    const sessions = supervisor
      .listRuntimes()
      .filter((runtime) => runtime.sessionId && ['starting', 'running'].includes(runtime.status))
      .map((runtime) => ({
        projectId: runtime.projectId,
        sessionId: runtime.sessionId,
        tabIds: runtime.tabIds,
        url: runtime.url,
      }));
    sendJson(response, 200, { sessions });
    return;
  }

  if (method === 'POST' && pathname === '/api/extension/heartbeat') {
    requireJsonRequest(request);
    const payload = await readJsonBody(request);
    extensionState.version = typeof payload.version === 'string' ? payload.version.slice(0, 40) : '';
    publish({ type: 'extension', extension: publicExtensionState(extensionState) });
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === 'POST' && pathname === '/api/extension/annotations') {
    requireJsonRequest(request);
    const payload = await readJsonBody(request);
    projectStore.setAnnotationSnapshot(payload);
    extensionState.annotationSync = projectStore.getAnnotationSnapshotStatus();
    publish({ type: 'annotations', capturedAt: new Date().toISOString() });
    sendJson(response, 200, { ok: true });
    return;
  }

  const sessionMatch = pathname.match(/^\/api\/extension\/sessions\/([a-zA-Z0-9_-]+)\/(attach|closed)$/);
  if (method === 'POST' && sessionMatch) {
    requireJsonRequest(request);
    const payload = await readJsonBody(request);
    const tabId = Number(payload.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) throw createHttpError(400, 'A valid tab id is required.');
    const [, sessionId, action] = sessionMatch;
    const runtime = supervisor.getBySession(sessionId);
    if (!runtime) throw createHttpError(404, 'Run session not found.');
    if (action === 'attach') {
      const attachedRuntime = await supervisor.attachTab(sessionId, tabId);
      sendJson(response, 200, {
        ok: true,
        projectId: attachedRuntime.projectId,
        sessionId,
        url: attachedRuntime.url,
      });
      return;
    }
    await supervisor.handleTabClosed(sessionId, tabId);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: 'Extension bridge route not found.' });
}

function buildProjectListItem(projectStore, supervisor, project) {
  return {
    ...project,
    runtime: supervisor.getRuntime(project.id),
    summary: projectStore.getProjectSummary(project.id),
  };
}

function buildProjectDetail(projectStore, supervisor, project) {
  return {
    annotations: projectStore.getAnnotationsForProject(project.id),
    logs: supervisor.getLogs(project.id),
    project,
    runtime: supervisor.getRuntime(project.id),
    summary: projectStore.getProjectSummary(project.id),
  };
}

async function serveStaticRoute(request, response, requestUrl, uiDirectory) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const staticRoutes = new Map([
    ['/', 'index.html'],
    ['/app.js', 'app.js'],
    ['/pending-changes.js', 'pending-changes.js'],
    ['/styles.css', 'styles.css'],
  ]);
  const fileName = staticRoutes.get(requestUrl.pathname);
  if (!fileName) return false;
  const filePath = path.join(uiDirectory, fileName);
  const content = fs.readFileSync(filePath);
  response.writeHead(200, {
    'Content-Length': content.length,
    'Content-Type': STATIC_CONTENT_TYPES[path.extname(fileName)] || 'application/octet-stream',
  });
  if (request.method === 'HEAD') response.end();
  else response.end(content);
  return true;
}

async function serveLaunchRoute(request, response, requestUrl, supervisor, getLaunchTicket) {
  const match = requestUrl.pathname.match(/^\/launch\/([a-zA-Z0-9_-]+)$/);
  if (!match) return false;
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return true;
  }
  const ticket = requestUrl.searchParams.get('ticket') || '';
  if (!getLaunchTicket(ticket, match[1])) {
    sendHtml(response, 403, launchErrorPage('This test link is no longer valid.'));
    return true;
  }
  const runtime = supervisor.getBySession(match[1]);
  if (!runtime || runtime.status !== 'running' || !runtime.url) {
    sendHtml(response, 404, launchErrorPage('This website is no longer running.'));
    return true;
  }
  const target = escapeHtml(runtime.url);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="0.8;url=${target}">
  <title>Opening test site</title>
</head>
<body>
  <main><h1>Opening your test site…</h1><p>The annotator is connecting this tab to the local run.</p><p><a href="${target}">Continue now</a></p></main>
</body>
</html>`;
  sendHtml(response, 200, html);
  return true;
}

function launchErrorPage(message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test site unavailable</title></head><body><main><h1>Test site unavailable</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function isAuthorizedExtensionRequest(request, extensionToken) {
  if (getBearerToken(request) !== extensionToken) return false;
  const origin = String(request.headers.origin || '');
  return !origin || origin.startsWith('chrome-extension://');
}

function serveExtensionChallenge(request, response, requestUrl, extensionToken) {
  if (requestUrl.pathname !== '/api/extension/challenge') return false;
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return true;
  }
  const origin = String(request.headers.origin || '');
  if (origin && !origin.startsWith('chrome-extension://')) {
    sendJson(response, 403, { error: 'Extension bridge origin rejected.' });
    return true;
  }
  const nonce = requestUrl.searchParams.get('nonce') || '';
  if (!/^[a-f0-9]{64}$/.test(nonce)) {
    sendJson(response, 400, { error: 'A valid challenge nonce is required.' });
    return true;
  }
  const proof = crypto
    .createHmac('sha256', extensionToken)
    .update(`${EXTENSION_CHALLENGE_CONTEXT}${nonce}`)
    .digest('hex');
  sendJson(response, 200, { proof, protocol: 1 });
  return true;
}

async function serveExtensionPair(request, response, requestUrl, options) {
  if (requestUrl.pathname !== '/api/extension/pair') return false;
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return true;
  }
  const origin = String(request.headers.origin || '');
  if (origin && !origin.startsWith('chrome-extension://')) {
    sendJson(response, 403, { error: 'Extension bridge origin rejected.' });
    return true;
  }
  requireJsonRequest(request);
  const payload = await readJsonBody(request);
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
  const ticket = typeof payload.ticket === 'string' ? payload.ticket : '';
  const tabId = Number(payload.tabId);
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId) || !/^[a-f0-9]{64}$/.test(ticket)) {
    throw createHttpError(400, 'A valid launch ticket is required.');
  }
  if (!Number.isInteger(tabId) || tabId < 0) throw createHttpError(400, 'A valid tab id is required.');
  if (!options.getLaunchTicket(ticket, sessionId, true)) {
    throw createHttpError(410, 'This launch ticket has expired or was already used.');
  }
  const runtime = options.supervisor.getBySession(sessionId);
  if (!runtime || runtime.status !== 'running') throw createHttpError(409, 'This test session is no longer running.');
  markExtensionSeen(options.extensionState, request);
  options.publish({ type: 'extension', extension: publicExtensionState(options.extensionState) });
  sendJson(response, 200, {
    ok: true,
    projectId: runtime.projectId,
    sessionId,
    token: options.extensionToken,
    url: runtime.url,
  });
  return true;
}

function markExtensionSeen(extensionState, request) {
  const origin = String(request.headers.origin || '');
  extensionState.connected = true;
  extensionState.lastSeen = new Date().toISOString();
  if (origin.startsWith('chrome-extension://')) extensionState.extensionId = origin.slice('chrome-extension://'.length);
}

function publicExtensionState(extensionState) {
  const lastSeenMs = Date.parse(extensionState.lastSeen || '');
  const connected = Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs < 90000;
  return { ...extensionState, connected };
}

function requireJsonRequest(request) {
  const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim();
  if (contentType !== 'application/json') throw createHttpError(415, 'Use application/json for this request.');
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(createHttpError(413, 'Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_error) {
        reject(createHttpError(400, 'Request body is not valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function isAllowedHost(hostHeader, expectedPort) {
  if (!hostHeader) return false;
  try {
    const parsed = new URL(`http://${hostHeader}`);
    return LOOPBACK_HOSTS.has(parsed.hostname) && Number(parsed.port || 80) === expectedPort;
  } catch (_error) {
    return false;
  }
}

function getBearerToken(request) {
  const authorization = String(request.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

function setSecurityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(response, statusCode, body) {
  if (response.headersSent) return;
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'Content-Length': payload.length,
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(payload);
}

function sendHtml(response, statusCode, html) {
  if (response.headersSent) return;
  const payload = Buffer.from(html);
  response.writeHead(statusCode, {
    'Content-Length': payload.length,
    'Content-Type': 'text/html; charset=utf-8',
  });
  response.end(payload);
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

module.exports = {
  createApiServer,
  createHttpError,
  isAllowedHost,
};
