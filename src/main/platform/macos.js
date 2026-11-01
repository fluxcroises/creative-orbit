'use strict';

/*
 * macOS : installation depuis des images disque .dmg (ou des paquets .pkg).
 *
 * - Détection : on cherche `appName` (ex. « Pixel Atelier.app ») dans
 *   /Applications puis ~/Applications et on lit sa version dans Info.plist.
 * - Installation : le .dmg est monté sans l'afficher dans le Finder, l'app est
 *   copiée avec `ditto` (qui conserve signature et attributs), puis le disque
 *   est éjecté. Si le .dmg contient un .pkg, il est installé avec `installer`.
 *   Quand des droits administrateur sont nécessaires, macOS affiche sa
 *   fenêtre habituelle de mot de passe.
 * - Désinstallation : l'app est placée dans la Corbeille.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { shell } = require('electron');
const { run } = require('./exec');
const { OrbitError, Codes } = require('../errors');

const SYSTEM_APPS = '/Applications';
const userApps = () => path.join(os.homedir(), 'Applications');

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const asq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function isWritable(p) {
  try {
    await fsp.access(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Exécute une commande shell avec la fenêtre d'autorisation administrateur de macOS. */
async function runPrivileged(command, failCode) {
  const script = `do shell script ${asq(command)} with administrator privileges`;
  const { code, stderr } = await run('/usr/bin/osascript', ['-e', script]);
  if (code === 0) return;
  if (/-128/.test(stderr)) throw new OrbitError(Codes.CANCELLED, 'Cancelled by user');
  throw new OrbitError(failCode, stderr.trim() || `osascript exited with ${code}`);
}

async function readVersion(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const { code, stdout } = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
    if (code === 0 && stdout.trim()) return stdout.trim();
  }
  return '0';
}

async function isRunning(appPath) {
  const { code } = await run('/usr/bin/pgrep', ['-f', '--', reEscape(appPath + '/Contents/MacOS/')]);
  return code === 0;
}

async function assertNotRunning(detected) {
  if (detected && (await isRunning(detected.path))) {
    throw new OrbitError(Codes.APP_RUNNING, 'Application is running');
  }
}

async function installPkg(pkg) {
  await runPrivileged(`/usr/sbin/installer -pkg ${shq(pkg)} -target /`, Codes.INSTALL_FAILED);
}

async function copyApp(src, build, detected) {
  let targetDir;
  if (detected) targetDir = path.dirname(detected.path);
  else if (await isWritable(SYSTEM_APPS)) targetDir = SYSTEM_APPS;
  else {
    // Compte standard sans droits : installation dans ~/Applications.
    targetDir = userApps();
    await fsp.mkdir(targetDir, { recursive: true });
  }
  const dest = path.join(targetDir, build.appName);
  const tmp = path.join(targetDir, `.${build.appName}.orbit-new`);

  const canWrite = (await isWritable(targetDir)) && (!fs.existsSync(dest) || (await isWritable(dest)));
  if (canWrite) {
    try {
      await fsp.rm(tmp, { recursive: true, force: true });
      const r = await run('/usr/bin/ditto', [src, tmp]);
      if (r.code !== 0) throw new Error(r.stderr);
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.rename(tmp, dest);
      return dest;
    } catch {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      // On retente avec les droits administrateur ci-dessous.
    }
  }
  await runPrivileged(
    `rm -rf ${shq(tmp)} && /usr/bin/ditto ${shq(src)} ${shq(tmp)} && rm -rf ${shq(dest)} && mv ${shq(tmp)} ${shq(dest)}`,
    Codes.INSTALL_FAILED,
  );
  return dest;
}

async function installFromDmg(file, build, detected) {
  const mountPoint = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-dmg-'));
  const attach = await run('/usr/bin/hdiutil', [
    'attach', file, '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mountPoint,
  ]);
  if (attach.code !== 0) {
    await fsp.rm(mountPoint, { recursive: true, force: true });
    throw new OrbitError(Codes.INSTALL_FAILED, 'hdiutil attach failed: ' + attach.stderr.trim());
  }
  try {
    const items = await fsp.readdir(mountPoint);
    const app = items.includes(build.appName) ? build.appName : items.find((n) => n.endsWith('.app'));
    if (app) return await copyApp(path.join(mountPoint, app), build, detected);
    const pkg = items.find((n) => n.endsWith('.pkg'));
    if (pkg) return await installPkg(path.join(mountPoint, pkg));
    throw new OrbitError(Codes.INSTALL_FAILED, 'No .app or .pkg found in disk image');
  } finally {
    await run('/usr/bin/hdiutil', ['detach', mountPoint, '-force']);
    await fsp.rm(mountPoint, { recursive: true, force: true }).catch(() => {});
  }
}

function createMacBackend() {
  return {
    key: 'macos',

    /** Renvoie Map<id, {version, path}>. */
    async scan(apps) {
      const result = new Map();
      for (const app of apps) {
        const build = app.platforms.macos;
        if (!build) continue;
        for (const dir of [SYSTEM_APPS, userApps()]) {
          const p = path.join(dir, build.appName);
          if (fs.existsSync(path.join(p, 'Contents', 'Info.plist'))) {
            result.set(app.id, { version: await readVersion(p), path: p });
            break;
          }
        }
      }
      return result;
    },

    async install({ file, build, detected }) {
      await assertNotRunning(detected);
      if (/\.pkg$/i.test(file)) await installPkg(file);
      else if (/\.dmg$/i.test(file)) await installFromDmg(file, build, detected);
      else throw new OrbitError(Codes.NOT_SUPPORTED, 'Only .dmg and .pkg are supported on macOS');
      return { rebootRequired: false };
    },

    async uninstall({ detected }) {
      await assertNotRunning(detected);
      try {
        await shell.trashItem(detected.path);
      } catch {
        await runPrivileged(`rm -rf ${shq(detected.path)}`, Codes.UNINSTALL_FAILED);
      }
      return { rebootRequired: false };
    },

    async launch({ detected }) {
      const err = await shell.openPath(detected.path);
      if (err) throw new OrbitError(Codes.LAUNCH_FAILED, err);
    },
  };
}

module.exports = { createMacBackend, _test: { shq, asq, reEscape } };
