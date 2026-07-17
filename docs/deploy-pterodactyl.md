# Déployer Flix sur Pterodactyl (ou Pelican)

Flix se déploie sur un panel Pterodactyl comme n'importe quel serveur de jeu :
un egg à importer, une allocation de port, un dossier à remplir en SFTP. Ce
guide suppose un panel fonctionnel avec un node Wings sous Linux x86_64.

## 1. Importer l'egg

1. Téléchargez [`deploy/pterodactyl/egg-flix.json`](../deploy/pterodactyl/egg-flix.json).
2. Dans le panel : **Admin → Nests** → choisissez (ou créez) un nest, puis
   **Import Egg** et sélectionnez le fichier.

L'egg utilise l'image standard `ghcr.io/parkervcp/yolks:nodejs_22` au
démarrage et `node:22-bookworm-slim` pour l'installation — aucune image
custom à construire.

## 2. Créer le serveur

Dans **Admin → Servers → Create New** :

- **Egg** : Flix.
- **Allocation** : n'importe quel port libre — Flix lit `SERVER_PORT`
  automatiquement, rien à configurer.
- **Ressources recommandées** :
  - RAM : 1 Go minimum (4 Go si vous laissez l'installation compiler depuis
    les sources, voir ci-dessous) ;
  - Disque : ~500 Mo pour l'application + la taille de votre médiathèque
    (ou rien si elle est montée ailleurs) + le cache d'images ;
  - CPU : le direct play ne coûte presque rien ; comptez ~1 cœur par
    transcodage logiciel simultané (`FLIX_MAX_TRANSCODES`, défaut 2).

### Ce que fait le script d'installation

1. Il télécharge l'asset `flix-standalone-linux-x64.tar.gz` de la release
   GitHub (`FLIX_VERSION`, défaut `latest`) du dépôt `GITHUB_REPO`.
2. Si aucun asset n'existe (fork sans releases, tag sans bundle), il **compile
   depuis les sources** — prévoir ~3 Go de RAM le temps de l'installation.
3. Il vérifie que le binding natif SQLite se charge, et le reconstruit sinon.
4. Il installe un **ffmpeg statique** dans `/home/container/ffmpeg/` (le yolk
   Node n'en fournit pas).

Le réseau n'est utilisé **qu'à l'installation**. Au démarrage, Flix ne fait
aucun appel sortant — c'est une garantie du projet.

## 3. Remplir la médiathèque

Envoyez vos fichiers dans `/home/container/media` via SFTP (les identifiants
sont dans l'onglet **Settings** du serveur) :

```
media/
  Movies/
    Inception (2010)/Inception (2010) 1080p.mkv
  Shows/
    Dark (2017)/Season 01/Dark S01E01.mkv
```

Les sidecars Kodi (`movie.nfo`, `poster.jpg`, `fanart.jpg`, sous-titres
`.srt`) sont lus s'ils existent. Le scan démarre tout seul au premier boot,
et l'auto-rescan surveille le dossier ensuite.

## 4. Démarrer et se connecter

1. Démarrez le serveur. La console affiche `[flix] ready - listening on
   http://0.0.0.0:<port>` quand tout est prêt (c'est aussi le marqueur que
   Wings utilise pour passer le serveur en « online »).
2. Au **premier démarrage**, un mot de passe admin temporaire s'affiche dans
   la console (et est écrit dans `data/INITIAL_ADMIN_PASSWORD.txt`). Pour le
   fixer vous-même, renseignez la variable **Mot de passe admin initial**
   avant le premier boot.
3. Ouvrez `http://<ip-du-node>:<port>` — connectez-vous, changez le mot de
   passe, créez les profils du foyer.

## 5. Variables de l'egg

| Variable | Défaut | Rôle |
|---|---|---|
| `FLIX_VERSION` | `latest` | Release installée (réinstallation pour changer) |
| `GITHUB_REPO` | `ybenyedder/flix` | Dépôt source du bundle |
| `FLIX_MEDIA_DIR` | `/home/container/media` | Médiathèque scannée/diffusée |
| `FLIX_DATA_DIR` | `/home/container/data` | Base SQLite + caches |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `/home/container/ffmpeg/…` | Binaires installés par l'egg |
| `FLIX_ADMIN_PASSWORD` | *(vide → généré)* | Mot de passe admin du premier boot |
| `FLIX_MAX_TRANSCODES` | `2` | Sessions ffmpeg simultanées max |
| `FLIX_MAX_TRANSCODE_HEIGHT` | `1080` | Plafond de résolution d'un transcodage |
| `FLIX_TRICKPLAY` | `0` | Vignettes de scrubbing (coût CPU au scan) |
| `FLIX_LOG_FORMAT` | `pretty` | `json` pour des logs structurés |

## 6. Mises à jour

**Réinstallez** le serveur (Settings → Reinstall Server). Le script remplace
l'application mais ne touche jamais à `data/` (base, images, profils,
historique) ni à `media/` — vous retrouvez tout à l'identique.

## Dépannage

- **« ffmpeg not found » dans la console** (ou `"ffmpeg": false` dans la
  réponse de `/api/health`) — l'installation n'a pas pu télécharger le build
  statique, ou `FFMPEG_PATH` pointe mal. Relancez l'installation, ou déposez
  des binaires `ffmpeg`/`ffprobe` Linux x86_64 statiques dans
  `/home/container/ffmpeg/` à la main. Le direct play continue de fonctionner
  sans ffmpeg ; le scan et le remux/transcodage, non.
- **Bibliothèque vide** — vérifiez que les fichiers sont bien sous
  `/home/container/media` et lisibles ; l'endpoint `/api/health` répond
  `"mediaDir": false` quand le dossier est illisible.
- **Le serveur ne passe jamais « online »** — regardez la première erreur
  dans la console. Le cas classique est un binding SQLite d'une autre ABI
  (bundle construit avec un autre Node) : réinstallez, le script le
  reconstruit automatiquement.
- **La lecture rame** — chaque client incompatible force un transcodage
  logiciel. Montez `FLIX_MAX_TRANSCODES` seulement si le CPU suit ; la vraie
  solution est un client qui lit le format d'origine (l'app Android/TV lit
  quasi tout en direct play).
