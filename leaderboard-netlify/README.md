# AXECUBE Leaderboard — déploiement sur Netlify

## Ce que c'est
Un classement communautaire des meilleures difficultés atteintes par les mineurs AXECUBE
(BTC/Fractal ET Verus), hébergé gratuitement sur Netlify (fonctions serverless + stockage Blobs).

## Nouveautés : vérification cryptographique + classements par période

Depuis cette version, chaque soumission doit être accompagnée d'une **preuve de travail**
vérifiable (l'en-tête du bloc ayant produit la meilleure difficulté). Le serveur recalcule
lui-même le hash (sha256d) et rejette toute soumission dont la difficulté annoncée ne
correspond pas à un calcul réellement effectué — impossible d'annoncer un chiffre sans
avoir vraiment fait le travail de calcul équivalent.

Le classement (`/top`) renvoie maintenant plusieurs vues :
- `jour`, `semaine`, `mois` : meilleure difficulté atteinte sur chaque fenêtre glissante
- `allTime` : record absolu, jamais réinitialisé
- `top` : conservé pour compatibilité (équivalent à `allTime` filtré aux mineurs actifs)

## Déploiement (5 minutes)

### 1. Installer l'outil Netlify (une seule fois)
```bash
npm install -g netlify-cli
```

### 2. Se connecter à ton compte Netlify
```bash
cd axecube-leaderboard-netlify
netlify login
```
(Ça ouvre ton navigateur pour te connecter — utilise ton compte Netlify existant.)

### 3. Installer les dépendances
```bash
npm install
```

### 4. Créer le site et déployer
```bash
netlify init
```
Réponds aux questions :
- "Create & configure a new site" → oui
- Choisis ton équipe Netlify
- Nom du site → ce que tu veux (ex: `axecube-leaderboard`)

Puis déploie en production :
```bash
netlify deploy --prod
```

À la fin, Netlify t'affiche une URL du type :
```
https://axecube-leaderboard.netlify.app
```

### 5. Utiliser cette URL avec AXECUBE
```bash
node axecube.js TON_ADRESSE --network fractal --leaderboard https://axecube-leaderboard.netlify.app
```

## Vérifier que ça marche
```bash
curl https://axecube-leaderboard.netlify.app/top
```
Doit renvoyer `{"top":[],"total":0}` au tout début (avant le premier record soumis).

## Notes
- Les entrées inactives depuis plus de 7 jours sont automatiquement ignorées du classement (mais pas supprimées).
- Aucune adresse BTC/VRSC n'est jamais stockée ni transmise — uniquement le nom de worker (public par nature), le hashrate, le CPU, et la meilleure difficulté.
- Le plan gratuit Netlify inclut largement assez de requêtes et de stockage Blobs pour cet usage.
