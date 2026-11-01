#!/usr/bin/env node
/*
 * Démo de Creative Orbit sans vrais logiciels :
 *   npm run demo
 *
 * Lance un petit serveur local qui sert un catalogue d'exemple et de faux
 * installateurs (téléchargés pour de vrai, avec vérification SHA-256),
 * puis ouvre le lanceur en mode simulé : rien n'est réellement installé.
 *
 * Options : --server-only (serveur seul), --port=4777
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}`));
const PORT = Number((arg('port') || '').split('=')[1]) || 4777;
const BASE = `http://127.0.0.1:${PORT}`;
const MB = 1024 * 1024;

// Logiciels fictifs pour la démonstration.
const DEMO_APPS = [
  {
    id: 'pixel-atelier', name: 'Pixel Atelier', version: '2.4.0', color: '#d9480f', sizeMb: 32,
    category: { fr: 'Graphisme', en: 'Graphics' },
    summary: { fr: 'Retouche photo et peinture numérique, avec calques et pinceaux personnalisables.', en: 'Photo editing and digital painting with layers and custom brushes.' },
    description: { fr: 'Pixel Atelier réunit retouche photo et peinture numérique.\n\nNouveautés de la version 2.4 : pinceaux à texture, export WebP et correction automatique des couleurs.', en: 'Pixel Atelier brings photo editing and digital painting together.\n\nNew in 2.4: textured brushes, WebP export and automatic color correction.' },
  },
  {
    id: 'vecto', name: 'Vecto', version: '1.8.2', color: '#0b7285', sizeMb: 24,
    category: { fr: 'Graphisme', en: 'Graphics' },
    summary: { fr: 'Dessin vectoriel pour logos, affiches et illustrations.', en: 'Vector drawing for logos, posters and illustrations.' },
  },
  {
    id: 'mise-en-page', name: 'Mise en Page', version: '3.1.0', color: '#2b8a3e', sizeMb: 41,
    category: { fr: 'Publication', en: 'Publishing' },
    summary: { fr: 'Mise en page de brochures, magazines et livrets, prête pour l’impression.', en: 'Print-ready layout for brochures, magazines and booklets.' },
  },
  {
    id: 'studio-son', name: 'Studio Son', version: '0.9.4', color: '#1c5fc9', sizeMb: 28,
    category: { fr: 'Audio et vidéo', en: 'Audio & video' },
    summary: { fr: 'Enregistrement, montage et mixage audio multipiste.', en: 'Multitrack audio recording, editing and mixing.' },
  },
  {
    id: 'montage-video', name: 'Montage Vidéo', version: '1.2.0', color: '#a61e4d', sizeMb: 56,
    category: { fr: 'Audio et vidéo', en: 'Audio & video' },
    summary: { fr: 'Montage vidéo simple : découpe, titres, transitions et export pour le web.', en: 'Simple video editing: cuts, titles, transitions and web export.' },
  },
  {
    id: 'typo-lab', name: 'Typo Lab', version: '0.4.1', color: '#5f3dc4', sizeMb: 12, only: 'macos',
    category: { fr: 'Publication', en: 'Publishing' },
    summary: { fr: 'Création et retouche de polices de caractères.', en: 'Create and edit typefaces.' },
  },
];

// Faux installateurs : contenu aléatoire, empreinte calculée au démarrage.
const files = new Map();
for (const app of DEMO_APPS) {
  const buf = crypto.randomBytes(app.sizeMb * MB);
  files.set(app.id, { buf, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
}

function catalog() {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    apps: DEMO_APPS.map((a) => {
      const f = files.get(a.id);
      const build = (ext) => ({ url: `${BASE}/files/${a.id}-${a.version}.${ext}`, sha256: f.sha256, size: f.buf.length });
      const platforms = {};
      if (a.only !== 'macos') platforms.windows = { ...build('msi'), displayName: a.name };
      if (a.only !== 'windows') platforms.macos = { ...build('dmg'), appName: `${a.name}.app` };
      return {
        id: a.id, name: a.name, version: a.version, color: a.color,
        category: a.category, summary: a.summary, description: a.description,
        homepage: `https://github.com/MON-ASSO/${a.id}`,
        releaseNotesUrl: `https://github.com/MON-ASSO/${a.id}/releases/tag/v${a.version}`,
        platforms,
      };
    }),
  };
}

// Débit limité (~6 Mo/s) pour voir la progression.
const CHUNK = 192 * 1024;
const server = http.createServer((req, res) => {
  if (req.url === '/catalog.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(catalog(), null, 2));
  }
  const m = /^\/files\/([a-z0-9-]+?)-[\d.]+\.(msi|dmg)$/.exec(req.url);
  const f = m && files.get(m[1]);
  if (!f) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.buf.length });
  let off = 0;
  const timer = setInterval(() => {
    if (off >= f.buf.length) {
      clearInterval(timer);
      return res.end();
    }
    res.write(f.buf.subarray(off, off + CHUNK));
    off += CHUNK;
  }, 30);
  req.on('close', () => clearInterval(timer));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Catalogue de démo : ${BASE}/catalog.json`);
  if (arg('server-only')) return;
  const electron = require('electron');
  const child = spawn(electron, [root, '--simulate'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ORBIT_CATALOG_URL: `${BASE}/catalog.json`,
      // Au premier lancement : Pixel Atelier 2.3.0 et Vecto 1.8.2 « déjà installés ».
      ORBIT_SIMULATE_SEED: JSON.stringify({ 'pixel-atelier': { version: '2.3.0' }, vecto: { version: '1.8.2' } }),
    },
  });
  child.on('exit', (code) => {
    server.close();
    process.exit(code ?? 0);
  });
});
