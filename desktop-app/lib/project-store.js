'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 1;
const MAX_SERVICES = 6;
const MAX_ANNOTATION_ORIGINS = 64;
const MAX_SNAPSHOT_ANNOTATIONS = 5_000;
const MAX_EXTRA_COMMENTS = 25;
const MAX_CONTEXT_ELEMENTS = 20;
const MAX_RECENT_NOTES = 5;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function slugify(value, fallbackPrefix) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const slug = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64)
    .replace(/[-_]+$/g, '');
  return slug || randomId(fallbackPrefix);
}

function assertLookupId(value, label = 'project id') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(`${label} must match ${ID_PATTERN}`);
  }
  return value;
}

function requiredString(value, label, maxLength, options = {}) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  const result = options.preserveWhitespace ? value : value.trim();
  if (!result.trim()) throw new Error(`${label} cannot be empty`);
  if (result.length > maxLength) {
    throw new Error(`${label} cannot exceed ${maxLength} characters`);
  }
  if (result.includes('\0')) throw new Error(`${label} cannot contain null bytes`);
  return result;
}

function optionalString(value, label, maxLength, defaultValue = '') {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  if (value.length > maxLength) {
    throw new Error(`${label} cannot exceed ${maxLength} characters`);
  }
  if (value.includes('\0')) throw new Error(`${label} cannot contain null bytes`);
  return value;
}

function normalizeSourcePath(sourcePath) {
  const value = requiredString(sourcePath, 'sourcePath', 4_096);
  if (!path.isAbsolute(value)) throw new Error('sourcePath must be an absolute path');
  return path.normalize(value);
}

function normalizeWorkingDirectory(sourcePath, workingDirectory) {
  const raw = optionalString(workingDirectory, 'workingDirectory', 2_048, '.').trim() || '.';
  if (path.isAbsolute(raw)) {
    throw new Error('workingDirectory must be relative to sourcePath');
  }

  const resolved = path.resolve(sourcePath, raw);
  const relative = path.relative(sourcePath, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('workingDirectory must stay within sourcePath');
  }
  return relative || '.';
}

function parseHttpOrigin(value, label, shouldThrow = true) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('only http and https URLs are supported');
    }
    return parsed.origin;
  } catch (error) {
    if (!shouldThrow) return '';
    throw new Error(`${label} must be a valid http(s) URL`, { cause: error });
  }
}

function normalizeServiceUrl(value, index) {
  const url = optionalString(value, `services[${index}].url`, 4_096).trim();
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    return parsed.href;
  } catch (error) {
    throw new Error(`services[${index}].url must be a valid http(s) URL`, { cause: error });
  }
}

function normalizeServices(services, sourcePath) {
  if (!Array.isArray(services) || services.length < 1 || services.length > MAX_SERVICES) {
    throw new Error(`services must contain between 1 and ${MAX_SERVICES} entries`);
  }

  const ids = new Set();
  const normalized = services.map((service, index) => {
    if (!isRecord(service)) throw new TypeError(`services[${index}] must be an object`);

    const type = service.type;
    if (type !== 'static' && type !== 'command') {
      throw new Error(`services[${index}].type must be "static" or "command"`);
    }

    const name = requiredString(service.name, `services[${index}].name`, 120);
    let id = service.id === undefined ? slugify(name, 'service') : slugify(service.id, 'service');
    if (ids.has(id)) {
      if (service.id !== undefined) throw new Error(`service id is duplicated: ${id}`);
      let suffix = 2;
      const base = id.slice(0, 58);
      while (ids.has(`${base}-${suffix}`)) suffix += 1;
      id = `${base}-${suffix}`;
    }
    ids.add(id);

    const command = optionalString(
      service.command,
      `services[${index}].command`,
      4_096,
    ).trim();
    const needsConfiguration =
      type === 'command' && !command && service.needsConfiguration === true;
    if (type === 'command' && !command && !needsConfiguration) {
      throw new Error(`services[${index}].command is required for command services`);
    }

    const normalizedService = {
      id,
      type,
      name,
      workingDirectory: normalizeWorkingDirectory(sourcePath, service.workingDirectory),
      primary: service.primary === true,
      url: normalizeServiceUrl(service.url, index),
      command: type === 'command' ? command : '',
    };
    if (needsConfiguration) normalizedService.needsConfiguration = true;
    return normalizedService;
  });

  if (normalized.filter((service) => service.primary).length !== 1) {
    throw new Error('services must contain exactly one primary service');
  }
  return normalized;
}

function normalizeOrigins(origins) {
  if (origins === undefined || origins === null) return [];
  if (!Array.isArray(origins)) throw new TypeError('annotationOrigins must be an array');
  if (origins.length > MAX_ANNOTATION_ORIGINS) {
    throw new Error(`annotationOrigins cannot exceed ${MAX_ANNOTATION_ORIGINS} entries`);
  }
  return [...new Set(origins.map((origin) => parseHttpOrigin(origin, 'annotation origin')))];
}

function normalizeIsoTimestamp(value, fallback) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallback;
}

function normalizeProject(input, existingProject = null) {
  if (!isRecord(input)) throw new TypeError('project must be an object');
  const now = new Date().toISOString();
  const name = requiredString(input.name, 'name', 120);
  const sourcePath = normalizeSourcePath(input.sourcePath);
  let id;
  if (existingProject) {
    id = existingProject.id;
  } else if (input.id === undefined) {
    id = `${slugify(name, 'project').slice(0, 48)}-${crypto.randomUUID().slice(0, 8)}`;
  } else {
    id = slugify(input.id, 'project');
  }

  if (!ID_PATTERN.test(id)) throw new Error(`project id must match ${ID_PATTERN}`);

  return {
    id,
    name,
    sourcePath,
    services: normalizeServices(input.services, sourcePath),
    projectNotes: optionalString(input.projectNotes, 'projectNotes', 20_000),
    annotationOrigins: normalizeOrigins(input.annotationOrigins),
    autoStopOnTabClose: normalizeAutoStop(input.autoStopOnTabClose),
    lastRunAt: existingProject
      ? existingProject.lastRunAt || null
      : normalizeIsoTimestamp(input.lastRunAt, null),
    createdAt: existingProject
      ? existingProject.createdAt
      : normalizeIsoTimestamp(input.createdAt, now),
    updatedAt: existingProject ? now : normalizeIsoTimestamp(input.updatedAt, now),
  };
}

function normalizeAutoStop(value) {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new TypeError('autoStopOnTabClose must be a boolean');
  return value;
}

function safeExternalString(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function safeContextElement(value) {
  if (!isRecord(value)) return null;
  const result = {
    tag: safeExternalString(value.tag, 128),
    elId: safeExternalString(value.elId, 512),
    classes: safeExternalString(value.classes, 2_048),
    xpath: safeExternalString(value.xpath, 4_096),
    text: safeExternalString(value.text, 2_000),
  };
  return result;
}

function sanitizeAnnotation(value) {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) return null;

  const annotation = {
    id: value.id.trim().slice(0, 256),
    url: safeExternalString(value.url, 4_096),
    comment: safeExternalString(value.comment, 20_000),
    extraComments: Array.isArray(value.extraComments)
      ? value.extraComments
          .filter((comment) => typeof comment === 'string')
          .slice(0, MAX_EXTRA_COMMENTS)
          .map((comment) => comment.slice(0, 20_000))
      : [],
    tag: safeExternalString(value.tag, 128),
    elId: safeExternalString(value.elId, 512),
    classes: safeExternalString(value.classes, 2_048),
    xpath: safeExternalString(value.xpath, 4_096),
    text: safeExternalString(value.text, 2_000),
    timestamp: normalizeIsoTimestamp(value.timestamp, ''),
    pageLevel: value.pageLevel === true,
    contextElements: Array.isArray(value.contextElements)
      ? value.contextElements
          .slice(0, MAX_CONTEXT_ELEMENTS)
          .map(safeContextElement)
          .filter(Boolean)
      : [],
  };

  if (typeof value.projectId === 'string' && ID_PATTERN.test(value.projectId)) {
    annotation.projectId = value.projectId;
  }
  for (const field of ['createdAt', 'updatedAt', 'deletedAt']) {
    const timestamp = normalizeIsoTimestamp(value[field], '');
    if (timestamp) annotation[field] = timestamp;
  }
  return annotation;
}

function sanitizeAnnotationSnapshot(payload, timestampFallback = new Date().toISOString()) {
  let values = null;
  if (Array.isArray(payload)) {
    values = payload;
  } else if (isRecord(payload) && Array.isArray(payload.annotations)) {
    values = payload.annotations;
  }
  if (!values) {
    throw new TypeError('annotation snapshot must be an array or an object with annotations');
  }

  const byId = new Map();
  for (const value of values) {
    const annotation = sanitizeAnnotation(value);
    if (!annotation) continue;
    if (byId.has(annotation.id)) {
      byId.delete(annotation.id);
      byId.set(annotation.id, annotation);
    } else if (byId.size < MAX_SNAPSHOT_ANNOTATIONS) {
      byId.set(annotation.id, annotation);
    }
  }

  const requestedTimestamp = isRecord(payload) ? payload.capturedAt || payload.timestamp : null;
  const requestedTotal = isRecord(payload) ? Number(payload.totalAnnotations) : byId.size;
  const totalAnnotations = Number.isInteger(requestedTotal) && requestedTotal >= byId.size
    ? Math.min(requestedTotal, 1_000_000)
    : byId.size;
  return {
    capturedAt: normalizeIsoTimestamp(requestedTimestamp, timestampFallback),
    annotations: [...byId.values()],
    totalAnnotations,
    truncated: (isRecord(payload) && payload.truncated === true) || totalAnnotations > byId.size,
  };
}

function createInitialState() {
  return {
    version: STORE_VERSION,
    projects: [],
    extensionToken: crypto.randomBytes(32).toString('hex'),
    annotationSnapshot: {
      capturedAt: null,
      annotations: [],
      totalAnnotations: 0,
      truncated: false,
    },
  };
}

function normalizeLoadedState(value) {
  if (!isRecord(value)) throw new Error('project store root must be an object');
  if (value.version !== STORE_VERSION) {
    throw new Error(
      `unsupported project store version: ${String(value.version)} (expected ${STORE_VERSION})`,
    );
  }
  if (!Array.isArray(value.projects)) throw new Error('project store projects must be an array');

  const ids = new Set();
  const projects = value.projects.map((project, index) => {
    if (!isRecord(project) || typeof project.id !== 'string' || !ID_PATTERN.test(project.id)) {
      throw new Error(`project store contains an invalid project id at index ${index}`);
    }
    if (ids.has(project.id)) throw new Error(`project store contains duplicate id: ${project.id}`);
    ids.add(project.id);
    const normalized = normalizeProject(project);
    normalized.id = project.id;
    normalized.createdAt = normalizeIsoTimestamp(project.createdAt, normalized.createdAt);
    normalized.updatedAt = normalizeIsoTimestamp(project.updatedAt, normalized.updatedAt);
    return normalized;
  });

  const extensionToken =
    typeof value.extensionToken === 'string' && value.extensionToken.trim()
      ? value.extensionToken.trim().slice(0, 512)
      : crypto.randomBytes(32).toString('hex');
  const annotationSnapshot = value.annotationSnapshot
    ? sanitizeAnnotationSnapshot(value.annotationSnapshot, null)
    : { capturedAt: null, annotations: [], totalAnnotations: 0, truncated: false };

  return {
    version: STORE_VERSION,
    projects,
    extensionToken,
    annotationSnapshot,
  };
}

function annotationOrigin(annotation) {
  return parseHttpOrigin(annotation.url, 'annotation URL', false);
}

function resolveAnnotationProjectId(annotation, projects) {
  if (annotation.projectId) {
    return projects.some((project) => project.id === annotation.projectId)
      ? annotation.projectId
      : '';
  }
  const origin = annotationOrigin(annotation);
  if (!origin) return '';
  const matches = projects
    .filter((project) => project.annotationOrigins.includes(origin))
    .sort((left, right) => {
      const runDifference = Date.parse(right.lastRunAt || '') - Date.parse(left.lastRunAt || '');
      if (Number.isFinite(runDifference) && runDifference !== 0) return runDifference;
      const updatedDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return updatedDifference || left.id.localeCompare(right.id);
    });
  return matches[0]?.id || '';
}

function annotationNotes(annotation) {
  const notes = [annotation.comment, ...(annotation.extraComments || [])];
  return notes.filter((note) => typeof note === 'string' && note.trim());
}

function annotationPageKey(annotation) {
  try {
    const url = new URL(annotation.url);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return annotation.url || '';
  }
}

class ProjectStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new Error('ProjectStore filePath must be an absolute path');
    }
    this.filePath = path.normalize(filePath);
    this._state = null;
  }

  load() {
    if (this._state) return clone(this._state);

    if (!fs.existsSync(this.filePath)) {
      this._state = createInitialState();
      try {
        this._persist(this._state);
      } catch (error) {
        this._state = null;
        throw error;
      }
      return clone(this._state);
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new Error(`Could not read project store at ${this.filePath}: ${error.message}`, {
        cause: error,
      });
    }
    this._state = normalizeLoadedState(parsed);
    return clone(this._state);
  }

  listProjects() {
    this._ensureLoaded();
    return clone(this._state.projects);
  }

  getProject(id) {
    this._ensureLoaded();
    const safeId = assertLookupId(id);
    const project = this._state.projects.find((candidate) => candidate.id === safeId);
    return project ? clone(project) : null;
  }

  createProject(input) {
    this._ensureLoaded();
    const project = normalizeProject(input);
    if (this._state.projects.some((candidate) => candidate.id === project.id)) {
      throw new Error(`A project with id "${project.id}" already exists`);
    }
    return this._commit((draft) => {
      draft.projects.push(project);
      return project;
    });
  }

  updateProject(id, patch) {
    this._ensureLoaded();
    const safeId = assertLookupId(id);
    if (!isRecord(patch)) throw new TypeError('project patch must be an object');
    const index = this._state.projects.findIndex((project) => project.id === safeId);
    if (index < 0) throw new Error(`Project not found: ${safeId}`);

    const current = this._state.projects[index];
    const merged = { ...current };
    for (const field of [
      'name',
      'sourcePath',
      'services',
      'projectNotes',
      'annotationOrigins',
      'autoStopOnTabClose',
    ]) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) merged[field] = patch[field];
    }
    const updated = normalizeProject(merged, current);

    return this._commit((draft) => {
      draft.projects[index] = updated;
      return updated;
    });
  }

  deleteProject(id) {
    this._ensureLoaded();
    const safeId = assertLookupId(id);
    const index = this._state.projects.findIndex((project) => project.id === safeId);
    if (index < 0) return false;
    return this._commit((draft) => {
      draft.projects.splice(index, 1);
      return true;
    });
  }

  getExtensionToken() {
    this._ensureLoaded();
    return this._state.extensionToken;
  }

  setExtensionToken(token) {
    this._ensureLoaded();
    const safeToken = requiredString(token, 'extensionToken', 512);
    return this._commit((draft) => {
      draft.extensionToken = safeToken;
      return safeToken;
    });
  }

  recordRuntimeOrigin(projectId, url) {
    this._ensureLoaded();
    const safeId = assertLookupId(projectId);
    const index = this._state.projects.findIndex((project) => project.id === safeId);
    if (index < 0) throw new Error(`Project not found: ${safeId}`);
    const origin = parseHttpOrigin(url, 'runtime URL');
    return this._commit((draft) => {
      const updated = draft.projects[index];
      const existingIndex = updated.annotationOrigins.indexOf(origin);
      if (existingIndex >= 0) updated.annotationOrigins.splice(existingIndex, 1);
      if (updated.annotationOrigins.length >= MAX_ANNOTATION_ORIGINS) {
        updated.annotationOrigins.splice(0, updated.annotationOrigins.length - MAX_ANNOTATION_ORIGINS + 1);
      }
      updated.annotationOrigins.push(origin);
      updated.lastRunAt = new Date().toISOString();
      return updated;
    });
  }

  setAnnotationSnapshot(payload) {
    this._ensureLoaded();
    const snapshot = sanitizeAnnotationSnapshot(payload);
    return this._commit((draft) => {
      draft.annotationSnapshot = snapshot;
      return snapshot;
    });
  }

  getAnnotationSnapshotStatus() {
    this._ensureLoaded();
    const snapshot = this._state.annotationSnapshot;
    return {
      capturedAt: snapshot.capturedAt,
      receivedAnnotations: snapshot.annotations.length,
      totalAnnotations: snapshot.totalAnnotations,
      truncated: snapshot.truncated,
    };
  }

  getAnnotationsForProject(id) {
    this._ensureLoaded();
    const project = this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return clone(
      this._state.annotationSnapshot.annotations.filter(
        (annotation) => resolveAnnotationProjectId(annotation, this._state.projects) === project.id,
      ),
    );
  }

  getProjectSummary(id) {
    this._ensureLoaded();
    const project = this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const annotations = this.getAnnotationsForProject(id);
    const pageKeys = new Set();
    const recentNotes = [];
    let lastTimestamp = 0;

    for (const annotation of annotations) {
      const pageKey = annotationPageKey(annotation);
      if (pageKey) pageKeys.add(pageKey);
      const timestamp = Date.parse(annotation.timestamp || '') || 0;
      lastTimestamp = Math.max(lastTimestamp, timestamp);
      annotationNotes(annotation).forEach((comment, noteIndex) => {
        recentNotes.push({
          id: `${annotation.id}:${noteIndex}`,
          annotationId: annotation.id,
          comment,
          url: annotation.url,
          timestamp: annotation.timestamp || null,
          tag: annotation.tag,
          elId: annotation.elId,
          classes: annotation.classes,
          xpath: annotation.xpath,
          pageLevel: annotation.pageLevel,
          _sortTimestamp: timestamp,
        });
      });
    }

    recentNotes.sort((left, right) => right._sortTimestamp - left._sortTimestamp);
    for (const note of recentNotes) delete note._sortTimestamp;

    return {
      ...project,
      annotationCount: annotations.length,
      noteCount: recentNotes.length,
      pageCount: pageKeys.size,
      lastAnnotationAt: lastTimestamp ? new Date(lastTimestamp).toISOString() : null,
      recentNotes: recentNotes.slice(0, MAX_RECENT_NOTES),
    };
  }

  getUnassignedAnnotations() {
    this._ensureLoaded();
    return clone(
      this._state.annotationSnapshot.annotations.filter(
        (annotation) => !resolveAnnotationProjectId(annotation, this._state.projects),
      ),
    );
  }

  _ensureLoaded() {
    if (!this._state) this.load();
  }

  _commit(mutator) {
    const before = this._state;
    const draft = clone(before);
    const result = mutator(draft);
    try {
      this._persist(draft);
      this._state = draft;
    } catch (error) {
      this._state = before;
      throw error;
    }
    return clone(result);
  }

  _persist(state) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    let descriptor = null;

    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporaryPath, this.filePath);

      // Best-effort directory sync makes the rename durable on filesystems
      // that support opening directories. Windows does not, so failures here
      // are intentionally ignored after the atomic rename has succeeded.
      try {
        const directoryDescriptor = fs.openSync(directory, 'r');
        fs.fsyncSync(directoryDescriptor);
        fs.closeSync(directoryDescriptor);
      } catch {
        // Unsupported by this platform/filesystem.
      }
    } catch (error) {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // Preserve the original write error.
        }
      }
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file may already have been renamed or removed.
      }
      throw new Error(`Could not persist project store: ${error.message}`, { cause: error });
    }
  }
}

module.exports = {
  ProjectStore,
  STORE_VERSION,
  MAX_ANNOTATION_ORIGINS,
  MAX_SNAPSHOT_ANNOTATIONS,
};
