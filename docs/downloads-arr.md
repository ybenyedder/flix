# Téléchargements automatiques (intégration *arr)

Cette fonction **optionnelle et désactivée par défaut** connecte Flix à
**Sonarr** (séries), **Radarr** (films), **Prowlarr** (indexeurs), **Bazarr**
(sous-titres) et **qBittorrent** (client de téléchargement). Une fois activée,
vous cherchez dans Flix un titre absent de votre bibliothèque, cliquez sur
**Demander**, et il est téléchargé, sous-titré, puis ajouté automatiquement.

> ⚠️ C'est la **seule** fonction de Flix qui effectue des appels réseau sortants,
> et uniquement vers vos propres services locaux. Tant qu'elle est désactivée,
> Flix reste 100 % hors-ligne.

---

## 1. Déploiement en une commande (Docker)

Flix fournit toute la pile et la câble automatiquement. Depuis le dossier du
dépôt :

```bash
mkdir -p media/{movies,shows,downloads}
docker compose -f docker-compose.yml -f docker-compose.arr.yml up -d
```

Cela démarre `flix`, `qbittorrent`, `prowlarr`, `sonarr`, `radarr`, `bazarr`,
et un conteneur d'initialisation `arr-init` qui :

1. attend chaque service et lit sa clé API dans son volume de configuration ;
2. crée les dossiers racines (`/data/movies`, `/data/shows`) ;
3. branche qBittorrent comme client de téléchargement dans Sonarr et Radarr ;
4. enregistre Sonarr et Radarr comme applications dans Prowlarr (synchronisation
   complète des indexeurs) ;
5. câble Bazarr sur Sonarr/Radarr avec un profil de langues français + anglais
   (au mieux — voir §5) ;
6. écrit `arr-services.json` dans le volume de données de Flix, que **Flix
   détecte automatiquement** (aucune clé à copier).

Suivez la progression :

```bash
docker compose -f docker-compose.yml -f docker-compose.arr.yml logs -f arr-init
```

À la fin, `arr-init` affiche un récapitulatif (URLs + clés API) et les **étapes
manuelles**.

### La seule étape manuelle : les indexeurs Prowlarr

Prowlarr embarque des centaines de **définitions** d'indexeurs mais n'en active
**aucune** par défaut — un indexeur fiable est en général un tracker privé ou un
fournisseur Usenet lié à **votre** compte, que Flix ne peut pas configurer à
votre place. Ouvrez `http://<hôte>:9696`, terminez la configuration
d'authentification, puis **Indexers → Add Indexer**. La synchronisation
Applications pousse ensuite automatiquement l'indexeur vers Sonarr et Radarr.
Dans Flix, **Paramètres → Téléchargements**, le bouton **Tester** de Prowlarr
avertit tant qu'aucun indexeur n'est configuré.

#### Ajouter des sources en un clic depuis Flix (recommandé)

Le plus simple : dans **Flix → Paramètres → Téléchargements automatiques →
Sources de téléchargement**, cliquez sur un paquet d'indexeurs **publics**
(**Publics**, **Anime**, **Français**, **Russe**), sur **Tout ajouter** (tous les
paquets triés), ou sur **Tout l'existant** — ce dernier active **chacune des
sources publiques (sans compte) connues de Prowlarr**, soit l'intégralité du
catalogue (plusieurs centaines, tous pays/langues). Flix les crée dans Prowlarr
par vagues successives (avec compteur de progression), les route au besoin par
FlareSolverr — y compris en **retentant automatiquement via FlareSolverr** toute
source refusée par un blocage Cloudflare — et la synchro Applications les pousse
vers Sonarr/Radarr. Les sources mortes ou géo-bloquées sont listées
individuellement sans bloquer le reste. Aucun redéploiement ni édition de
fichier nécessaire.

#### Auto-activer des indexeurs publics au déploiement (`FLIX_ARR_INDEXERS`)

Pour tout automatiser dès le premier boot, demandez à `arr-init` d'activer des
paquets d'indexeurs **publics** (torrent, sans compte) via `FLIX_ARR_INDEXERS`.
Valeurs acceptées — un **paquet**, `all`, ou une liste combinée (paquets et/ou
noms de définitions Prowlarr) séparés par des virgules :

| Valeur    | Contenu |
|-----------|---------|
| `public`  | thepiratebay, 1337x, yts, eztv, limetorrents, torrentproject2, uindex, internetarchive, knaben, torrentscsv, torrentcore, magnetdownload, damagnet, btdirectory, showrss |
| `anime`   | nyaasi, tokyotosho, shanaproject, acgrip, dmhy, subsplease |
| `fr`      | torrent9 |
| `ru`      | rutor |
| `all`     | tous les paquets ci-dessus |
| `everything` | **toutes les définitions publiques connues de Prowlarr** (plusieurs centaines, tous pays/langues) — les échecs individuels sont simplement journalisés |

> Le jeu `public` ne contient que des sources vérifiées comme s'ajoutant de
> façon fiable. Des trackers publics jadis populaires (KickassTorrents,
> ExtraTorrent, TorrentDownloads…) sont aujourd'hui hors-ligne ou bloqués par
> Cloudflare et ont été retirés — s'ils échouent à l'ajout, l'UI en donne la
> raison exacte (site injoignable / Cloudflare 403 / clé requise).

```bash
# le grand jeu généraliste (films + séries)
FLIX_ARR_INDEXERS=public docker compose -f docker-compose.yml -f docker-compose.arr.yml up -d
# plusieurs paquets combinés
FLIX_ARR_INDEXERS=public,anime,fr docker compose -f docker-compose.yml -f docker-compose.arr.yml up -d
# ou une liste précise de définitions Prowlarr :
FLIX_ARR_INDEXERS=1337x,yts docker compose -f docker-compose.yml -f docker-compose.arr.yml up -d
# ou ABSOLUMENT TOUT le catalogue public de Prowlarr :
FLIX_ARR_INDEXERS=everything docker compose -f docker-compose.yml -f docker-compose.arr.yml up -d
```

La stack embarque **FlareSolverr** : `arr-init` l'enregistre comme proxy dans
Prowlarr et route automatiquement les indexeurs protégés par Cloudflare (1337x,
eztv, kickasstorrents, torrent9, uindex, dmhy, extratorrent) au travers — ils
fonctionnent donc sans intervention.

> ⚠️ Les indexeurs publics pointent souvent vers du contenu sous copyright
> (à vous de vérifier ce qui est légal chez vous) et restent variables en
> fiabilité (un indexeur peut être hors-ligne). Ceux qui échouent à l'ajout sont
> simplement signalés dans les logs `arr-init`, sans bloquer l'initialisation.
> Non défini, la variable ne change rien (étape manuelle ci-dessus).

#### Anti-blocage : bascule automatique en « balanced »

Sur des indexeurs publics, un release en `max` (Remux/4K) d'un titre de niche est
souvent **sans seed** et le téléchargement reste bloqué à 0 %. Flix surveille ça :
si une demande reste **bloquée à ~0 % pendant plus de 10 minutes**, il **rebascule
le profil qualité en « balanced »**, blackliste le release mort et **relance la
recherche** automatiquement (la demande affiche alors une note explicative). C'est
actif par défaut dès que « Téléchargements automatiques » est activé.

- `FLIX_ARR_STALL_MINUTES` : délai avant bascule (défaut `10`).
- `FLIX_ARR_STALL_FALLBACK=0` : désactive complètement le mécanisme.

#### Profil de qualité (`FLIX_ARR_QUALITY`)

`arr-init` règle le profil de qualité que Radarr/Sonarr utilisent :

- **`max`** (défaut) : autorise tout et met le cutoff sur la **meilleure qualité,
  jusqu'au 4K/Remux**. Vous obtenez le meilleur *quand il est disponible et
  seedé* — mais sur des indexeurs publics, le 4K/Remux est souvent peu seedé,
  donc attendez-vous à des téléchargements lents ou bloqués sur du contenu niche.
- **`balanced`** : **WEB-DL / x264 1080p** (sans Remux ni 4K). Fichiers plus
  petits, bien mieux seedés → **téléchargements rapides qui aboutissent**.
- **`off`** : laisse le profil *arr par défaut intact.

```bash
FLIX_ARR_QUALITY=balanced docker compose -f docker-compose.yml -f docker-compose.arr.yml up -d
```

`arr-init` ne touche que le profil vierge « Any » et le renomme, donc un profil
que vous avez personnalisé dans Radarr/Sonarr n'est jamais écrasé.

---

## 2. Arborescence et hardlinks

L'hôte partage un seul dossier `media/` :

```
media/
├── movies/      ← Radarr y importe les films      (monté /data/movies dans Radarr)
├── shows/       ← Sonarr y importe les séries      (monté /data/shows dans Sonarr)
└── downloads/   ← qBittorrent y télécharge          (invisible pour Flix)
```

- qBittorrent, Sonarr, Radarr et Bazarr montent tout `./media` en `/data`
  (lecture-écriture) → même système de fichiers, donc **hardlinks** possibles
  (pas de recopie, seeding préservé, style TRaSH).
- Flix monte `./media/movies` et `./media/shows` en **lecture seule** dans son
  `/media`, en plus de votre bibliothèque existante (`./videos`). Le dossier
  `downloads/` n'est jamais exposé au scanner de Flix.

Rien à faire côté scan : le **watcher** de Flix relance une analyse ~30 s après
qu'un fichier apparaît, le scanner reconnaît déjà les conventions Radarr/Sonarr
(`Film (2020)/Film (2020).mkv`, `Série/Season 01/Série - S01E01.mkv`) et ingère
les `.srt` déposés par Bazarr.

### PUID / PGID / fuseau

Les conteneurs linuxserver tournent sous `PUID=1000` / `PGID=1000` par défaut
(= l'utilisateur `node` de l'image Flix, donc les lectures fonctionnent). Pour
d'autres identifiants, exportez-les avant le `up` :

```bash
PUID=1001 PGID=1001 TZ=Europe/Paris docker compose -f docker-compose.yml -f docker-compose.arr.yml up -d
```

---

## 3. Sécurité de qBittorrent

L'interface web de qBittorrent est :

- **publiée sur `127.0.0.1` uniquement** (`127.0.0.1:8080:8080`) — inaccessible
  depuis l'extérieur de la machine hôte ;
- configurée pour **ne pas demander d'authentification aux IP du sous-réseau
  Docker fixe** `172.31.247.0/24` (`WebUI\AuthSubnetWhitelist`), ce qui permet à
  Sonarr/Radarr de s'y connecter sans identifiants.

Le fichier `qBittorrent.conf` est pré-écrit **avant le premier démarrage** de
qBittorrent par le conteneur `qbit-seed`, ce qui évite la course « on modifie la
conf pendant que qBittorrent tourne → écrasée à l'arrêt ».

> Ne republiez pas le port 8080 sur une interface publique. Si vous avez besoin
> d'y accéder à distance, passez par un tunnel SSH (`ssh -L 8080:localhost:8080`)
> ou un reverse-proxy authentifié.

---

## 3bis. VPN Mullvad (kill-switch) — optionnel

Sans VPN intégré, qBittorrent sort par la connexion de l'hôte : votre IP réelle
est exposée sur les torrents (sauf si votre hôte est déjà sous VPN, sans
kill-switch). L'overlay `docker-compose.vpn.yml` fait passer **uniquement
qBittorrent** par **Mullvad** (WireGuard) via **gluetun**, avec **kill-switch** :
si le tunnel tombe, qBittorrent perd tout accès réseau → **aucune fuite**.

**Mise en place, entièrement depuis Flix :**

1. Ajoutez l'overlay au déploiement :
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.arr.yml -f docker-compose.vpn.yml up -d
   # rootless podman : ajoutez -f docker-compose.podman.yml
   ```
   Au premier démarrage, gluetun n'a pas encore de config → le kill-switch
   maintient qBittorrent **hors ligne** (c'est voulu, zéro fuite).
2. Dans Flix, **Paramètres → VPN (Mullvad)** : collez votre **numéro de compte
   Mullvad** (16 chiffres) et cliquez **Activer**. Flix :
   - génère une paire de clés WireGuard et enregistre la clé publique auprès de
     Mullvad (récupère l'adresse du tunnel) ;
   - choisit le **relais le plus proche** (plus faible latence géographique) ;
   - écrit la config gluetun dans `./vpn/gluetun.env`.
3. Appliquez-la (gluetun doit relire sa config — Flix, isolé dans un conteneur,
   ne peut pas piloter le runtime) :
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.arr.yml -f docker-compose.vpn.yml up -d gluetun qbittorrent
   ```
   Le panneau **VPN** de Flix affiche alors **VPN actif** + l'**IP de sortie**.

Pour changer de serveur ou de compte : re-collez le numéro (ou le même) dans
Flix, puis réappliquez la commande de l'étape 3.

> **Rootless podman** : gluetun a besoin de `/dev/net/tun` et de la capacité
> `NET_ADMIN`. Assurez-vous que le module `tun` est chargé sur l'hôte
> (`sudo modprobe tun`). L'IPv6 du tunnel n'est pas configurée (IPv4 uniquement).

---

## 4. Utilisation

1. Dans Flix, **Paramètres → Téléchargements** : le service est déjà activé
   (l'exécution du compose *arr vaut opt-in) et les quatre services apparaissent
   en « auto-détecté ». Testez chacun.
2. Recherchez un titre absent de votre bibliothèque. Sous les résultats, la
   section **« Pas dans votre bibliothèque ? »** propose des titres externes.
3. Cliquez **Demander**. Suivez l'avancement dans le menu profil → **Demandes** :
   *Recherche → Téléchargement n % → Importation → Disponible*.
4. Une fois **Disponible**, le titre est dans votre bibliothèque (sous-titres
   compris) et se lit normalement.

Les profils **enfant** ne voient ni la section de découverte ni les demandes.
Tout profil non-enfant peut demander ; l'auteur d'une demande (ou un admin) peut
la retirer.

---

## 5. Bazarr (sous-titres)

Le câblage automatique de Bazarr est **au mieux** : son API de réglages varie
selon les versions. Si `arr-init` affiche un avertissement Bazarr, configurez-le
manuellement (2 minutes) :

1. Ouvrez `http://<hôte>:6767` → **Settings → Sonarr** : IP `sonarr`, port `8989`,
   clé API (visible dans le récap `arr-init` ou dans Sonarr → Settings → General).
2. **Settings → Radarr** : IP `radarr`, port `7878`, clé API.
3. **Settings → Languages** : ajoutez Français/Anglais et définissez un profil par
   défaut pour séries et films.
4. **Settings → Providers** : ajoutez au moins un fournisseur de sous-titres.

Les téléchargements fonctionnent même sans Bazarr — seuls les sous-titres
externes manqueront.

---

## 6. Installation Flix « bare-metal » avec la pile *arr en conteneurs

Si Flix tourne hors Docker (systemd, bureau) mais que vous voulez la pile *arr
en conteneurs, faites lire à `arr-init` le vrai dossier de données de Flix pour
qu'il y dépose `arr-services.json` :

```bash
# adaptez au dataDir réel de Flix (ex. ~/.local/share/flix)
FLIX_DATA_DIR=$HOME/.local/share/flix \
  docker compose -f docker-compose.arr.yml up -d
```

et montez ce dossier dans `arr-init` (remplacez le volume `flix-data:/flix-data`
par `${FLIX_DATA_DIR}:/flix-data`). Sinon, copiez simplement les URLs + clés
affichées par `arr-init` dans **Paramètres → Téléchargements**.

Sur bare-metal, un lancement dans un **terminal interactif** (`node start.mjs`)
propose aussi l'activation au démarrage (question `[o/N]`, délai 30 s). En
conteneur, il n'y a pas de terminal : l'exécution du compose *arr suffit à
activer la fonction.

---

## 7. Pterodactyl / Pelican

Les panels de jeu ne peuvent pas lancer de conteneurs voisins. Hébergez la pile
*arr ailleurs, puis renseignez ses URLs + clés API dans **Paramètres →
Téléchargements**. L'egg Flix n'est pas modifié.

---

## 8. Désactiver / supprimer

- **Désactiver** sans rien supprimer : Flix, **Paramètres → Téléchargements**,
  basculez l'interrupteur. Aucun appel sortant n'est plus émis (le client
  interne refuse toute requête tant que la fonction est désactivée).
- **Tout arrêter** :
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.arr.yml down
  ```
- **Tout supprimer** (conteneurs + volumes de configuration) :
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.arr.yml down -v
  ```
  Vos vidéos dans `media/` ne sont pas touchées.

---

## Dépannage

| Symptôme | Piste |
| --- | --- |
| `arr-init` échoue en boucle | `docker compose ... logs arr-init` ; un service met > 3 min à démarrer, ou une clé API est illisible. Il réessaie (`restart: on-failure`). |
| « aucun indexeur » dans Prowlarr | Ajoutez un indexeur dans Prowlarr (§1). |
| Une demande reste en « Recherche » | Aucun indexeur, ou aucune release trouvée. Vérifiez la file dans Sonarr/Radarr. |
| « radarr n'a pas répondu à temps » sur **Demander** | Le lookup passe par le proxy métadonnées de Radarr (lent à froid ou derrière le VPN). Flix attend jusqu'à 30 s et réessaie une fois automatiquement ; si l'erreur persiste, Radarr est probablement saturé ou arrêté — re-cliquez quelques secondes plus tard. |
| Reste en « Importation » | Le fichier est importé côté *arr mais pas encore vu par Flix : attendez le prochain scan (≤ 30 s), ou lancez une analyse manuelle. |
| Le test d'un service échoue dans Flix | Vérifiez l'URL/clé dans **Paramètres → Téléchargements** ; le service est peut-être arrêté. |
