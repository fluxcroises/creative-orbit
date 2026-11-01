#!/usr/bin/env node
/*
 * Génère catalog/catalog.json à partir de catalog/apps.json et des dernières
 * Releases GitHub de chaque logiciel.
 *
 *   node scripts/build-catalog.mjs            (ou npm run catalog)
 *
 * Variable facultative : GITHUB_TOKEN (évite la limite de 60 requêtes/heure ;
 * fournie automatiquement dans GitHub Actions).
 *
 * Pour chaque logiciel, le script prend la dernière Release publiée (ni brouillon,
 * ni préversion), repère le .msi et le .dmg grâce aux motifs `asset`, et récupère
 * leur empreinte SHA-256 (fournie par GitHub, sinon calculée en téléchargeant le
 * fichier). Si un dépôt est injoignable, l'entrée précédente est conservée.
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseCatalog } = require('../src/main/catalog.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'catalog', 'apps.json');
const OUTPUT = path.join(root, 'catalog', 'catalog.json');
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'creative-orbit-catalog',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

async function latestRelease(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repo}`);
  return res.json();
}

async function sha256Of(asset) {
  if (typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) return asset.digest.slice(7);
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': headers['User-Agent'] } });
  if (!res.ok) throw new Error(`Download ${res.status} for ${asset.name}`);
  const hash = crypto.createHash('sha256');
  for await (const chunk of res.body) hash.update(chunk);
  return hash.digest('hex');
}

async function buildPlatform(release, spec, extra) {
  if (!spec) return null;
  const re = new RegExp(spec.asset, 'i');
  const asset = release.assets.find((a) => re.test(a.name));
  if (!asset) {
    console.warn(`  ! aucun fichier ne correspond à /${spec.asset}/ dans ${release.tag_name}`);
    return null;
  }
  return { url: asset.browser_download_url, sha256: await sha256Of(asset), size: asset.size, ...extra };
}

async function main() {
  const source = JSON.parse(await fs.readFile(SOURCE, 'utf8'));
  let previous = { apps: [] };
  try {
    previous = JSON.parse(await fs.readFile(OUTPUT, 'utf8'));
  } catch {
    /* premier passage */
  }

  const apps = [];
  let failures = 0;
  for (const def of source.apps) {
    console.log(`• ${def.name} (${def.repo})`);
    try {
      const rel = await latestRelease(def.repo);
      const version = String(rel.tag_name).replace(/^v/i, '');
      const { windows: win, macos: mac } = def;
      const platforms = {};
      const w = await buildPlatform(rel, win, {
        displayName: win && win.displayName,
        ...(win && win.displayNamePattern ? { displayNamePattern: win.displayNamePattern } : {}),
        ...(win && win.executable ? { executable: win.executable } : {}),
      });
      if (w) platforms.windows = w;
      const m = await buildPlatform(rel, mac, {
        appName: mac && mac.appName,
        ...(mac && mac.bundleId ? { bundleId: mac.bundleId } : {}),
      });
      if (m) platforms.macos = m;
      apps.push({
        id: def.id,
        name: def.name,
        version,
        color: def.color,
        icon: def.icon,
        category: def.category,
        summary: def.summary,
        description: def.description,
        homepage: def.homepage || `https://github.com/${def.repo}`,
        releaseNotesUrl: rel.html_url,
        platforms,
      });
      console.log(`  version ${version} : ${Object.keys(platforms).join(', ') || 'aucun fichier'}`);
    } catch (err) {
      failures++;
      const old = previous.apps.find((a) => a.id === def.id);
      console.warn(`  ! ${err.message}${old ? ' (entrée précédente conservée)' : ''}`);
      if (old) apps.push(old);
    }
  }

  const catalog = { schemaVersion: 1, generatedAt: new Date().toISOString(), apps };
  // Vérifie que le lanceur acceptera le résultat.
  const check = parseCatalog(catalog, { baseUrl: 'https://example.invalid/catalog.json' });
  for (const w of check.warnings) console.warn('  ! entrée ignorée par le lanceur :', w);

  const before = JSON.stringify({ ...previous, generatedAt: null });
  const after = JSON.stringify({ ...catalog, generatedAt: null });
  if (before === after) {
    console.log('Catalogue inchangé.');
  } else {
    await fs.writeFile(OUTPUT, JSON.stringify(catalog, null, 2) + '\n');
    console.log(`Catalogue écrit : ${path.relative(root, OUTPUT)} (${apps.length} logiciels)`);
  }
  if (failures && failures === source.apps.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
