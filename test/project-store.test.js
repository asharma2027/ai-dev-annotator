'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { detectProjectPlan } = require('../desktop-app/lib/project-detector');
const {
  MAX_ANNOTATION_ORIGINS,
  MAX_SNAPSHOT_ANNOTATIONS,
  ProjectStore,
  STORE_VERSION,
} = require('../desktop-app/lib/project-store');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiann-project-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function commandService(overrides = {}) {
  return {
    id: 'web',
    type: 'command',
    name: 'Website',
    workingDirectory: '.',
    primary: true,
    url: '',
    command: 'npm run dev',
    ...overrides,
  };
}

function projectInput(sourcePath, overrides = {}) {
  return {
    id: 'sample-project',
    name: 'Sample Project',
    sourcePath,
    services: [commandService()],
    projectNotes: 'Remember the mobile breakpoint.',
    annotationOrigins: [],
    autoStopOnTabClose: true,
    ...overrides,
  };
}

test('detectProjectPlan finds package scripts and their lockfile package manager', (t) => {
  const sourcePath = temporaryDirectory(t);
  fs.writeFileSync(
    path.join(sourcePath, 'package.json'),
    JSON.stringify({ name: 'detected-app', scripts: { dev: 'vite', start: 'node server.js' } }),
  );
  fs.writeFileSync(path.join(sourcePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9');

  assert.deepEqual(detectProjectPlan(sourcePath), {
    name: 'detected-app',
    services: [
      {
        type: 'command',
        name: 'Website',
        workingDirectory: '.',
        primary: true,
        url: '',
        command: 'pnpm run dev',
      },
    ],
    warnings: [],
  });
});

test('detectProjectPlan uses a static site and returns a configurable fallback', (t) => {
  const staticPath = temporaryDirectory(t);
  fs.writeFileSync(path.join(staticPath, 'index.html'), '<!doctype html>');
  assert.deepEqual(detectProjectPlan(staticPath).services, [
    {
      type: 'static',
      name: 'Website',
      workingDirectory: '.',
      primary: true,
      url: '',
      command: '',
    },
  ]);

  const unknownPath = temporaryDirectory(t);
  const unknown = detectProjectPlan(unknownPath);
  assert.equal(unknown.services[0].type, 'command');
  assert.equal(unknown.services[0].command, '');
  assert.equal(unknown.services[0].needsConfiguration, true);
  assert.match(unknown.warnings.join(' '), /configure a start command/i);

  assert.throws(() => detectProjectPlan('relative/path'), /absolute path/i);
  assert.throws(
    () => detectProjectPlan(path.join(unknownPath, 'missing')),
    /does not exist/i,
  );
});

test('ProjectStore creates and atomically persists a versioned store', (t) => {
  const sourcePath = temporaryDirectory(t);
  const storePath = path.join(sourcePath, 'state', 'projects.json');
  const store = new ProjectStore(storePath);
  const initialToken = store.getExtensionToken();

  assert.match(initialToken, /^[a-f0-9]{64}$/);
  const created = store.createProject(projectInput(sourcePath));
  assert.equal(created.id, 'sample-project');
  assert.equal(created.services[0].id, 'web');

  const serialized = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(serialized.version, STORE_VERSION);
  assert.equal(serialized.extensionToken, initialToken);
  assert.equal(serialized.annotationSnapshot.capturedAt, null);
  assert.equal(serialized.projects.length, 1);
  assert.deepEqual(
    fs.readdirSync(path.dirname(storePath)).filter((name) => name.endsWith('.tmp')),
    [],
  );

  const reloaded = new ProjectStore(storePath);
  assert.equal(reloaded.getExtensionToken(), initialToken);
  assert.equal(reloaded.load().annotationSnapshot.capturedAt, null);
  assert.equal(reloaded.getProject('sample-project').projectNotes, created.projectNotes);
  assert.equal(reloaded.setExtensionToken('replacement-token'), 'replacement-token');
  assert.equal(new ProjectStore(storePath).getExtensionToken(), 'replacement-token');
});

test('failed atomic replacement preserves both disk and memory state', { concurrency: false }, (t) => {
  const sourcePath = temporaryDirectory(t);
  const storePath = path.join(sourcePath, 'projects.json');
  const store = new ProjectStore(storePath);
  store.createProject(projectInput(sourcePath));
  const before = fs.readFileSync(storePath, 'utf8');
  const renameSync = fs.renameSync;

  fs.renameSync = (from, to) => {
    if (to === storePath) throw new Error('simulated rename failure');
    return renameSync(from, to);
  };
  try {
    assert.throws(
      () => store.updateProject('sample-project', { projectNotes: 'not persisted' }),
      /simulated rename failure/,
    );
  } finally {
    fs.renameSync = renameSync;
  }

  assert.equal(fs.readFileSync(storePath, 'utf8'), before);
  assert.equal(store.getProject('sample-project').projectNotes, 'Remember the mobile breakpoint.');
  assert.deepEqual(
    fs.readdirSync(path.dirname(storePath)).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('ProjectStore validates source paths, service topology, and containment', (t) => {
  const sourcePath = temporaryDirectory(t);
  const store = new ProjectStore(path.join(sourcePath, 'projects.json'));

  assert.throws(
    () => store.createProject(projectInput('relative/path')),
    /sourcePath must be an absolute path/,
  );
  assert.throws(
    () =>
      store.createProject(
        projectInput(sourcePath, {
          services: [commandService({ workingDirectory: '../escape' })],
        }),
      ),
    /stay within sourcePath/,
  );
  assert.throws(
    () =>
      store.createProject(
        projectInput(sourcePath, {
          services: [commandService({ primary: false })],
        }),
      ),
    /exactly one primary/,
  );
  assert.throws(
    () =>
      store.createProject(
        projectInput(sourcePath, {
          services: [commandService({ command: '   ' })],
        }),
      ),
    /command is required/,
  );
  const configurable = store.createProject(
    projectInput(sourcePath, {
      id: 'configure-me',
      services: [commandService({ command: '', needsConfiguration: true })],
    }),
  );
  assert.equal(configurable.services[0].needsConfiguration, true);
  const configured = store.updateProject('configure-me', {
    services: [commandService({ command: 'npm run preview', needsConfiguration: true })],
  });
  assert.equal(configured.services[0].command, 'npm run preview');
  assert.equal('needsConfiguration' in configured.services[0], false);
  assert.throws(
    () =>
      store.createProject(
        projectInput(sourcePath, {
          autoStopOnTabClose: 'yes',
        }),
      ),
    /must be a boolean/,
  );
  assert.throws(() => store.getProject('../unsafe'), /project id must match/);
});

test('annotations map by explicit project id or recorded origin and are sanitized', (t) => {
  const root = temporaryDirectory(t);
  const firstPath = path.join(root, 'first');
  const secondPath = path.join(root, 'second');
  fs.mkdirSync(firstPath);
  fs.mkdirSync(secondPath);
  const store = new ProjectStore(path.join(root, 'projects.json'));
  store.createProject(projectInput(firstPath, { id: 'first', annotationOrigins: [] }));
  store.createProject(projectInput(secondPath, { id: 'second', annotationOrigins: [] }));
  store.recordRuntimeOrigin('first', 'http://localhost:4173/dashboard?preview=true');

  store.setAnnotationSnapshot({
    capturedAt: '2026-07-14T12:00:00.000Z',
    annotations: [
      {
        id: 'origin-note',
        url: 'http://localhost:4173/settings',
        comment: 'Origin mapped',
        extraComments: ['One more detail'],
        timestamp: '2026-07-14T10:00:00.000Z',
        tag: 'button',
        xpath: '/html/body/button',
        privatePayload: 'must not cross the boundary',
      },
      {
        id: 'explicit-note',
        projectId: 'second',
        url: 'http://localhost:4173/also-matches-first-origin',
        comment: 'Explicitly mapped',
        timestamp: '2026-07-14T11:00:00.000Z',
      },
      {
        id: 'origin-note',
        url: 'http://localhost:4173/settings',
        comment: 'Newest duplicate wins',
        timestamp: '2026-07-14T12:00:00.000Z',
      },
      {
        id: 'unassigned-note',
        url: 'https://unassigned.example/',
        comment: 'Loose note',
      },
    ],
  });

  const first = store.getAnnotationsForProject('first');
  assert.equal(first.length, 1);
  assert.equal(first[0].comment, 'Newest duplicate wins');
  assert.equal('privatePayload' in first[0], false);
  assert.deepEqual(store.getAnnotationsForProject('second').map((item) => item.id), [
    'explicit-note',
  ]);
  assert.deepEqual(store.getUnassignedAnnotations().map((item) => item.id), [
    'unassigned-note',
  ]);
});

test('snapshot size is capped and project summaries expose useful note metrics', (t) => {
  const root = temporaryDirectory(t);
  const store = new ProjectStore(path.join(root, 'projects.json'));
  store.createProject(
    projectInput(root, {
      annotationOrigins: ['http://localhost:3000'],
    }),
  );

  const annotations = Array.from({ length: MAX_SNAPSHOT_ANNOTATIONS + 20 }, (_, index) => ({
    id: `ann_${index}`,
    url: index < 2 ? `http://localhost:3000/page-${index}` : 'https://unassigned.example/',
    comment: index === 0 ? 'First note' : index === 1 ? 'Second note' : '',
    extraComments: index === 1 ? ['Follow-up'] : [],
    timestamp: new Date(Date.UTC(2026, 6, 14, 10, index % 60)).toISOString(),
  }));
  const snapshot = store.setAnnotationSnapshot(annotations);
  assert.equal(snapshot.annotations.length, MAX_SNAPSHOT_ANNOTATIONS);
  assert.equal(snapshot.totalAnnotations, MAX_SNAPSHOT_ANNOTATIONS);
  assert.equal(snapshot.truncated, false);

  const boundedSnapshot = store.setAnnotationSnapshot({
    annotations: snapshot.annotations,
    totalAnnotations: MAX_SNAPSHOT_ANNOTATIONS + 250,
    truncated: true,
  });
  assert.deepEqual(store.getAnnotationSnapshotStatus(), {
    capturedAt: boundedSnapshot.capturedAt,
    receivedAnnotations: MAX_SNAPSHOT_ANNOTATIONS,
    totalAnnotations: MAX_SNAPSHOT_ANNOTATIONS + 250,
    truncated: true,
  });

  const summary = store.getProjectSummary('sample-project');
  assert.equal(summary.annotationCount, 2);
  assert.equal(summary.noteCount, 3);
  assert.equal(summary.pageCount, 2);
  assert.equal(summary.lastAnnotationAt, '2026-07-14T10:01:00.000Z');
  assert.equal(summary.recentNotes[0].comment, 'Second note');
  assert.equal(summary.recentNotes[1].comment, 'Follow-up');

  assert.equal(store.deleteProject('sample-project'), true);
  assert.equal(store.deleteProject('sample-project'), false);
});

test('runtime origin history evicts stale ports instead of blocking a launch', (t) => {
  const root = temporaryDirectory(t);
  const store = new ProjectStore(path.join(root, 'projects.json'));
  store.createProject(projectInput(root, { annotationOrigins: [] }));

  for (let index = 0; index <= MAX_ANNOTATION_ORIGINS; index += 1) {
    store.recordRuntimeOrigin('sample-project', `http://127.0.0.1:${20_000 + index}/`);
  }

  const project = store.getProject('sample-project');
  assert.equal(project.annotationOrigins.length, MAX_ANNOTATION_ORIGINS);
  assert.equal(project.annotationOrigins.includes('http://127.0.0.1:20000'), false);
  assert.equal(project.annotationOrigins.includes(`http://127.0.0.1:${20_000 + MAX_ANNOTATION_ORIGINS}`), true);
});

test('the most recently launched project owns legacy notes on a shared origin', (t) => {
  const root = temporaryDirectory(t);
  const firstPath = path.join(root, 'first');
  const secondPath = path.join(root, 'second');
  fs.mkdirSync(firstPath);
  fs.mkdirSync(secondPath);
  const sharedOrigin = 'http://localhost:3000';
  const store = new ProjectStore(path.join(root, 'projects.json'));
  store.createProject(projectInput(firstPath, {
    id: 'first',
    annotationOrigins: [sharedOrigin, 'http://localhost:3001'],
    lastRunAt: '2026-07-12T10:00:00.000Z',
  }));
  store.createProject(projectInput(secondPath, {
    id: 'second',
    annotationOrigins: [sharedOrigin],
    lastRunAt: '2026-07-13T10:00:00.000Z',
  }));
  store.setAnnotationSnapshot({ annotations: [{ id: 'legacy', url: `${sharedOrigin}/page`, comment: 'Legacy' }] });
  assert.equal(store.getAnnotationsForProject('second').length, 1);

  store.recordRuntimeOrigin('first', `${sharedOrigin}/page`);
  assert.equal(store.getAnnotationsForProject('first').length, 1);
  const first = store.getProject('first');
  assert.ok(Number.isFinite(Date.parse(first.lastRunAt)));
  assert.deepEqual(first.annotationOrigins, ['http://localhost:3001', sharedOrigin]);
});
