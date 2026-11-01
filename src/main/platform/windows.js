'use strict';

/*
 * Windows : installateurs .exe (NSIS, comme ceux de Tauri) et paquets .msi.
 *
 * - Détection : on lit les entrées « Applications installées » du registre
 *   (HKLM 64/32 bits et HKCU) et on les associe au catalogue grâce à
 *   `displayName` (nom exact) ou `displayNamePattern` (expression régulière).
 * - .exe (NSIS) : lancé avec `installerArgs` (par défaut `/P`, le mode passif
 *   des installateurs Tauri : barre de progression, aucune question). S'il
 *   s'installe pour tous les utilisateurs, Windows affiche la demande
 *   d'autorisation administrateur (UAC). La désinstallation lance
 *   l'`UninstallString` du registre avec `uninstallerArgs` (par défaut `/P`).
 * - .msi : `msiexec /i fichier.msi /passive` ; désinstallation par
 *   `msiexec /x {ProductCode} /passive`. Le MSI doit déclarer une
 *   « MajorUpgrade » pour qu'une nouvelle version remplace l'ancienne.
 */

const fs = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');
const { run } = require('./exec');
const { compare } = require('../version');
const { OrbitError, Codes } = require('../errors');

const PS_LIST = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$paths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$items = Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName } |
  Select-Object @{n='key';e={$_.PSChildName}}, DisplayName, DisplayVersion,
    InstallLocation, DisplayIcon, WindowsInstaller, UninstallString
ConvertTo-Json -InputObject @($items) -Compress
`;

/*
 * Lance un programme comme un double-clic (ShellExecute) : si son manifeste
 * demande les droits administrateur, Windows affiche l'UAC. Attend la fin du
 * programme et renvoie son code de sortie (1223 si l'UAC est refusé).
 * Chemin et arguments passent par des variables d'environnement : aucun
 * problème de guillemets.
 */
const PS_START = `
$ErrorActionPreference = 'Stop'
try {
  $a = @{ FilePath = $env:ORBIT_FILE; Wait = $true; PassThru = $true }
  if ($env:ORBIT_ARGS) { $a.ArgumentList = $env:ORBIT_ARGS }
  $p = Start-Process @a
  exit $p.ExitCode
} catch {
  $e = $_.Exception
  while ($e) { if ($e.NativeErrorCode -eq 1223) { exit 1223 }; $e = $e.InnerException }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 9999
}
`;

const GUID_RE = /^\{[0-9A-F-]{36}\}$/i;
const DEFAULT_EXE_ARGS = ['/P'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unquote = (s) => (s ? String(s).trim().replace(/^"(.*)"$/, '$1') : null);

function powershell(script, env) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, ...env },
  });
}

async function listUninstallEntries() {
  const { code, stdout, stderr } = await powershell(PS_LIST);
  if (code !== 0) throw new Error('PowerShell failed: ' + stderr);
  const text = stdout.trim();
  if (!text) return [];
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : [data];
}

async function startElevatable(file, args) {
  const { code, stderr } = await powershell(PS_START, { ORBIT_FILE: file, ORBIT_ARGS: (args || []).join(' ') });
  return { code, stderr: stderr.trim() };
}

function matches(build, entry) {
  const name = String(entry.DisplayName || '').normalize('NFC').toLowerCase();
  if (build.displayName && name === build.displayName.normalize('NFC').toLowerCase()) return true;
  if (build.displayNamePattern && new RegExp(build.displayNamePattern, 'i').test(name)) return true;
  return false;
}

function findEntry(build, entries) {
  let best = null;
  for (const e of entries) {
    if (!matches(build, e)) continue;
    if (!best || compare(e.DisplayVersion, best.DisplayVersion) > 0) best = e;
  }
  return best;
}

function expandEnv(p) {
  return String(p).replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
}

function exeFromDisplayIcon(icon) {
  if (!icon) return null;
  const p = String(icon).replace(/^"|"$/g, '').replace(/,-?\d+$/, '').replace(/^"|"$/g, '');
  return /\.exe$/i.test(p) ? p : null;
}

/** Sépare `"C:\x\uninstall.exe" /S` en { exe, args }. */
function parseCommand(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return null;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end < 0) return null;
    return { exe: s.slice(1, end), args: s.slice(end + 1).trim() };
  }
  const m = /^(.*?\.exe)(\s.*)?$/i.exec(s);
  return m ? { exe: m[1], args: (m[2] || '').trim() } : { exe: s, args: '' };
}

function checkMsiExit(code, failCode, logPath) {
  if (code === 0) return { rebootRequired: false };
  if (code === 1641 || code === 3010) return { rebootRequired: true };
  if (code === 1602 || code === 1223) throw new OrbitError(Codes.CANCELLED, 'Cancelled by user');
  if (code === 1618) throw new OrbitError(Codes.INSTALLER_BUSY, 'Another installation is in progress');
  throw new OrbitError(failCode, `msiexec exited with code ${code}`, { exitCode: code, log: logPath });
}

/** Codes de sortie NSIS : 0 réussi, 1 annulé, 2 interrompu par l'installateur. */
function checkExeExit({ code, stderr }, failCode) {
  if (code === 0) return { rebootRequired: false };
  if (code === 1 || code === 1223) throw new OrbitError(Codes.CANCELLED, 'Cancelled by user');
  if (code === 9999) throw new OrbitError(failCode, stderr || 'Could not start installer');
  throw new OrbitError(failCode, `installer exited with code ${code}`, { exitCode: code });
}

function createWindowsBackend() {
  return {
    key: 'windows',

    /** Renvoie Map<id, {version, productCode, uninstallString, installLocation, displayIcon}>. */
    async scan(apps) {
      const entries = await listUninstallEntries();
      const result = new Map();
      for (const app of apps) {
        const build = app.platforms.windows;
        if (!build) continue;
        const best = findEntry(build, entries);
        if (best) {
          result.set(app.id, {
            version: String(best.DisplayVersion || '0'),
            productCode: GUID_RE.test(best.key) && Number(best.WindowsInstaller) === 1 ? best.key : null,
            uninstallString: best.UninstallString || null,
            installLocation: unquote(best.InstallLocation),
            displayIcon: best.DisplayIcon || null,
          });
        }
      }
      return result;
    },

    async install({ file, build, logPath }) {
      if (/\.msi$/i.test(file)) {
        const { code } = await run('msiexec.exe', ['/i', file, '/passive', '/norestart', '/l*v', logPath]);
        return checkMsiExit(code, Codes.INSTALL_FAILED, logPath);
      }
      if (/\.exe$/i.test(file)) {
        const res = await startElevatable(file, build.installerArgs || DEFAULT_EXE_ARGS);
        return checkExeExit(res, Codes.INSTALL_FAILED);
      }
      throw new OrbitError(Codes.NOT_SUPPORTED, 'Only .exe and .msi installers are supported on Windows');
    },

    async uninstall({ build, detected, logPath }) {
      if (detected.productCode) {
        const { code } = await run('msiexec.exe', ['/x', detected.productCode, '/passive', '/norestart', '/l*v', logPath]);
        return checkMsiExit(code, Codes.UNINSTALL_FAILED, logPath);
      }
      const cmd = parseCommand(detected.uninstallString);
      if (!cmd || !fs.existsSync(cmd.exe)) {
        await shell.openExternal('ms-settings:appsfeatures');
        throw new OrbitError(Codes.NOT_SUPPORTED, 'No usable uninstaller');
      }
      const args = [...(cmd.args ? [cmd.args] : []), ...(build.uninstallerArgs || DEFAULT_EXE_ARGS)];
      checkExeExit(await startElevatable(cmd.exe, args), Codes.UNINSTALL_FAILED);
      // Un désinstallateur NSIS se recopie dans %TEMP% et rend la main tout de
      // suite : on attend que l'entrée disparaisse du registre.
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        if (!findEntry(build, await listUninstallEntries())) return { rebootRequired: false };
        await sleep(1500);
      }
      throw new OrbitError(Codes.UNINSTALL_FAILED, 'Application still registered after uninstall');
    },

    async launch({ build, detected }) {
      const candidates = [];
      if (build.executable) candidates.push(expandEnv(build.executable));
      const fromIcon = exeFromDisplayIcon(detected.displayIcon);
      if (fromIcon) candidates.push(fromIcon);
      if (detected.installLocation && build.executable) {
        candidates.push(path.join(detected.installLocation, path.basename(expandEnv(build.executable))));
      }
      const exe = candidates.find((p) => path.isAbsolute(p) && fs.existsSync(p));
      if (!exe) throw new OrbitError(Codes.LAUNCH_FAILED, 'Executable not found', { candidates });
      const err = await shell.openPath(exe);
      if (err) throw new OrbitError(Codes.LAUNCH_FAILED, err);
    },
  };
}

module.exports = {
  createWindowsBackend,
  _test: { matches, findEntry, exeFromDisplayIcon, expandEnv, checkMsiExit, checkExeExit, parseCommand },
};
