'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProcessSupervisor,
  extractHttpUrl,
  normalizeLoopbackUrl,
  probeHttpUrl,
} = require('../desktop-app/lib/process-supervisor');

async function makeWebsite(t, body = '<h1>Test website</h1>') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'annotator-supervisor-'));
  await fs.writeFile(path.join(directory, 'index.html'), body, 'utf8');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function staticProject(id, sourcePath, overrides = {}) {
  return {
    id,
    name: `Project ${id}`,
    sourcePath,
    autoStopOnTabClose: true,
    services: [{
      id: 'website',
      name: 'Website',
      type: 'static',
      workingDirectory: '.',
      primary: true,
    }],
    ...overrides,
  };
}

function requestText(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Connection: 'close' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.setTimeout(2_000, () => request.destroy(new Error('Test HTTP request timed out')));
    request.once('error', reject);
  });
}

function assertPortCanBeRebound(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

function createSupervisor(options = {}) {
  return new ProcessSupervisor({
    readinessTimeoutMs: 3_000,
    readinessIntervalMs: 25,
    probeTimeoutMs: 500,
    shutdownGraceMs: 300,
    forceKillWaitMs: 300,
    ...options,
  });
}

function nodeCommand(source) {
  const encodedSource = Buffer.from(source).toString('base64');
  const evaluation = `eval(Buffer.from('${encodedSource}','base64').toString())`;
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(evaluation)}`;
}

test('starts a static service, serves it when ready, stops it, and frees its port', async (t) => {
  const sourcePath = await makeWebsite(t, '<h1>Static fixture</h1>');
  const supervisor = createSupervisor();
  const changes = [];
  const logs = [];
  supervisor.on('change', (runtime) => changes.push(runtime));
  supervisor.on('log', (entry) => logs.push(entry));
  t.after(() => supervisor.stopAll('test-cleanup'));

  const running = await supervisor.startProject(staticProject('static-project', sourcePath));
  assert.equal(running.state, 'running');
  assert.equal(running.services.length, 1);
  assert.equal(running.services[0].state, 'running');
  assert.equal(running.services[0].type, 'static');
  assert.equal(new URL(running.url).hostname, '127.0.0.1');

  const response = await requestText(running.url);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, '<h1>Static fixture</h1>');
  assert.ok(changes.some((runtime) => runtime.state === 'starting'));
  assert.ok(changes.some((runtime) => runtime.state === 'running'));
  assert.ok(logs.some((entry) => entry.message.includes('Serving')));
  assert.ok(supervisor.getLogs('static-project').length > 0);

  const port = running.services[0].port;
  const stopped = await supervisor.stopProject('static-project');
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.stopReason, 'manual');
  assert.equal(stopped.services[0].state, 'stopped');
  await assertPortCanBeRebound(port);
});

test('static services serve normal assets but deny traversal, dot paths, and private keys', async (t) => {
  const sourcePath = await makeWebsite(t, '<script src="/assets/app.js"></script>');
  const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'annotator-outside-'));
  t.after(() => fs.rm(outsideDirectory, { recursive: true, force: true }));
  await fs.mkdir(path.join(sourcePath, 'assets'));
  await fs.mkdir(path.join(sourcePath, '.git'));
  await fs.writeFile(path.join(sourcePath, 'assets', 'app.js'), 'window.fixture = true;', 'utf8');
  await fs.writeFile(path.join(sourcePath, 'assets', 'config.json'), '{"public":true}', 'utf8');
  await fs.writeFile(path.join(sourcePath, '.env'), 'API_SECRET=do-not-serve', 'utf8');
  await fs.writeFile(path.join(sourcePath, '.git', 'config'), 'private repository config', 'utf8');
  await fs.writeFile(path.join(sourcePath, 'production.env'), 'API_SECRET=do-not-serve', 'utf8');
  await fs.writeFile(path.join(sourcePath, 'server.pem'), 'private key fixture', 'utf8');
  await fs.writeFile(path.join(sourcePath, 'client_secret.prod.json'), '{"secret":true}', 'utf8');
  await fs.writeFile(path.join(outsideDirectory, 'outside.txt'), 'outside root', 'utf8');

  const supervisor = createSupervisor();
  t.after(() => supervisor.stopAll('test-cleanup'));
  const running = await supervisor.startProject(staticProject('static-security', sourcePath));

  assert.deepEqual(await requestText(new URL('/assets/app.js', running.url)), {
    statusCode: 200,
    body: 'window.fixture = true;',
  });
  assert.deepEqual(await requestText(new URL('/assets/config.json', running.url)), {
    statusCode: 200,
    body: '{"public":true}',
  });

  for (const pathname of [
    '/.env',
    '/%2eenv',
    '/.git/config',
    '/production.env',
    '/server.pem',
    '/client_secret.prod.json',
    '/%2E%2E%2Foutside.txt',
  ]) {
    const response = await requestText(new URL(pathname, running.url));
    assert.equal(response.statusCode, 403, `${pathname} should be forbidden`);
    assert.equal(response.body, 'Forbidden');
  }
});

test('static services reject escaping and sensitive symlinks while preserving safe in-root links', async (t) => {
  const sourcePath = await makeWebsite(t);
  const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'annotator-symlink-'));
  t.after(() => fs.rm(outsideDirectory, { recursive: true, force: true }));
  await fs.writeFile(path.join(sourcePath, '.env'), 'API_SECRET=do-not-serve', 'utf8');
  await fs.writeFile(path.join(sourcePath, 'public.txt'), 'safe asset', 'utf8');
  await fs.writeFile(path.join(outsideDirectory, 'outside.txt'), 'outside root', 'utf8');

  try {
    await fs.symlink(path.join(outsideDirectory, 'outside.txt'), path.join(sourcePath, 'outside-link.txt'));
    await fs.symlink(path.join(sourcePath, '.env'), path.join(sourcePath, 'renamed-secret.txt'));
    await fs.symlink(path.join(sourcePath, 'public.txt'), path.join(sourcePath, 'safe-link.txt'));
  } catch (error) {
    if (['EACCES', 'ENOSYS', 'EPERM'].includes(error?.code)) {
      t.skip(`This platform cannot create test symlinks: ${error.code}`);
      return;
    }
    throw error;
  }

  const supervisor = createSupervisor();
  t.after(() => supervisor.stopAll('test-cleanup'));
  const running = await supervisor.startProject(staticProject('static-symlinks', sourcePath));

  assert.equal((await requestText(new URL('/outside-link.txt', running.url))).statusCode, 403);
  assert.equal((await requestText(new URL('/renamed-secret.txt', running.url))).statusCode, 403);
  assert.deepEqual(await requestText(new URL('/safe-link.txt', running.url)), {
    statusCode: 200,
    body: 'safe asset',
  });
});

test('only an exact attached tab closure auto-stops its project', async (t) => {
  const sourcePath = await makeWebsite(t);
  const supervisor = createSupervisor();
  t.after(() => supervisor.stopAll('test-cleanup'));

  const running = await supervisor.startProject(staticProject('tabs', sourcePath));
  supervisor.attachTab(running.sessionId, 42);
  const attached = supervisor.attachTab(running.sessionId, 43);
  assert.deepEqual(attached.tabIds, [42, 43]);

  const afterUnrelatedTab = await supervisor.handleTabClosed(running.sessionId, 99);
  assert.equal(afterUnrelatedTab.state, 'running');
  assert.deepEqual(afterUnrelatedTab.tabIds, [42, 43]);
  assert.equal(await supervisor.handleTabClosed('unrelated-session', 42), null);
  assert.equal(supervisor.getRuntime('tabs').state, 'running');

  const afterFirstTestTab = await supervisor.handleTabClosed(running.sessionId, 42);
  assert.equal(afterFirstTestTab.state, 'running');
  assert.deepEqual(afterFirstTestTab.tabIds, [43]);
  const stopped = await supervisor.handleTabClosed(running.sessionId, 43);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.stopReason, 'tab-closed');
  assert.deepEqual(stopped.tabIds, []);
});

test('a run self-stops when no extension test tab attaches', async (t) => {
  const sourcePath = await makeWebsite(t);
  const supervisor = createSupervisor({ attachmentTimeoutMs: 40 });
  t.after(() => supervisor.stopAll('test-cleanup'));
  const stoppedPromise = new Promise((resolve) => {
    supervisor.on('change', (runtime) => {
      if (runtime.projectId === 'unattached' && runtime.status === 'stopped') resolve(runtime);
    });
  });

  const running = await supervisor.startProject(staticProject('unattached', sourcePath));
  assert.equal(running.awaitingTab, true);
  assert.ok(Number.isFinite(Date.parse(running.attachmentDeadlineAt)));
  const stopped = await Promise.race([
    stoppedPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Unattached run did not stop')), 1_000)),
  ]);
  assert.equal(stopped.stopReason, 'tab-not-attached');
});

test('double start and double stop calls are idempotent and serialized', async (t) => {
  const sourcePath = await makeWebsite(t);
  const supervisor = createSupervisor();
  t.after(() => supervisor.stopAll('test-cleanup'));
  const project = staticProject('idempotent', sourcePath);

  const firstStart = supervisor.startProject(project);
  const secondStart = supervisor.startProject(project);
  assert.strictEqual(secondStart, firstStart);
  const [firstRuntime, secondRuntime] = await Promise.all([firstStart, secondStart]);
  assert.equal(firstRuntime.sessionId, secondRuntime.sessionId);
  assert.equal(firstRuntime.services[0].port, secondRuntime.services[0].port);

  const firstStop = supervisor.stopProject(project.id);
  const secondStop = supervisor.stopProject(project.id);
  assert.strictEqual(secondStop, firstStop);
  const [firstStopped, secondStopped] = await Promise.all([firstStop, secondStop]);
  assert.equal(firstStopped.state, 'stopped');
  assert.equal(secondStopped.sessionId, firstStopped.sessionId);
  assert.equal((await supervisor.stopProject(project.id)).state, 'stopped');
});

test('projects run and stop in isolation', async (t) => {
  const sourceA = await makeWebsite(t, 'website-a');
  const sourceB = await makeWebsite(t, 'website-b');
  const supervisor = createSupervisor();
  t.after(() => supervisor.stopAll('test-cleanup'));

  const [runtimeA, runtimeB] = await Promise.all([
    supervisor.startProject(staticProject('project-a', sourceA)),
    supervisor.startProject(staticProject('project-b', sourceB)),
  ]);
  assert.notEqual(runtimeA.sessionId, runtimeB.sessionId);
  assert.notEqual(runtimeA.services[0].port, runtimeB.services[0].port);
  assert.equal(supervisor.listRuntimes().length, 2);
  assert.equal(supervisor.getBySession(runtimeB.sessionId).projectId, 'project-b');

  await supervisor.stopProject('project-a', 'isolation-test');
  assert.equal(supervisor.getRuntime('project-a').state, 'stopped');
  assert.equal(supervisor.getRuntime('project-b').state, 'running');
  const responseB = await requestText(runtimeB.url);
  assert.equal(responseB.statusCode, 200);
  assert.equal(responseB.body, 'website-b');

  const stopped = await supervisor.stopAll('test-finished');
  assert.equal(stopped.length, 2);
  assert.equal(supervisor.getRuntime('project-b').state, 'stopped');
  assert.equal(supervisor.getRuntime('project-b').stopReason, 'test-finished');
});

test('a secondary command without a URL is treated as a worker, not an HTTP service', async (t) => {
  const sourcePath = await makeWebsite(t);
  const supervisor = createSupervisor({ commandStabilityMs: 50 });
  t.after(() => supervisor.stopAll('test-cleanup'));
  const project = staticProject('with-worker', sourcePath, {
    services: [
      {
        id: 'website',
        name: 'Website',
        type: 'static',
        workingDirectory: '.',
        primary: true,
      },
      {
        id: 'watcher',
        name: 'Watcher',
        type: 'command',
        command: nodeCommand('setInterval(function keepRunning() {}, 1000);'),
        workingDirectory: '.',
        url: '',
        primary: false,
      },
    ],
  });

  const running = await supervisor.startProject(project);
  const worker = running.services.find((service) => service.id === 'watcher');
  assert.equal(running.state, 'running');
  assert.equal(worker.state, 'running');
  assert.equal(worker.url, null);
  assert.ok(Number.isInteger(worker.port));
  assert.ok(Number.isInteger(worker.pid));

  const stopped = await supervisor.stopProject(project.id);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.services.find((service) => service.id === 'watcher').state, 'stopped');
});

test('command services use the resolved desktop environment', async (t) => {
  const sourcePath = await makeWebsite(t);
  let receivedOverrides = null;
  const environmentResolver = {
    async resolve(overrides) {
      receivedOverrides = { ...overrides };
      return {
        ...process.env,
        ...overrides,
        ANNOTATOR_RESOLVED_ENV: 'ready',
      };
    },
  };
  const supervisor = createSupervisor({ commandStabilityMs: 50, environmentResolver });
  t.after(() => supervisor.stopAll('test-cleanup'));
  const project = staticProject('resolved-environment', sourcePath, {
    services: [
      {
        id: 'website',
        name: 'Website',
        type: 'static',
        workingDirectory: '.',
        primary: true,
      },
      {
        id: 'worker',
        name: 'Worker',
        type: 'command',
        command: nodeCommand("process.stdout.write(process.env.ANNOTATOR_RESOLVED_ENV + ':' + process.env.PROJECT_SETTING + '\\n'); setInterval(function keepRunning() {}, 1000);"),
        workingDirectory: '.',
        url: '',
        primary: false,
        env: { PROJECT_SETTING: 'from-project' },
      },
    ],
  });

  const running = await supervisor.startProject(project);
  assert.equal(running.state, 'running');
  assert.deepEqual(receivedOverrides, { PROJECT_SETTING: 'from-project' });
  assert.ok(supervisor.getLogs(project.id).some((entry) => entry.message === 'ready:from-project'));
});

test('an unknown project has a safe stopped runtime', () => {
  const supervisor = createSupervisor();
  const runtime = supervisor.getRuntime('not-started');
  assert.equal(runtime.projectId, 'not-started');
  assert.equal(runtime.state, 'stopped');
  assert.equal(runtime.status, 'stopped');
  assert.equal(runtime.sessionId, null);
  assert.deepEqual(runtime.services, []);
});

test('service URL discovery and readiness only accept local test servers', async () => {
  assert.equal(normalizeLoopbackUrl('https://docs.example.com/start'), null);
  assert.equal(normalizeLoopbackUrl('http://192.168.1.50:3000/'), null);
  assert.equal(normalizeLoopbackUrl('http://localhost:3000/path'), 'http://localhost:3000/path');
  assert.equal(normalizeLoopbackUrl('http://[::1]:4173/'), 'http://[::1]:4173/');
  assert.equal(normalizeLoopbackUrl('http://[::]:4173/'), 'http://[::1]:4173/');
  assert.equal(normalizeLoopbackUrl('https://localhost:4173/'), 'https://localhost:4173/');
  await assert.rejects(probeHttpUrl('https://docs.example.com/start'), /only support loopback/);
  assert.equal(
    extractHttpUrl('Docs: https://docs.example.com\nLocal: http://0.0.0.0:5173/dashboard'),
    'http://127.0.0.1:5173/dashboard',
  );
});
