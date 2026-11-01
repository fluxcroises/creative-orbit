'use strict';

/*
 * Système simulé : utilisé pour la démo (npm run demo), les tests, et sous
 * Linux. Les téléchargements sont réels (avec vérification SHA-256) mais
 * l'« installation » est seulement enregistrée dans un fichier JSON.
 */

const fsp = require('node:fs/promises');
const { OrbitError, Codes } = require('../errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createSimulatedBackend({ statePath, as = 'windows', delayMs = 1500, onLaunch, seed = null } = {}) {
  async function load() {
    try {
      return JSON.parse(await fsp.readFile(statePath, 'utf8'));
    } catch {
      // Premier lancement de la démo : état initial facultatif (ex. une version ancienne
      // déjà « installée » pour montrer une mise à jour).
      return seed ? { ...seed } : {};
    }
  }
  const save = (s) => fsp.writeFile(statePath, JSON.stringify(s, null, 2));

  return {
    key: as,
    simulated: true,

    async scan(apps) {
      const s = await load();
      const result = new Map();
      for (const app of apps) if (s[app.id]) result.set(app.id, { version: s[app.id].version });
      return result;
    },

    async install({ app, build }) {
      await sleep(delayMs);
      if (process.env.ORBIT_SIMULATE_FAIL === app.id) {
        throw new OrbitError(Codes.INSTALL_FAILED, 'Simulated failure', { exitCode: 1603 });
      }
      const s = await load();
      s[app.id] = { version: build.version, installedAt: new Date().toISOString() };
      await save(s);
      return { rebootRequired: false };
    },

    async uninstall({ app }) {
      await sleep(delayMs / 2);
      const s = await load();
      delete s[app.id];
      await save(s);
      return { rebootRequired: false };
    },

    async launch({ app }) {
      if (onLaunch) onLaunch(app);
    },
  };
}

module.exports = { createSimulatedBackend };
