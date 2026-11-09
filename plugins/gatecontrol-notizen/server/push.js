'use strict';

// What a push of the plugin carries to open its page (1.1.0, README "Pushes"): data.notizen = { kind, area, taskId |
// listId | notebookId | vaultId, … } — with the keys of 1.0 (task, list, notebook, vault) kept for older apps.
//   reminder          (topic reminders) { kind, taskId, listId, area }
//   assigned          (topic shared)    { kind, taskId, listId, area }
//   shared_list       (topic shared)    { kind, listId, area }
//   shared_notebook   (topic shared)    { kind, notebookId, area, vaultId? }
//   vault_request     (topic vault)     { kind, vaultId, notebookId, deviceId, area }
//   listday           (topic listday)   { kind, listId, area, day } (1.2.0: the morning of a list day, „Heute ist Einkaufstag“)

const reminder = (task, area) => ({ kind: 'reminder', taskId: task.id, listId: task.list_id, area: area || null, task: task.id });
const assigned = (taskId, listId, area) => ({ kind: 'assigned', taskId, listId, area: area || null, task: taskId });
const sharedList = (list) => ({ kind: 'shared_list', listId: list.id, area: list.area || null, list: list.id });
const sharedNotebook = (nb) => ({ kind: 'shared_notebook', notebookId: nb.id, area: nb.area || null, ...(nb.vault_id ? { vaultId: nb.vault_id } : {}), notebook: nb.id });
const vaultRequest = (nb, deviceId) => ({
  kind: 'vault_request', vaultId: nb.vault_id, notebookId: nb.id, deviceId, area: nb.area || null, vault: nb.vault_id, notebook: nb.id, event: 'request',
});

const listDay = (list, day) => ({ kind: 'listday', listId: list.id, area: list.area || null, day, list: list.id });

module.exports = { reminder, assigned, sharedList, sharedNotebook, vaultRequest, listDay };
