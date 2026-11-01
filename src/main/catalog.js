'use strict';

const fsp = require('node:fs/promises');
const { OrbitError, Codes } = require('./errors');

/*
 * Le catalogue est un fichier JSON public (voir catalog/README.md) qui décrit
 * chaque logiciel de la suite : version, liens de téléchargement par système,
 * empreinte SHA-256, textes en français et en anglais.
 */

const SCHEMA_VERSION = 1;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA_RE = /^[a-f0-9]{64}$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const PLATFORMS = ['windows', 'macos'];
const ARG_RE = /^[/-][A-Za-z0-9_=:.-]{0,40}$/;

function isAllowedUrl(u, { allowLocalHttp }) {
  try {
    const url = new URL(u);
    if (url.protocol === 'https:') return true;
    return (
      allowLocalHttp &&
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function text(v) {
  if (typeof v === 'string') return { fr: v, en: v };
  if (v && typeof v === 'object') {
    const fr = typeof v.fr === 'string' ? v.fr : typeof v.en === 'string' ? v.en : '';
    const en = typeof v.en === 'string' ? v.en : fr;
    return { fr, en };
  }
  return { fr: '', en: '' };
}

function resolveUrl(u, base) {
  if (typeof u !== 'string' || !u) return null;
  try {
    return new URL(u, base).toString();
  } catch {
    return null;
  }
}

function normalizeBuild(key, raw, app, opts) {
  if (!raw || typeof raw !== 'object') return null;
  const url = resolveUrl(raw.url, opts.baseUrl);
  if (!url || !isAllowedUrl(url, opts)) throw new Error(`${key}: invalid url`);
  if (!SHA_RE.test(raw.sha256 || '')) throw new Error(`${key}: invalid sha256`);
  const build = {
    url,
    sha256: raw.sha256.toLowerCase(),
    size: Number(raw.size) > 0 ? Number(raw.size) : 0,
    version: typeof raw.version === 'string' && raw.version ? raw.version : app.version,
  };
  if (!build.version) throw new Error(`${key}: missing version`);
  if (key === 'windows') {
    if (typeof raw.displayName !== 'string' && typeof raw.displayNamePattern !== 'string') {
      throw new Error('windows: displayName or displayNamePattern required');
    }
    if (raw.displayName) build.displayName = raw.displayName;
    if (raw.displayNamePattern) {
      new RegExp(raw.displayNamePattern, 'i'); // valide l'expression
      build.displayNamePattern = raw.displayNamePattern;
    }
    if (typeof raw.executable === 'string') build.executable = raw.executable;
    for (const k of ['installerArgs', 'uninstallerArgs']) {
      if (raw[k] === undefined) continue;
      // Options de ligne de commande simples uniquement (ex. "/P", "/S", "--silent").
      if (!Array.isArray(raw[k]) || !raw[k].every((a) => typeof a === 'string' && ARG_RE.test(a))) {
        throw new Error(`windows: invalid ${k}`);
      }
      build[k] = raw[k];
    }
  } else if (key === 'macos') {
    if (typeof raw.appName !== 'string' || !/\.app$/.test(raw.appName) || raw.appName.includes('/')) {
      throw new Error('macos: appName must look like "Name.app"');
    }
    build.appName = raw.appName;
    if (typeof raw.bundleId === 'string') build.bundleId = raw.bundleId;
  }
  return build;
}

function normalizeApp(raw, opts) {
  if (!raw || typeof raw !== 'object') throw new Error('not an object');
  if (!ID_RE.test(raw.id || '')) throw new Error(`invalid id "${raw.id}"`);
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('missing name');
  const app = {
    id: raw.id,
    name: raw.name.trim(),
    version: typeof raw.version === 'string' ? raw.version : '',
    color: COLOR_RE.test(raw.color || '') ? raw.color : '#4b3fd6',
    icon: null,
    category: text(raw.category),
    summary: text(raw.summary),
    description: text(raw.description),
    homepage: null,
    releaseNotesUrl: null,
    platforms: {},
  };
  for (const k of ['icon', 'homepage', 'releaseNotesUrl']) {
    const u = resolveUrl(raw[k], opts.baseUrl);
    if (u && isAllowedUrl(u, opts)) app[k] = u;
  }
  for (const key of PLATFORMS) {
    const b = normalizeBuild(key, raw.platforms && raw.platforms[key], app, opts);
    if (b) app.platforms[key] = b;
  }
  return app;
}

/**
 * Valide et normalise un catalogue. Les entrées invalides sont ignorées
 * (et listées dans `warnings`) pour qu'une erreur sur un logiciel ne bloque
 * pas toute la suite.
 */
function parseCatalog(json, opts = {}) {
  let data = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json);
    } catch (e) {
      throw new OrbitError(Codes.CATALOG_INVALID, 'Invalid JSON: ' + e.message);
    }
  }
  if (!data || data.schemaVersion !== SCHEMA_VERSION || !Array.isArray(data.apps)) {
    throw new OrbitError(Codes.CATALOG_INVALID, `Unsupported catalog (schemaVersion ${data && data.schemaVersion})`);
  }
  const apps = [];
  const warnings = [];
  const seen = new Set();
  for (const raw of data.apps) {
    try {
      const app = normalizeApp(raw, opts);
      if (seen.has(app.id)) throw new Error('duplicate id');
      seen.add(app.id);
      apps.push(app);
    } catch (e) {
      warnings.push(`${(raw && raw.id) || '?'}: ${e.message}`);
    }
  }
  return { apps, warnings, generatedAt: data.generatedAt || null };
}

/**
 * Charge le catalogue depuis le réseau ; en cas d'échec, utilise la dernière
 * copie enregistrée (mode hors ligne).
 */
async function loadCatalog({ url, fetch, cachePath, allowLocalHttp = false, timeoutMs = 15000 }) {
  const opts = { baseUrl: url, allowLocalHttp };
  let networkError = null;
  try {
    if (!isAllowedUrl(url, opts)) throw new OrbitError(Codes.CATALOG_INVALID, 'Catalog URL must use https');
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new OrbitError(Codes.HTTP, `HTTP ${res.status}`, { status: res.status });
    const body = await res.text();
    const parsed = parseCatalog(body, opts);
    const fetchedAt = new Date().toISOString();
    if (cachePath) {
      await fsp
        .writeFile(cachePath, JSON.stringify({ url, fetchedAt, body }), 'utf8')
        .catch(() => {});
    }
    return { ...parsed, source: 'network', fetchedAt, error: null };
  } catch (err) {
    networkError =
      err instanceof OrbitError ? err : new OrbitError(Codes.NETWORK, err.message || String(err));
  }
  if (cachePath) {
    try {
      const cached = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      if (cached.url === url) {
        const parsed = parseCatalog(cached.body, opts);
        return { ...parsed, source: 'cache', fetchedAt: cached.fetchedAt, error: networkError };
      }
    } catch {
      /* pas de cache utilisable */
    }
  }
  return { apps: [], warnings: [], source: 'none', fetchedAt: null, error: networkError };
}

module.exports = { parseCatalog, loadCatalog, isAllowedUrl, SCHEMA_VERSION };
