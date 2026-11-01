'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { OrbitError, Codes } = require('./errors');

/**
 * Télécharge `url` vers `dest` en vérifiant l'empreinte SHA-256.
 * Le fichier est d'abord écrit en « .part » puis renommé une fois vérifié :
 * un fichier présent à `dest` est donc toujours complet et intègre.
 *
 * @param {object} o
 * @param {typeof fetch} o.fetch       net.fetch d'Electron (respecte le proxy système) ou fetch.
 * @param {string} o.sha256            empreinte attendue (obligatoire).
 * @param {number} [o.size]            taille annoncée, utilisée si Content-Length est absent.
 * @param {AbortSignal} [o.signal]
 * @param {(received:number,total:number)=>void} [o.onProgress]
 */
async function download(url, dest, o) {
  if (!o || !/^[a-f0-9]{64}$/i.test(o.sha256 || '')) {
    throw new OrbitError(Codes.CHECKSUM, 'Missing SHA-256 for ' + url);
  }
  let res;
  try {
    res = await o.fetch(url, { signal: o.signal, redirect: 'follow' });
  } catch (err) {
    if (o.signal && o.signal.aborted) throw new OrbitError(Codes.CANCELLED, 'Cancelled');
    throw new OrbitError(Codes.NETWORK, err.message);
  }
  if (!res.ok || !res.body) {
    throw new OrbitError(Codes.HTTP, `HTTP ${res.status}`, { status: res.status });
  }

  const total = Number(res.headers.get('content-length')) || o.size || 0;
  const part = dest + '.part';
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let received = 0;

  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      if (o.onProgress) o.onProgress(received, total);
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (err) {
    out.destroy();
    await fsp.rm(part, { force: true });
    if (o.signal && o.signal.aborted) throw new OrbitError(Codes.CANCELLED, 'Cancelled');
    throw new OrbitError(Codes.NETWORK, err.message);
  }

  const digest = hash.digest('hex');
  if (digest !== o.sha256.toLowerCase()) {
    await fsp.rm(part, { force: true });
    throw new OrbitError(Codes.CHECKSUM, `SHA-256 mismatch for ${url}`, {
      expected: o.sha256.toLowerCase(),
      actual: digest,
    });
  }
  await fsp.rm(dest, { force: true });
  await fsp.rename(part, dest);
  return { path: dest, size: received, sha256: digest };
}

module.exports = { download };
