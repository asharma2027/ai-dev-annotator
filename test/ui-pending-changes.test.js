'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { saveBeforeProjectChange } = require('../desktop-app/ui/pending-changes');

function createOptions(overrides = {}) {
  let currentProjectId = 'project-a';
  return {
    getProjectId: () => currentProjectId,
    hasBriefChanges: () => false,
    hasPlanChanges: () => false,
    projectId: 'project-a',
    saveBrief: async () => true,
    savePlan: async () => true,
    setProjectId: (projectId) => { currentProjectId = projectId; },
    ...overrides,
  };
}

test('a failed brief save prevents switching and does not attempt the run plan save', async () => {
  let planSaveCount = 0;
  const options = createOptions({
    hasBriefChanges: () => true,
    hasPlanChanges: () => true,
    saveBrief: async () => false,
    savePlan: async () => { planSaveCount += 1; return true; },
  });

  assert.equal(await saveBeforeProjectChange(options), false);
  assert.equal(planSaveCount, 0);
});

test('dirty brief and run plan are both saved before switching', async () => {
  const saves = [];
  let briefDirty = true;
  let planDirty = true;
  const options = createOptions({
    hasBriefChanges: () => briefDirty,
    hasPlanChanges: () => planDirty,
    saveBrief: async () => { saves.push('brief'); briefDirty = false; return true; },
    savePlan: async () => { saves.push('plan'); planDirty = false; return true; },
  });

  assert.equal(await saveBeforeProjectChange(options), true);
  assert.deepEqual(saves, ['brief', 'plan']);
});

test('a failed run plan save prevents switching', async () => {
  const options = createOptions({
    hasPlanChanges: () => true,
    savePlan: async () => false,
  });

  assert.equal(await saveBeforeProjectChange(options), false);
});

test('an unexpected selection change while saving aborts the transition', async () => {
  const options = createOptions({ hasBriefChanges: () => true });
  options.saveBrief = async () => {
    options.setProjectId('project-c');
    return true;
  };

  assert.equal(await saveBeforeProjectChange(options), false);
});

test('an edit made while the other surface saves is flushed before closing', async () => {
  let briefDirty = true;
  let planDirty = true;
  let briefSaves = 0;
  const options = createOptions({
    hasBriefChanges: () => briefDirty,
    hasPlanChanges: () => planDirty,
    saveBrief: async () => {
      briefSaves += 1;
      briefDirty = false;
      return true;
    },
    savePlan: async () => {
      planDirty = false;
      briefDirty = true;
      return true;
    },
  });

  assert.equal(await saveBeforeProjectChange(options), true);
  assert.equal(briefSaves, 2);
  assert.equal(briefDirty, false);
  assert.equal(planDirty, false);
});

test('a save that never clears its dirty flag cannot approve closing', async () => {
  let attempts = 0;
  const options = createOptions({
    hasBriefChanges: () => true,
    saveBrief: async () => { attempts += 1; return true; },
  });

  assert.equal(await saveBeforeProjectChange(options), false);
  assert.equal(attempts, 20);
});
