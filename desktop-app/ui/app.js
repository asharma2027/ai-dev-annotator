'use strict';

const ACTIVE_STATES = new Set(['starting', 'running', 'stopping']);
const MAX_SERVICES = 6;

const state = {
  annotationQuery: '',
  briefDirty: false,
  briefSavePromise: null,
  briefSaveTimer: null,
  busyProjects: new Map(),
  closePreparationInProgress: false,
  detail: null,
  detailRequest: 0,
  eventSource: null,
  extension: { connected: false },
  planDirty: false,
  planRevision: 0,
  planSavePromise: null,
  projectQuery: '',
  projects: [],
  refreshQueued: false,
  refreshing: false,
  selectedProjectId: null,
  selectionInProgress: false,
  serviceDraft: [],
  serviceDraftProjectId: null,
  token: '',
};

const elements = Object.fromEntries(
  Array.from(document.querySelectorAll('[id]'), (element) => [element.id, element]),
);

bindEvents();
initialize();

async function initialize() {
  try {
    if (!window.annotatorDesktop?.getDashboardToken) {
      throw new Error('Open this dashboard from the AI Annotator Home desktop app.');
    }
    state.token = await window.annotatorDesktop.getDashboardToken();
    await refreshWorkspace({ showDetailLoading: true });
    connectEvents();
  } catch (error) {
    showGlobalError(error);
  } finally {
    elements['initial-loading'].hidden = true;
  }
}

function bindEvents() {
  elements['add-project-button'].addEventListener('click', openAddProjectDialog);
  elements['empty-add-button'].addEventListener('click', openAddProjectDialog);
  elements['close-add-dialog'].addEventListener('click', closeAddProjectDialog);
  elements['cancel-add-project'].addEventListener('click', closeAddProjectDialog);
  elements['choose-folder-button'].addEventListener('click', chooseProjectFolder);
  elements['clear-folder-button'].addEventListener('click', clearProjectFolder);
  elements['add-project-form'].addEventListener('submit', createProject);
  elements['new-project-name'].addEventListener('input', updateCreateProjectButton);
  elements['retry-button'].addEventListener('click', () => refreshWorkspace({ showDetailLoading: true }));
  elements['project-search'].addEventListener('input', (event) => {
    state.projectQuery = event.target.value.trim().toLowerCase();
    renderProjectList();
  });
  elements['clear-project-search'].addEventListener('click', () => {
    elements['project-search'].value = '';
    state.projectQuery = '';
    renderProjectList();
    elements['project-search'].focus();
  });
  elements['annotation-search'].addEventListener('input', (event) => {
    state.annotationQuery = event.target.value.trim().toLowerCase();
    renderAnnotations();
  });
  elements['detail-run-button'].addEventListener('click', () => toggleProject(state.selectedProjectId));
  elements['detail-open-button'].addEventListener('click', () => openProject(state.selectedProjectId));
  elements['delete-project-button'].addEventListener('click', deleteSelectedProject);
  elements['project-brief'].addEventListener('input', handleBriefInput);
  elements['save-brief-button'].addEventListener('click', saveBrief);
  elements['add-service-button'].addEventListener('click', addService);
  elements['run-plan-form'].addEventListener('submit', saveRunPlan);
  elements['copy-logs-button'].addEventListener('click', copyLogs);
  document.addEventListener('keydown', handleKeyboardShortcut);
  window.addEventListener('beforeunload', () => state.eventSource?.close());
  window.annotatorDesktop?.onPrepareClose?.(prepareDashboardClose);
  window.annotatorDesktop?.onClosePreparationCancelled?.(cancelDashboardClosePreparation);
}

function cancelDashboardClosePreparation() {
  state.closePreparationInProgress = false;
  elements.workspace.inert = false;
  elements.workspace.removeAttribute('aria-busy');
}

async function prepareDashboardClose() {
  if (state.closePreparationInProgress) return;
  state.closePreparationInProgress = true;
  elements.workspace.inert = true;
  elements.workspace.setAttribute('aria-busy', 'true');
  let ready = false;
  try {
    ready = await window.AnnotatorPendingChanges.saveBeforeProjectChange({
      getProjectId: () => state.selectedProjectId,
      hasBriefChanges: () => state.briefDirty,
      hasPlanChanges: () => state.planDirty,
      projectId: state.selectedProjectId,
      saveBrief,
      savePlan: saveRunPlan,
    });
    if (ready) state.eventSource?.close();
  } catch (error) {
    showToast(error.message || 'Could not save project changes.', 'error');
  } finally {
    window.annotatorDesktop?.finishClosePreparation?.(ready);
    state.closePreparationInProgress = false;
    if (!ready) {
      elements.workspace.inert = false;
      elements.workspace.removeAttribute('aria-busy');
    }
  }
}

async function api(pathname, options = {}) {
  const headers = { Authorization: `Bearer ${state.token}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(pathname, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
    headers,
    method: options.method || 'GET',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || payload.error || `Request failed with status ${response.status}.`);
  return payload;
}

async function refreshWorkspace(options = {}) {
  if (state.refreshing) {
    state.refreshQueued = true;
    return;
  }
  state.refreshing = true;
  try {
    const bootstrap = await api('/api/bootstrap');
    state.projects = bootstrap.projects || [];
    state.extension = bootstrap.extension || { connected: false };
    if (!state.projects.some((project) => project.id === state.selectedProjectId)) {
      state.selectedProjectId = state.projects[0]?.id || null;
      state.detail = null;
      state.serviceDraftProjectId = null;
      state.briefDirty = false;
      state.planDirty = false;
    }
    hideGlobalError();
    renderWorkspace();
    if (state.selectedProjectId) {
      await loadProjectDetail(state.selectedProjectId, options.showDetailLoading === true);
    } else {
      renderProjectDetail();
    }
  } catch (error) {
    showGlobalError(error);
  } finally {
    state.refreshing = false;
    if (state.refreshQueued) {
      state.refreshQueued = false;
      queueMicrotask(() => refreshWorkspace());
    }
  }
}

async function loadProjectDetail(projectId, showLoading = false) {
  const requestId = ++state.detailRequest;
  if (showLoading || state.detail?.project?.id !== projectId) {
    elements['detail-loading'].hidden = false;
    elements['detail-placeholder'].hidden = true;
    elements['detail-content'].hidden = true;
  }
  try {
    const detail = await api(`/api/projects/${encodeURIComponent(projectId)}`);
    if (requestId !== state.detailRequest || projectId !== state.selectedProjectId) return;
    state.detail = detail;
    if (state.serviceDraftProjectId !== projectId || !state.planDirty) {
      state.serviceDraft = clone(detail.project.services || []);
      state.serviceDraftProjectId = projectId;
      state.planDirty = false;
    }
    renderProjectDetail();
  } catch (error) {
    if (requestId === state.detailRequest) showToast(error.message, 'error');
  } finally {
    if (requestId === state.detailRequest) elements['detail-loading'].hidden = true;
  }
}

function connectEvents() {
  state.eventSource?.close();
  state.eventSource = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
  let refreshTimer = null;
  state.eventSource.onmessage = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshWorkspace(), 220);
  };
}

function renderWorkspace() {
  renderExtensionStatus();
  renderRunningStrip();
  renderProjectList();
}

function renderExtensionStatus() {
  const connected = state.extension.connected === true;
  const extensionStatus = elements['extension-status'];
  extensionStatus.dataset.state = connected ? 'connected' : 'disconnected';
  const annotationSync = state.extension.annotationSync || {};
  const syncWasTruncated = annotationSync.truncated === true;
  extensionStatus.querySelector('.connection-label').textContent = connected
    ? syncWasTruncated
      ? `Extension connected · ${annotationSync.receivedAnnotations || 0}/${annotationSync.totalAnnotations || 0} recent notes`
      : 'Extension connected'
    : 'Extension connects on launch';
  extensionStatus.title = syncWasTruncated
    ? 'The dashboard keeps the most recent notes that fit safely in the local sync snapshot. All notes remain available in the extension.'
    : '';

  const activeProjects = state.projects.filter((project) => ACTIVE_STATES.has(runtimeStatus(project.runtime)));
  const allAttached = activeProjects.length > 0 && activeProjects.every((project) => (project.runtime.tabIds || []).length > 0);
  const safety = elements['auto-stop-status'];
  if (allAttached) safety.lastChild.textContent = ' Exact-tab protection active';
  else if (activeProjects.length > 0) safety.lastChild.textContent = ' Waiting for test tab';
  else safety.lastChild.textContent = ' Auto-stop ready';
}

function renderRunningStrip() {
  const running = state.projects.filter((project) => ACTIVE_STATES.has(runtimeStatus(project.runtime)));
  elements['running-strip'].hidden = running.length === 0;
  elements['running-count'].textContent = `${running.length}`;
  const fragment = document.createDocumentFragment();
  for (const project of running) {
    const item = createElement('div', 'running-item');
    item.append(
      createElement('span', 'running-item-name', project.name),
      createElement('span', 'running-item-state', humanizeStatus(runtimeStatus(project.runtime))),
    );
    const stopButton = createElement('button', '', 'Stop');
    stopButton.type = 'button';
    stopButton.disabled = state.busyProjects.get(project.id) === 'stop' || runtimeStatus(project.runtime) === 'stopping';
    stopButton.addEventListener('click', () => toggleProject(project.id, 'stop'));
    item.append(stopButton);
    fragment.append(item);
  }
  elements['running-items'].replaceChildren(fragment);
}

function renderProjectList() {
  const projects = state.projects.filter((project) => {
    if (!state.projectQuery) return true;
    return `${project.name} ${project.sourcePath}`.toLowerCase().includes(state.projectQuery);
  });
  elements['project-count'].textContent = String(state.projects.length);
  elements['project-count'].setAttribute('aria-label', `${state.projects.length} projects`);
  elements['project-empty'].hidden = state.projects.length !== 0;
  elements['filtered-empty'].hidden = state.projects.length === 0 || projects.length !== 0;

  const fragment = document.createDocumentFragment();
  for (const project of projects) fragment.append(createProjectRow(project));
  elements['project-list'].replaceChildren(fragment);
}

function createProjectRow(project) {
  const status = runtimeStatus(project.runtime);
  const pendingAction = state.busyProjects.get(project.id);
  const row = createElement('article', `project-row${project.id === state.selectedProjectId ? ' is-selected' : ''}`);
  row.dataset.status = status;

  const mainButton = createElement('button', 'project-row-main');
  mainButton.type = 'button';
  mainButton.addEventListener('click', () => selectProject(project.id));
  const nameLine = createElement('span', 'project-name-line');
  nameLine.append(
    createElement('span', 'project-name', project.name),
    createElement('span', 'status-mini', humanizeStatus(status)),
  );
  const projectPath = createElement('span', 'project-path', project.sourcePath);
  projectPath.title = project.sourcePath;
  const meta = createElement('span', 'project-meta');
  meta.append(
    createElement('span', '', `${project.summary?.noteCount || 0} notes`),
    createElement('span', '', `${project.summary?.pageCount || 0} pages`),
    createElement('span', '', lastActivityLabel(project)),
  );
  mainButton.append(nameLine, projectPath, meta);

  const actions = createElement('div', 'row-actions');
  const buttons = createElement('div', 'row-action-buttons');
  if (status === 'running') {
    const openButton = createElement('button', 'row-button', 'Open');
    openButton.type = 'button';
    openButton.addEventListener('click', () => openProject(project.id));
    buttons.append(openButton);
  }
  const toggleButton = createElement(
    'button',
    `row-button ${ACTIVE_STATES.has(status) ? 'stop' : 'run'}`,
    ACTIVE_STATES.has(status) ? 'Stop' : 'Run',
  );
  toggleButton.type = 'button';
  toggleButton.disabled = status === 'stopping'
    || pendingAction === 'stop'
    || (pendingAction === 'start' && !ACTIVE_STATES.has(status));
  toggleButton.addEventListener('click', () => toggleProject(project.id));
  buttons.append(toggleButton);
  actions.append(buttons);
  row.append(mainButton, actions);
  if (project.runtime?.error) row.append(createElement('p', 'project-error-line', project.runtime.error));
  return row;
}

async function selectProject(projectId) {
  if (!projectId || projectId === state.selectedProjectId) return true;
  if (state.selectionInProgress) return false;

  const previousProjectId = state.selectedProjectId;
  state.selectionInProgress = true;
  try {
    const readyToSwitch = await window.AnnotatorPendingChanges.saveBeforeProjectChange({
      getProjectId: () => state.selectedProjectId,
      hasBriefChanges: () => state.briefDirty,
      hasPlanChanges: () => state.planDirty,
      projectId: previousProjectId,
      saveBrief,
      savePlan: saveRunPlan,
    });
    if (!readyToSwitch) return false;

    clearTimeout(state.briefSaveTimer);
    elements['project-brief'].blur();
    elements['project-brief'].value = '';
    state.selectedProjectId = projectId;
    state.detail = null;
    state.annotationQuery = '';
    elements['annotation-search'].value = '';
    state.serviceDraft = [];
    state.serviceDraftProjectId = null;
    state.planDirty = false;
    renderProjectList();
    await loadProjectDetail(projectId, true);
    return true;
  } finally {
    state.selectionInProgress = false;
  }
}

function renderProjectDetail() {
  const detail = state.detail;
  if (!state.selectedProjectId || !detail || detail.project.id !== state.selectedProjectId) {
    elements['detail-placeholder'].hidden = false;
    elements['detail-content'].hidden = true;
    return;
  }

  elements['detail-placeholder'].hidden = true;
  elements['detail-content'].hidden = false;
  elements['detail-title'].textContent = detail.project.name;
  elements['detail-path'].textContent = detail.project.sourcePath;
  elements['detail-path'].title = detail.project.sourcePath;

  const status = runtimeStatus(detail.runtime);
  const statusBadge = elements['detail-status'];
  statusBadge.dataset.status = status;
  statusBadge.querySelector('span:last-child').textContent = humanizeStatus(status);
  elements['detail-error'].hidden = !detail.runtime?.error;
  elements['detail-error'].textContent = detail.runtime?.error || '';

  const isActive = ACTIVE_STATES.has(status);
  const pendingAction = state.busyProjects.get(detail.project.id);
  const isBusy = pendingAction === 'stop' || status === 'stopping';
  elements['detail-open-button'].hidden = status !== 'running';
  elements['detail-open-button'].disabled = isBusy;
  elements['detail-run-button'].disabled = status === 'stopping'
    || pendingAction === 'stop'
    || (pendingAction === 'start' && !ACTIVE_STATES.has(status));
  elements['detail-run-button'].classList.toggle('is-stop', isActive);
  elements['detail-run-button'].querySelector('.action-label').textContent = isActive ? 'Stop project' : 'Run locally';
  elements['delete-project-button'].disabled = isActive;

  renderOverview();
  renderBrief();
  renderAnnotations();
  renderServices();
  renderLogs();
}

function renderOverview() {
  const { project, runtime, summary } = state.detail;
  const services = runtime.services || [];
  const runningServices = services.filter((service) => runtimeStatus(service) === 'running').length;
  const cards = [
    ['Notes', summary.noteCount || 0, `${summary.annotationCount || 0} annotations`],
    ['Pages', summary.pageCount || 0, 'annotated routes'],
    ['Services', project.services.length, runningServices ? `${runningServices} currently live` : 'one lifecycle toggle'],
    ['Last activity', compactRelativeDate(summary.lastAnnotationAt || runtime.timestamps?.stoppedAt || runtime.timestamps?.runningAt), runtimeStatus(runtime)],
  ];
  const fragment = document.createDocumentFragment();
  for (const [label, value, subtext] of cards) {
    const card = createElement('div', 'stat-card');
    card.append(
      createElement('span', 'stat-label', String(label)),
      createElement('span', 'stat-value', String(value ?? '—')),
      createElement('span', 'stat-subtext', String(subtext || '')),
    );
    fragment.append(card);
  }
  elements['stat-grid'].replaceChildren(fragment);
  elements['last-refreshed'].textContent = `Updated ${compactRelativeDate(new Date().toISOString())}`;

  const live = runtimeStatus(runtime) === 'running' && runtime.url;
  elements['session-callout'].hidden = !live;
  elements['session-url'].textContent = live ? runtime.url : '';
  elements['session-safety-message'].textContent = runtime.awaitingTab
    ? 'Waiting for the extension test tab; services self-stop if it cannot attach.'
    : 'Closing its browser tab stops every related service.';
}

function renderBrief() {
  const textarea = elements['project-brief'];
  if (!state.briefDirty && document.activeElement !== textarea) {
    textarea.value = state.detail.project.projectNotes || '';
  }
  updateBriefCounter();
  if (!state.briefDirty) setSaveState(elements['brief-save-state'], 'saved', 'Saved');
}

function handleBriefInput() {
  state.briefDirty = true;
  updateBriefCounter();
  elements['save-brief-button'].disabled = false;
  setSaveState(elements['brief-save-state'], 'dirty', 'Unsaved changes');
  clearTimeout(state.briefSaveTimer);
  state.briefSaveTimer = setTimeout(saveBrief, 900);
}

function updateBriefCounter() {
  const length = elements['project-brief'].value.length;
  elements['brief-character-count'].textContent = `${length.toLocaleString()} / 20,000`;
}

async function saveBrief() {
  if (!state.briefDirty) return true;
  if (!state.selectedProjectId) return false;
  if (state.briefSavePromise) return state.briefSavePromise;

  const savePromise = persistBriefChanges();
  state.briefSavePromise = savePromise;
  try {
    return await savePromise;
  } finally {
    if (state.briefSavePromise === savePromise) state.briefSavePromise = null;
  }
}

async function persistBriefChanges() {
  const projectId = state.selectedProjectId;

  while (state.briefDirty && state.selectedProjectId === projectId) {
    const projectNotes = elements['project-brief'].value;
    clearTimeout(state.briefSaveTimer);
    setSaveState(elements['brief-save-state'], 'saving', 'Saving…');
    elements['save-brief-button'].disabled = true;
    try {
      const detail = await api(`/api/projects/${encodeURIComponent(projectId)}`, {
        body: { projectNotes },
        method: 'PATCH',
      });
      if (state.selectedProjectId !== projectId) return false;
      state.detail = detail;
      if (elements['project-brief'].value !== projectNotes) continue;
      state.briefDirty = false;
      setSaveState(elements['brief-save-state'], 'saved', 'Saved');
      scheduleWorkspaceRefresh();
    } catch (error) {
      elements['save-brief-button'].disabled = false;
      setSaveState(elements['brief-save-state'], 'error', 'Could not save');
      showToast(error.message, 'error');
      return false;
    }
  }
  return !state.briefDirty && state.selectedProjectId === projectId;
}

function renderAnnotations() {
  if (!state.detail) return;
  const query = state.annotationQuery;
  const entries = [];
  for (const annotation of state.detail.annotations || []) {
    const notes = [annotation.comment, ...(annotation.extraComments || [])]
      .map((note) => String(note || '').trim())
      .filter(Boolean);
    const selector = annotationSelector(annotation);
    for (const note of notes) {
      const haystack = `${note} ${annotation.url} ${selector} ${annotation.text || ''}`.toLowerCase();
      if (!query || haystack.includes(query)) entries.push({ annotation, note, selector });
    }
  }

  elements['annotation-count'].textContent = String(state.detail.summary.noteCount || 0);
  elements['annotation-empty'].hidden = (state.detail.summary.noteCount || 0) !== 0;
  elements['annotation-filtered-empty'].hidden = !query || entries.length !== 0;

  const groups = new Map();
  for (const entry of entries) {
    const key = entry.annotation.url || 'Unknown page';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const fragment = document.createDocumentFragment();
  for (const [url, groupEntries] of groups) fragment.append(createAnnotationGroup(url, groupEntries));
  elements['annotation-groups'].replaceChildren(fragment);
}

function createAnnotationGroup(url, entries) {
  const group = createElement('section', 'annotation-page');
  const header = createElement('header', 'annotation-page-header');
  const title = createElement('span', 'annotation-page-title');
  title.title = url;
  title.append(createElement('span', '', pageHost(url)), document.createTextNode(pageLabel(url)));
  header.append(title, createElement('span', 'annotation-page-count', `${entries.length} ${entries.length === 1 ? 'note' : 'notes'}`));
  const list = createElement('div', 'annotation-list');
  for (const { annotation, note, selector } of entries) {
    const item = createElement('article', 'annotation-item');
    item.append(
      createElement('p', 'annotation-note', note),
      createElement('time', 'annotation-time', formatDate(annotation.timestamp)),
    );
    const target = createElement('div', 'annotation-target');
    const selectorElement = createElement('span', 'annotation-selector', selector);
    selectorElement.title = annotation.xpath || selector;
    target.append(selectorElement);
    if (annotation.text) {
      const text = createElement('span', 'annotation-text', annotation.text);
      text.title = annotation.text;
      target.append(text);
    }
    item.append(target);
    list.append(item);
  }
  group.append(header, list);
  return group;
}

function renderServices() {
  if (!state.detail) return;
  const fragment = document.createDocumentFragment();
  state.serviceDraft.forEach((service, index) => fragment.append(createServiceRow(service, index)));
  elements['services-list'].replaceChildren(fragment);
  elements['services-empty'].hidden = state.serviceDraft.length !== 0;
  elements['add-service-button'].disabled = state.serviceDraft.length >= MAX_SERVICES;
  elements['save-plan-button'].disabled = !state.planDirty;
  const primary = state.serviceDraft.find((service) => service.primary);
  const needsConfiguration = state.serviceDraft.some((service) => service.needsConfiguration || (service.type === 'command' && !service.command));
  elements['service-summary'].textContent = state.serviceDraft.length
    ? `${state.serviceDraft.length} ${state.serviceDraft.length === 1 ? 'service' : 'services'} · ${needsConfiguration ? 'needs configuration' : `primary: ${primary?.name || 'not selected'}`}`
    : 'No services configured';
}

function createServiceRow(service, index) {
  const row = createElement('div', 'service-row');
  row.dataset.index = String(index);
  row.append(
    createServiceTextField('Name', 'name', service.name || '', index),
    createServiceTypeField(service, index),
    createServiceTextField('Working folder', 'workingDirectory', service.workingDirectory || '.', index),
    createServiceTextField('Command', 'command', service.command || '', index, service.type === 'static'),
    createServiceTextField('Ready URL', 'url', service.url || '', index, false, 'Optional'),
    createPrimaryField(service, index),
  );
  const removeButton = createElement('button', 'icon-button remove-service');
  removeButton.type = 'button';
  removeButton.title = 'Remove service';
  removeButton.setAttribute('aria-label', `Remove ${service.name || 'service'}`);
  removeButton.append(createElement('span', 'close-mark'));
  removeButton.addEventListener('click', () => removeService(index));
  row.append(removeButton);
  return row;
}

function createServiceTextField(label, field, value, index, disabled = false, placeholder = '') {
  const wrapper = createElement('label', 'service-field');
  wrapper.append(createElement('span', '', label));
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.disabled = disabled;
  input.dataset.field = field;
  input.addEventListener('input', (event) => updateServiceField(index, field, event.target.value));
  wrapper.append(input);
  return wrapper;
}

function createServiceTypeField(service, index) {
  const wrapper = createElement('label', 'service-field');
  wrapper.append(createElement('span', '', 'Type'));
  const select = document.createElement('select');
  for (const [value, label] of [['command', 'Command'], ['static', 'Static files']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = service.type === value;
    select.append(option);
  }
  select.addEventListener('change', (event) => {
    updateServiceField(index, 'type', event.target.value);
    if (event.target.value === 'static') state.serviceDraft[index].command = '';
    renderServices();
  });
  wrapper.append(select);
  return wrapper;
}

function createPrimaryField(service, index) {
  const wrapper = createElement('label', 'primary-choice');
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'primary-service';
  radio.checked = service.primary === true;
  radio.addEventListener('change', () => {
    state.serviceDraft.forEach((candidate, candidateIndex) => {
      candidate.primary = candidateIndex === index;
    });
    markPlanDirty();
    renderServices();
  });
  wrapper.append(radio, createElement('span', 'radio-mark'), document.createTextNode('Primary'));
  return wrapper;
}

function updateServiceField(index, field, value) {
  state.serviceDraft[index][field] = value;
  if (field === 'command' && value.trim()) delete state.serviceDraft[index].needsConfiguration;
  markPlanDirty();
}

function markPlanDirty() {
  state.planDirty = true;
  state.planRevision += 1;
  elements['save-plan-button'].disabled = false;
  setSaveState(elements['plan-save-state'], 'dirty', 'Unsaved changes');
}

function addService() {
  if (state.serviceDraft.length >= MAX_SERVICES) return;
  state.serviceDraft.push({
    command: '',
    name: `Service ${state.serviceDraft.length + 1}`,
    primary: state.serviceDraft.length === 0,
    type: 'command',
    url: '',
    workingDirectory: '.',
  });
  markPlanDirty();
  renderServices();
}

function removeService(index) {
  const wasPrimary = state.serviceDraft[index]?.primary;
  state.serviceDraft.splice(index, 1);
  if (wasPrimary && state.serviceDraft.length) state.serviceDraft[0].primary = true;
  markPlanDirty();
  renderServices();
}

async function saveRunPlan(event) {
  event?.preventDefault();
  if (!state.planDirty) return true;
  if (!state.selectedProjectId) return false;
  if (state.planSavePromise) return state.planSavePromise;

  const savePromise = persistRunPlanChanges();
  state.planSavePromise = savePromise;
  try {
    return await savePromise;
  } finally {
    if (state.planSavePromise === savePromise) state.planSavePromise = null;
  }
}

async function persistRunPlanChanges() {
  const projectId = state.selectedProjectId;

  while (state.planDirty && state.selectedProjectId === projectId) {
    const revision = state.planRevision;
    const services = state.serviceDraft.map((service) => ({
      command: service.type === 'command' ? String(service.command || '').trim() : '',
      id: service.id,
      name: String(service.name || '').trim(),
      primary: service.primary === true,
      type: service.type,
      url: String(service.url || '').trim(),
      workingDirectory: String(service.workingDirectory || '.').trim() || '.',
    }));
    const validationError = validateServices(services);
    if (validationError) {
      setSaveState(elements['plan-save-state'], 'error', 'Needs attention');
      showToast(validationError, 'error');
      return false;
    }

    setSaveState(elements['plan-save-state'], 'saving', 'Saving…');
    elements['save-plan-button'].disabled = true;
    try {
      const detail = await api(`/api/projects/${encodeURIComponent(projectId)}`, {
        body: { services },
        method: 'PATCH',
      });
      if (state.selectedProjectId !== projectId) return false;
      if (state.planRevision !== revision) continue;
      state.detail = detail;
      state.serviceDraft = clone(detail.project.services);
      state.serviceDraftProjectId = projectId;
      state.planDirty = false;
      setSaveState(elements['plan-save-state'], 'saved', 'Saved');
      renderServices();
      scheduleWorkspaceRefresh();
    } catch (error) {
      elements['save-plan-button'].disabled = false;
      setSaveState(elements['plan-save-state'], 'error', 'Could not save');
      showToast(error.message, 'error');
      return false;
    }
  }
  return !state.planDirty && state.selectedProjectId === projectId;
}

function validateServices(services) {
  if (!services.length) return 'Add at least one service.';
  if (services.length > MAX_SERVICES) return `A project can run at most ${MAX_SERVICES} services.`;
  if (services.filter((service) => service.primary).length !== 1) return 'Choose exactly one primary service.';
  if (services.some((service) => !service.name)) return 'Every service needs a name.';
  if (services.some((service) => service.type === 'command' && !service.command)) return 'Every command service needs a start command.';
  return '';
}

function renderLogs() {
  const logs = state.detail?.logs || [];
  elements['log-summary'].textContent = logs.length ? `${logs.length} lines from this session` : 'No output yet';
  if (!logs.length) {
    elements['logs-view'].replaceChildren(createElement('span', 'log-empty', 'Run the project to see service output.'));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of logs) {
    const line = createElement('div', 'log-line');
    line.dataset.stream = entry.stream || 'system';
    line.append(
      createElement('span', 'log-time', formatTime(entry.timestamp)),
      createElement('span', 'log-source', entry.serviceName || 'project'),
      createElement('span', 'log-message', entry.message || ''),
    );
    fragment.append(line);
  }
  elements['logs-view'].replaceChildren(fragment);
  if (elements['logs-details'].open) elements['logs-view'].scrollTop = elements['logs-view'].scrollHeight;
}

async function copyLogs() {
  const logs = state.detail?.logs || [];
  if (!logs.length) return;
  const text = logs.map((entry) => `${entry.timestamp} [${entry.serviceName || 'project'}] ${entry.message}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast('Session logs copied.');
  } catch (_error) {
    showToast('Could not copy logs.', 'error');
  }
}

async function toggleProject(projectId, forcedAction = '') {
  if (!projectId) return;
  const project = state.projects.find((candidate) => candidate.id === projectId);
  const status = runtimeStatus(project?.runtime || (state.detail?.project.id === projectId ? state.detail.runtime : null));
  const action = forcedAction || (ACTIVE_STATES.has(status) ? 'stop' : 'start');
  const pendingAction = state.busyProjects.get(projectId);
  if (pendingAction && !(pendingAction === 'start' && action === 'stop')) return;
  if (action === 'start' && project?.services?.some((service) => service.needsConfiguration || (service.type === 'command' && !service.command))) {
    if (state.selectedProjectId !== projectId && !await selectProject(projectId)) return;
    elements['run-plan-details'].open = true;
    showToast('Add the missing start command before running this project.', 'error');
    return;
  }
  state.busyProjects.set(projectId, action);
  renderWorkspace();
  if (state.detail?.project.id === projectId) renderProjectDetail();
  try {
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/${action}`, { method: 'POST' });
    if (action === 'stop') showToast('Project and related services stopped.');
    else if (runtimeStatus(result.runtime) === 'running') showToast('Project is ready for testing.');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    if (state.busyProjects.get(projectId) === action) state.busyProjects.delete(projectId);
    await refreshWorkspace();
  }
}

async function openProject(projectId) {
  if (!projectId) return;
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}/open`, { method: 'POST' });
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function deleteSelectedProject() {
  const project = state.detail?.project;
  if (!project) return;
  if (!window.confirm(`Remove "${project.name}" from Annotator Home? The source folder will not be deleted.`)) return;
  try {
    await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
    showToast('Project removed. Its source folder was left untouched.');
    state.selectedProjectId = null;
    state.detail = null;
    await refreshWorkspace({ showDetailLoading: true });
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function openAddProjectDialog() {
  elements['add-project-form'].reset();
  clearProjectFolder();
  elements['add-project-error'].hidden = true;
  elements['add-project-dialog'].showModal();
  setTimeout(() => elements['new-project-name'].focus(), 0);
}

function closeAddProjectDialog() {
  elements['add-project-dialog'].close();
}

async function chooseProjectFolder() {
  try {
    const folderPath = await window.annotatorDesktop.chooseFolder();
    if (!folderPath) return;
    elements['new-project-path'].value = folderPath;
    const display = elements['new-project-path-display'];
    display.dataset.empty = 'false';
    display.querySelector('.path-value').textContent = folderPath;
    display.title = folderPath;
    elements['clear-folder-button'].disabled = false;
    if (!elements['new-project-name'].value.trim()) {
      elements['new-project-name'].value = folderPath.split(/[\\/]/).filter(Boolean).pop() || 'Website';
    }
    updateCreateProjectButton();
  } catch (error) {
    showAddProjectError(error.message);
  }
}

function clearProjectFolder() {
  elements['new-project-path'].value = '';
  const display = elements['new-project-path-display'];
  display.dataset.empty = 'true';
  display.querySelector('.path-value').textContent = 'No folder selected';
  display.removeAttribute('title');
  elements['clear-folder-button'].disabled = true;
  updateCreateProjectButton();
}

function updateCreateProjectButton() {
  elements['create-project-button'].disabled = !elements['new-project-name'].value.trim() || !elements['new-project-path'].value;
}

async function createProject(event) {
  event.preventDefault();
  const name = elements['new-project-name'].value.trim();
  const sourcePath = elements['new-project-path'].value;
  if (!name || !sourcePath) return;
  const button = elements['create-project-button'];
  button.disabled = true;
  button.classList.add('is-busy');
  elements['add-project-error'].hidden = true;
  try {
    const detail = await api('/api/projects', {
      body: {
        name,
        projectNotes: elements['new-project-notes'].value,
        sourcePath,
      },
      method: 'POST',
    });
    closeAddProjectDialog();
    state.selectedProjectId = detail.project.id;
    state.detail = detail;
    state.serviceDraftProjectId = null;
    showToast(`${detail.project.name} added.`);
    await refreshWorkspace({ showDetailLoading: true });
  } catch (error) {
    showAddProjectError(error.message);
  } finally {
    button.classList.remove('is-busy');
    updateCreateProjectButton();
  }
}

function showAddProjectError(message) {
  elements['add-project-error'].textContent = message;
  elements['add-project-error'].hidden = false;
}

function showGlobalError(error) {
  elements['global-error-message'].textContent = error?.message || 'The local workspace could not be loaded.';
  elements['global-error'].hidden = false;
}

function hideGlobalError() {
  elements['global-error'].hidden = true;
}

function showToast(message, kind = 'success') {
  const toast = createElement('div', 'toast');
  toast.dataset.kind = kind;
  toast.append(createElement('span', '', String(message)));
  const closeButton = createElement('button', '', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Dismiss notification');
  const remove = () => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 170);
  };
  closeButton.addEventListener('click', remove);
  toast.append(closeButton);
  elements['toast-region'].append(toast);
  setTimeout(remove, kind === 'error' ? 6500 : 3500);
}

function handleKeyboardShortcut(event) {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
  const tagName = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) || elements['add-project-dialog'].open) return;
  event.preventDefault();
  elements['project-search'].focus();
}

function scheduleWorkspaceRefresh() {
  state.refreshQueued = true;
  if (!state.refreshing) setTimeout(() => refreshWorkspace(), 100);
}

function setSaveState(element, value, label) {
  element.dataset.state = value;
  element.textContent = label;
}

function runtimeStatus(runtime) {
  return runtime?.status || runtime?.state || 'stopped';
}

function humanizeStatus(status) {
  return {
    error: 'Needs attention',
    running: 'Running',
    starting: 'Starting',
    stopped: 'Stopped',
    stopping: 'Stopping',
  }[status] || status;
}

function lastActivityLabel(project) {
  const timestamp = project.summary?.lastAnnotationAt
    || project.runtime?.timestamps?.stoppedAt
    || project.runtime?.timestamps?.runningAt
    || project.updatedAt;
  return timestamp ? `Active ${compactRelativeDate(timestamp)}` : 'Not run yet';
}

function compactRelativeDate(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return 'Never';
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

function formatDate(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
}

function formatTime(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return '--:--:--';
  return new Intl.DateTimeFormat(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(timestamp));
}

function pageHost(urlValue) {
  try {
    return new URL(urlValue).host;
  } catch (_error) {
    return 'page';
  }
}

function pageLabel(urlValue) {
  try {
    const url = new URL(urlValue);
    return url.pathname || '/';
  } catch (_error) {
    return urlValue;
  }
}

function annotationSelector(annotation) {
  if (annotation.pageLevel || annotation.tag === 'page') return 'Whole page';
  const id = annotation.elId ? `#${annotation.elId}` : '';
  const classes = annotation.classes && annotation.classes !== 'N/A' ? annotation.classes : '';
  return `${annotation.tag || 'element'}${id}${classes}` || annotation.xpath || 'Element';
}

function createElement(tagName, className = '', text = '') {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== '') element.textContent = text;
  return element;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
