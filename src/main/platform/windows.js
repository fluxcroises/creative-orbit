'use strict';

/*
 * Windows : installation des paquets .msi via msiexec.
 *
 * - Détection : on lit les entrées « Programmes et fonctionnalités » du
 *   registre (HKLM 64/32 bits et HKCU) et on les associe au catalogue grâce à
 *   `displayName` (nom exact) ou `displayNamePattern` (expression régulière).
 * - Installation / mise à jour : `msiexec /i fichier.msi /passive`. Si le MSI
 *   s'installe pour tous les utilisateurs, Windows affiche lui-même la demande
 *   d'autorisation administrateur (UAC). Pour qu'une mise à jour remplace
 *   l'ancienne version, le MSI doit déclarer une « MajorUpgrade » (voir README).
 * - Désinstallation : `msiexec /x {ProductCode} /passive`.
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

const GUID_RE = /^\{[0-9A-F-]{36}\}$/i;

async function listUninstallEntries() {
  const { code, stdout, stderr } = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    PS_LIST,
  ]);
  if (code !== 0) throw new Error('PowerShell failed: ' + stderr);
  const text = stdout.trim();
  if (!text) return [];
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : [data];
}

function matches(build, entry) {
  const name = String(entry.DisplayName || '');
  if (build.displayName && name.toLowerCase() === build.displayName.toLowerCase()) return true;
  if (build.displayNamePattern && new RegExp(build.displayNamePattern, 'i').test(name)) return true;
  return false;
}

function expandEnv(p) {
  return String(p).replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
}

function exeFromDisplayIcon(icon) {
  if (!icon) return null;
  const p = String(icon).replace(/^"|"$/g, '').replace(/,-?\d+$/, '').replace(/^"|"$/g, '');
  return /\.exe$/i.test(p) ? p : null;
}

const MSI_EXIT = {
  0: null,
  1641: 'reboot', // installation réussie, redémarrage lancé
  3010: 'reboot', // installation réussie, redémarrage nécessaire
};

function checkMsiExit(code, failCode, logPath) {
  if (code in MSI_EXIT) return { rebootRequired: MSI_EXIT[code] === 'reboot' };
  if (code === 1602 || code === 1223) throw new OrbitError(Codes.CANCELLED, 'Cancelled by user');
  if (code === 1618) throw new OrbitError(Codes.INSTALLER_BUSY, 'Another installation is in progress');
  throw new OrbitError(failCode, `msiexec exited with code ${code}`, { exitCode: code, log: logPath });
}

function createWindowsBackend() {
  return {
    key: 'windows',

    /** Renvoie Map<id, {version, productCode, installLocation, displayIcon}>. */
    async scan(apps) {
      const entries = await listUninstallEntries();
      const result = new Map();
      for (const app of apps) {
        const build = app.platforms.windows;
        if (!build) continue;
        let best = null;
        for (const e of entries) {
          if (!matches(build, e)) continue;
          if (!best || compare(e.DisplayVersion, best.DisplayVersion) > 0) best = e;
        }
        if (best) {
          result.set(app.id, {
            version: String(best.DisplayVersion || '0'),
            productCode: GUID_RE.test(best.key) && Number(best.WindowsInstaller) === 1 ? best.key : null,
            installLocation: best.InstallLocation || null,
            displayIcon: best.DisplayIcon || null,
          });
        }
      }
      return result;
    },

    async install({ file, logPath }) {
      if (!/\.msi$/i.test(file)) {
        throw new OrbitError(Codes.NOT_SUPPORTED, 'Only .msi packages are supported on Windows');
      }
      const { code } = await run('msiexec.exe', ['/i', file, '/passive', '/norestart', '/l*v', logPath]);
      return checkMsiExit(code, Codes.INSTALL_FAILED, logPath);
    },

    async uninstall({ detected, logPath }) {
      if (!detected.productCode) {
        // Pas un MSI : on renvoie vers les paramètres Windows.
        await shell.openExternal('ms-settings:appsfeatures');
        throw new OrbitError(Codes.NOT_SUPPORTED, 'Not an MSI installation');
      }
      const { code } = await run('msiexec.exe', ['/x', detected.productCode, '/passive', '/norestart', '/l*v', logPath]);
      return checkMsiExit(code, Codes.UNINSTALL_FAILED, logPath);
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

module.exports = { createWindowsBackend, _test: { matches, exeFromDisplayIcon, expandEnv, checkMsiExit } };
