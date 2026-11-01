'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { compare, isNewer } = require('../src/main/version');
const { parseCatalog, loadCatalog } = require('../src/main/catalog');
const { download } = require('../src/main/download');
const { Manager } = require('../src/main/manager');
const { createSimulatedBackend } = require('../src/main/platform/simulated');
const win = require('../src/main/platform/windows')._test;
const mac = require('../src/main/platform/macos')._test;
const { serve, sha256 } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-test-'));
const SHA = 'a'.repeat(64);

// ---------- versions ----------

test('compare les versions', () => {
  assert.equal(compare('1.2.3', '1.2.3'), 0);
  assert.equal(compare('v1.10.0', '1.9.9'), 1);
  assert.equal(compare('2.0', '2.0.0.0'), 0); // MSI à 4 nombres
  assert.equal(compare('2.0.0-beta.2', '2.0.0'), -1);
  assert.equal(compare('2.0.0-beta.10', '2.0.0-beta.2'), 1);
  assert.equal(compare('2.0.0-alpha', '2.0.0-beta'), -1);
  assert.ok(isNewer('2.4.0', '2.3.9'));
  assert.ok(!isNewer('2.4.0', '2.4.0'));
});

// ---------- catalogue ----------

const validApp = (over = {}) => ({
  id: 'pixel-atelier',
  name: 'Pixel Atelier',
  version: '2.4.0',
  summary: { fr: 'Retouche', en: 'Editing' },
  icon: 'icons/pa.png',
  platforms: {
    windows: { url: 'https://example.org/pa.msi', sha256: SHA, size: 10, displayName: 'Pixel Atelier' },
    macos: { url: 'https://example.org/pa.dmg', sha256: SHA, size: 10, appName: 'Pixel Atelier.app' },
  },
  ...over,
});

test('catalogue : normalise et résout les adresses relatives', () => {
  const r = parseCatalog({ schemaVersion: 1, apps: [validApp()] }, { baseUrl: 'https://cdn.example.org/catalog/catalog.json' });
  assert.equal(r.apps.length, 1);
  assert.equal(r.apps[0].icon, 'https://cdn.example.org/catalog/icons/pa.png');
  assert.equal(r.apps[0].platforms.windows.version, '2.4.0');
  assert.deepEqual(r.apps[0].category, { fr: '', en: '' });
});

test('catalogue : ignore les entrées invalides sans bloquer les autres', () => {
  const bad = [
    validApp({ id: 'Bad Id' }),
    validApp({ id: 'http', platforms: { windows: { url: 'http://example.org/x.msi', sha256: SHA, displayName: 'X' } } }),
    validApp({ id: 'nosha', platforms: { windows: { url: 'https://example.org/x.msi', sha256: 'abc', displayName: 'X' } } }),
    validApp({ id: 'macbad', platforms: { macos: { url: 'https://example.org/x.dmg', sha256: SHA, appName: '../x.app' } } }),
    validApp({ id: 'ok' }),
    validApp({ id: 'ok' }),
  ];
  const r = parseCatalog({ schemaVersion: 1, apps: bad }, { baseUrl: 'https://example.org/c.json' });
  assert.deepEqual(r.apps.map((a) => a.id), ['ok']);
  assert.equal(r.warnings.length, 5);
});

test('catalogue : refuse un schéma inconnu', () => {
  assert.throws(() => parseCatalog({ schemaVersion: 2, apps: [] }), { code: 'CATALOG_INVALID' });
  assert.throws(() => parseCatalog('{oops'), { code: 'CATALOG_INVALID' });
});

test('catalogue : utilise la copie locale quand le réseau échoue', async () => {
  const dir = tmp();
  const cachePath = path.join(dir, 'cache.json');
  const srv = await serve({
    '/c.json': (req, res) => res.end(JSON.stringify({ schemaVersion: 1, apps: [validApp()] })),
  });
  const url = `${srv.base}/c.json`;
  const first = await loadCatalog({ url, fetch, cachePath, allowLocalHttp: true });
  assert.equal(first.source, 'network');
  await srv.close();
  const second = await loadCatalog({ url, fetch, cachePath, allowLocalHttp: true, timeoutMs: 2000 });
  assert.equal(second.source, 'cache');
  assert.equal(second.apps.length, 1);
  assert.equal(second.error.code, 'NETWORK');
});

test('catalogue : refuse une adresse http hors développement', async () => {
  const r = await loadCatalog({ url: 'http://127.0.0.1:1/c.json', fetch });
  assert.equal(r.source, 'none');
  assert.equal(r.error.code, 'CATALOG_INVALID');
});

// ---------- téléchargement ----------

test('téléchargement : vérifie le SHA-256 et rapporte la progression', async () => {
  const body = crypto.randomBytes(300_000);
  const srv = await serve({ '/f.msi': (req, res) => res.end(body) });
  const dest = path.join(tmp(), 'f.msi');
  let last = 0;
  const r = await download(`${srv.base}/f.msi`, dest, { fetch, sha256: sha256(body), onProgress: (n) => (last = n) });
  assert.equal(r.size, body.length);
  assert.equal(last, body.length);
  assert.ok(fs.readFileSync(dest).equals(body));
  assert.ok(!fs.existsSync(dest + '.part'));
  await srv.close();
});

test('téléchargement : rejette un fichier modifié', async () => {
  const srv = await serve({ '/f.msi': (req, res) => res.end('contenu piégé') });
  const dest = path.join(tmp(), 'f.msi');
  await assert.rejects(download(`${srv.base}/f.msi`, dest, { fetch, sha256: SHA }), { code: 'CHECKSUM' });
  assert.ok(!fs.existsSync(dest));
  assert.ok(!fs.existsSync(dest + '.part'));
  await srv.close();
});

test('téléchargement : erreurs HTTP et annulation', async () => {
  const srv = await serve({
    '/slow': (req, res) => {
      res.writeHead(200, { 'Content-Length': 10_000_000 });
      res.write(Buffer.alloc(1000));
    },
  });
  const dir = tmp();
  await assert.rejects(download(`${srv.base}/absent`, path.join(dir, 'a'), { fetch, sha256: SHA }), { code: 'HTTP' });
  const ctrl = new AbortController();
  const p = download(`${srv.base}/slow`, path.join(dir, 'b'), {
    fetch, sha256: SHA, signal: ctrl.signal, onProgress: () => ctrl.abort(),
  });
  await assert.rejects(p, { code: 'CANCELLED' });
  assert.ok(!fs.existsSync(path.join(dir, 'b.part')));
  await srv.close();
});

// ---------- gestionnaire (installation simulée) ----------

async function setupManager({ seed, failId } = {}) {
  const dir = tmp();
  const body = crypto.randomBytes(50_000);
  const app = (id, version) => validApp({
    id,
    name: id,
    version,
    platforms: { windows: { url: `/files/${id}.msi`, sha256: sha256(body), size: body.length, displayName: id } },
  });
  const catalog = { schemaVersion: 1, apps: [app('alpha', '2.0.0'), app('beta', '1.0.0'), app('gamma', '3.0.0')] };
  const srv = await serve({
    '/catalog.json': (req, res) => res.end(JSON.stringify(catalog)),
    '/files/alpha.msi': (req, res) => res.end(body),
    '/files/beta.msi': (req, res) => res.end(body),
    '/files/gamma.msi': (req, res) => res.end(body),
  });
  if (failId) process.env.ORBIT_SIMULATE_FAIL = failId;
  const backend = createSimulatedBackend({ statePath: path.join(dir, 'state.json'), delayMs: 20, seed });
  const m = new Manager({
    backend,
    fetch,
    catalogUrl: `${srv.base}/catalog.json`,
    allowLocalHttp: true,
    paths: { cache: path.join(dir, 'cache.json'), downloads: path.join(dir, 'dl'), logs: path.join(dir, 'logs') },
    log: { warn() {}, error() {} },
  });
  await m.refresh();
  return { m, srv, dir };
}
const byId = (m, id) => m.snapshot().apps.find((a) => a.id === id);

test('gestionnaire : installe, détecte les mises à jour, met à jour et désinstalle', async () => {
  const { m, srv, dir } = await setupManager({ seed: { alpha: { version: '1.5.0' } } });
  assert.equal(byId(m, 'alpha').updateAvailable, true);
  assert.equal(m.updatesCount(), 1);
  assert.equal(byId(m, 'beta').installed, null);

  const events = [];
  m.on('finished', (e) => events.push(e));
  await Promise.all([m.install('beta'), m.update('alpha')]);
  assert.equal(byId(m, 'beta').installed.version, '1.0.0');
  assert.equal(byId(m, 'alpha').installed.version, '2.0.0');
  assert.equal(m.updatesCount(), 0);
  assert.deepEqual(events.map((e) => `${e.id}:${e.type}:${e.ok}`).sort(), ['alpha:update:true', 'beta:install:true']);
  assert.equal(fs.readdirSync(path.join(dir, 'dl')).length, 0, 'les installateurs téléchargés sont supprimés');

  await m.uninstall('beta');
  assert.equal(byId(m, 'beta').installed, null);
  await srv.close();
});

test('gestionnaire : une erreur d’installation est conservée et affichable', async () => {
  const { m, srv } = await setupManager({ failId: 'gamma' });
  await m.install('gamma');
  delete process.env.ORBIT_SIMULATE_FAIL;
  const g = byId(m, 'gamma');
  assert.equal(g.installed, null);
  assert.equal(g.error.code, 'INSTALL_FAILED');
  assert.equal(g.error.op, 'install');
  assert.equal(g.op, null);
  m.dismiss('gamma');
  assert.equal(byId(m, 'gamma').error, null);
  await srv.close();
});

test('gestionnaire : les installations passent une par une', async () => {
  const { m, srv } = await setupManager();
  let active = 0;
  let maxActive = 0;
  const orig = m.backend.install;
  m.backend.install = async (args) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      return await orig(args);
    } finally {
      active--;
    }
  };
  await Promise.all(['alpha', 'beta', 'gamma'].map((id) => m.install(id)));
  assert.equal(maxActive, 1);
  assert.equal(m.snapshot().apps.filter((a) => a.installed).length, 3);
  await srv.close();
});

// ---------- utilitaires de plateforme ----------

test('Windows : association au registre et exécutable', () => {
  assert.ok(win.matches({ displayName: 'Pixel Atelier' }, { DisplayName: 'pixel atelier' }));
  assert.ok(win.matches({ displayNamePattern: '^Pixel Atelier( \\d+)?$' }, { DisplayName: 'Pixel Atelier 2' }));
  assert.ok(!win.matches({ displayName: 'Pixel' }, { DisplayName: 'Pixel Atelier' }));
  assert.equal(win.exeFromDisplayIcon('"C:\\Apps\\PA\\pa.exe",0'), 'C:\\Apps\\PA\\pa.exe');
  assert.equal(win.exeFromDisplayIcon('C:\\Apps\\PA\\pa.ico'), null);
  assert.deepEqual(win.checkMsiExit(3010, 'INSTALL_FAILED'), { rebootRequired: true });
  assert.throws(() => win.checkMsiExit(1602, 'INSTALL_FAILED'), { code: 'CANCELLED' });
  assert.throws(() => win.checkMsiExit(1618, 'INSTALL_FAILED'), { code: 'INSTALLER_BUSY' });
  assert.throws(() => win.checkMsiExit(1603, 'INSTALL_FAILED'), { code: 'INSTALL_FAILED' });
});

test('macOS : échappement des commandes', () => {
  assert.equal(mac.shq("L'Atelier.app"), `'L'\\''Atelier.app'`);
  assert.equal(mac.asq('a "b" \\c'), '"a \\"b\\" \\\\c"');
  assert.equal(mac.reEscape('/Applications/A (1).app'), '/Applications/A \\(1\\)\\.app');
});
