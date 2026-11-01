'use strict';

/** Textes affichés par le processus principal (menu de la barre, notifications, boîtes de dialogue). */
const STRINGS = {
  fr: {
    open: 'Ouvrir Creative Orbit',
    checkUpdates: 'Rechercher des mises à jour',
    quit: 'Quitter Creative Orbit',
    tooltip: 'Creative Orbit',
    tooltipUpdates: (n) => `Creative Orbit : ${n} mise${n > 1 ? 's' : ''} à jour disponible${n > 1 ? 's' : ''}`,
    updatesTitle: 'Mises à jour disponibles',
    updatesBody: (names) => names.length === 1 ? `Une nouvelle version de ${names[0]} est disponible.` : `${names.length} logiciels peuvent être mis à jour : ${names.join(', ')}.`,
    installed: (n, v) => `${n} ${v} est installé.`,
    updated: (n, v) => `${n} a été mis à jour en version ${v}.`,
    uninstalled: (n) => `${n} a été désinstallé.`,
    failed: (n) => `L'opération sur ${n} a échoué. Ouvrez Creative Orbit pour plus de détails.`,
    quitBusyTitle: 'Des opérations sont en cours',
    quitBusyBody: 'Des téléchargements ou installations sont en cours. Si vous quittez, les téléchargements seront annulés.',
    quitAnyway: 'Quitter quand même',
    cancel: 'Annuler',
    demoLaunchTitle: 'Mode démo',
    demoLaunchBody: (n) => `Dans la version réelle, ${n} s'ouvrirait maintenant.`,
    ok: 'OK',
  },
  en: {
    open: 'Open Creative Orbit',
    checkUpdates: 'Check for updates',
    quit: 'Quit Creative Orbit',
    tooltip: 'Creative Orbit',
    tooltipUpdates: (n) => `Creative Orbit: ${n} update${n > 1 ? 's' : ''} available`,
    updatesTitle: 'Updates available',
    updatesBody: (names) => names.length === 1 ? `A new version of ${names[0]} is available.` : `${names.length} apps can be updated: ${names.join(', ')}.`,
    installed: (n, v) => `${n} ${v} is installed.`,
    updated: (n, v) => `${n} was updated to version ${v}.`,
    uninstalled: (n) => `${n} was uninstalled.`,
    failed: (n) => `The operation on ${n} failed. Open Creative Orbit for details.`,
    quitBusyTitle: 'Operations in progress',
    quitBusyBody: 'Downloads or installations are in progress. If you quit, downloads will be cancelled.',
    quitAnyway: 'Quit anyway',
    cancel: 'Cancel',
    demoLaunchTitle: 'Demo mode',
    demoLaunchBody: (n) => `In the real version, ${n} would open now.`,
    ok: 'OK',
  },
};

module.exports = { STRINGS };
