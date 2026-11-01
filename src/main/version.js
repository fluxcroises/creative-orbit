'use strict';

/**
 * Comparaison de versions tolérante : « 1.2 », « v1.2.3 », « 2.0.0-beta.1 »,
 * « 1.2.3.0 » (versions MSI à 4 nombres). Renvoie -1, 0 ou 1.
 */
function parse(v) {
  const s = String(v ?? '').trim().replace(/^v/i, '').split('+')[0];
  const dash = s.indexOf('-');
  const core = dash < 0 ? s : s.slice(0, dash);
  const pre = dash < 0 ? [] : s.slice(dash + 1).split('.').filter(Boolean);
  const nums = core.split('.').map((n) => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
  return { nums, pre };
}

function compareIdent(a, b) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Math.sign(Number(a) - Number(b));
  if (na) return -1;
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compare(a, b) {
  const A = parse(a);
  const B = parse(b);
  const len = Math.max(A.nums.length, B.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (A.nums[i] || 0) - (B.nums[i] || 0);
    if (d !== 0) return Math.sign(d);
  }
  // Une version finale est plus récente que ses préversions.
  if (!A.pre.length && B.pre.length) return 1;
  if (A.pre.length && !B.pre.length) return -1;
  const plen = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < plen; i++) {
    if (A.pre[i] === undefined) return -1;
    if (B.pre[i] === undefined) return 1;
    const d = compareIdent(A.pre[i], B.pre[i]);
    if (d !== 0) return d;
  }
  return 0;
}

const isNewer = (candidate, current) => compare(candidate, current) > 0;

module.exports = { compare, isNewer, parse };
