'use strict';

async function saveBeforeProjectChange(options) {
  const {
    getProjectId,
    hasBriefChanges,
    hasPlanChanges,
    projectId,
    saveBrief,
    savePlan,
  } = options;

  if (!projectId) return true;
  for (let pass = 0; pass < 20 && getProjectId() === projectId; pass += 1) {
    if (hasBriefChanges() && !await saveBrief()) return false;
    if (getProjectId() !== projectId) return false;
    if (hasPlanChanges() && !await savePlan()) return false;
    if (getProjectId() !== projectId) return false;
    if (!hasBriefChanges() && !hasPlanChanges()) return true;
  }
  return false;
}

const pendingChanges = { saveBeforeProjectChange };

if (typeof module === 'object' && module.exports) {
  module.exports = pendingChanges;
} else {
  globalThis.AnnotatorPendingChanges = pendingChanges;
}
