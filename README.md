# Creative Orbit

Le lanceur des logiciels de l'association, sur le modèle d'Adobe Creative Cloud.
Depuis une seule fenêtre, on peut **installer**, **ouvrir**, **mettre à jour** et
**désinstaller** tous les logiciels de la suite, sous **Windows** et **macOS**.

- Catalogue en ligne : les nouveautés et les mises à jour apparaissent sans réinstaller le lanceur.
- Vérification SHA-256 de chaque fichier téléchargé.
- Notifications de mise à jour (vérification toutes les 6 heures) et icône dans la barre des tâches / des menus.
- Interface en français et en anglais, thème sombre, clair ou celui du système, et charte du kit Creative Orbit.
- Le lanceur se met à jour tout seul (Releases GitHub).

---

## 1. Essayer tout de suite (mode démo)

Prérequis : [Node.js](https://nodejs.org) 22 ou plus récent.

```bash
npm install
```

```bash
npm run demo
```

La démo lance un petit serveur local avec 6 logiciels fictifs. Les téléchargements
sont réels, avec leur barre de progression, mais **rien n'est vraiment installé**.
Au premier lancement, Pixel Atelier 2.3.0 est « déjà installé » pour montrer une
mise à jour. Les données de la démo sont séparées de celles du vrai lanceur.

Tests automatiques :

```bash
npm test
```

---

## 2. Comment ça marche

```
 Dépôts GitHub des logiciels            Dépôt « creative-orbit »                  Ordinateurs des membres
 ┌────────────────────────┐   lu par   ┌───────────────────────────┐  lu par   ┌────────────────────────┐
 │ Releases : .msi + .dmg │──────────▶│ catalog/catalog.json      │─────────▶│ Lanceur Creative Orbit │
 └────────────────────────┘ (Action)   │ (généré automatiquement)  │ (6 h)     │ télécharge, vérifie,   │
                                       │ Releases du lanceur       │──────────▶│ installe               │
                                       └───────────────────────────┘ mise à jour└────────────────────────┘
```

| Étape | Windows (.msi) | macOS (.dmg) |
|---|---|---|
| Détecter | Entrées « Applications installées » du registre, associées par `displayName` | `/Applications/<appName>` puis `~/Applications`, version lue dans `Info.plist` |
| Installer / mettre à jour | `msiexec /i … /passive` : barre de progression Windows, et demande d'autorisation (UAC) si le MSI s'installe pour tous les utilisateurs | Montage invisible du .dmg, copie de l'app avec `ditto`, éjection. Un `.pkg` dans le .dmg est aussi accepté |
| Désinstaller | `msiexec /x {ProductCode} /passive` | App placée dans la Corbeille |
| Ouvrir | `executable` du catalogue (ou icône du registre) | `open` de l'app |

Le lanceur lui-même s'installe **sans droits administrateur**, pour l'utilisateur
courant, comme Creative Cloud.

---

## 3. Mise en place (une seule fois)

### 3.1 Dépôt GitHub du lanceur

1. Créez un dépôt **public** `creative-orbit` dans le compte GitHub de l'association et poussez-y ce dossier.
2. Remplacez `MON-ASSO` par le nom de ce compte dans :
   - `package.json` → `orbit.catalogUrl`
   - `electron-builder.yml` → `publish.owner`
   - `catalog/apps.json` → `repo` de chaque logiciel
3. Facultatif : changez `appId` dans `electron-builder.yml` (ex. `org.monasso.creativeorbit`). Faites-le **avant** la première publication, car il ne doit plus changer ensuite.

### 3.2 Signature macOS (compte Apple Developer)

Sans signature ni notarisation, macOS refuse d'ouvrir le lanceur. Dans
**Settings → Secrets and variables → Actions** du dépôt, ajoutez :

| Secret | Contenu |
|---|---|
| `MAC_CERT_P12_BASE64` | Certificat **Developer ID Application** exporté depuis Trousseau d'accès en `.p12`, puis encodé avec `base64 -i cert.p12 \| pbcopy` |
| `MAC_CERT_PASSWORD` | Mot de passe choisi à l'export du `.p12` |
| `APPLE_ID` | Adresse du compte Apple Developer |
| `APPLE_APP_SPECIFIC_PASSWORD` | Mot de passe pour application, créé sur [account.apple.com](https://account.apple.com) |
| `APPLE_TEAM_ID` | Identifiant d'équipe (10 caractères, visible sur developer.apple.com) |

### 3.3 Windows sans certificat

Le lanceur fonctionne sans certificat, mais au premier lancement de l'installateur,
Windows SmartScreen affiche « Windows a protégé votre ordinateur ». Il faut alors
cliquer sur **Informations complémentaires → Exécuter quand même**. Pensez à
l'indiquer sur votre page de téléchargement. Pour supprimer cet avertissement
plus tard :

- [SignPath Foundation](https://signpath.org) : signature gratuite pour les projets open source ;
- Azure Artifact Signing (Microsoft) : abonnement mensuel peu coûteux, sous conditions d'éligibilité.

Les mises à jour automatiques du lanceur fonctionnent aussi sans signature.

### 3.4 Publier une version du lanceur

1. Augmentez `version` dans `package.json` (ex. `0.2.0`).
2. Créez l'étiquette correspondante et poussez-la :

```bash
git tag v0.2.0
```

```bash
git push origin v0.2.0
```

L'action **Publier le lanceur** construit `Creative-Orbit-Setup-0.2.0.exe`
(Windows x64 et ARM) et `Creative-Orbit-0.2.0.dmg` (Mac Intel et Apple Silicon),
puis les ajoute à la Release. Les lanceurs déjà installés se mettent à jour d'eux-mêmes.

---

## 4. Ajouter un logiciel au catalogue

### 4.1 Ce que doit fournir chaque logiciel

Chaque logiciel a son propre dépôt GitHub **public**. Ses Releases contiennent :

- **Windows** : un `.msi`
  - le nom affiché dans « Applications installées » (`ProductName`) doit rester **identique** d'une version à l'autre (sinon, utilisez `displayNamePattern`) ;
  - le MSI doit déclarer une **MajorUpgrade** (WiX : `<MajorUpgrade DowngradeErrorMessage="…" />`) avec un `UpgradeCode` fixe. C'est ce qui permet à une nouvelle version de remplacer l'ancienne.
- **macOS** : un `.dmg` contenant l'app (`Mon Logiciel.app`) à sa racine
  - l'app doit être **signée et notarisée**, sinon Gatekeeper la bloque. Le compte Apple Developer de l'association peut servir pour toute la suite ;
  - `CFBundleShortVersionString` doit contenir le numéro de version.
- L'étiquette de la Release est le numéro de version : `v2.4.0` ou `2.4.0`.

### 4.2 Le déclarer

Ajoutez une entrée dans `catalog/apps.json` :

```jsonc
{
  "id": "pixel-atelier",                  // minuscules, chiffres et tirets ; ne doit jamais changer
  "name": "Pixel Atelier",
  "repo": "MON-ASSO/pixel-atelier",       // dépôt GitHub du logiciel
  "color": "#d9480f",                     // couleur de la vignette si pas d'icône
  "icon": "icons/pixel-atelier.png",      // facultatif : PNG carré dans catalog/icons/
  "category": { "fr": "Graphisme", "en": "Graphics" },
  "summary":  { "fr": "Phrase courte.", "en": "Short sentence." },
  "description": { "fr": "Texte long (fiche détaillée).", "en": "Long text." },
  "windows": {
    "asset": "\\.msi$",                   // expression régulière : quel fichier de la Release
    "displayName": "Pixel Atelier",       // nom exact dans « Applications installées »
    "executable": "%ProgramFiles%\\Pixel Atelier\\Pixel Atelier.exe"
  },
  "macos": {
    "asset": "\\.dmg$",
    "appName": "Pixel Atelier.app"
  }
}
```

Un logiciel disponible seulement sur un système n'a qu'une des deux sections. Le
lanceur l'affiche alors dans « Pas encore disponibles sur … » pour l'autre système.

### 4.3 Mettre le catalogue à jour

C'est automatique : l'action **Mettre à jour le catalogue** relit les dernières
Releases toutes les 6 heures et à chaque modification de `apps.json`. Elle
régénère `catalog/catalog.json`, avec les adresses, les tailles et les SHA-256.
On peut aussi la lancer à la main depuis l'onglet **Actions**, ou localement :

```bash
npm run catalog
```

Pour une publication immédiate après chaque version d'un logiciel, ajoutez cette
étape à la fin de l'action de release **du logiciel**. Elle demande un jeton
`CATALOG_TOKEN` avec accès « Contents: read & write » au dépôt `creative-orbit` :

```yaml
- name: Prévenir Creative Orbit
  run: gh api repos/MON-ASSO/creative-orbit/dispatches -f event_type=app-released
  env:
    GH_TOKEN: ${{ secrets.CATALOG_TOKEN }}
```

---

## 5. Organisation du code

```
src/main/            processus principal (Node.js)
  main.js            fenêtre, icône de barre, notifications, mises à jour du lanceur, IPC
  manager.js         catalogue + état des logiciels + file d'opérations
  catalog.js         chargement et validation du catalogue (copie hors ligne)
  download.js        téléchargement avec progression, annulation et SHA-256
  platform/          windows.js (msiexec), macos.js (dmg/pkg), simulated.js (démo/tests)
  preload.js         API limitée exposée à l'interface
src/renderer/        interface (HTML/CSS/JS sans framework)
  i18n.js            tous les textes, français et anglais
src/assets/          icônes de la barre des tâches / des menus
build/               icônes .ico / .icns et droits macOS pour l'installateur
catalog/             apps.json (à éditer), catalog.json (généré), icons/
scripts/             demo.mjs, build-catalog.mjs
test/                tests (npm test)
```

**Sécurité** : l'interface n'a aucun accès direct au système (isolation de
contexte, bac à sable, CSP stricte). Le catalogue n'accepte que des adresses
`https`, et tout fichier dont l'empreinte SHA-256 ne correspond pas est supprimé
sans être exécuté.

**Journaux** : les journaux `msiexec` sont enregistrés dans le dossier ouvert par
**Paramètres → Journaux d'installation**.

**Variables utiles en développement** : `ORBIT_CATALOG_URL` (autre catalogue),
`--simulate` (installations simulées), `ORBIT_SIMULATE_AS=macos|windows`,
`ORBIT_SIMULATE_FAIL=<id>` (simule un échec).
