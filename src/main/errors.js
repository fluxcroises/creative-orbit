'use strict';

/**
 * Erreur métier transmise à l'interface. `code` est traduit côté interface
 * (voir src/renderer/i18n.js, clés « error.* »).
 */
class OrbitError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'OrbitError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const Codes = Object.freeze({
  NETWORK: 'NETWORK', // réseau indisponible, serveur injoignable
  HTTP: 'HTTP', // réponse HTTP en erreur (404…)
  CHECKSUM: 'CHECKSUM', // fichier téléchargé corrompu ou modifié
  CANCELLED: 'CANCELLED', // annulé par l'utilisateur (y compris refus de l'élévation)
  INSTALL_FAILED: 'INSTALL_FAILED',
  UNINSTALL_FAILED: 'UNINSTALL_FAILED',
  LAUNCH_FAILED: 'LAUNCH_FAILED',
  APP_RUNNING: 'APP_RUNNING', // le logiciel doit être fermé
  INSTALLER_BUSY: 'INSTALLER_BUSY', // une autre installation Windows est en cours
  NOT_SUPPORTED: 'NOT_SUPPORTED', // pas de version pour ce système / désinstallation impossible ici
  CATALOG_INVALID: 'CATALOG_INVALID',
  UNKNOWN: 'UNKNOWN',
});

function toPlainError(err) {
  if (err instanceof OrbitError) {
    return { code: err.code, message: err.message, details: err.details };
  }
  if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
    return { code: Codes.CANCELLED, message: 'Cancelled' };
  }
  return { code: Codes.UNKNOWN, message: String((err && err.message) || err) };
}

module.exports = { OrbitError, Codes, toPlainError };
