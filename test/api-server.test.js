'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createApiServer } = require('../desktop-app/lib/api-server');
const { ProcessSupervisor } = require('../desktop-app/lib/process-supervisor');
const { ProjectStore } = require('../desktop-app/lib/project-store');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiann-api-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function requestJson(port, pathname, options = {}) {
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = { ...(options.headers || {}) };
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        resolve({ body: parsed, headers: response.headers, statusCode: response.statusCode });
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error('API test request timed out')));
    request.once('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

function openEventStream(port, token) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      path: `/api/events?token=${encodeURIComponent(token)}`,
      port,
    }, (response) => resolve({ request, response }));
    request.once('error', reject);
  });
}

function createUiFixture(root) {
  const uiDirectory = path.join(root, 'ui');
  fs.mkdirSync(uiDirectory);
  fs.writeFileSync(path.join(uiDirectory, 'index.html'), '<!doctype html><title>Fixture</title>');
  fs.writeFileSync(path.join(uiDirectory, 'app.js'), '');
  fs.writeFileSync(path.join(uiDirectory, 'pending-changes.js'), '');
  fs.writeFileSync(path.join(uiDirectory, 'styles.css'), '');
  return uiDirectory;
}

function createStaticProject(store, sourcePath) {
  return store.createProject({
    id: 'fixture-project',
    name: 'Fixture project',
    sourcePath,
    services: [{
      id: 'website',
      command: '',
      name: 'Website',
      primary: true,
      type: 'static',
      url: '',
      workingDirectory: '.',
    }],
  });
}

test('API rejects untrusted dashboard and extension requests', async (t) => {
  const root = temporaryDirectory(t);
  const port = await reservePort();
  const store = new ProjectStore(path.join(root, 'state.json'));
  const supervisor = new ProcessSupervisor();
  const api = createApiServer({
    dashboardToken: 'dashboard-secret',
    extensionToken: store.getExtensionToken(),
    openSession: async () => {},
    port,
    projectStore: store,
    supervisor,
    uiDirectory: createUiFixture(root),
  });
  await api.start();
  t.after(() => api.stop());

  assert.equal((await requestJson(port, '/pending-changes.js')).statusCode, 200);
  assert.equal((await requestJson(port, '/api/bootstrap')).statusCode, 401);
  assert.equal((await requestJson(port, '/api/bootstrap', {
    headers: { Authorization: 'Bearer dashboard-secret' },
  })).statusCode, 200);
  assert.equal((await requestJson(port, '/api/bootstrap', {
    headers: { Authorization: 'Bearer dashboard-secret', Host: 'untrusted.example' },
  })).statusCode, 403);

  const challengeNonce = 'a'.repeat(64);
  const challenge = await requestJson(port, `/api/extension/challenge?nonce=${challengeNonce}`, {
    headers: { Origin: 'chrome-extension://fixture' },
  });
  const expectedProof = crypto
    .createHmac('sha256', store.getExtensionToken())
    .update(`ai-dev-annotator-desktop-v1:${challengeNonce}`)
    .digest('hex');
  assert.equal(challenge.statusCode, 200);
  assert.equal(challenge.body.protocol, 1);
  assert.equal(challenge.body.proof, expectedProof);
  assert.equal((await requestJson(port, `/api/extension/challenge?nonce=${challengeNonce}`, {
    headers: { Origin: 'https://hostile.example' },
  })).statusCode, 403);

  const heartbeatPath = '/api/extension/heartbeat';
  assert.equal((await requestJson(port, heartbeatPath, {
    body: { version: '1.0.0' },
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-token', Origin: 'chrome-extension://fixture' },
  })).statusCode, 401);
  assert.equal((await requestJson(port, heartbeatPath, {
    body: { version: '1.0.0' },
    method: 'POST',
    headers: { Authorization: `Bearer ${store.getExtensionToken()}`, Origin: 'https://hostile.example' },
  })).statusCode, 401);
  assert.equal((await requestJson(port, heartbeatPath, {
    body: { version: '1.0.0' },
    method: 'POST',
    headers: { Authorization: `Bearer ${store.getExtensionToken()}`, Origin: 'chrome-extension://fixture' },
  })).statusCode, 200);

  const stream = await openEventStream(port, 'dashboard-secret');
  await Promise.race([
    api.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('API shutdown waited on the event stream')), 1_000)),
  ]);
  stream.response.destroy();
  stream.request.destroy();
});

test('start, exact-tab attach, and tab-close stop work end to end', async (t) => {
  const root = temporaryDirectory(t);
  const website = path.join(root, 'website');
  fs.mkdirSync(website);
  fs.writeFileSync(path.join(website, 'index.html'), '<h1>Fixture website</h1>');

  const port = await reservePort();
  const store = new ProjectStore(path.join(root, 'state.json'));
  const project = createStaticProject(store, website);
  const supervisor = new ProcessSupervisor({ readinessTimeoutMs: 3_000 });
  let openedRuntime = null;
  const api = createApiServer({
    dashboardToken: 'dashboard-secret',
    extensionToken: store.getExtensionToken(),
    openSession: async (runtime) => {
      openedRuntime = runtime;
    },
    port,
    projectStore: store,
    supervisor,
    uiDirectory: createUiFixture(root),
  });
  await api.start();
  t.after(async () => {
    await supervisor.stopAll('test-cleanup');
    await api.stop();
  });

  const dashboardHeaders = { Authorization: 'Bearer dashboard-secret' };
  const started = await requestJson(port, `/api/projects/${project.id}/start`, {
    headers: dashboardHeaders,
    method: 'POST',
  });
  assert.equal(started.statusCode, 200);
  assert.equal(started.body.runtime.status, 'running');
  assert.equal(openedRuntime.sessionId, started.body.runtime.sessionId);
  assert.equal(store.getProject(project.id).annotationOrigins.length, 1);

  const sessionPath = `/api/extension/sessions/${openedRuntime.sessionId}`;
  const ticket = api.createLaunchTicket(openedRuntime.sessionId);
  assert.equal((await requestJson(port, `/launch/${openedRuntime.sessionId}?ticket=${ticket}`)).statusCode, 200);
  assert.equal((await requestJson(port, `/launch/${openedRuntime.sessionId}?token=${store.getExtensionToken()}`)).statusCode, 403);
  const pair = await requestJson(port, '/api/extension/pair', {
    body: { sessionId: openedRuntime.sessionId, tabId: 321, ticket },
    headers: { Origin: 'chrome-extension://fixture' },
    method: 'POST',
  });
  assert.equal(pair.statusCode, 200);
  assert.equal(pair.body.token, store.getExtensionToken());
  assert.equal((await requestJson(port, '/api/extension/pair', {
    body: { sessionId: openedRuntime.sessionId, tabId: 322, ticket },
    headers: { Origin: 'chrome-extension://fixture' },
    method: 'POST',
  })).statusCode, 410);

  const extensionHeaders = {
    Authorization: `Bearer ${pair.body.token}`,
    Origin: 'chrome-extension://fixture',
  };
  assert.equal((await requestJson(port, `${sessionPath}/attach`, {
    body: { tabId: 321 },
    headers: extensionHeaders,
    method: 'POST',
  })).statusCode, 200);
  assert.deepEqual(supervisor.getRuntime(project.id).tabIds, [321]);

  assert.equal((await requestJson(port, `${sessionPath}/closed`, {
    body: { tabId: 999 },
    headers: extensionHeaders,
    method: 'POST',
  })).statusCode, 200);
  assert.equal(supervisor.getRuntime(project.id).status, 'running');

  assert.equal((await requestJson(port, `${sessionPath}/closed`, {
    body: { tabId: 321 },
    headers: extensionHeaders,
    method: 'POST',
  })).statusCode, 200);
  assert.equal(supervisor.getRuntime(project.id).status, 'stopped');
  assert.equal(supervisor.getRuntime(project.id).stopReason, 'tab-closed');
});

test('an attached run self-stops when the extension heartbeat disappears', async (t) => {
  const root = temporaryDirectory(t);
  const website = path.join(root, 'website');
  fs.mkdirSync(website);
  fs.writeFileSync(path.join(website, 'index.html'), '<h1>Lease fixture</h1>');
  const port = await reservePort();
  const store = new ProjectStore(path.join(root, 'state.json'));
  const project = createStaticProject(store, website);
  const supervisor = new ProcessSupervisor({ attachmentTimeoutMs: 5_000, readinessTimeoutMs: 3_000 });
  const api = createApiServer({
    dashboardToken: 'dashboard-secret',
    extensionLeaseCheckMs: 10,
    extensionLeaseTimeoutMs: 60,
    extensionToken: store.getExtensionToken(),
    openSession: async () => {},
    port,
    projectStore: store,
    supervisor,
    uiDirectory: createUiFixture(root),
  });
  await api.start();
  t.after(async () => {
    await supervisor.stopAll('test-cleanup');
    await api.stop();
  });

  const extensionHeaders = {
    Authorization: `Bearer ${store.getExtensionToken()}`,
    Origin: 'chrome-extension://fixture',
  };
  assert.equal((await requestJson(port, '/api/extension/heartbeat', {
    body: { version: '1.0.0' },
    headers: extensionHeaders,
    method: 'POST',
  })).statusCode, 200);
  const running = await supervisor.startProject(project);
  supervisor.attachTab(running.sessionId, 777);
  const stopped = await Promise.race([
    new Promise((resolve) => {
      supervisor.on('change', (runtime) => {
        if (runtime.projectId === project.id && runtime.status === 'stopped') resolve(runtime);
      });
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Extension lease did not stop the run')), 1_000)),
  ]);
  assert.equal(stopped.stopReason, 'extension-disconnected');
});
