# ⛏ AXECUBE — Mineur Lottery

**Minage solo Bitcoin, Fractal Bitcoin et VerusCoin, directement sur votre CPU — gratuit, honnête, sans rien acheter.**

AXECUBE transforme votre ordinateur en un vrai mineur solo : calcul SHA-256 réel (WASM/SIMD), tableau de bord en temps réel, vérification en direct de ce que vous toucheriez si un bloc était trouvé, système de badges de progression, et classement communautaire vérifié cryptographiquement.

> ⚠️ **Ce que ce projet n'est pas** : un plan pour s'enrichir. Sur CPU, vos vraies chances de trouver un bloc Bitcoin sont de l'ordre de **1 sur plusieurs centaines de milliards par jour**. AXECUBE affiche ce chiffre honnêtement, sans jamais l'enjoliver. C'est un outil pédagogique et ludique — pas un produit financier.

---

## ✨ Fonctionnalités

- ⛏️ Moteur SHA-256 réel (WASM + SIMD), aucune simulation
- 📊 Tableau de bord web en temps réel, accessible aussi depuis votre téléphone (même réseau Wi-Fi)
- 🔒 Vérification en direct de la coinbase — sachez exactement ce que vous toucheriez si un bloc était trouvé
- 🏅 Système de badges par palier de difficulté (Bronze → Légende), avec popup de célébration
- 🏆 Classement communautaire avec preuve cryptographique anti-triche, fenêtres jour/semaine/mois
- 🪙 Trois réseaux : Bitcoin, Fractal Bitcoin (solo), et VerusCoin (pool, module indépendant)
- 🤝 Préréglages de pool : solo (public-pool.io, Braiins Solo, CKPool, Mineshop.eu) ou répartition automatique (ViaBTC, Braiins Pool)
- ⏸️ Pause/reprise du minage à la volée depuis le dashboard
- 🧭 Page de découverte pédagogique et visite guidée interactive intégrées
- 💚 Page de soutien (don Bitcoin + partenaires matériel)
- 🖥️ macOS et Windows, lanceurs graphiques inclus (aucune ligne de commande requise)

## 🚀 Démarrage rapide

### macOS
```bash
git clone https://github.com/VOTRE-COMPTE/axecube.git
cd axecube
```
Double-cliquez sur `AXECUBE.command`. Premier lancement : clic droit → Ouvrir (macOS bloque les fichiers téléchargés par défaut).

### Windows
Double-cliquez sur `AXECUBE.bat`. Si SmartScreen s'affiche : *Informations complémentaires → Exécuter quand même*.

### Ligne de commande (toutes plateformes, nécessite [Node.js](https://nodejs.org) ≥ 18)
```bash
node axecube.js VOTRE_ADRESSE_BTC --network fractal
```

Le tableau de bord s'ouvre automatiquement sur `http://localhost:1337`.

## ⚙️ Options principales

| Option | Description | Défaut |
|---|---|---|
| `--network btc\|fractal` | Réseau à miner | `btc` |
| `--threads N` | Nombre de cœurs CPU utilisés | `cœurs - 1` |
| `--worker NOM` | Nom affiché sur le pool (utile à plusieurs machines) | `web` |
| `--pool host:port` | Pool personnalisé | pool par défaut du réseau |
| `--pool-preset NOM` | Préréglage (`braiins-solo`, `ckpool`, `mineshop-solo`, `viabtc`, `braiins-pool`) | — |
| `--mode solo\|pool` | Type de minage | `solo` |
| `--lan` | Ouvre le tableau de bord au réseau local (téléphone) | désactivé |
| `--leaderboard URL` | Active le classement communautaire | désactivé |
| `--selftest` | Vérifie l'intégrité du moteur de hash | — |

### Modes solo vs pool

- **Solo** (`--mode solo`, par défaut) : l'adresse peut être partagée entre plusieurs machines (famille/amis) pour cumuler le hashrate. La récompense entière va sur cette adresse si un bloc est trouvé — à réserver aux personnes de confiance.
- **Pool** (`--mode pool`) : répartition automatique proportionnelle à votre contribution réelle, aucun risque de partage. Nécessite un compte créé au préalable chez le pool (ex. [ViaBTC](https://viabtc.com), [Braiins Pool](https://pool.braiins.com)).

## 🪙 Mode VerusCoin (CPU, module indépendant)

Verus utilise l'algorithme VerusHash 2.2. AXECUBE peut piloter un mineur natif externe ([ccminer, branche ARM](https://github.com/monkins1010/ccminer)) :

```bash
node axecube.js VOTRE_ADRESSE_VRSC --network verus \
  --verus-miner /chemin/vers/ccminer \
  --verus-pool stratum+tcp://eu.luckpool.net:3956
```

Ce mode ne modifie jamais le moteur BTC/Fractal — c'est un module séparé.

## 🏆 Classement communautaire

Le dossier [`leaderboard-netlify/`](./leaderboard-netlify) contient un backend déployable gratuitement sur [Netlify](https://netlify.com) (fonctions serverless + stockage Blobs). Chaque soumission est vérifiée cryptographiquement côté serveur (recalcul du hash SHA-256d) — impossible de déclarer une difficulté sans avoir réellement fait le calcul.

Voir [`leaderboard-netlify/README.md`](./leaderboard-netlify/README.md) pour le déploiement (5 minutes).

## 🧪 Vérifier l'intégrité du moteur

```bash
node axecube.js --selftest
```

## 📁 Structure du dépôt

```
axecube/
├── axecube.js              # Moteur principal (BTC/Fractal/Verus + dashboard)
├── AXECUBE.command          # Lanceur macOS
├── AXECUBE.bat               # Lanceur Windows
├── assets/badges/            # Images des paliers de progression
└── leaderboard-netlify/      # Backend du classement communautaire (Netlify)
```

## 🤝 Contribuer

Les issues et pull requests sont bienvenues. Merci de garder l'esprit du projet : **honnêteté avant tout** — aucune fonctionnalité ne doit exagérer les chances réelles de gain.

## 📜 Licence

MIT — voir [LICENSE](./LICENSE). Utilisation, modification et redistribution libres.

## ⚠️ Avertissement

AXECUBE est fourni « tel quel », sans garantie. Le minage sollicite votre CPU et consomme de l'électricité. Ceci n'est pas un conseil en investissement. Voir [LICENSE](./LICENSE) pour le détail.
