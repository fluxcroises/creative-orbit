'use strict';

const fs = require('node:fs');

const DEFAULTS = Object.freeze({
  language: 'auto', // auto | fr | en
  theme: 'dark', // dark | light | system
  launchAtLogin: false,
  runInBackground: true, // fermer la fenêtre laisse le lanceur dans la barre des tâches / des menus
  autoCheck: true, // vérifie les mises à jour toutes les 6 heures
  catalogUrl: '', // vide = adresse définie dans package.json
  onboarded: false, // écran d'accueil déjà vu
});

const VALIDATORS = {
  language: (v) => ['auto', 'fr', 'en'].includes(v),
  theme: (v) => ['dark', 'light', 'system'].includes(v),
  launchAtLogin: (v) => typeof v === 'boolean',
  runInBackground: (v) => typeof v === 'boolean',
  autoCheck: (v) => typeof v === 'boolean',
  catalogUrl: (v) => typeof v === 'string' && (v === '' || /^https:\/\//.test(v)),
  onboarded: (v) => typeof v === 'boolean',
};

class Settings {
  constructor(file) {
    this.file = file;
    this.values = { ...DEFAULTS };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this._merge(saved);
    } catch {
      /* premier lancement */
    }
  }

  _merge(patch) {
    const changed = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (VALIDATORS[k] && VALIDATORS[k](v) && this.values[k] !== v) {
        this.values[k] = v;
        changed[k] = v;
      }
    }
    return changed;
  }

  get() {
    return { ...this.values };
  }

  /** Applique les clés valides et renvoie celles qui ont changé. */
  set(patch) {
    const changed = this._merge(patch);
    if (Object.keys(changed).length) {
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
    }
    return changed;
  }
}

module.exports = { Settings, DEFAULTS };
