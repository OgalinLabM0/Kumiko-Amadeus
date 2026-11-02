'use strict';
function createCredentialRequestRegistry() {
  const owners = new Map();
  return {
    async run(sender, id, work) {
      if (!sender || typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid request identity.');
      let requests = owners.get(sender); if (!requests) { requests = new Map(); owners.set(sender, requests); }
      if (requests.has(id)) throw new Error('Duplicate request identity.');
      const controller = new AbortController(); requests.set(id, controller);
      try { return await work(controller.signal); }
      finally { requests.delete(id); if (!requests.size) owners.delete(sender); }
    },
    cancel(sender, id) { const controller = owners.get(sender)?.get(id); if (!controller) return false; controller.abort(); return true; },
  };
}
module.exports = { createCredentialRequestRegistry };
