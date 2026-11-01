'use strict';

const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { loadCatalog } = require('./catalog');
const { download } = require('./download');
const { isNewer } = require('./version');
const { OrbitError, Codes, toPlainError } = require('./errors');

/**
 * Cœur du lanceur : tient le catalogue, l'état d'installation de chaque
 * logiciel et les opérations en cours. Les téléchargements peuvent se faire
 * en parallèle ; les installations/désinstallations passent une par une
 * (Windows Installer n'en accepte qu'une à la fois).
 *
 * Événements : « change » (état modifié), « finished » ({id, type, ok, error}).
 */
class Manager extends EventEmitter {
  constructor({ backend, fetch, catalogUrl, paths, allowLocalHttp = false, log = console }) {
    super();
    this.backend = backend;
    this.fetch = fetch;
    this.catalogUrl = catalogUrl;
    this.paths = paths; // { cache, downloads, logs }
    this.allowLocalHttp = allowLocalHttp;
    this.log = log;

    this.catalog = { apps: [], source: 'none', fetchedAt: null, error: null, warnings: [] };
    this.status = 'idle'; // idle | loading
    this.loadedOnce = false;
    this.detected = new Map();
    this.ops = new Map();
    this.errors = new Map();
    this.notices = new Map();
    this._chain = Promise.resolve();
    this._refreshing = null;
    this._emitTimer = null;
  }

  // ---------- état ----------

  emitChange() {
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this.emit('change');
    }, 80);
  }

  snapshot() {
    const key = this.backend.key;
    const apps = this.catalog.apps.map((app) => {
      const build = app.platforms[key] || null;
      const detected = this.detected.get(app.id) || null;
      const op = this.ops.get(app.id);
      return {
        id: app.id,
        name: app.name,
        color: app.color,
        icon: app.icon,
        category: app.category,
        summary: app.summary,
        description: app.description,
        homepage: app.homepage,
        releaseNotesUrl: app.releaseNotesUrl,
        available: !!build,
        latestVersion: build ? build.version : app.version || null,
        size: build ? build.size : 0,
        otherPlatforms: Object.keys(app.platforms).filter((k) => k !== key),
        installed: detected ? { version: detected.version } : null,
        updateAvailable: !!(build && detected && isNewer(build.version, detected.version)),
        op: op
          ? { type: op.type, phase: op.phase, received: op.received, total: op.total }
          : null,
        error: this.errors.get(app.id) || null,
        notice: this.notices.get(app.id) || null,
      };
    });
    return {
      platform: key,
      simulated: !!this.backend.simulated,
      status: this.status,
      loadedOnce: this.loadedOnce,
      catalog: {
        url: this.catalogUrl,
        source: this.catalog.source,
        fetchedAt: this.catalog.fetchedAt,
        error: this.catalog.error ? toPlainError(this.catalog.error) : null,
      },
      apps,
    };
  }

  updatesCount() {
    return this.snapshot().apps.filter((a) => a.updateAvailable).length;
  }

  hasActiveOps() {
    return this.ops.size > 0;
  }

  // ---------- catalogue ----------

  refresh() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      this.status = 'loading';
      this.emitChange();
      try {
        this.catalog = await loadCatalog({
          url: this.catalogUrl,
          fetch: this.fetch,
          cachePath: this.paths.cache,
          allowLocalHttp: this.allowLocalHttp,
        });
        for (const w of this.catalog.warnings) this.log.warn('[catalog]', w);
        if (this.catalog.error) this.log.warn('[catalog]', this.catalog.error.message);
        await this._rescan();
      } finally {
        this.status = 'idle';
        this.loadedOnce = true;
        this._refreshing = null;
        this.emitChange();
      }
    })();
    return this._refreshing;
  }

  async _rescan() {
    try {
      this.detected = await this.backend.scan(this.catalog.apps);
    } catch (err) {
      this.log.error('[scan]', err);
    }
  }

  // ---------- opérations ----------

  _exclusive(fn) {
    const run = this._chain.then(fn);
    this._chain = run.catch(() => {});
    return run;
  }

  _get(id) {
    const app = this.catalog.apps.find((a) => a.id === id);
    if (!app) throw new OrbitError(Codes.UNKNOWN, `Unknown app ${id}`);
    return app;
  }

  _logPath(id, type) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(this.paths.logs, `${id}-${type}-${stamp}.log`);
  }

  _fail(id, type, err) {
    const e = toPlainError(err);
    if (e.code !== Codes.CANCELLED) {
      this.errors.set(id, { ...e, op: type });
      this.log.error(`[${type}] ${id}:`, e.code, e.message);
    }
    this.emit('finished', { id, type, ok: false, error: e });
  }

  /** Installe le logiciel, ou le met à jour s'il est déjà présent. */
  async install(id) {
    if (this.ops.has(id)) return;
    const app = this._get(id);
    const build = app.platforms[this.backend.key];
    const type = this.detected.has(id) ? 'update' : 'install';
    this.errors.delete(id);
    if (!build) {
      this._fail(id, type, new OrbitError(Codes.NOT_SUPPORTED, 'No build for this platform'));
      this.emitChange();
      return;
    }

    const controller = new AbortController();
    const op = { type, phase: 'downloading', received: 0, total: build.size, controller };
    this.ops.set(id, op);
    this.emitChange();

    const ext = path.extname(new URL(build.url).pathname).toLowerCase();
    const safeVersion = build.version.replace(/[^0-9A-Za-z.-]/g, '_');
    const file = path.join(this.paths.downloads, `${id}-${safeVersion}${ext}`);
    try {
      await fsp.mkdir(this.paths.downloads, { recursive: true });
      await fsp.mkdir(this.paths.logs, { recursive: true });
      await download(build.url, file, {
        fetch: this.fetch,
        sha256: build.sha256,
        size: build.size,
        signal: controller.signal,
        onProgress: (received, total) => {
          op.received = received;
          op.total = total;
          this.emitChange();
        },
      });
      op.phase = 'queued';
      this.emitChange();
      const result = await this._exclusive(async () => {
        if (controller.signal.aborted) throw new OrbitError(Codes.CANCELLED, 'Cancelled');
        op.phase = 'installing';
        this.emitChange();
        return this.backend.install({
          app,
          build,
          file,
          detected: this.detected.get(id) || null,
          logPath: this._logPath(id, type),
        });
      });
      if (result && result.rebootRequired) this.notices.set(id, 'reboot');
      this.emit('finished', { id, type, ok: true, version: build.version });
    } catch (err) {
      this._fail(id, type, err);
    } finally {
      this.ops.delete(id);
      await fsp.rm(file, { force: true }).catch(() => {});
      await this._rescan();
      this.emitChange();
    }
  }

  update(id) {
    return this.install(id);
  }

  updateAll() {
    const ids = this.snapshot()
      .apps.filter((a) => a.updateAvailable && !a.op)
      .map((a) => a.id);
    return Promise.all(ids.map((id) => this.install(id)));
  }

  async uninstall(id) {
    if (this.ops.has(id)) return;
    const app = this._get(id);
    const build = app.platforms[this.backend.key];
    const op = { type: 'uninstall', phase: 'queued', received: 0, total: 0, controller: new AbortController() };
    this.errors.delete(id);
    this.notices.delete(id);
    this.ops.set(id, op);
    this.emitChange();
    try {
      await fsp.mkdir(this.paths.logs, { recursive: true });
      const result = await this._exclusive(async () => {
        if (op.controller.signal.aborted) throw new OrbitError(Codes.CANCELLED, 'Cancelled');
        const detected = this.detected.get(id);
        if (!detected) return null; // déjà désinstallé entre-temps
        op.phase = 'uninstalling';
        this.emitChange();
        return this.backend.uninstall({ app, build, detected, logPath: this._logPath(id, 'uninstall') });
      });
      if (result && result.rebootRequired) this.notices.set(id, 'reboot');
      this.emit('finished', { id, type: 'uninstall', ok: true });
    } catch (err) {
      this._fail(id, 'uninstall', err);
    } finally {
      this.ops.delete(id);
      await this._rescan();
      this.emitChange();
    }
  }

  /** Annule un téléchargement ou une opération en attente. */
  cancel(id) {
    const op = this.ops.get(id);
    if (op && (op.phase === 'downloading' || op.phase === 'queued')) op.controller.abort();
  }

  async launch(id) {
    const app = this._get(id);
    const detected = this.detected.get(id);
    if (!detected) return;
    try {
      await this.backend.launch({ app, build: app.platforms[this.backend.key], detected });
    } catch (err) {
      this.errors.set(id, { ...toPlainError(err), op: 'launch' });
      this.emitChange();
    }
  }

  dismiss(id) {
    this.errors.delete(id);
    this.notices.delete(id);
    this.emitChange();
  }
}

module.exports = { Manager };
