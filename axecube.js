#!/usr/bin/env node
/**
 * ⛏️  AXECUBE — le Bitaxe virtuel pour Mac · mineur solo Bitcoin en un seul fichier
 * ------------------------------------------------------------------------------
 * - Vrai minage solo via Stratum (pool par défaut : public-pool.io, 0% de frais,
 *   le pool par défaut des Bitaxe). Si tu trouves un bloc → récompense sur TON adresse.
 * - Multi-threads (worker_threads), zéro dépendance externe.
 * - Dashboard web style AxeOS sur http://localhost:1337
 *
 * Usage :
 *   node axecube.js <ADRESSE_BTC> [options]
 *
 * Options (ou variables d'env) :
 *   --pool host:port   (défaut: public-pool.io:21496)   [env POOL]
 *   --threads N        (défaut: nb de coeurs - 1)       [env THREADS]
 *   --port N           (port du dashboard, défaut 1337) [env DASH_PORT]
 *   --worker name      (nom du worker, défaut "web")    [env WORKER]
 *   --password pass    (mot de passe pool, défaut "x")  [env POOL_PASSWORD]
 *   --solo-split N      (0-100, SoloPool.com uniquement : % solo vs pool, prime sur --password) [env SOLO_SPLIT]
 *                      (ex: certains pools acceptent "d=32" pour fixer la difficulté de départ)
 *   --devise eur|usd   (devise du cours BTC, défaut eur)  [env DEVISE]
 *   --lang fr|en       (langue, défaut : celle du système)  [env AXECUBE_LANG]
 *   --lan              (ouvre le dashboard au réseau local, protégé par un jeton)
 *   --leaderboard URL  (serveur de classement communautaire AXECUBE, optionnel)
 *   --network btc|fractal  (réseau à miner, défaut : btc)  [env AXECUBE_NETWORK]
 *   --selftest         (vérifie le moteur de hash contre le bloc Genesis)
 *   --version          (affiche le numéro de version et quitte)
 *
 * ⚠Honnêteté totale : un CPU fait ~1 MH/s, un Bitaxe ~1 200 000 MH/s.
 *    C'est un ticket de loterie astronomiquement improbable. Mais il est réel.
 */

// Numéro de version local -- comparé à celui publié sur GitHub au démarrage (voir
// verifierMiseAJour plus bas) pour prévenir simplement si une version plus récente existe.
// À incrémenter à chaque changement notable poussé sur main.
const AXECUBE_VERSION = '1.5.0';

'use strict';

const crypto = require('crypto');
const net = require('net');
const dgram = require('dgram');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Empreinte de cache pour les images de la page /machines : basée sur la date de
// dernière modification réelle des fichiers sur disque, pas un numéro à incrémenter
// à la main. Ainsi, remplacer bitaxe-board.png ou fan-blade.png puis redémarrer le
// serveur force automatiquement le navigateur à retélécharger la nouvelle version,
// sans jamais servir une copie périmée en cache.
function empreinteFichier(cheminRelatif) {
  try {
    return String(Math.floor(fs.statSync(path.join(__dirname, cheminRelatif)).mtimeMs));
  } catch {
    return String(Date.now());
  }
}
const CACHE_CARTE = empreinteFichier(path.join('assets', 'bitaxe-board.png'));
const CACHE_VENTILO = empreinteFichier(path.join('assets', 'fan-blade.png'));
const CACHE_LOGO_VENTILO = empreinteFichier(path.join('assets', 'logo-ventilo.png'));
// Empreinte partagée pour toutes les variantes de carte par palier (assets/machines/) --
// basée sur l'heure de démarrage du serveur (fiable même si un fichier existant est
// simplement écrasé sans renommage, contrairement à la date du dossier qui ne bouge
// pas toujours dans ce cas). Un redémarrage suffit donc à rafraîchir le cache pour
// n'importe laquelle des 22 images.
const CACHE_MACHINES = String(Date.now());
// Même principe pour les logos de cube au centre du ventilateur (assets/cubes/) --
// mêmes noms de fichiers que sur le classement en ligne (cube-p01.png..cube-p22.png),
// pour pouvoir réutiliser directement les mêmes images sans les renommer.
const CACHE_CUBES = String(Date.now());

// --- Configuration visuelle éditable ---
// Toutes les positions/tailles des éléments de la carte "machines" (page /machines),
// modifiables depuis le mode édition intégré, sauvegardées dans assets/config-visuel.json
// pour survivre aux redémarrages. Les valeurs par défaut ci-dessous sont celles calibrées
// manuellement au fil des sessions précédentes.
const CHEMIN_CONFIG_VISUEL = path.join(__dirname, 'assets', 'config-visuel.json');
const CONFIG_VISUEL_DEFAUT = {
  ecran:        { left: 23.85, top: 4.49,  width: 51.03, height: 41.31 },
  fondNoir:     { left: 26.42, top: 55.30, width: 46.97 },
  ventilo:      { left: 23.50, top: 53.71, width: 53.00, pivotX: 50.69, pivotY: 48.18 },
  logoVentilo:  { left: 33.27, top: 31.38, width: 35.00 },
  contourGlow:  { left: 3.86,  top: 2.09,  width: 91.62, height: 86.18 },
  barreGlow:    { left: 21.02, top: 95.32, width: 60.12, height: 1.95 },
  boutonVentilo:{ left: 17.71, top: 50.98, width: 5.18 },
};
const CHEMIN_CONFIG_ECRAN = path.join(__dirname, 'assets', 'config-ecran.json');
// Position/taille de chaque champ texte affiché à l'intérieur de l'écran, par page
// (0 = page 1, 1 = page 2) -- éditable en direct via le bouton "🛠 Écran" sur /machines.
// Valeurs par défaut calées approximativement sur la disposition en grille d'origine ;
// l'outil de calibrage sert justement à les affiner sans avoir à toucher au code.
const CONFIG_ECRAN_DEFAUT = {
  // Marge autour du contenu, à l'intérieur du cadre noir de l'écran -- réglable en direct
  // via le bandeau "🛠 Écran" (champs "Marge H/V"), pour utiliser plus (ou moins) de la
  // surface réellement disponible plutôt qu'un padding figé choisi une fois pour toutes.
  margeH: 2.5, margeV: 2,
  page0: {
    hashLabel:   { left: 0,  top: 0,  width: 62, size: 1.0 },
    blocs:       { left: 62, top: 1,  width: 38, size: 1.0 },
    hashValeur:  { left: 0,  top: 10, width: 100, size: 1.0 },
    uptime:      { left: 0,  top: 33, width: 44, size: 1.0 },
    threads:     { left: 50, top: 33, width: 50, size: 1.0 },
    pool:        { left: 0,  top: 50, width: 44, size: 1.0 },
    difficulte:  { left: 50, top: 50, width: 50, size: 1.0 },
    meilleure:   { left: 0,  top: 67, width: 44, size: 1.0 },
    shares:      { left: 50, top: 67, width: 50, size: 1.0 },
    acceptation: { left: 0,  top: 84, width: 44, size: 1.0 },
    cours:       { left: 50, top: 84, width: 50, size: 1.0 },
  },
  page1: {
    blocAMiner:      { left: 0,  top: 0,  width: 44, size: 1.0 },
    blocsTrouves:    { left: 50, top: 0,  width: 50, size: 1.0 },
    thermique:       { left: 0,  top: 20, width: 44, size: 1.0 },
    paiement:        { left: 50, top: 20, width: 50, size: 1.0 },
    difficulteReseau:{ left: 0,  top: 40, width: 100, size: 1.0 },
    recordJour:      { left: 0,  top: 58, width: 44, size: 1.0 },
    skinActif:       { left: 50, top: 58, width: 50, size: 1.0 },
    progression:     { left: 0,  top: 76, width: 44, size: 1.0 },
    travailTotal:    { left: 50, top: 76, width: 50, size: 1.0 },
    badges:          { left: 0,  top: 90, width: 60, size: 1.0, sizeIcone: 1.0 },
    niveauGenese:    { left: 62, top: 90, width: 38, size: 1.0, sizeIcone: 1.0 },
  },
};
function chargerConfigEcran() {
  try {
    const brut = fs.readFileSync(CHEMIN_CONFIG_ECRAN, 'utf8');
    const lu = JSON.parse(brut);
    const fusion = {
      margeH: Number.isFinite(Number(lu.margeH)) ? Number(lu.margeH) : CONFIG_ECRAN_DEFAUT.margeH,
      margeV: Number.isFinite(Number(lu.margeV)) ? Number(lu.margeV) : CONFIG_ECRAN_DEFAUT.margeV,
      page0: {}, page1: {},
    };
    for (const page of ['page0', 'page1']) {
      for (const cle of Object.keys(CONFIG_ECRAN_DEFAUT[page])) {
        fusion[page][cle] = Object.assign({}, CONFIG_ECRAN_DEFAUT[page][cle], (lu[page] && lu[page][cle]) || {});
      }
    }
    return fusion;
  } catch {
    return JSON.parse(JSON.stringify(CONFIG_ECRAN_DEFAUT));
  }
}
function sauvegarderConfigEcran(config) {
  fs.mkdirSync(path.dirname(CHEMIN_CONFIG_ECRAN), { recursive: true });
  fs.writeFileSync(CHEMIN_CONFIG_ECRAN, JSON.stringify(config, null, 2), 'utf8');
}
let configEcran = chargerConfigEcran();
function chargerConfigVisuel() {
  try {
    const brut = fs.readFileSync(CHEMIN_CONFIG_VISUEL, 'utf8');
    const lu = JSON.parse(brut);
    // Fusionne avec les défauts pour tolérer un fichier partiel ou une ancienne version.
    const fusion = {};
    for (const cle of Object.keys(CONFIG_VISUEL_DEFAUT)) {
      fusion[cle] = Object.assign({}, CONFIG_VISUEL_DEFAUT[cle], lu[cle] || {});
    }
    return fusion;
  } catch {
    return JSON.parse(JSON.stringify(CONFIG_VISUEL_DEFAUT));
  }
}
function sauvegarderConfigVisuel(config) {
  fs.mkdirSync(path.dirname(CHEMIN_CONFIG_VISUEL), { recursive: true });
  fs.writeFileSync(CHEMIN_CONFIG_VISUEL, JSON.stringify(config, null, 2), 'utf8');
}
let configVisuel = chargerConfigVisuel();

// Zones par skin Premium (voir bouton "🎯 Zones du skin" sur /machines) : un simple
// dictionnaire { itemId: {ecran:{...}, ventilo:{...}, ...} } stocké en local, à côté de
// config-visuel.json -- ne concerne QUE l'affichage sur TA PROPRE carte, jamais envoyé à
// Netlify (les autres visiteurs ne voient de toute façon jamais tes skins Premium, voir
// carteLegere()). Chaque skin ne stocke que les zones qui DÉVIENT du gabarit standard --
// absent = ce skin suit le gabarit par défaut (cv), comme la grande majorité des pièces.
//
// DISTRIBUTION : ce fichier est prévu pour être commité dans le repo Git (contrairement à
// assets/premium/, gitignoré) -- une fois un skin réglé et enregistré ici, penser à
// `git add assets/zones-premium.json && git commit && git push` pour que les réglages
// arrivent aux autres utilisateurs au prochain `git pull`, sans configuration de leur part.
const CHEMIN_ZONES_PREMIUM = path.join(__dirname, 'assets', 'zones-premium.json');
function chargerZonesPremium() {
  try { return JSON.parse(fs.readFileSync(CHEMIN_ZONES_PREMIUM, 'utf8')); }
  catch { return {}; }
}
function sauvegarderZonesPremium(zones) {
  fs.mkdirSync(path.dirname(CHEMIN_ZONES_PREMIUM), { recursive: true });
  fs.writeFileSync(CHEMIN_ZONES_PREMIUM, JSON.stringify(zones, null, 2), 'utf8');
}
let zonesPremium = chargerZonesPremium();

// Hélices propres à un skin Premium (découpées depuis l'artwork du skin lui-même, voir
// bouton "✂️ Extraire l'hélice" du panneau "🎯 Zones du skin") -- un PNG transparent par
// itemId dans assets/helices-premium/. Absent = ce skin utilise le calque par défaut
// (fan-blade.png) ou celui du vrai palier, comme avant. Même logique de distribution que
// zones-premium.json : ce dossier doit être commité en Git pour arriver aux autres
// utilisateurs, contrairement à assets/premium/ (gitignoré).
const DOSSIER_HELICES_PREMIUM = path.join(__dirname, 'assets', 'helices-premium');
function listerHelicesSkinDisponibles() {
  try {
    return new Set(fs.readdirSync(DOSSIER_HELICES_PREMIUM)
      .filter(f => f.endsWith('.png'))
      .map(f => f.slice(0, -4)));
  } catch { return new Set(); }
}
let helicesSkinDisponibles = listerHelicesSkinDisponibles();

// Cube (logo central) propre à un skin Premium -- FOURNI directement par Chris (pas
// découpé depuis l'artwork, contrairement à l'hélice), pour rester indépendant : c'est un
// enfant du ventilateur (voir .logoVentilo, "enfant du ventilateur, donc tourne
// automatiquement avec lui"), mais son image et sa position lui sont propres, sans lien
// avec l'image de l'hélice elle-même. Même règle de distribution que les autres assets
// de skin : assets/cubes-premium/ doit être commité en Git.
const DOSSIER_CUBES_PREMIUM = path.join(__dirname, 'assets', 'cubes-premium');
function listerCubesSkinDisponibles() {
  try {
    return new Set(fs.readdirSync(DOSSIER_CUBES_PREMIUM)
      .filter(f => f.endsWith('.png'))
      .map(f => f.slice(0, -4)));
  } catch { return new Set(); }
}
let cubesSkinDisponibles = listerCubesSkinDisponibles();

const { spawn } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

/* ============================== UTILITAIRES =============================== */

const DIFF1 = 0x00000000FFFF0000000000000000000000000000000000000000000000000000n;

// Paliers de progression (badges) — franchis dans l'ordre selon le record de difficulté personnel
// ==================== Config dons / partenaires (À PERSONNALISER) ====================
// Remplacez ces deux valeurs par les vôtres — c'est tout ce qu'il y a à faire pour activer
// la page /soutenir. Laissez telles quelles pour que la page affiche un message "pas encore configuré".
const DON_BTC_ADRESSE = 'bc1quefg6edfny2cnzzktqxl3d8xuwxd3ssqcw7wkt';           // <-- votre adresse dédiée aux dons
const LIEN_MINESHOP_AFFILIATION = 'VOTRE_LIEN_AFFILIATION_ICI';   // <-- votre lien d'affiliation Mineshop.eu

const PALIERS = [
  { cle: 'bronze',   nom: 'BRONZE',   seuil: 100 },
  { cle: 'argent',   nom: 'ARGENT',   seuil: 1000 },
  { cle: 'or',       nom: 'OR',       seuil: 10000 },
  { cle: 'platine',  nom: 'PLATINE',  seuil: 100000 },
  { cle: 'diamant',  nom: 'DIAMANT',  seuil: 1000000 },
  { cle: 'legende',  nom: 'LÉGENDE',  seuil: 10000000 },
];

// Grille des 22 cubes CPU (système loterie sur bestDiff) -- doit rester STRICTEMENT
// identique à celle de recompenses.html / mes-recompenses.html / telecharger-media.js.
// Sert ici à savoir quels paliers demander au serveur de récompenses.
const SEUILS_CPU = [
  200, 300, 500, 750, 1000, 1500, 2500, 4000,
  6000, 10000, 15000, 25000, 40000,
  60000,
  100000, 150000,
  200000,
  300000, 400000, 500000,
  750000, 1000000,
];
function niveauDeCube(bestDiff) {
  bestDiff = Number(bestDiff) || 0;
  let niveau = 0;
  for (let i = 0; i < SEUILS_CPU.length; i++) {
    if (bestDiff >= SEUILS_CPU[i]) niveau = i + 1; else break;
  }
  return niveau;
}

function sha256d(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

/** Inverse l'ordre des octets à l'intérieur de chaque mot de 4 octets. */
function swap32(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i += 4) {
    out[i] = buf[i + 3]; out[i + 1] = buf[i + 2];
    out[i + 2] = buf[i + 1]; out[i + 3] = buf[i];
  }
  return out;
}

/** Difficulté d'un hash (digest sha256d brut, interprété en little-endian). */
function hashDifficulty(hashBuf) {
  const beHex = Buffer.from(hashBuf).reverse().toString('hex');
  const value = BigInt('0x' + beHex);
  if (value === 0n) return Infinity;
  return Number((DIFF1 * 1000000n) / value) / 1000000;
}

/** Cible BigInt correspondant à une difficulté de pool. */
function difficultyToTarget(diff) {
  const scaled = BigInt(Math.max(1, Math.round(diff * 1000000)));
  return (DIFF1 * 1000000n) / scaled;
}

/** Difficulté réseau approx. depuis nBits (hex big-endian). */
function nbitsToDifficulty(nbitsHex) {
  try {
    const nbits = parseInt(nbitsHex, 16);
    const exp = nbits >>> 24;
    const mant = BigInt(nbits & 0x007fffff);
    const target = mant << (8n * (BigInt(exp) - 3n));
    if (target === 0n) return 0;
    return Number((DIFF1 * 1000n) / target) / 1000;
  } catch { return 0; }
}

/** Construit l'en-tête de bloc de 80 octets (nonce à l'offset 76). */
function buildHeaderPrefix(job, merkleRoot) {
  const header = Buffer.alloc(80);
  Buffer.from(job.version, 'hex').reverse().copy(header, 0);          // version LE
  swap32(Buffer.from(job.prevhash, 'hex')).copy(header, 4);           // prevhash (mots swappés)
  merkleRoot.copy(header, 36);                                        // merkle root (tel quel)
  Buffer.from(job.ntime, 'hex').reverse().copy(header, 68);           // ntime LE
  Buffer.from(job.nbits, 'hex').reverse().copy(header, 72);           // nbits LE
  return header;
}

/** Merkle root depuis le hash de la coinbase + branches Stratum. */
function buildMerkleRoot(cbHash, branches) {
  let root = cbHash;
  for (const b of branches) {
    root = sha256d(Buffer.concat([root, Buffer.from(b, 'hex')]));
  }
  return root;
}

/* ---- Décodage d'adresse Bitcoin → scriptPubKey (pour vérifier la coinbase) ---- */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
  let num = 0n;
  for (const c of str) {
    const v = B58.indexOf(c);
    if (v < 0) return null;
    num = num * 58n + BigInt(v);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let buf = Buffer.from(hex, 'hex');
  for (const c of str) { if (c !== '1') break; buf = Buffer.concat([Buffer.from([0]), buf]); }
  return buf;
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(valeurs) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of valeurs) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function bech32Decode(addr) {
  const s = addr.toLowerCase();
  if (s !== addr && addr.toUpperCase() !== addr) return null;  // casse mixte interdite
  const sep = s.lastIndexOf('1');
  if (sep < 1 || s.length > 90) return null;
  const hrp = s.slice(0, sep);
  if (hrp !== 'bc' && hrp !== 'tb' && hrp !== 'bcrt') return null;
  const data = [];
  for (const c of s.slice(sep + 1)) {
    const v = BECH32.indexOf(c);
    if (v < 0) return null;
    data.push(v);
  }
  if (data.length < 7) return null;
  const vals = data.slice(0, -6);           // somme de contrôle retirée
  const version = vals[0];
  // Vérification de la somme de contrôle : bech32 (v0) ou bech32m (v1+)
  const attendu = version === 0 ? 1 : 0x2bc830a3;
  if (bech32Polymod(hrpExpand(hrp).concat(data)) !== attendu) return null;
  // conversion 5 bits → 8 bits
  let acc = 0, bits = 0;
  const out = [];
  for (const v of vals.slice(1)) {
    acc = (acc << 5) | v; bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  const program = Buffer.from(out);
  if (bits >= 5 || (acc << (8 - bits)) & 0xff) return null;   // bits de rembourrage non nuls
  if (program.length < 2 || program.length > 40) return null;
  if (version === 0 && program.length !== 20 && program.length !== 32) return null;
  if (version > 16) return null;
  return { version, program };
}

/** scriptPubKey attendu (hex) pour une adresse, ou null si format non reconnu. */
function scriptDepuisAdresse(addr) {
  try {
    if (/^(bc1|tb1)/i.test(addr)) {
      const d = bech32Decode(addr);
      if (!d) return null;
      const op = d.version === 0 ? 0x00 : 0x50 + d.version;
      return Buffer.concat([Buffer.from([op, d.program.length]), d.program]).toString('hex');
    }
    const b = base58Decode(addr);
    if (!b || b.length !== 25) return null;
    // Somme de contrôle Base58Check : 4 derniers octets = sha256d(payload)
    const somme = sha256d(b.slice(0, 21)).slice(0, 4);
    if (!somme.equals(b.slice(21))) return null;
    const hash = b.slice(1, 21);
    if (b[0] === 0x00) return '76a914' + hash.toString('hex') + '88ac';   // P2PKH
    if (b[0] === 0x05) return 'a914' + hash.toString('hex') + '87';       // P2SH
    return null;
  } catch { return null; }
}

/* ---- Analyse complète de la transaction coinbase (sorties + montants) ---- */

function lireVarint(buf, o) {
  const p = buf[o];
  if (p < 0xfd) return { valeur: p, taille: 1 };
  if (p === 0xfd) return { valeur: buf.readUInt16LE(o + 1), taille: 3 };
  if (p === 0xfe) return { valeur: buf.readUInt32LE(o + 1), taille: 5 };
  return { valeur: Number(buf.readBigUInt64LE(o + 1)), taille: 9 };
}

/** Analyse une coinbase sérialisée et renvoie ses sorties avec leurs montants.
 *  Note : coinb1+extranonce1+extranonce2+coinb2 (fourni par le pool via Stratum)
 *  est toujours en sérialisation "legacy", jamais SegWit — pas de marqueur à gérer.
 *  Une coinbase valide a toujours exactement 1 entrée : si ce n'est pas le cas,
 *  la reconstruction est corrompue (tailles d'extranonce incohérentes, job
 *  périmé...) et on préfère le détecter tout de suite plutôt que de mal parser. */
function analyserCoinbase(hex) {
  try {
    const b = Buffer.from(hex, 'hex');
    let o = 4;                                        // version
    const nIn = lireVarint(b, o); o += nIn.taille;
    if (nIn.valeur !== 1) return null;                // une coinbase n'a jamais qu'une entrée
    for (let i = 0; i < nIn.valeur; i++) {
      o += 36;                                        // outpoint
      const sl = lireVarint(b, o); o += sl.taille + sl.valeur;
      o += 4;                                         // sequence
    }
    const nOut = lireVarint(b, o); o += nOut.taille;
    if (!nOut.valeur || nOut.valeur > 100) return null;
    const sorties = [];
    for (let i = 0; i < nOut.valeur; i++) {
      if (o + 8 > b.length) return null;
      const satoshis = Number(b.readBigUInt64LE(o)); o += 8;
      const sl = lireVarint(b, o); o += sl.taille;
      if (o + sl.valeur > b.length) return null;
      sorties.push({ satoshis, script: b.slice(o, o + sl.valeur).toString('hex') });
      o += sl.valeur;
    }
    return { sorties };
  } catch { return null; }
}

/** Ce que l'utilisateur toucherait réellement si ce bloc était trouvé. */
function verifierPaiement(hex, scriptAttendu) {
  const cb = analyserCoinbase(hex);
  if (!cb) return { etat: 'illisible', satoshis: 0, total: 0, part: 0 };
  let a_moi = 0, total = 0;
  for (const s of cb.sorties) {
    total += s.satoshis;
    if (s.script === scriptAttendu) a_moi += s.satoshis;
  }
  const part = total > 0 ? a_moi / total : 0;
  const etat = a_moi > 0 ? (part >= 0.99 ? 'complet' : 'partiel') : 'absent';
  return { etat, satoshis: a_moi, total, part };
}

/** Hauteur de bloc extraite de coinb1 (BIP34), best-effort. */
function parseBlockHeight(coinb1Hex) {
  try {
    const buf = Buffer.from(coinb1Hex, 'hex');
    // tx: version(4) + nb_inputs(1) + outpoint(36) + scriptLen(varint 1) + push(1) + hauteur LE
    const i = 4 + 1 + 36;
    const pushLen = buf[i + 1];
    if (pushLen < 1 || pushLen > 4) return null;
    let h = 0;
    for (let k = pushLen - 1; k >= 0; k--) h = h * 256 + buf[i + 2 + k];
    return h;
  } catch { return null; }
}

/* ================================ WORKER ================================== */

/* Modules WASM embarqués (compilés depuis AssemblyScript) :
   - SIMD : 4 nonces par itération (i32x4), scan par lots avec collecte des candidats
   - scalaire : repli si le SIMD n'est pas supporté */
const WASM_SIMD2S_B64 = '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';
const WASM_SIMD2D_B64 = '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';
const WASM_SIMD_B64 = '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';
const WASM_B64 = 'AGFzbQEAAAABFgNgCX9/f39/f39/fwBgAn9/AX5gAAADBAMAAQIFAwEAAQY4C38BQQALfwFBAAt/AUEAC38BQQALfwFBAAt/AUEAC38BQQALfwFBAAt/AUEAC38BQQALfwFBAAsHGwMHcHJlcGFyZQACBHNjYW4AAQZtZW1vcnkCAAwBAgqNCwPLAgELfyAAIQkgASEKIAIhCyADIQwgBCENIAUhDiAGIQ8gByEQA0AgEUHAAEgEQCARQQJ0IhJBsCJqKAIAIBJBoCBqKAIAIAcgBEEHdCAEQRl2ciAEQRp0IARBBnZyIARBFXQgBEELdnJzc2ogBCAFcSAEQX9zIAZxc2pqaiESIABBCnQgAEEWdnIgAEEedCAAQQJ2ciAAQRN0IABBDXZyc3MgASACcSAAIAFxIAAgAnFzc2ohEyAGIQcgBSEGIAQhBSADIBJqIQQgAiEDIAEhAiAAIQEgEiATaiEAIBFBAWohEQwBCwsgCCAAIAlqNgIAIAhBBGogASAKajYCACAIQQhqIAIgC2o2AgAgCEEMaiADIAxqNgIAIAhBEGogBCANajYCACAIQRRqIAUgDmo2AgAgCEEYaiAGIA9qNgIAIAhBHGogByAQajYCAAubBQEFfwNAIAEgA0sEQEGwIiMINgIAQbQiIwk2AgBBuCIjCjYCAEG8IiAAIANqIgRBgP6DeHFBCHcgBEH/gfwHcUEIeHI2AgBBwCJBgICAgHg2AgBBBSECA0AgAkEPSARAIAJBAnRBsCJqQQA2AgAgAkEBaiECDAELC0HsIkGABTYCAEEQIQIDQCACQcAASARAIAJBAnQiBUGoImooAgAhBiAFQbAiaiAFQZQiaigCACAFQfAhaigCACAFQfQhaigCACIFQRl0IAVBB3ZyIAVBDnQgBUESdnJzIAVBA3ZzamogBkEPdCAGQRF2ciAGQQ10IAZBE3ZycyAGQQp2c2o2AgAgAkEBaiECDAELCyMAIwEjAiMDIwQjBSMGIwdBsCQQAEGwIkGwJCgCADYCAEG0IkG0JCgCADYCAEG4IkG4JCgCADYCAEG8IkG8JCgCADYCAEHAIkHAJCgCADYCAEHEIkHEJCgCADYCAEHIIkHIJCgCADYCAEHMIkHMJCgCADYCAEHQIkGAgICAeDYCAEEJIQIDQCACQQ9IBEAgAkECdEGwImpBADYCACACQQFqIQIMAQsLQewiQYACNgIAQRAhAgNAIAJBwABIBEAgAkECdCIFQagiaigCACEGIAVBsCJqIAVBlCJqKAIAIAVB8CFqKAIAIAVB9CFqKAIAIgVBGXQgBUEHdnIgBUEOdCAFQRJ2cnMgBUEDdnNqaiAGQQ90IAZBEXZyIAZBDXQgBkETdnJzIAZBCnZzajYCACACQQFqIQIMAQsLQefMp9AGQYXdntt7QfLmu+MDQbrqv6p6Qf+kuYgFQYzRldh5Qauzj/wBQZmag98FQYABEABBnAEoAgBB//8DcUUEQCAErQ8LIANBAWohAwwBCwtCfwugAwEDfwNAIABBEEgEQCAAQQJ0IgEoAgAhAiABQbAiaiACQYD+g3hxQQh3IAJB/4H8B3FBCHhyNgIAIABBAWohAAwBCwtBECEAA0AgAEHAAEgEQCAAQQJ0IgFBqCJqKAIAIQIgAUGwImogAUGUImooAgAgAUHwIWooAgAgAUH0IWooAgAiAUEZdCABQQd2ciABQQ50IAFBEnZycyABQQN2c2pqIAJBD3QgAkERdnIgAkENdCACQRN2cnMgAkEKdnNqNgIAIABBAWohAAwBCwtB58yn0AZBhd2e23tB8ua74wNBuuq/qnpB/6S5iAVBjNGV2HlBq7OP/AFBmZqD3wVBsCQQAEGwJCgCACQAQbQkKAIAJAFBuCQoAgAkAkG8JCgCACQDQcAkKAIAJARBxCQoAgAkBUHIJCgCACQGQcwkKAIAJAdBwAAoAgAiAEGA/oN4cUEIdyAAQf+B/AdxQQh4ciQIQcQAKAIAIgBBgP6DeHFBCHcgAEH/gfwHcUEIeHIkCUHIACgCACIAQYD+g3hxQQh3IABB/4H8B3FBCHhyJAoLC5gCAgBBjCALAhwBAEGYIAuIAgQAAAAAAQAAmC+KQpFEN3HP+8C1pdu16VvCVjnxEfFZpII/ktVeHKuYqgfYAVuDEr6FMSTDfQxVdF2+cv6x3oCnBtybdPGbwcFpm+SGR77vxp3BD8yhDCRvLOktqoR0StypsFzaiPl2UlE+mG3GMajIJwOwx39Zv/ML4MZHkafVUWPKBmcpKRSFCrcnOCEbLvxtLE0TDThTVHMKZbsKanYuycKBhSxykqHov6JLZhqocItLwqNRbMcZ6JLRJAaZ1oU1DvRwoGoQFsGkGQhsNx5Md0gntbywNLMMHDlKqthOT8qcW/NvLmjugo90b2OleBR4yIQIAseM+v++kOtsUKT3o/m+8nhxxg==';

if (!isMainThread) {
  const workerId = workerData.workerId;
  let wasmEngine = null;   // { prepare, scan, mem, dv } ou null si repli sur crypto
  let current = null;      // { header76, job, en2hex, target, poolDiff }
  let job = null;
  let extranonce1 = '';
  let en2size = 4;
  let poolDiff = 1;
  let target = difficultyToTarget(1);
  let en2Counter = 0;
  let nonce = 0;

  function makeExtranonce2() {
    const en2 = Buffer.alloc(en2size);
    if (en2size > 0) en2[0] = workerId & 0xff;
    let c = en2Counter;
    for (let i = 1; i < en2size; i++) { en2[i] = c & 0xff; c = Math.floor(c / 256); }
    return en2;
  }

  function prepareWork() {
    if (!job) return;
    const en2 = makeExtranonce2();
    const coinbase = Buffer.from(job.coinb1 + extranonce1 + en2.toString('hex') + job.coinb2, 'hex');
    const merkleRoot = buildMerkleRoot(sha256d(coinbase), job.merkleBranch);
    const header = buildHeaderPrefix(job, merkleRoot);
    current = { header, en2hex: en2.toString('hex') };
    nonce = 0;
    if (wasmEngine) {
      wasmEngine.mem.set(header, 0);
      wasmEngine.prepare();
    }
  }

  parentPort.on('message', (m) => {
    if (m.type === 'job') {
      job = m.job;
      extranonce1 = m.extranonce1;
      en2size = m.extranonce2Size;
      if (typeof m.difficulty === 'number') { poolDiff = m.difficulty; target = difficultyToTarget(poolDiff); }
      en2Counter = (en2Counter + 1) & 0xffffff;
      prepareWork();
    } else if (m.type === 'difficulty') {
      poolDiff = m.value;
      target = difficultyToTarget(poolDiff);
    }
  });

  function reportCandidate(hashBuf, n) {
    const diff = hashDifficulty(hashBuf);
    // Preuve vérifiable : préfixe fixe de l'en-tête (76 octets) + le nonce gagnant exact,
    // reconstitué ici (les moteurs WASM/SIMD ne réécrivent pas le nonce dans ce buffer JS).
    const preuveHeader = Buffer.alloc(80);
    current.header.copy(preuveHeader, 0, 0, 76);
    preuveHeader.writeUInt32LE(n >>> 0, 76);
    parentPort.postMessage({ type: 'best', diff, headerHex: preuveHeader.toString('hex') });
    const beHex = Buffer.from(hashBuf).reverse().toString('hex');
    if (BigInt('0x' + beHex) <= target) {
      parentPort.postMessage({
        type: 'share',
        jobId: job.jobId,
        extranonce2: current.en2hex,
        ntime: job.ntime,
        nonce: (n >>> 0).toString(16).padStart(8, '0'),
        diff,
        hash: beHex,
      });
    }
  }

  function nextExtranonce2() {
    en2Counter = (en2Counter + 1) & 0xffffff;
    prepareWork();
  }

  // --- Chemin WASM : le scan de nonces se fait entièrement dans le module ---
  const BATCH_WASM = 262144;
  function readWasmDigest() {
    const buf = Buffer.alloc(32);
    for (let i = 0; i < 8; i++) buf.writeUInt32BE(wasmEngine.dv.getUint32(128 + i * 4, true), i * 4);
    return buf;
  }
  function mineWasm() {
    if (!current) { setTimeout(mineWasm, 200); return; }
    const remaining = 0x100000000 - nonce;
    const count = Math.min(BATCH_WASM, remaining);
    const r = Number(wasmEngine.scan(nonce >>> 0, count));
    let done;
    if (r >= 0) {
      done = r - nonce + 1;
      reportCandidate(readWasmDigest(), r);
      nonce = r + 1;
    } else {
      done = count;
      nonce += count;
    }
    if (nonce >= 0x100000000) nextExtranonce2();
    parentPort.postMessage({ type: 'stats', hashes: done });
    setImmediate(mineWasm);
  }

  // --- Chemin de repli : moteur crypto natif de Node ---
  const BATCH = 25000;
  function mineCrypto() {
    if (!current) { setTimeout(mineCrypto, 200); return; }
    const header = current.header;
    let n = nonce;
    for (let i = 0; i < BATCH; i++) {
      header.writeUInt32LE(n >>> 0, 76);
      const hash = sha256d(header);
      if (hash[31] === 0 && hash[30] === 0) reportCandidate(hash, n);
      n = (n + 1) >>> 0;
      if (n === 0) { nextExtranonce2(); break; }
    }
    nonce = n;
    parentPort.postMessage({ type: 'stats', hashes: BATCH });
    setImmediate(mineCrypto);
  }

  // --- Chemin SIMD : 4 nonces par itération, candidats collectés par lots ---
  function mineSimd() {
    if (!current) { setTimeout(mineSimd, 200); return; }
    const remaining = 0x100000000 - nonce;
    const count = Math.min(BATCH_WASM, remaining);
    const r = wasmEngine.scan(nonce >>> 0, count);
    const processed = Number(r >> 32n);
    const cands = Number(r & 0xffffffffn);
    for (let i = 0; i < cands; i++) {
      const off = 128 + i * 40;
      const cn = wasmEngine.dv.getUint32(off, true);
      const buf = Buffer.alloc(32);
      for (let j = 0; j < 8; j++) buf.writeUInt32BE(wasmEngine.dv.getUint32(off + 4 + j * 4, true), j * 4);
      reportCandidate(buf, cn);
    }
    nonce += processed;
    if (nonce >= 0x100000000) nextExtranonce2();
    parentPort.postMessage({ type: 'stats', hashes: processed });
    setImmediate(mineSimd);
  }

  async function loadEngine(b64) {
    const mod = await WebAssembly.instantiate(Buffer.from(b64, 'base64'), {
      env: { abort: () => { throw new Error('wasm abort'); } },
    });
    const { prepare, scan, memory } = mod.instance.exports;
    return { prepare, scan, mem: new Uint8Array(memory.buffer), dv: new DataView(memory.buffer) };
  }

  /** Mesure le débit d'un moteur SIMD (~0,15 s) pour choisir le meilleur sur CETTE machine. */
  function benchEngine(eng) {
    const hd = crypto.randomBytes(80);
    eng.mem.set(hd, 0);
    eng.prepare();
    eng.scan(0, 131072); // échauffement du JIT
    const N = 393216;
    const t0 = process.hrtime.bigint();
    let cursor = 0;
    while (cursor < N) {
      const r = eng.scan(131072 + cursor, N - cursor);
      cursor += Number(r >> 32n);
    }
    return N / (Number(process.hrtime.bigint() - t0) / 1e9);
  }

  (async () => {
    // Trois variantes SIMD : la meilleure dépend de l'architecture (registres, JIT).
    const variants = [
      ['boucles compactes', WASM_SIMD_B64],
      ['déroulé simple vague', WASM_SIMD2S_B64],
      ['déroulé double vague', WASM_SIMD2D_B64],
    ];
    let best = null, bestRate = 0, bestName = '';
    for (const [name, b64] of variants) {
      try {
        const eng = await loadEngine(b64);
        const rate = benchEngine(eng);
        if (rate > bestRate) { best = eng; bestRate = rate; bestName = name; }
      } catch (e) { /* variante non supportée sur cette machine */ }
    }
    if (best) {
      wasmEngine = best;
      if (current) { wasmEngine.mem.set(current.header, 0); wasmEngine.prepare(); nonce = 0; }
      parentPort.postMessage({ type: 'engine', engine: 'simd', variant: bestName, rate: bestRate });
      mineSimd();
      return;
    }
    try {
      wasmEngine = await loadEngine(WASM_B64);
      if (current) { wasmEngine.mem.set(current.header, 0); wasmEngine.prepare(); nonce = 0; }
      parentPort.postMessage({ type: 'engine', engine: 'wasm' });
      mineWasm();
    } catch (e) {
      wasmEngine = null;
      parentPort.postMessage({ type: 'engine', engine: 'crypto', reason: String(e) });
      mineCrypto();
    }
  })();
  return;
}

/* ============================ PROCESSUS PRINCIPAL ========================= */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const suivant = argv[i + 1];
      if (suivant === undefined || suivant.startsWith('--')) args[a.slice(2)] = true;
      else args[a.slice(2)] = argv[++i];
    }
    else args._.push(a);
  }
  return args;
}

/* ------------------------------- Self-test -------------------------------- */

function selfTest() {
  console.log('🧪 Self-test du moteur de hash (bloc Genesis)…');
  // 1) sha256d de l'en-tête Genesis brut
  const genesisHeader = Buffer.from(
    '0100000000000000000000000000000000000000000000000000000000000000' +
    '000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa' +
    '4b1e5e4a29ab5f49ffff001d1dac2b7c', 'hex');
  const h1 = Buffer.from(sha256d(genesisHeader)).reverse().toString('hex');
  const expected = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
  console.log('  sha256d(header Genesis) :', h1 === expected ? '✅ OK' : `ÉCHEC (${h1})`);

  // 2) Reconstruction complète façon Stratum (coinbase → merkle → header → hash)
  const cbTx =
    '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d' +
    '0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66' +
    '207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe55' +
    '48271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba' +
    '0b8d578a4c702b6bf11d5fac00000000';
  const job = {
    jobId: 'genesis',
    prevhash: '0'.repeat(64),
    coinb1: cbTx, coinb2: '',
    merkleBranch: [],
    version: '00000001',
    nbits: '1d00ffff',
    ntime: '495fab29',
  };
  const merkleRoot = buildMerkleRoot(sha256d(Buffer.from(cbTx, 'hex')), job.merkleBranch);
  const mrHex = Buffer.from(merkleRoot).reverse().toString('hex');
  const mrExpected = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b';
  console.log('  merkle root Genesis     :', mrHex === mrExpected ? '✅ OK' : `ÉCHEC (${mrHex})`);

  const header = buildHeaderPrefix(job, merkleRoot);
  header.writeUInt32LE(0x7c2bac1d, 76);
  const h2raw = sha256d(header);
  const h2 = Buffer.from(h2raw).reverse().toString('hex');
  console.log('  header reconstruit      :', h2 === expected ? '✅ OK' : `ÉCHEC (${h2})`);
  console.log('  difficulté du hash      :', hashDifficulty(h2raw).toFixed(1), '(attendu ≈ 2536.4)');

  const ok = h1 === expected && mrHex === mrExpected && h2 === expected;
  console.log(ok ? '✅ Moteur validé.' : '❌ Problème détecté.');
  process.exit(ok ? 0 : 1);
}

/* ============================ MODULE VERUSCOIN ============================= */
/* Mode indépendant : pilote un mineur natif externe (ccminer -a verus) via
 * un processus enfant. N'utilise ni les worker_threads WASM, ni le client
 * Stratum interne du moteur BTC/Fractal — architecture, code et état séparés. */

function normaliserVersMHs(valeur, unite) {
  const n = Number(String(valeur).replace(',', '.'));
  if (!isFinite(n)) return 0;
  switch (unite.toUpperCase()) {
    case 'H': return n / 1e6;
    case 'KH': return n / 1e3;
    case 'MH': return n;
    case 'GH': return n * 1e3;
    case 'TH': return n * 1e6;
    default: return 0;
  }
}

function analyserLigneVerus(ligne, s) {
  const mHash = ligne.match(/([\d.,]+)\s*(H|KH|MH|GH|TH)\/s/i);
  if (mHash) s.hashrateMHs = normaliserVersMHs(mHash[1], mHash[2]);

  if (/accepted|share accepted|yes!/i.test(ligne)) { s.accepted++; s.poolConnected = true; }
  if (/rejected|share rejected|booooo/i.test(ligne)) { s.rejected++; s.poolConnected = true; }

  const mDiff = ligne.match(/diff(?:iculty)?[\s:=]+([\d.eE+-]+)/i);
  if (mDiff) s.difficulty = Number(mDiff[1]);

  if (/connected|authorized|login succeeded|connection.*establish/i.test(ligne)) s.poolConnected = true;
  if (/connection refused|timeout|disconnected|dns/i.test(ligne)) s.poolConnected = false;
}

function demarrerVerus(args) {
  const address = args._[0] || process.env.VRSC_ADDRESS;
  if (!address) {
    console.error('\nUsage : node axecube.js <ADRESSE_VRSC> --network verus --verus-miner /chemin/vers/ccminer [options]\n');
    process.exit(1);
  }
  const minerPath = args['verus-miner'] || process.env.VERUS_MINER_PATH;
  if (!minerPath || !fs.existsSync(minerPath)) {
    console.error(`\n⚠️  Mineur Verus introuvable${minerPath ? ` : ${minerPath}` : ' (précise --verus-miner /chemin/vers/ccminer)'}.\n`);
    process.exit(1);
  }

  const pool = args['verus-pool'] || process.env.VERUS_POOL;
  if (!pool || !pool.startsWith('stratum+tcp://')) {
    console.error('\n⚠️  --verus-pool doit être une URL du type stratum+tcp://host:port\n');
    process.exit(1);
  }
  const workerName = args['verus-worker'] || process.env.VERUS_WORKER || 'axecube';
  const password = args['verus-password'] || process.env.VERUS_PASSWORD || 'x';
  const coreCount = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  let threads = Math.max(1, Math.min(coreCount, parseInt(args['verus-threads'] || process.env.VERUS_THREADS ||
                    String(Math.max(1, coreCount - 1)), 10)));
  const dashPort = parseInt(args.port || process.env.DASH_PORT || '1337', 10);
  const user = `${address}.${workerName}`;

  const s = {
    running: false, poolConnected: false, startedAt: 0,
    hashrateMHs: 0, accepted: 0, rejected: 0, difficulty: 0, threads, coreCount,
    processId: null, pool, user, logs: [],
  };
  const journal = (level, message) => {
    s.logs.push({ t: Date.now(), level, message });
    if (s.logs.length > 300) s.logs.shift();
    console.log(`[${new Date().toLocaleTimeString('fr-FR')}] ${message}`);
  };

  let enfant = null;
  let tentative = 0;
  let arretVoulu = false;
  let redemarrageVoulu = false;

  function lancer() {
    const arguments_ = ['-a', 'verus', '-o', pool, '-u', user, '-p', password, '-t', String(s.threads)];
    journal('info', `Lancement du mineur Verus (${s.threads} threads) sur ${pool}…`);
    enfant = spawn(minerPath, arguments_, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    s.processId = enfant.pid;
    s.running = true;
    s.startedAt = Date.now();
    s.hashrateMHs = 0;

    const surLigne = (buf) => {
      for (const ligne of buf.toString('utf8').split('\n')) {
        if (!ligne.trim()) continue;
        analyserLigneVerus(ligne, s);
        journal('info', `[ccminer] ${ligne.trim()}`);
      }
    };
    enfant.stdout.on('data', surLigne);
    enfant.stderr.on('data', surLigne);

    enfant.on('error', (err) => {
      journal('err', `Impossible de lancer le mineur : ${err.message}`);
    });

    enfant.on('exit', (code, signal) => {
      s.running = false;
      s.poolConnected = false;
      if (redemarrageVoulu) {
        redemarrageVoulu = false;
        journal('info', 'Redémarrage avec le nouveau nombre de cœurs…');
        lancer();
        return;
      }
      journal(code === 0 ? 'info' : 'err',
        `Mineur Verus arrêté (code ${code}${signal ? `, signal ${signal}` : ''}).`);
      if (!arretVoulu) {
        tentative++;
        const delai = Math.min(60000, 5000 * tentative);
        journal('warn', `Reconnexion dans ${Math.round(delai / 1000)}s…`);
        setTimeout(lancer, delai);
      } else {
        tentative = 0;
      }
    });
  }

  function arreter() {
    arretVoulu = true;
    if (enfant && !enfant.killed) {
      enfant.kill('SIGTERM');
      setTimeout(() => { if (enfant && !enfant.killed) enfant.kill('SIGKILL'); }, 5000);
    }
  }

  function changerThreads(n) {
    const nv = Math.max(1, Math.min(s.coreCount, n));
    if (nv === s.threads) return s.threads;
    s.threads = nv;
    journal('info', `Changement du nombre de cœurs → ${nv}. Redémarrage du mineur…`);
    if (enfant && !enfant.killed) {
      redemarrageVoulu = true;
      enfant.kill('SIGTERM');
      setTimeout(() => { if (enfant && !enfant.killed) enfant.kill('SIGKILL'); }, 5000);
    } else {
      lancer();
    }
    return s.threads;
  }

  process.on('SIGINT', () => { arreter(); process.exit(0); });
  process.on('SIGTERM', () => { arreter(); process.exit(0); });

  lancer();

  /* ------------------------- Dashboard HTTP (style AXECUBE) ------------------------ */
  const serveur = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/verus-stats') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        running: s.running, poolConnected: s.poolConnected,
        hashrateMHs: s.hashrateMHs, accepted: s.accepted, rejected: s.rejected,
        difficulty: s.difficulty, threads: s.threads, coreCount: s.coreCount,
        uptimeSeconds: s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0,
        processId: s.processId, pool: s.pool, user: s.user,
        logs: s.logs.slice(-80),
      }));
      return;
    }
    if (url.pathname === '/api/verus-threads') {
      const n = parseInt(url.searchParams.get('n'), 10);
      if (!Number.isInteger(n)) { res.writeHead(400); res.end('{}'); return; }
      const nv = changerThreads(n);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, threads: nv }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AXECUBE — VerusCoin</title>
<style>
  :root{
    --chassis:#0e0f12; --bezel:#17191f; --edge:#242832; --plate:#0a0b0e;
    --oled:#05070a; --amber:#96f01f; --amber-dim:rgba(150,240,31,.78);
    --amber-faint:rgba(150,240,31,.5); --glow:0 0 10px rgba(150,240,31,.35);
    --white-dim:#7a8496; --led-ok:#4dffc3; --led-ko:#ff4d5e;
    --mono:ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{background:#000;display:flex;justify-content:center;align-items:stretch;
       font-family:var(--mono);margin:0;padding:10px;-webkit-text-size-adjust:100%}
  .device{width:min(400px,100%);display:flex;flex-direction:column;
          background:linear-gradient(160deg,#14161b,var(--chassis) 40%);
          border:1px solid var(--edge);border-radius:22px;
          box-shadow:0 12px 40px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.05);
          padding:14px 14px 10px}
  .plate{display:flex;align-items:center;gap:10px;padding:3px 4px 13px;flex-wrap:wrap}
  .led{width:9px;height:9px;border-radius:50%;background:var(--led-ok);
       box-shadow:0 0 8px var(--led-ok);animation:pulse 3s ease-in-out infinite}
  @keyframes pulse{50%{box-shadow:0 0 12px var(--led-ok)}}
  .brandline{font-weight:800;letter-spacing:.06em;color:#eaeaea;font-size:17px}
  .brandline b{color:var(--amber)}
  .sub{font-size:8px;letter-spacing:.28em;color:var(--white-dim);margin-top:-2px}
  .brand{display:flex;flex-direction:column;line-height:1.1}
  .screen{flex:1;display:flex;flex-direction:column;gap:12px;overflow:hidden;
          background:var(--oled);border-radius:12px;border:1px solid #10141a;
          box-shadow:inset 0 0 30px rgba(0,0,0,.9);
          padding:16px 14px 12px;color:var(--amber);position:relative}
  .hero .l{font-size:9px;letter-spacing:.28em;color:var(--white-dim)}
  .hero .hr{font-size:38px;font-weight:800;line-height:1.1;text-shadow:var(--glow);
            font-variant-numeric:tabular-nums}
  .hero .meta{font-size:10px;color:var(--white-dim);margin-top:2px}
  .rows{display:flex;flex-direction:column;gap:7px;font-size:12.5px;margin-top:4px}
  .row{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .row .k{font-size:9px;letter-spacing:.18em;color:var(--white-dim)}
  .row b{font-variant-numeric:tabular-nums}
  .statut-run{color:var(--amber);text-shadow:var(--glow)}
  .statut-wait{color:#e8b64a}
  .statut-off{color:var(--led-ko)}
  .cores{display:flex;align-items:center;gap:8px}
  .cbtn{background:none;border:1px solid #333a47;color:#8a94a6;font-family:var(--mono);
        font-size:13px;width:24px;height:24px;border-radius:6px;cursor:pointer;line-height:1}
  .cbtn:hover{border-color:var(--amber);color:var(--amber)}
  .sep{border-top:1px dashed rgba(150,240,31,.18);margin:2px 0}
  .console{background:#03040600;border:1px solid #10141a;border-radius:8px;padding:9px 10px;
           height:170px;overflow-y:auto;font-size:10.5px;line-height:1.65;margin-top:4px}
  .console div{opacity:.95}
  .ok{color:var(--amber)}.err{color:#ff5d5d}.warn{color:#e8b64a}.info{color:#c9c9c9}
  .foot{text-align:center;padding-top:9px;font-size:8px;letter-spacing:.3em;color:#626c7e}
</style></head><body>
<div class="device">
  <div class="plate">
    <div class="led"></div>
    <div class="brand">
      <div class="brandline">AXE<b>CUBE</b></div>
      <div class="sub">VERUSCOIN · CPU</div>
    </div>
  </div>
  <div class="screen">
    <div class="hero">
      <div class="l">TAUX DE HASH</div>
      <div class="hr" id="hr">—</div>
      <div class="meta" id="statut">—</div>
    </div>
    <div class="rows">
      <div class="row"><span class="k">SHARES</span><b id="shares">—</b></div>
      <div class="row"><span class="k">DIFFICULTÉ</span><b id="diff">—</b></div>
      <div class="row"><span class="k">CŒURS</span>
        <div class="cores">
          <button class="cbtn" id="moins">−</button>
          <b id="th">—</b>
          <button class="cbtn" id="plus">+</button>
        </div>
      </div>
      <div class="row"><span class="k">TEMPS ACTIF</span><b id="up">—</b></div>
      <div class="row"><span class="k">POOL</span><b id="pool" style="font-size:10px">—</b></div>
    </div>
    <div class="sep"></div>
    <div class="console" id="logs"></div>
  </div>
  <div class="foot">VERUSHASH 2.2 · MINAGE POOL RÉEL</div>
</div>
<script>
function fmtUp(s){const h=String(Math.floor(s/3600)).padStart(2,'0'),m=String(Math.floor(s%3600/60)).padStart(2,'0'),ss=String(s%60).padStart(2,'0');return h+':'+m+':'+ss}
let coreMax = 1;
async function maj(){
  const d = await (await fetch('/api/verus-stats')).json();
  coreMax = d.coreCount || coreMax;
  const statutEl = document.getElementById('statut');
  if(!d.running){ statutEl.textContent='⏹ Arrêté'; statutEl.className='meta statut-off'; }
  else if(d.poolConnected){ statutEl.textContent='⛏ En minage'; statutEl.className='meta statut-run'; }
  else { statutEl.textContent='🔌 Connexion…'; statutEl.className='meta statut-wait'; }
  document.getElementById('hr').textContent = d.hashrateMHs.toFixed(2)+' MH/s';
  document.getElementById('shares').textContent = d.accepted+' acceptées · '+d.rejected+' rejetées';
  document.getElementById('diff').textContent = d.difficulty ? Number(d.difficulty).toLocaleString('fr-FR') : '—';
  document.getElementById('th').textContent = d.threads+'/'+d.coreCount;
  document.getElementById('up').textContent = fmtUp(d.uptimeSeconds);
  document.getElementById('pool').textContent = d.pool;
  const logs = document.getElementById('logs');
  const enBas = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 10;
  logs.innerHTML = d.logs.map(l=>'<div class="'+l.level+'">'+new Date(l.t).toLocaleTimeString('fr-FR')+' '+l.message+'</div>').join('');
  if(enBas) logs.scrollTop = logs.scrollHeight;
}
async function regler(delta){
  const actuel = parseInt((document.getElementById('th').textContent||'1').split('/')[0], 10) || 1;
  const cible = Math.max(1, Math.min(coreMax, actuel + delta));
  await fetch('/api/verus-threads?n='+cible);
  maj();
}
document.getElementById('plus').addEventListener('click', ()=>regler(1));
document.getElementById('moins').addEventListener('click', ()=>regler(-1));
maj(); setInterval(maj, 2000);
</script></body></html>`);
  });
  serveur.listen(dashPort, '127.0.0.1', () => {
    journal('info', `Dashboard VerusCoin : http://localhost:${dashPort}`);
  });
}

/* --------------------------------- Main ----------------------------------- */

/** Sur macOS, si axecube-temp-daemon.sh tourne (voir ce script), lit la donnée thermique
 *  réelle qu'il écrit dans /tmp/axecube-temp.log -- soit une température en °C (Mac Intel),
 *  soit un niveau de pression thermique qualitatif (Apple Silicon). Renvoie null si le
 *  démon n'est pas installé/lancé -- entièrement optionnel, jamais bloquant. */
function lireEtatThermiqueReel() {
  if (process.platform === 'win32') {
    // Valeur mise en cache par le sondage périodique en arrière-plan (voir
    // demarrerLectureTemperatureWindows plus bas) -- on ne relance jamais PowerShell
    // à chaque appel de cette fonction, ce serait bien trop lent pour l'API du dashboard.
    if (temperatureWindowsCache && (Date.now() - temperatureWindowsCache.quand) < 20000) {
      return { type: 'temperature', valeur: temperatureWindowsCache.valeur };
    }
    return null;
  }
  if (process.platform !== 'darwin') return null;
  try {
    const contenu = fs.readFileSync('/tmp/axecube-temp.log', 'utf8');
    for (const ligne of contenu.split('\n')) {
      const l = ligne.toLowerCase();
      if (l.includes('temperature')) {
        const m = ligne.match(/([0-9]+\.?[0-9]*)\s*C\b/);
        if (m) return { type: 'temperature', valeur: parseFloat(m[1]) };
      }
      if (l.includes('current pressure level')) {
        const parties = ligne.split(':');
        if (parties.length >= 2) return { type: 'pression', valeur: parties[1].trim() };
      }
    }
  } catch { /* fichier absent -- démon non installé, fonctionnalité optionnelle */ }
  return null;
}

// --- Windows : température CPU réelle via LibreHardwareMonitor -----------------------
// Windows n'expose pas la température CPU nativement de façon fiable (contrairement à
// macOS avec powermetrics) -- on s'appuie sur LibreHardwareMonitor (gratuit, open-source),
// qui doit tourner EN ADMINISTRATEUR pour publier ses capteurs via WMI. Si l'outil n'est
// pas installé/lancé, la requête échoue silencieusement et on se rabat sur l'indicateur
// de throttling basé sur le hashrate (déjà actif sur toutes les plateformes) -- aucun
// crash, fonctionnalité entièrement optionnelle comme sur Mac.
let temperatureWindowsCache = null; // { valeur, quand } ou null si jamais lu / indisponible
function demarrerLectureTemperatureWindows() {
  if (process.platform !== 'win32') return;
  const { exec } = require('child_process');
  // On prend le MAX parmi les capteurs "température package/total CPU" habituels,
  // pour rester compatible Intel (Package) et AMD (Tdie/Tctl) sans savoir à l'avance
  // quel capteur exact porte le nom sur la machine de l'utilisateur.
  const commande = 'powershell -NoProfile -NonInteractive -Command "'
    + "Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction Stop "
    + "| Where-Object { $_.SensorType -eq 'Temperature' -and ("
    + "$_.Name -like '*Package*' -or $_.Name -like '*CPU Total*' -or $_.Name -like '*Tdie*' -or $_.Name -like '*Core Max*'"
    + ") } | Measure-Object -Property Value -Maximum | Select-Object -ExpandProperty Maximum"
    + '"';
  function lire() {
    exec(commande, { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) { temperatureWindowsCache = null; return; }
      const v = parseFloat(String(stdout).trim());
      if (Number.isFinite(v)) temperatureWindowsCache = { valeur: v, quand: Date.now() };
      else temperatureWindowsCache = null;
    });
  }
  lire();
  setInterval(lire, 8000); // toutes les 8s -- assez réactif, sans spammer PowerShell
}
demarrerLectureTemperatureWindows();

function main() {
  const args = parseArgs(process.argv);
  if (args.version) { console.log(AXECUBE_VERSION); process.exit(0); }
  if (args.selftest) return selfTest();

  // Mode VerusCoin : module totalement indépendant, ne touche pas au moteur BTC/Fractal
  if ((args.network || '').toLowerCase() === 'verus') {
    return demarrerVerus(args);
  }

  // Vérification d'adresse pour le lanceur : code 0 = valide, 1 = invalide
  if (typeof args['verifier-adresse'] === 'string') {
    const sc = scriptDepuisAdresse(args['verifier-adresse']);
    if (sc) { console.log(sc); process.exit(0); }
    process.exit(1);
  }

  const address = args._[0] || process.env.BTC_ADDRESS;
  if (!address) {
    console.error('Usage : node axecube.js <ADRESSE_BTC> [--pool host:port] [--threads N] [--port N]');
    console.error('        node axecube.js --selftest');
    process.exit(1);
  }

  // Preregles de pool connus pour BTC. 'solo' = adresse brute, aucun compte requis
  // (recompense entiere sur cette adresse si un bloc est trouve -- a ne partager qu'en
  // confiance, ex. famille/amis). 'pool' = repartition automatique (FPPS/PPLNS),
  // necessite un compte cree au prealable sur le site du pool.
  const RESEAUX = {
    btc: { label: 'Bitcoin', symbole: 'BTC', recompense: 3.125,
           poolDefaut: 'public-pool.io', portDefaut: 21496 },
    fractal: { label: 'Fractal Bitcoin', symbole: 'FB', recompense: 25,
               poolDefaut: 'eu3.solopool.org', portDefaut: 8002 },
  };
  let reseauCle = (args.network || process.env.AXECUBE_NETWORK || 'btc').toLowerCase();
  let reseau = RESEAUX[reseauCle] || RESEAUX.btc;
  if (!RESEAUX[reseauCle]) {
    console.error(`\n⚠️  Reseau "${reseauCle}" inconnu. Reseaux disponibles : ${Object.keys(RESEAUX).join(', ')}.\n`);
    process.exit(1);
  }

  const PRESETS_POOL = {
    solopool:       { host: 'public-pool.io', port: 21496, mode: 'solo', compte: false, diffMin: 1,
                      note: 'Solo, aucun compte requis -- adresse BTC directe.' },
    'braiins-solo': { host: 'solo.stratum.braiins.com', port: 3333, mode: 'solo', compte: false, diffMin: 512,
                      note: 'Solo (Braiins), aucun compte requis -- adresse BTC directe. '
                          + 'Difficulte minimale fixee a 512 par le pool (documente officiellement).' },
    ckpool:         { host: 'solo.ckpool.org', port: 3333, mode: 'solo', compte: false, diffMin: 10000,
                      note: 'Solo (CKPool, actif depuis 2014, tres reputable), aucun compte requis -- '
                          + 'adresse BTC directe. 2% de frais sur bloc trouve. ATTENTION : difficulte '
                          + 'minimale fixee a 10000 par le pool -- a hashrate CPU, vos shares resteront '
                          + 'probablement invisibles la plupart du temps (ce pool cible plutot les ASIC).' },
    'mineshop-solo': { host: 'stratum-de.solo.mineshop.eu', port: 3333, mode: 'solo', compte: false, diffMin: 1,
                      note: 'Solo (Mineshop.eu), aucun compte requis -- adresse BTC directe. '
                          + '0% de frais, serveur Allemagne (faible latence Europe). Plancher de difficulte '
                          + 'abaisse a 1 (comme public-pool.io) : aucune limite technique confirmee cote '
                          + 'Mineshop, donc autant laisser le pool imposer lui-meme son vrai plancher via '
                          + 'son propre vardiff plutot que de le brider depuis le client.' },
    'nmminer-solo': { host: 'solobtc.nmminer.com', port: 3333, mode: 'solo', compte: false, diffMin: 1,
                      note: 'Solo (fork communautaire de public-pool.io, projet NMMiner), aucun compte '
                          + 'requis -- adresse BTC directe. Concu a l\'origine pour du materiel ESP32 '
                          + '(quelques centaines de kH/s) -- donc plancher de difficulte tres bas, ideal '
                          + 'pour voir des shares tres frequents sur un CPU. Alternative Australie '
                          + 'disponible : au.solobtc.nmminer.com.' },
    'nerdminer-solo': { host: 'pool.nerdminer.io', port: 3333, mode: 'solo', compte: false, diffMin: 1,
                      note: 'Solo (NerdMiner Pool, etabli depuis 2023), aucun compte requis -- '
                          + 'adresse BTC directe utilisee comme nom de worker, mot de passe "x". '
                          + 'Communaute active (Multi NerdMiner, Bitaxe, NMMiner, NerdAxe tous presents '
                          + 'sur ce pool) -- outil "Miner Lookup" public sur pool.nerdminer.io pour '
                          + 'verifier son propre statut par adresse.' },
    axeminer:       { host: 'pool.axeminer.com', port: 7777, mode: 'solo', compte: false, diffMin: 0.01,
                      note: 'Solo (AxeMiner Pool, "Where Small Miners Make Big Swings"), aucun compte '
                          + 'requis -- adresse BTC directe utilisee comme nom de worker, mot de passe "x". '
                          + 'Port 7777 officiellement dedie aux "Small USB Lottery Miner" 1-1000 kH/s '
                          + '(NMMiner, Nerdminer, BitsyMiner, ESP-32), difficulte plancher confirmee a 0.01 '
                          + '-- tres largement adaptee au CPU, shares tres frequents attendus. Port 7778 '
                          + 'separe existe pour les Bitaxe/petits ASIC (400 GH/s-4.5 TH/s, plancher 512), '
                          + 'non utilise ici. Pool explicitement non recommande pour Antminer ou gros ASIC.' },
    ocean:          { host: 'mine.ocean.xyz', port: 3334, mode: 'solo', compte: false, diffMin: 1,
                      note: 'Solo (OCEAN, fonde par Luke Dashjr -- developpeur Bitcoin Core -- et '
                          + 'soutenu par Jack Dorsey), aucun compte ni KYC requis -- adresse BTC directe. '
                          + 'Design non-custodial, dashboard consultable par simple adresse sur ocean.xyz. '
                          + 'Seul pool de cette liste avec des frais (2%, ou 1% via DATUM) preleves '
                          + 'uniquement si un bloc est trouve -- jamais sur les parts normales. Plancher de '
                          + 'difficulte non confirme officiellement pour du CPU (surtout teste avec du '
                          + 'materiel Bitaxe/ASIC), a verifier a l\'usage.' },
    'solopool-com': { host: 'eu.solopool.com', port: 3333, mode: 'solo', compte: false, diffMin: 1,
                      note: 'Solo (SoloPool.com, serveur EU), aucun compte requis -- adresse BTC directe. '
                          + 'Possede un client CPU/GPU dedie en open-source (SHA256-NI). Fonctionnalite '
                          + 'unique "Solo Split" : le mot de passe accepte un chiffre de 0 a 100 pour doser '
                          + 'librement le ratio solo/pool part par part (x = 100% solo par defaut). '
                          + '2% de frais dev, preleves uniquement sur un bloc reellement trouve. Port haute '
                          + 'difficulte separe (4444, diff 500000) reserve a la location de hashrate -- '
                          + 'utiliser le port standard 3333 pour un CPU.' },
    viabtc:         { host: 'btc.viabtc.io', port: 3333, mode: 'pool', compte: true, diffMin: 128,
                      note: 'Repartition auto (FPPS/PPS+/PPLNS) -- necessite un compte ViaBTC cree '
                          + 'au prealable sur viabtc.com. Utilisateur au format "votreIDViaBTC.worker", '
                          + 'pas votre adresse BTC seule.' },
    'braiins-pool': { host: 'stratum.braiins.com', port: 3333, mode: 'pool', compte: true, diffMin: 128,
                      note: 'Repartition auto (FPPS) -- necessite un compte cree au prealable sur '
                          + 'pool.braiins.com. Utilisateur au format "votrePseudoBraiins.worker", '
                          + 'pas votre adresse BTC seule.' },
  };
  const presetCle = args['pool-preset'] || process.env.POOL_PRESET || '';
  const preset = presetCle ? PRESETS_POOL[presetCle] : null;
  if (presetCle && !preset) {
    console.error(`\n⚠️  Prereglage "${presetCle}" inconnu. Disponibles : ${Object.keys(PRESETS_POOL).join(', ')}.\n`);
    process.exit(1);
  }
  const modeCle = (args.mode || (preset && preset.mode) || process.env.AXECUBE_MODE || 'solo').toLowerCase();

  const poolStr = args.pool || process.env.POOL
    || (preset ? `${preset.host}:${preset.port}` : `${reseau.poolDefaut}:${reseau.portDefaut}`);
  let [poolHost, poolPortStr] = poolStr.split(':');
  let poolPort = parseInt(poolPortStr || String(reseau.portDefaut), 10);
  // Mode simulation : toute connexion vers une adresse locale/privée (127.x, localhost,
  // ::1, 192.168.x, 10.x, 172.16-31.x) sans passer par un --pool-preset connu est
  // considérée comme un test (ex. axecube-simulateur.js) -- jamais un vrai pool public.
  // Empêche qu'un faux "bloc" trouvé en test ne contamine le vrai record all-time ou
  // ne soit soumis au leaderboard communautaire (voir garde plus bas).
  const enModeSimulation = !preset && /^(127\.|localhost$|::1$|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(poolHost);
  if (enModeSimulation) {
    console.log(`\n  🧪 Mode simulation détecté (pool local "${poolHost}") — le record all-time et le`);
    console.log(`     classement communautaire resteront protégés, aucune contamination possible.\n`);
  }
  const coreCount = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  const threads = Math.max(1, parseInt(args.threads || process.env.THREADS || String(Math.max(1, coreCount - 1)), 10));
  const dashPort = parseInt(args.port || process.env.DASH_PORT || '1337', 10);
  const ouvertLan = !!(args.lan || process.env.AXECUBE_LAN);
  const CLASSEMENT_PAR_DEFAUT = 'https://axecube-leaderboard.netlify.app';
  const leaderboardDesactive = !!(args['no-leaderboard'] || process.env.AXECUBE_NO_LEADERBOARD);
  const leaderboardUrl = leaderboardDesactive ? '' :
    ((typeof args.leaderboard === 'string' ? args.leaderboard : process.env.AXECUBE_LEADERBOARD) || CLASSEMENT_PAR_DEFAUT);
  const jeton = ouvertLan ? crypto.randomBytes(12).toString('hex') : null;

  // Identité machine : une empreinte tirée du matériel/OS, jamais stockée dans un fichier
  // qu'on pourrait copier d'une machine à l'autre par erreur (contrairement au nom de
  // worker, qui lui vit dans .axecube-config et peut être recopié par inadvertance).
  // Sert uniquement à distinguer deux machines physiques sur le classement — n'a aucun
  // rapport avec le nom affiché.
  function obtenirIdentiteMachine() {
    const { execFileSync } = require('child_process');
    let brut = '';
    try {
      if (process.platform === 'darwin') {
        const sortie = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 3000 }).toString('utf8');
        const m = sortie.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
        if (m) brut = m[1];
      } else if (process.platform === 'win32') {
        const sortie = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'], { timeout: 4000 }).toString('utf8');
        brut = sortie.trim();
      } else {
        brut = fs.readFileSync('/etc/machine-id', 'utf8').trim();
      }
    } catch { /* commande indisponible : repli ci-dessous */ }
    if (!brut) brut = `${os.hostname()}|${(os.cpus()[0] || {}).model || ''}|${os.totalmem()}`;
    return crypto.createHash('sha256').update(brut).digest('hex').slice(0, 12);
  }
  const machineId = obtenirIdentiteMachine();

  // Le nom de worker est celui choisi à la création (--worker=...), utilisé À L'IDENTIQUE
  // partout : pool, classement communautaire, dashboard local. Le machineId matériel reste
  // strictement interne -- jamais concaténé dans un nom visible ; il ne sert qu'en coulisses
  // (clé de stockage côté classement pour distinguer deux machines physiques, déduplication
  // via fusionner-identites.js). Si aucun nom n'est choisi, un nom par défaut dérivé du
  // machineId est utilisé comme repli -- seul cas où le machineId apparaît dans un nom.
  const nomPersonnalise = (args.worker || process.env.WORKER || '').trim();
  const suffixeMachine = machineId.slice(0, 6);
  let workerName = nomPersonnalise || `mineur-${suffixeMachine}`;
  const nomAffichage = workerName;
  // --solo-split N (0-100) : spécifique à SoloPool.com -- dose le ratio solo/pool part par
  // part directement via le mot de passe stratum (x = 100% solo, valeur par défaut). Prend
  // le pas sur --password quand fourni, puisque c'est la même mécanique sur ce pool précis
  // (le mot de passe standard n'a aucun autre rôle sur un pool solo classique).
  const soloSplitBrut = args['solo-split'] !== undefined ? args['solo-split'] : process.env.SOLO_SPLIT;
  const soloSplit = (soloSplitBrut !== undefined && soloSplitBrut !== '')
    ? Math.max(0, Math.min(100, parseInt(soloSplitBrut, 10) || 0)) : null;
  const poolPassword = (soloSplit !== null) ? String(soloSplit) : (args.password || process.env.POOL_PASSWORD || 'x');
  const user = `${address}.${workerName}`;
  let poolLabel = poolHost;

  /* ------------------------------ État global ----------------------------- */
  const state = {
    startedAt: Date.now(),
    connected: false,
    pool: `${poolHost}:${poolPort}`,
    user,
    threads,
    poolDiff: 1,
    netDiff: 0,
    blockHeight: null,
    jobId: null,
    accepted: 0,
    rejected: 0,
    bestDiff: 0,
    recordExterne: 0, // meilleure diff vue sur le pool, non prouvable localement -- affichage seulement
    engine: 'démarrage…',
    btcPrice: null, btcAt: 0,
    lastBlockAt: 0, netHashrate: 0,
    paiement: null, paiementCle: null,
    hrParCoeurPic: 0, throttle: 0, reseauChangeAt: 0,
    calibration: null, calibEnCours: false,
    histRecord: [], histHash: [],  // {t, v} échantillonnés pour la page détails
    startedReal: Date.now(),
    btcDevise: (args.devise || process.env.DEVISE || 'eur').toLowerCase(),
    btcSymbol: ({ eur: '€', usd: '$', gbp: '£', chf: 'CHF', cad: 'CA$' })[(args.devise || process.env.DEVISE || 'eur').toLowerCase()] || '',
    hashEvents: [],       // [{t, n}] fenêtre glissante
    hashrate: 0,
    log: [],              // derniers évènements
    totalHashes: 0,
    actif: true,           // false = minage en pause (workers arrêtés)
    // Meilleur candidat "en cours" (indépendant du record all-time) : sert uniquement à
    // alimenter les classements JOUR/SEMAINE/MOIS du classement communautaire. N'a pas
    // besoin d'être persisté ni remis à zéro localement -- le serveur gère le découpage
    // calendaire lui-même à chaque soumission reçue.
    bestDiffRecent: 0,
    bestProofHeaderRecent: null,
    // Skin Premium actif choisi localement par l'utilisateur (identifiant de fichier dans
    // assets/premium/, ou null = aucun -- retour à l'affichage automatique du palier
    // Genèse). Purement visuel : ne modifie JAMAIS bestDiff, paliersAtteints, ni aucune
    // donnée envoyée au classement -- voir infosCube()/carteComplete() côté client.
    skinPremiumActif: null,
    // bestDiff RÉELLEMENT vérifié côté serveur (jamais fiable en local seul -- voir
    // recupererBestDiffVerifie). Rafraîchi périodiquement ; 0 tant que le premier appel
    // n'a pas abouti. C'est cette valeur, jamais state.bestDiff seul, qui doit décider
    // quels badges bronze/argent/or/... sont affichés comme réellement débloqués.
    bestDiffVerifie: 0,
  };

  function log(kind, msg) {
    const entry = { t: Date.now(), kind, msg };
    state.log.push(entry);
    if (state.log.length > 300) state.log.shift();
    const stamp = new Date(entry.t).toLocaleTimeString('fr-FR');
    console.log(`[${stamp}] ${msg}`);
  }

  const scriptAttendu = modeCle === 'pool' ? null : scriptDepuisAdresse(address);
  if (modeCle !== 'pool' && !scriptAttendu) {
    console.error(`\n⚠️  "${address}" n'est pas une adresse Bitcoin valide (somme de contrôle incorrecte).`);
    console.error('   Vérifiez-la : une erreur de saisie enverrait la récompense dans le vide.\n');
    process.exit(1);
  }

  /* ------------------------------- Langues -------------------------------- */
  const lang = (args.lang || process.env.AXECUBE_LANG ||
    ((process.env.LANG || process.env.LC_ALL || 'fr').toLowerCase().startsWith('fr') ? 'fr' : 'en')).toLowerCase() === 'en' ? 'en' : 'fr';

  const LANGUES = {
    fr: {
      banniere: 'A X E C U B E — mineur lottery · minage solo Bitcoin',
      adresse: 'Adresse ', pool: 'Pool    ', threads: 'Cœurs   ',
      cours: (p, sym) => `💱 Cours BTC : ${p} ${sym}`,
      recordCharge: (d, sh, h) => `💾 Record chargé : ${d} (${sh} shares, ${h} cumulés)`,
      sauvegardeKo: (e) => `Sauvegarde impossible : ${e}`,
      etatSauve: '💾 État sauvegardé. À la prochaine !',
      nouveauRecord: (d) => `🏆 Nouveau record de difficulté : ${d}`,
      workerErr: (i, e) => `Worker ${i} erreur : ${e}`,
      threadsMaj: (n) => `Cœurs → ${n}`,
      moteurSimd: (v, r) => `⚡⚡ Moteur WASM SIMD activé — variante « ${v} » (${r} MH/s au banc d'essai)`,
      moteurWasm: '⚡ Moteur WASM activé (SHA-256d midstate)',
      moteurRepli: (r) => `Moteur de repli crypto (WASM indisponible : ${r})`,
      sharePerdu: 'Share trouvé mais pool déconnecté — perdu.',
      shareSoumis: (d, n) => `📤 Share soumis (diff ${d}) nonce=${n}`,
      blocTrouve: '🎉🎉🎉 DIFFICULTÉ RÉSEAU ATTEINTE — BLOC POTENTIEL TROUVÉ !!! 🎉🎉🎉',
      souscription: (e1, sz) => `Souscription OK (extranonce1=${e1}, en2size=${sz})`,
      autorise: (w) => `✅ Autorisé sur le pool (worker « ${w} »)`,
      autoRefus: (e) => `❌ Autorisation refusée : ${e} — vérifie ton adresse BTC.`,
      shareOk: (d, t) => `✅ Share ACCEPTÉ (diff ${d}) — total ${t}`,
      shareKo: (e) => `❌ Share rejeté : ${e}`,
      diffPool: (d) => `Difficulté pool → ${d}`,
      nouveauBloc: (j, h) => `Nouveau bloc réseau — job ${j} (hauteur ${h})`,
      connexion: (h, p) => `Connexion à ${h}:${p}…`,
      connecte: (h) => `⚡ Connecté à ${h}`,
      poolIllisible: (l) => `Message pool illisible : ${l}`,
      reseauErr: (e) => `Erreur réseau : ${e}`,
      deconnecte: 'Déconnecté du pool — reconnexion dans 5 s…',
      dashboard: (p) => `📊 Dashboard : http://localhost:${p}`,
      dashboardLocal: (p) => `📊 Dashboard : http://localhost:${p}  (téléphone : ajoutez --lan)`,
      changementReseau: (l) => `🔀 Changement de réseau : ${l} — reconnexion…`,
      calibDebut: (p) => `🌡️ Calibration en cours — test des paliers : ${p} cœurs (~1 min)`,
      calibPalier: (n, hr) => `   ${n} cœurs → ${hr} MH/s`,
      calibFin: (no, ho, nm, hm) => `✅ Réglage optimal : ${no} cœurs (${ho} MH/s) · max ${nm} cœurs (${hm} MH/s)`,
      dashboardLan: (u) => `📱 Depuis votre téléphone (même Wi-Fi) : http://${u}`,
      recordRepris: (d) => `🏆 Record repris depuis le pool : ${d}`,
      lanFerme: '🔒 Accès limité à cet ordinateur. Pour le téléphone : relancez avec --lan',
      jetonManquant: 'AXECUBE : accès refusé. Utilisez le lien complet affiché au démarrage (avec ?token=…).',
      dashboardLanAutre: (n, u) => `   … ou (${n}) : http://${u}`,
      paieComplet: (b, p, sym) => `🔒 Coinbase analysée : ${b} ${sym} vous reviendraient (${p} % des sorties)`,
      paiePartiel: (b, p, sym) => `🔎 Coinbase analysée : ${b} ${sym} pour vous, soit ${p} % des sorties`,
      paieAbsent: '⚠️ Votre adresse n\'apparaît dans AUCUNE sortie de la coinbase',
      paieIllisible: 'Coinbase illisible : montant non vérifiable',
      ui: {
        hashrate: 'TAUX DE HASH', record: 'RECORD DE DIFFICULTÉ', recordCourt: 'RECORD',
        shares: 'SHARES', difficulte: 'DIFFICULTÉ', bloc: 'BLOC', reseau: 'RÉSEAU',
        coeurs: 'CŒURS', uptime: 'UPTIME', cours: 'COURS BTC', depuis: 'DEPUIS',
        acceptes: 'acceptés', rejetes: 'rejetés', poolMot: 'pool', reseauMot: 'réseau',
        demarrage: 'démarrage…', calibrage: 'Calibrage de la loterie…',
        ilya: 'il y a', h: 'h', min: 'min', s: 's', j: 'j',
        chance: 'chance sur', parBloc: 'par bloc', tempsMoyen: 'temps moyen',
        ans: 'ans', jackpot: 'jackpot',
        pied: 'MINAGE SOLO RÉEL · SI BLOC TROUVÉ, RÉCOMPENSE SUR TON ADRESSE',
        pipTitre: 'Panneau flottant',
        pipSafari: "Le panneau flottant nécessite Chrome, Edge ou Brave.\\n\\nSur Safari : réduisez la fenêtre et placez-la dans un coin de l'écran.",
        partager: 'Partager mon record', notif: 'Notifications',
        notifRecord: 'Nouveau record de difficulté', notifBloc: 'BLOC TROUVÉ !!!',
        notifBlocTexte: 'Vérifiez immédiatement votre adresse sur mempool.space',
        carteRecord: 'RECORD DE DIFFICULTÉ', carteEn: 'en', carteDe: 'de minage solo',
        paiement: 'PAIEMENT', versVous: 'vers vous', nonVerifie: 'non vérifiable',
        absent: 'adresse absente', desSorties: 'des sorties',
        throttle: 'THERMIQUE', calibrer: 'Calibrer les cœurs', calibrerCourt: 'CALIBRER', details: 'Page de détails',
        thrOk: 'Aucune limitation', thrLeger: 'Léger ralentissement', thrFort: 'Performance réduite',
        confirmReseau: 'Changer de réseau miné (chaque réseau garde son propre record)',
        calibEnCours: 'Calibration…', froid: 'à froid', optimal: 'optimal', maxi: 'max',
        calibReco: 'Réglage recommandé', calibExplique: 'Test automatique du meilleur nombre de cœurs (~1 min)',
      },
    },
    en: {
      banniere: 'A X E C U B E — mineur lottery · Bitcoin solo mining',
      adresse: 'Address ', pool: 'Pool    ', threads: 'Cores   ',
      cours: (p, sym) => `💱 BTC price: ${p} ${sym}`,
      recordCharge: (d, sh, h) => `💾 Record loaded: ${d} (${sh} shares, ${h} hashed)`,
      sauvegardeKo: (e) => `Could not save: ${e}`,
      etatSauve: '💾 State saved. See you next time!',
      nouveauRecord: (d) => `🏆 New best difficulty: ${d}`,
      workerErr: (i, e) => `Worker ${i} error: ${e}`,
      threadsMaj: (n) => `Cores → ${n}`,
      moteurSimd: (v, r) => `⚡⚡ WASM SIMD engine enabled — "${v}" variant (${r} MH/s on the bench)`,
      moteurWasm: '⚡ WASM engine enabled (SHA-256d midstate)',
      moteurRepli: (r) => `Falling back to crypto engine (WASM unavailable: ${r})`,
      sharePerdu: 'Share found but pool disconnected — lost.',
      shareSoumis: (d, n) => `📤 Share submitted (diff ${d}) nonce=${n}`,
      blocTrouve: '🎉🎉🎉 NETWORK DIFFICULTY MET — POTENTIAL BLOCK FOUND !!! 🎉🎉🎉',
      souscription: (e1, sz) => `Subscribed (extranonce1=${e1}, en2size=${sz})`,
      autorise: (w) => `✅ Authorized on pool (worker "${w}")`,
      autoRefus: (e) => `❌ Authorization refused: ${e} — check your BTC address.`,
      shareOk: (d, t) => `✅ Share ACCEPTED (diff ${d}) — total ${t}`,
      shareKo: (e) => `❌ Share rejected: ${e}`,
      diffPool: (d) => `Pool difficulty → ${d}`,
      nouveauBloc: (j, h) => `New network block — job ${j} (height ${h})`,
      connexion: (h, p) => `Connecting to ${h}:${p}…`,
      connecte: (h) => `⚡ Connected to pool ${h}`,
      poolIllisible: (l) => `Unreadable pool message: ${l}`,
      reseauErr: (e) => `Network error: ${e}`,
      deconnecte: 'Disconnected from pool — reconnecting in 5 s…',
      dashboard: (p) => `📊 Dashboard: http://localhost:${p}`,
      dashboardLocal: (p) => `📊 Dashboard: http://localhost:${p}  (phone: add --lan)`,
      changementReseau: (l) => `🔀 Switching network: ${l} — reconnecting…`,
      calibDebut: (p) => `🌡️ Calibrating — testing core counts: ${p} (~1 min)`,
      calibPalier: (n, hr) => `   ${n} cores → ${hr} MH/s`,
      calibFin: (no, ho, nm, hm) => `✅ Best setting: ${no} cores (${ho} MH/s) · max ${nm} cores (${hm} MH/s)`,
      dashboardLan: (u) => `📱 From your phone (same Wi-Fi): http://${u}`,
      recordRepris: (d) => `🏆 Record recovered from the pool: ${d}`,
      lanFerme: '🔒 Access limited to this computer. For your phone: restart with --lan',
      jetonManquant: 'AXECUBE: access denied. Use the full link shown at startup (with ?token=…).',
      dashboardLanAutre: (n, u) => `   … or (${n}): http://${u}`,
      paieComplet: (b, p, sym) => `🔒 Coinbase parsed: ${b} ${sym} would come to you (${p}% of outputs)`,
      paiePartiel: (b, p, sym) => `🔎 Coinbase parsed: ${b} ${sym} for you, i.e. ${p}% of outputs`,
      paieAbsent: '⚠️ Your address appears in NO coinbase output',
      paieIllisible: 'Unreadable coinbase: amount cannot be verified',
      ui: {
        hashrate: 'HASHRATE', record: 'BEST DIFFICULTY', recordCourt: 'BEST',
        shares: 'SHARES', difficulte: 'DIFFICULTY', bloc: 'BLOCK', reseau: 'NETWORK',
        coeurs: 'CORES', uptime: 'UPTIME', cours: 'BTC PRICE', depuis: 'SINCE',
        acceptes: 'accepted', rejetes: 'rejected', poolMot: 'pool', reseauMot: 'network',
        demarrage: 'starting…', calibrage: 'Calibrating the lottery…',
        ilya: '', h: 'h', min: 'min', s: 's', j: 'd',
        chance: 'chance in', parBloc: 'per block', tempsMoyen: 'average wait',
        ans: 'years', jackpot: 'jackpot',
        pied: 'REAL SOLO MINING · IF A BLOCK IS FOUND, THE REWARD GOES TO YOUR ADDRESS',
        pipTitre: 'Floating panel',
        pipSafari: 'The floating panel requires Chrome, Edge or Brave.\\n\\nOn Safari: just shrink the window and park it in a corner of your screen.',
        partager: 'Share my record', notif: 'Notifications',
        notifRecord: 'New best difficulty', notifBloc: 'BLOCK FOUND !!!',
        notifBlocTexte: 'Check your address on mempool.space right now',
        carteRecord: 'BEST DIFFICULTY', carteEn: 'at', carteDe: 'of solo mining',
        paiement: 'PAYOUT', versVous: 'to you', nonVerifie: 'not verifiable',
        absent: 'address absent', desSorties: 'of outputs',
        throttle: 'THERMAL', calibrer: 'Calibrate cores', calibrerCourt: 'CALIBRATE', details: 'Details page',
        thrOk: 'No throttling', thrLeger: 'Slightly throttled', thrFort: 'Performance reduced',
        confirmReseau: 'Switch mined network (each network keeps its own record)',
        calibEnCours: 'Calibrating…', froid: 'cold', optimal: 'best', maxi: 'max',
        calibReco: 'Recommended setting', calibExplique: 'Auto-test of the best core count (~1 min)',
      },
    },
  };
  const t = LANGUES[lang];

  /* ----------------------------- Cours du BTC ----------------------------- */
  const devise = (args.devise || process.env.DEVISE || 'eur').toLowerCase();
  const SYMBOLES = { eur: '€', usd: '$', gbp: '£', chf: 'CHF', cad: 'CA$' };

  function getJSON(url, cb) {
    const req = https.get(url, { timeout: 8000, headers: { 'User-Agent': 'axecube/1.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return cb(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
      res.on('end', () => { try { cb(null, JSON.parse(data)); } catch (e) { cb(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', cb);
  }

  /* ------------------------- Récupération des récompenses ------------------------- *
   * Télécharge automatiquement, dans assets/machines/ et assets/cubes/, les images
   * correspondant aux paliers RÉELLEMENT atteints par cette machine (vérifié côté
   * serveur via le vrai bestDiff enregistré, jamais celui annoncé localement). Ne
   * retélécharge jamais un fichier déjà présent -- rapide au second appel. */
  function recupererUnMedia(type, niveau, cb) {
    if (!leaderboardUrl) return cb(new Error('classement désactivé'));
    const numero = String(niveau).padStart(2, '0');
    const url = `${leaderboardUrl}/.netlify/functions/telecharger-media?machineId=${encodeURIComponent(machineId)}&type=${type}&niveau=${niveau}`;
    const req = https.get(url, { timeout: 10000, headers: { 'User-Agent': 'axecube/1.0' } }, (res) => {
      const morceaux = [];
      res.on('data', (c) => morceaux.push(c));
      res.on('end', () => {
        const corps = Buffer.concat(morceaux);
        if (res.statusCode !== 200) {
          let raison = 'HTTP ' + res.statusCode;
          try { raison = JSON.parse(corps.toString('utf8')).erreur || raison; } catch { /* corps non-JSON */ }
          return cb(new Error(raison));
        }
        cb(null, corps);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', cb);
  }

  /** Zones d'un skin Premium, lues en LOCAL (assets/zones-premium.json, voir plus haut)
   *  -- réglées via le bouton "🎯 Zones du skin" sur /machines. Plus aucun aller-retour
   *  Netlify nécessaire : ça ne concerne que l'affichage de TA propre carte. */
  function zonesSkinActifPour(itemId) {
    return (itemId && zonesPremium[itemId]) || null;
  }

  /** Liste les pièces premium ACTUELLEMENT marquées gratuites par l'admin (via
   *  admin-offres.js) -- lecture publique, pas de vérification de palier ici : un
   *  cadeau explicite du créateur ne dépend jamais de la performance de minage,
   *  contrairement aux 22 cartes Genèse. */
  function listerPremiumGratuits(cb) {
    if (!leaderboardUrl) return cb(null, []);
    const url = `${leaderboardUrl}/.netlify/functions/offres-premium`;
    const req = https.get(url, { timeout: 10000, headers: { 'User-Agent': 'axecube/1.0' } }, (res) => {
      const morceaux = [];
      res.on('data', (c) => morceaux.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(morceaux).toString('utf8'));
          const offres = j.offres || {};
          const gratuits = Object.keys(offres).filter((id) => offres[id] && offres[id].statut === 'gratuit');
          cb(null, gratuits);
        } catch (e) { cb(e, []); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => cb(null, [])); // classement indisponible -- pas bloquant, juste 0 pièce premium ce coup-ci
  }

  function recupererUnPremiumGratuit(itemId, cb) {
    if (!leaderboardUrl) return cb(new Error('classement désactivé'));
    const url = `${leaderboardUrl}/.netlify/functions/telecharger-premium-gratuit?itemId=${encodeURIComponent(itemId)}`;
    const req = https.get(url, { timeout: 10000, headers: { 'User-Agent': 'axecube/1.0' } }, (res) => {
      const morceaux = [];
      res.on('data', (c) => morceaux.push(c));
      res.on('end', () => {
        const corps = Buffer.concat(morceaux);
        if (res.statusCode !== 200) {
          let raison = 'HTTP ' + res.statusCode;
          try { raison = JSON.parse(corps.toString('utf8')).erreur || raison; } catch { /* corps non-JSON */ }
          return cb(new Error(raison));
        }
        cb(null, corps);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', cb);
  }

  /** Liste les pièces Premium RÉELLEMENT possédées par CETTE machine (registre serveur,
   *  alimenté quand un téléchargement a été fait depuis boutique.html avec ce machineId).
   *  C'est ce registre, et lui seul, qui fait foi pour l'activation en skin -- jamais le
   *  simple fait qu'une pièce soit actuellement gratuite en boutique (qui peut changer
   *  à tout moment sans retirer ce qu'un mineur a déjà obtenu). */
  /** Récupère le bestDiff RÉELLEMENT vérifié côté serveur pour cette machine (même source
   *  que telecharger-media.js) -- jamais la valeur locale seule, qui peut être modifiée en
   *  éditant miner-state.json à la main. C'est CETTE valeur, pas state.bestDiff, qui doit
   *  décider quels badges bronze/argent/or/... sont affichés comme réellement débloqués. */
  function recupererBestDiffVerifie(cb) {
    if (!leaderboardUrl) return cb(new Error('leaderboardUrl non configuré'), 0);
    const url = `${leaderboardUrl}/.netlify/functions/mon-record?machineId=${encodeURIComponent(machineId)}`;
    const req = https.get(url, { timeout: 10000, headers: { 'User-Agent': 'axecube/1.0' } }, (res) => {
      const morceaux = [];
      res.on('data', (c) => morceaux.push(c));
      res.on('end', () => {
        const corps = Buffer.concat(morceaux).toString('utf8');
        try {
          const j = JSON.parse(corps);
          if (res.statusCode !== 200) {
            return cb(new Error(`HTTP ${res.statusCode} -- ${j.erreur || corps.slice(0, 100)}`), 0);
          }
          cb(null, typeof j.bestDiff === 'number' ? j.bestDiff : 0);
        } catch (e) {
          cb(new Error(`réponse illisible (HTTP ${res.statusCode}) : ${corps.slice(0, 100)}`), 0);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); cb(new Error('délai dépassé (timeout)'), 0); });
    req.on('error', (e) => cb(e, 0));
  }

  function listerPossessionsPremium(cb) {
    if (!leaderboardUrl) return cb(null, []);
    const url = `${leaderboardUrl}/.netlify/functions/mes-possessions-premium?machineId=${encodeURIComponent(machineId)}`;
    const req = https.get(url, { timeout: 10000, headers: { 'User-Agent': 'axecube/1.0' } }, (res) => {
      const morceaux = [];
      res.on('data', (c) => morceaux.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(morceaux).toString('utf8'));
          cb(null, Array.isArray(j.items) ? j.items : []);
        } catch (e) { cb(e, []); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => cb(null, []));
  }

  /** Récupère l'image complète d'une pièce déjà POSSÉDÉE par cette machine (indépendamment
   *  de son statut actuel en boutique -- une pièce obtenue gratuitement hier reste
   *  accessible même si elle passe en "achat" aujourd'hui). */
  function recupererUnPremiumPossede(itemId, cb) {
    if (!leaderboardUrl) return cb(new Error('classement désactivé'));
    const url = `${leaderboardUrl}/.netlify/functions/telecharger-premium-possede?itemId=${encodeURIComponent(itemId)}&machineId=${encodeURIComponent(machineId)}`;
    const req = https.get(url, { timeout: 10000, headers: { 'User-Agent': 'axecube/1.0' } }, (res) => {
      const morceaux = [];
      res.on('data', (c) => morceaux.push(c));
      res.on('end', () => {
        const corps = Buffer.concat(morceaux);
        if (res.statusCode !== 200) {
          let raison = 'HTTP ' + res.statusCode;
          try { raison = JSON.parse(corps.toString('utf8')).erreur || raison; } catch { /* corps non-JSON */ }
          return cb(new Error(raison));
        }
        cb(null, corps);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', cb);
  }

  // Cache mémoire côté serveur (jamais sur disque) pour l'image d'un skin Premium possédé
  // -- évite de resolliciter Netlify à chaque affichage si le cache navigateur (5 min) a
  // été vidé (redémarrage du process, hard refresh...). Netlify peut parfois répondre
  // lentement (démarrage à froid de la fonction) ; ce cache absorbe cette latence pour
  // TOUTES les requêtes suivantes dans la fenêtre, pas juste celles du même navigateur.
  const cachePremiumMemoire = new Map(); // itemId -> { donnees, expire }
  const DUREE_CACHE_PREMIUM_MS = 5 * 60 * 1000;
  function recupererUnPremiumPossedeAvecCache(itemId, cb) {
    const entree = cachePremiumMemoire.get(itemId);
    if (entree && entree.expire > Date.now()) return cb(null, entree.donnees);
    recupererUnPremiumPossede(itemId, (err, donnees) => {
      if (err) return cb(err);
      cachePremiumMemoire.set(itemId, { donnees, expire: Date.now() + DUREE_CACHE_PREMIUM_MS });
      cb(null, donnees);
    });
  }

  /** Active un skin Premium : ne fait JAMAIS de copie locale de l'image -- seule
   *  l'AUTORISATION (state.skinPremiumActif, un simple identifiant texte) est stockée sur
   *  cette machine. L'image elle-même reste hébergée en ligne et n'est jamais écrite sur
   *  disque ; elle est chargée à la demande via le proxy /assets/premium/<id>.png (voir
   *  route serveur), qui revérifie la possession à chaque affichage. On vérifie quand
   *  même la possession ici, une fois, pour renvoyer tout de suite un message clair côté
   *  interface plutôt que de laisser échouer silencieusement au premier affichage. */
  function activerSkinPremiumDirect(itemId, cb) {
    if (!/^[a-z0-9-]{1,60}$/i.test(itemId || '')) return cb(new Error('identifiant invalide'));
    listerPossessionsPremium((_err, possedees) => {
      if (!possedees.includes(itemId)) {
        return cb(new Error('pièce non possédée -- obtiens-la d\'abord depuis la boutique (bouton 🛒)'));
      }
      state.skinPremiumActif = itemId;
      stateDirty = true;
      saveState();
      soumettreRecordLeaderboard(false); // propage immédiatement au classement public
      cb(null, {});
    });
  }

  /** Revérifie périodiquement que le skin actif est TOUJOURS possédé par cette machine.
   *  Nécessaire pour le jour où une pièce peut être revendue/transférée (Mint + marché
   *  secondaire) : si le registre de possession ne la liste plus pour ce machineId (parce
   *  qu'elle a changé de propriétaire), le skin est retiré automatiquement -- jamais
   *  affiché sans possession valide, même si le fichier PNG traîne encore localement. */
  function revaliderSkinPremiumActif() {
    if (!state.skinPremiumActif) return;
    const skinActuel = state.skinPremiumActif;
    listerPossessionsPremium((err, possedees) => {
      if (err) return; // classement injoignable -- on ne retire rien sur un simple souci réseau
      if (state.skinPremiumActif !== skinActuel) return; // a changé entre-temps, rien à faire
      if (!possedees.includes(skinActuel)) {
        state.skinPremiumActif = null;
        stateDirty = true;
        saveState();
        log('warn', `🎨 Skin Premium "${skinActuel}" retiré automatiquement -- cette machine n'en est plus propriétaire (revente/transfert détecté). Retour au palier Genèse.`);
        soumettreRecordLeaderboard(false);
      }
    });
  }
  // Vérifie au démarrage (après un court délai, le temps que leaderboardUrl/machineId
  // soient bien prêts), puis toutes les 10 minutes -- pas besoin de plus fréquent, la
  // perte de possession n'est jamais instantanée (il faut un Mint + une vente).
  setTimeout(revaliderSkinPremiumActif, 15000);
  setInterval(revaliderSkinPremiumActif, 600000);

  /** Rafraîchit state.bestDiffVerifie depuis le serveur -- au démarrage, puis
   *  régulièrement. C'est cette valeur (jamais state.bestDiff seul) qui doit décider
   *  quels badges bronze/argent/or/... sont affichés comme réellement débloqués. */
  function rafraichirBestDiffVerifie() {
    recupererBestDiffVerifie((err, valeur) => {
      if (err) {
        // Pas la peine d'alerter si le classement est simplement désactivé (--no-leaderboard)
        // -- c'est un choix assumé, pas une panne.
        if (leaderboardUrl) {
          log('warn', `⚠️ Vérification du badge impossible pour l'instant (${err.message || err}). ` +
            `Vérifie que mon-record.js est bien déployé sur ton classement.`);
        }
        return;
      }
      if (valeur !== state.bestDiffVerifie) {
        const avant = state.bestDiffVerifie;
        state.bestDiffVerifie = valeur;
        stateDirty = true; saveState();
        log('info', `🔒 Record vérifié mis à jour : ${formatDiff(valeur)} (était ${formatDiff(avant)}).`);
      }
    });
  }
  setTimeout(rafraichirBestDiffVerifie, 12000);
  setInterval(rafraichirBestDiffVerifie, 180000);

  function recupererRecompenses(cb) {
    const niveauGagne = niveauDeCube(state.bestDiff);
    listerPremiumGratuits((_errPremium, itemsPremiumGratuits) => {
      const taches = [];
      for (let n = 1; n <= niveauGagne; n++) {
        taches.push({ type: 'machine', niveau: n, dossier: 'machines', prefixe: 'niveau' });
        taches.push({ type: 'cube', niveau: n, dossier: 'cubes', prefixe: 'cube-p' });
      }
      // Pièces premium actuellement offertes gratuitement -- dossier séparé (assets/premium/)
      // pour ne jamais se mélanger avec la collection Genèse des 22 paliers.
      itemsPremiumGratuits.forEach((itemId) => {
        taches.push({ type: 'premium', itemId, dossier: 'premium', nomFichier: `${itemId}.png` });
      });

      const resultat = { telecharges: [], dejaPresents: [], echecs: [], niveauGagne };
      let restantes = taches.length;
      if (restantes === 0) return cb(null, resultat);
      taches.forEach((tache) => {
        const nomFichier = tache.nomFichier || `${tache.prefixe}-${String(tache.niveau).padStart(2, '0')}.png`;
        const cheminLocal = path.join(__dirname, 'assets', tache.dossier, nomFichier);
        const etiquette = tache.type === 'premium' ? `premium ${tache.itemId}` : `${tache.type} ${String(tache.niveau).padStart(2, '0')}`;
        if (fs.existsSync(cheminLocal)) {
          resultat.dejaPresents.push(etiquette);
          if (--restantes === 0) cb(null, resultat);
          return;
        }
        const surReponse = (err, donnees) => {
          if (err) {
            resultat.echecs.push(etiquette + ' (' + err.message + ')');
          } else {
            try {
              fs.mkdirSync(path.dirname(cheminLocal), { recursive: true });
              fs.writeFileSync(cheminLocal, donnees);
              resultat.telecharges.push(etiquette);
            } catch (e) {
              resultat.echecs.push(etiquette + ' (écriture: ' + e.message + ')');
            }
          }
          if (--restantes === 0) cb(null, resultat);
        };
        if (tache.type === 'premium') {
          recupererUnPremiumGratuit(tache.itemId, surReponse);
        } else {
          recupererUnMedia(tache.type, tache.niveau, surReponse);
        }
      });
    });
  }

  const SOURCES = [
    { url: `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${devise}`,
      lire: (j) => j && j.bitcoin && j.bitcoin[devise] },
    { url: `https://api.coinbase.com/v2/prices/BTC-${devise.toUpperCase()}/spot`,
      lire: (j) => j && j.data && parseFloat(j.data.amount) },
  ];

  function majCours(i = 0) {
    if (i >= SOURCES.length) return; // aucune source joignable : on réessaiera plus tard
    getJSON(SOURCES[i].url, (err, json) => {
      let prix;
      try { prix = err ? null : SOURCES[i].lire(json); } catch { prix = null; }
      if (typeof prix === 'number' && isFinite(prix) && prix > 0) {
        const premier = !state.btcPrice;
        state.btcPrice = prix;
        state.btcAt = Date.now();
        if (premier) log('info', t.cours(Math.round(prix).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-US'), state.btcSymbol));
      } else {
        majCours(i + 1);
      }
    });
  }

  setTimeout(majCours, 1500);
  setInterval(() => majCours(), 5 * 60 * 1000); // rafraîchi toutes les 5 minutes

  /* ---- Reprise du record & stats officielles, quel que soit le pool solo ---- */
  // Chaque pool solo connu garde en mémoire la meilleure difficulté déjà soumise pour une
  // adresse, même sans fichier local chez nous. On la resynchronise à chaque connexion (et
  // reconnexion) au pool, pas seulement au démarrage — c'est ce endroit-là qui donne l'API
  // à interroger pour le pool actuellement configuré. Braiins Solo ne propose rien
  // d'équivalent en public sans compte : on ne tente rien pour ce pool-là.
  function urlStatsExternes(host) {
    if (/public-pool\.io/i.test(host)) return { type: 'publicpool', url: `https://public-pool.io:40557/api/client/${address}` };
    if (/ckpool\.org/i.test(host)) return { type: 'ckpool', url: `https://solo.ckpool.org/users/${address}` };
    if (/mineshop\.eu/i.test(host)) return { type: 'ckpool', url: `https://solo.mineshop.eu/api/miner.php?wallet=${encodeURIComponent(address)}` };
    if (/axeminer\.com/i.test(host)) return { type: 'axeminer', url: `https://axeminer.com/api/client/${address}` };
    return null;
  }
  let statsExternesPool = null;
  function synchroniserRecordEtStats() {
    const cible = urlStatsExternes(poolHost || '');
    if (!cible) { statsExternesPool = null; return; }
    https.get(cible.url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          log('warn', `⚠️ Reprise du record : ${cible.url} → HTTP ${res.statusCode}. Réponse : ${data.slice(0, 150).replace(/\s+/g, ' ')}`);
          return;
        }
        try {
          const j = JSON.parse(data);
          let meilleur = 0;
          if (cible.type === 'publicpool') {
            if (Array.isArray(j.workers)) {
              for (const w of j.workers) { const d = parseFloat(w.bestDifficulty); if (isFinite(d) && d > meilleur) meilleur = d; }
            }
            const global = parseFloat(j.bestDifficulty);
            if (isFinite(global) && global > meilleur) meilleur = global;
            const hrSomme = Array.isArray(j.workers) ? j.workers.reduce((a, w) => a + (parseFloat(w.hashRate) || 0), 0) : 0;
            statsExternesPool = {
              hashrate1hr: hrSomme ? formatHashrate(hrSomme) : null, shares: null,
              bestshare: meilleur || null, workers: Array.isArray(j.workers) ? j.workers.length : null,
              recu: Date.now(),
            };
          } else if (cible.type === 'axeminer') {
            // AxeMiner garde un historique PAR SESSION (chaque redémarrage crée un nouveau
            // sessionId avec sa propre bestDifficulty repartie de 0) -- il faut donc prendre
            // le MAXIMUM parmi toutes tes sessions passées, pas juste la plus récente, sans
            // quoi un simple redémarrage ferait apparemment "perdre" tout ton record.
            if (Array.isArray(j.workers)) {
              let hrSomme = 0;
              for (const w of j.workers) {
                if (workerName && w.name && w.name !== workerName) continue; // autre worker du même wallet
                const d = parseFloat(w.bestDifficulty);
                if (isFinite(d) && d > meilleur) meilleur = d;
                const hr = parseFloat(w.hashRate);
                if (isFinite(hr)) hrSomme += hr;
              }
              statsExternesPool = {
                hashrate1hr: hrSomme ? formatHashrate(hrSomme) : null, shares: null,
                bestshare: meilleur || null, workers: j.workersCount || j.workers.length,
                recu: Date.now(),
              };
            }
          } else { // ckpool (couvre aussi Mineshop.eu, qui tourne le même logiciel)
            // bestshare = valeur précise (ex. 362.9995...) ; bestever = version arrondie
            // affichée dans leur UI (362). On garde la précise pour la comparaison locale.
            meilleur = Number(j.bestshare) || Number(j.bestever) || 0;
            statsExternesPool = {
              hashrate1hr: j.hashrate1hr, hashrate1d: j.hashrate1d,
              shares: j.shares, bestshare: meilleur || j.bestever, workers: j.workers,
              recu: Date.now(),
            };
          }
          if (!meilleur) {
            log('warn', `⚠️ Reprise du record : réponse reçue de ${cible.url} mais aucun champ de difficulté reconnu (${Object.keys(j).slice(0, 8).join(', ')}).`);
          }
          // Important : on ne touche PAS à state.bestDiff ici -- cette valeur sert aussi à
          // décider si une part minée localement est "un nouveau record" (et donc à
          // soumettre au classement). Si on y mettait la valeur récupérée du pool (invérifiable
          // localement), toute vraie part future avec une diff plus basse ne serait plus
          // jamais reconnue comme record, même si elle est la seule qu'on peut prouver.
          // On la garde donc à part, uniquement pour l'affichage et les paliers.
          if (meilleur > state.recordExterne) {
            state.recordExterne = meilleur;
            stateDirty = true; saveState();
            log('ok', t.recordRepris(formatDiff(meilleur)));
            for (const p of PALIERS) {
              if (meilleur >= p.seuil && !state.paliersAtteints[p.cle]) {
                state.paliersAtteints[p.cle] = new Date().toISOString();
                log('best', `🏅 Palier ${p.nom} débloqué !`);
              }
            }
          }
        } catch (e) {
          log('warn', `⚠️ Reprise du record : réponse illisible depuis ${cible.url} (${data.slice(0, 150).replace(/\s+/g, ' ')})`);
        }
      });
    }).on('error', (e) => { log('warn', `⚠️ Reprise du record : ${cible.url} injoignable (${e.code || e.message})`); })
      .on('timeout', function () { this.destroy(); });
  }
  setTimeout(synchroniserRecordEtStats, 2500);
  setInterval(synchroniserRecordEtStats, 60000);

  // Ping périodique du classement, indépendant du navigateur : avant, seul un nouveau
  // record déclenchait une soumission depuis ce process -- si personne ne gardait le
  // dashboard ouvert dans un onglet (seul module à soumettre en continu via majLead()),
  // le pool actuellement utilisé ne se rafraîchissait jamais côté classement, même si
  // le mineur tournait depuis des heures sans battre son record. Silencieux (pas de log)
  // car il est parfaitement normal qu'un ping périodique n'apporte pas de preuve nouvelle.
  setInterval(() => soumettreRecordLeaderboard(false), 90000);

  /* -------- Soumission immédiate au classement dès qu'un nouveau record apparaît -------- */
  // Avant : seul le dashboard ouvert dans le navigateur soumettait (toutes les ~30s, et
  // jamais si personne ne regarde). Maintenant c'est le process AXECUBE lui-même qui pousse,
  // dès la détection, sans dépendre d'un onglet ouvert.
  let dernierEnvoiRecord = 0;
  function soumettreRecordLeaderboard(avecLog = true) {
    if (!leaderboardUrl || leaderboardDesactive || enModeSimulation) return;
    const maintenant = Date.now();
    if (maintenant - dernierEnvoiRecord < 3000) return; // anti-rafale si plusieurs 'best' arrivent d'un coup
    dernierEnvoiRecord = maintenant;
    try {
      const base = leaderboardUrl.endsWith('/') ? leaderboardUrl.slice(0, -1) : leaderboardUrl;
      const payload = JSON.stringify({
        worker: nomAffichage, bestDiff: state.bestDiff, hashrate: state.hashrate, machineId, pool: poolLabel,
        cpu: cpuModel, headerHex: state.bestProofHeader || null,
        diffPeriode: state.bestDiffRecent || 0, headerHexPeriode: state.bestProofHeaderRecent || null,
        accepted: state.accepted || 0, totalHashes: state.totalHashes || 0,
        skinPremiumActif: state.skinPremiumActif || null,
      });
      const urlObj = new URL(base + '/submit');
      const req = https.request(urlObj, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            // Capture le code d'accès de cette machine, renvoyé par le classement à chaque
            // réponse -- toujours le même une fois généré côté serveur. Affiché dans le
            // dashboard pour que le propriétaire puisse rattacher cette machine à son wallet
            // sur "Mes récompenses gagnées".
            if (j && j.codeAcces && j.codeAcces !== state.codeAccesClassement) {
              state.codeAccesClassement = j.codeAcces;
              stateDirty = true;
            }
            // Le classement communautaire fait AUTORITÉ sur le record all-time : chaque
            // valeur qu'il renvoie a été revérifiée cryptographiquement à partir d'une vraie
            // preuve de travail (voir submit.js). Si le fichier local diverge -- qu'il ait été
            // modifié à la main, corrompu, ou contaminé par un test -- on le recale
            // automatiquement sur la valeur du serveur, dans un sens comme dans l'autre.
            if (typeof j.bestDiff === 'number' && j.bestDiff !== state.bestDiff) {
              const ancien = state.bestDiff;
              state.bestDiff = j.bestDiff;
              stateDirty = true;
              log('warn', `🔒 Record local (${formatDiff(ancien)}) ne correspondait pas au classement ` +
                `vérifié (${formatDiff(j.bestDiff)}) — corrigé automatiquement. Le classement fait toujours autorité.`);
            }
            // On ne log que pour une vraie tentative de nouveau record (avecLog=true) --
            // le ping périodique en arrière-plan ne signale jamais rien à l'écran, sans quoi
            // ce message reviendrait toutes les 90s pour un mineur au record non prouvable.
            if (avecLog && j && j.verifie === false) {
              log('warn', `⚠️ Classement : record de ${formatDiff(state.bestDiff)} non retenu (${j.raison || 'raison inconnue'}). ` +
                `Normal si ce record vient d'une reprise depuis le pool sans preuve locale — il repassera dès qu'AXECUBE le retrouvera lui-même.`);
            }
            // Le record est authentique (preuve valide), mais le saut de difficulté est
            // statistiquement incohérent avec le temps écoulé/hashrate rapporté par CETTE
            // machine -- peut arriver sur un coup de chance réel (rare), mais aussi si une
            // preuve calculée ailleurs a été injectée sous ce machineId. Le classement le
            // garde quand même (jamais pénalisé pour un vrai coup de chance), mais un futur
            // Mint/NFT exigera l'absence de ce marqueur avant d'accepter de frapper.
            if (avecLog && j && j.sautSuspect) {
              log('warn', `🔍 Record accepté mais marqué "saut suspect" -- progression bien plus rapide que ce que ` +
                `ton hashrate rapporté permettrait normalement. Si c'est un vrai coup de chance, rien à faire. ` +
                `Ce marqueur pourra compter si ce record sert un jour de base à un NFT.`);
            }
          } catch { /* réponse illisible, on ignore */ }
        });
      });
      req.on('error', () => { /* leaderboard injoignable, on retentera au prochain record */ });
      req.on('timeout', function () { this.destroy(); });
      req.write(payload);
      req.end();
    } catch { /* ignore */ }
  }

  /* --------------------- Persistance (record & compteurs) ------------------ */
  const STATE_FILE = path.join(__dirname, 'miner-state.json');
  let stateDirty = false;
  // Au-delà de 30 minutes d'arrêt, le compteur de shares accepté/rejeté (qui ne sert qu'à
  // voir "l'activité de cette session"), ainsi que le chrono UPTIME affiché, sont considérés
  // comme une nouvelle session et repartent à zéro -- seul le record de difficulté (permanent)
  // n'est jamais remis à zéro.
  const SEUIL_REPRISE_MS = 1800e3; // 30 minutes

  // Chaque réseau (BTC, Fractal…) a sa propre mémoire : un record de 757 sur Bitcoin
  // n'a aucun sens affiché comme record Fractal, les échelles de difficulté diffèrent trop.
  let banques = {};
  let dernierArretISO = null;
  let dernierStartedAt = null;
  // Skin Premium : préférence indépendante du réseau miné (btc/fractal), donc stockée
  // au niveau racine du fichier d'état, pas dans banques[reseauCle].
  let skinPremiumSauvegarde = null;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    dernierArretISO = saved.savedAt || null;
    dernierStartedAt = typeof saved.startedAt === 'number' ? saved.startedAt : null;
    skinPremiumSauvegarde = typeof saved.skinPremiumActif === 'string' ? saved.skinPremiumActif : null;
    if (saved.reseaux && typeof saved.reseaux === 'object') {
      banques = saved.reseaux;
    } else if (typeof saved.bestDiff === 'number') {
      // Ancien format (avant le multi-réseau) : on suppose que c'était du Bitcoin
      banques.btc = {
        bestDiff: saved.bestDiff, accepted: saved.accepted || 0,
        rejected: saved.rejected || 0, totalHashes: saved.totalHashes || 0,
      };
    }
  } catch { /* premier lancement : pas de fichier, c'est normal */ }

  // Coupure depuis le dernier arrêt (crash, redémarrage manuel, mise à jour…). Réutilisée
  // à la fois pour la reprise des shares (dans chargerBanque) et pour la reprise du chrono
  // UPTIME juste en dessous : les deux partagent la même règle des 30 minutes.
  const coupureDepuisArretMs = dernierArretISO ? (Date.now() - new Date(dernierArretISO).getTime()) : Infinity;

  // Clé de date locale (YYYY-MM-DD, fuseau de la machine) -- sert à détecter le passage
  // à un nouveau jour pour remettre à zéro les compteurs "du jour" (meilleure diff du
  // jour, total difficultés du jour), sans jamais toucher au total cumulé infini.
  function cleJourLocal(d = new Date()) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), j = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${j}`;
  }
  /** Archive un jour révolu dans journalJour (avec son détail), puis comble tout jour
   *  ENTIÈREMENT sauté entre l'ancienne date et la nouvelle (mineur resté éteint un jour
   *  complet, ou redémarré après minuit sans qu'aucun share n'ait déclenché le contrôle
   *  exactement à ce moment-là) -- sans ce comblement, ces jours donneraient l'impression
   *  trompeuse de n'avoir jamais existé plutôt que "existé mais sans activité". Utilisée
   *  à la fois en direct (verifierRolloverJour, à chaque share) et au démarrage
   *  (chargerBanque, quand le mineur redémarre un autre jour que celui sauvegardé) --
   *  avant cette factorisation, seul le premier chemin archivait vraiment, l'autre
   *  jetait silencieusement la journée en cours sans jamais l'enregistrer.
   */
  function archiverJourEtCombler(ancienneDate, ancienBestDiff, ancienDiffTotal, ancienDetail, nouvelleDate) {
    if (ancienneDate && (ancienBestDiff || 0) > 0) {
      state.journalJour.push({
        date: ancienneDate,
        bestDiff: ancienBestDiff || 0,
        diffTotal: ancienDiffTotal || 0,
        // Détail brut conservé pour ce jour précis -- consultable plus tard au clic.
        // Trié du plus récent au plus ancien pour un affichage naturel une fois développé.
        detail: Array.isArray(ancienDetail) ? [...ancienDetail].reverse() : [],
      });
    }
    if (ancienneDate) {
      const debut = new Date(ancienneDate + 'T00:00:00');
      const fin = new Date(nouvelleDate + 'T00:00:00');
      const curseur = new Date(debut);
      curseur.setDate(curseur.getDate() + 1);
      while (curseur < fin) {
        state.journalJour.push({ date: cleJourLocal(curseur), bestDiff: 0, diffTotal: 0, detail: [], sansActivite: true });
        curseur.setDate(curseur.getDate() + 1);
      }
    }
    // Garde un historique raisonnable (les 120 derniers jours avec activité).
    if (state.journalJour.length > 120) state.journalJour.splice(0, state.journalJour.length - 120);
  }
  function verifierRolloverJour() {
    const jourActuel = cleJourLocal();
    if (state.diffJourDate !== jourActuel) {
      archiverJourEtCombler(state.diffJourDate, state.bestDiffJour, state.diffJour, state.detailJour, jourActuel);
      state.detailJour = [];
      state.diffJour = 0;
      state.bestDiffJour = 0;
      state.diffJourDate = jourActuel;
      stateDirty = true;
    }
  }

  function chargerBanque(cle) {
    const b = banques[cle] || {};
    state.bestDiff = b.bestDiff || 0;
    state.bestProofHeader = b.bestProofHeader || null;
    state.recordExterne = b.recordExterne || 0;
    // Shares acceptés/rejetés : cumulés tant que la coupure entre deux lancements reste
    // sous une heure (ex. redémarrage pour une mise à jour) -- au-delà, on considère que
    // c'est une nouvelle session de minage et le compteur repart à zéro.
    const coupureMs = coupureDepuisArretMs;
    if (coupureMs <= SEUIL_REPRISE_MS) {
      state.accepted = b.accepted || 0;
      state.rejected = b.rejected || 0;
    } else {
      if (dernierArretISO) log('info', `Reprise après plus d'1h d'arrêt (${Math.round(coupureMs/3600e3*10)/10}h) — compteur de shares de cette session remis à zéro. Le record de difficulté, lui, reste conservé.`);
      state.accepted = 0;
      state.rejected = 0;
    }
    state.totalHashes = b.totalHashes || 0;
    state.depuis = b.depuis || new Date().toISOString();
    state.paliersAtteints = b.paliersAtteints || {};

    // Total cumulé infini (somme de TOUTES les difficultés acceptées, depuis le tout
    // premier lancement) -- ne se remet jamais à zéro, quel que soit le temps d'arrêt.
    state.diffTotalInfini = b.diffTotalInfini || 0;
    // Compteur de blocs potentiellement trouvés (share dont la diff dépasse la difficulté
    // réseau) -- conservé pour toujours, jamais remis à zéro, même après un simple partage
    // non retenu par le pool (voir plus bas pour la nuance "potentiel" vs confirmé).
    state.blocsTrouves = b.blocsTrouves || 0;
    // Date de départ du compteur infini -- fixée une seule fois, au tout premier
    // lancement où ce champ existe, puis jamais modifiée ensuite.
    state.diffInfiniDepuis = b.diffInfiniDepuis || new Date().toISOString();
    // Code d'accès de cette machine (généré côté classement, capturé et conservé ici pour
    // affichage -- voir soumettreRecordLeaderboard).
    state.codeAccesClassement = b.codeAccesClassement || null;

    // Journal quotidien : un "bloc" par jour ayant eu de l'activité (date, meilleure
    // diff du jour, total du jour), conservé même après le passage au jour suivant --
    // permet de consulter l'historique jour par jour, façon registre chronologique.
    state.journalJour = Array.isArray(b.journalJour) ? b.journalJour : [];
    // Détail brut du jour en cours (shares individuels non encore archivés dans le
    // journal) -- rechargé pour ne pas perdre la journée en cours lors d'un redémarrage.
    state.detailJour = Array.isArray(b.detailJour) ? b.detailJour : [];

    // Compteurs "du jour" -- rattachés à une date (fuseau local). Si la date sauvegardée
    // ne correspond plus à aujourd'hui (nouveau jour, ou machine restée éteinte plus
    // longtemps), on archive d'abord proprement l'ancien jour (même logique que le
    // rollover en direct, voir archiverJourEtCombler) avant de remettre ces deux
    // compteurs à zéro -- sans ça, fermer le mineur un jour et le rouvrir le lendemain
    // jetait silencieusement toute la journée sans jamais l'enregistrer dans le journal.
    const jourActuel = cleJourLocal();
    if (b.diffJourDate === jourActuel) {
      state.diffJour = b.diffJour || 0;
      state.bestDiffJour = b.bestDiffJour || 0;
    } else {
      archiverJourEtCombler(b.diffJourDate || null, b.bestDiffJour || 0, b.diffJour || 0, b.detailJour, jourActuel);
      state.diffJour = 0;
      state.bestDiffJour = 0;
      state.detailJour = [];
      stateDirty = true;
    }
    state.diffJourDate = jourActuel;
    // Rattrapage : si un record préexistant (prouvé ou récupéré du pool) dépasse déjà des
    // paliers jamais enregistrés (ex. mise à jour depuis une version antérieure à cette
    // fonctionnalité), on les marque atteints avec la date de premier lancement comme repère.
    const meilleurConnu = Math.max(state.bestDiff, state.recordExterne);
    for (const p of PALIERS) {
      if (meilleurConnu >= p.seuil && !state.paliersAtteints[p.cle]) {
        state.paliersAtteints[p.cle] = state.depuis;
      }
    }
  }
  chargerBanque(reseauCle);
  // Recharge le skin Premium choisi la dernière fois -- juste un identifiant texte, aucun
  // fichier à vérifier (l'image n'est jamais stockée localement). La revalidation de
  // possession (revaliderSkinPremiumActif, ~15s après démarrage) confirmera ensuite que
  // cette machine possède toujours réellement la pièce.
  if (skinPremiumSauvegarde && /^[a-z0-9-]{1,60}$/i.test(skinPremiumSauvegarde)) {
    state.skinPremiumActif = skinPremiumSauvegarde;
  }
  log('info', t.recordCharge(state.bestDiff > 0 ? formatDiff(state.bestDiff) : '—', state.accepted, formatHashrate(state.totalHashes).replace('/s', '')));

  // Reprise du chrono UPTIME : si l'arrêt précédent (crash, redémarrage, mise à jour) date
  // de moins de 30 minutes, on repart avec l'horodatage d'origine plutôt que Date.now(),
  // pour que le compteur affiché continue comme si de rien n'était plutôt que de retomber à 0.
  if (coupureDepuisArretMs <= SEUIL_REPRISE_MS && typeof dernierStartedAt === 'number' && dernierStartedAt > 0) {
    state.startedAt = dernierStartedAt;
    state.startedReal = dernierStartedAt;
    log('info', `⏱️ Chrono repris (coupure de ${Math.round(coupureDepuisArretMs / 1000)}s) — l'UPTIME continue depuis avant l'arrêt.`);
  }

  function saveState() {
    banques[reseauCle] = {
      bestDiff: state.bestDiff, bestProofHeader: state.bestProofHeader || null,
      recordExterne: state.recordExterne || 0,
      accepted: state.accepted, rejected: state.rejected,
      totalHashes: state.totalHashes,
      depuis: state.depuis, paliersAtteints: state.paliersAtteints,
      diffTotalInfini: state.diffTotalInfini || 0,
      blocsTrouves: state.blocsTrouves || 0,
      diffInfiniDepuis: state.diffInfiniDepuis || new Date().toISOString(),
      codeAccesClassement: state.codeAccesClassement || null,
      journalJour: state.journalJour || [],
      detailJour: state.detailJour || [],
      diffJour: state.diffJour || 0, bestDiffJour: state.bestDiffJour || 0,
      diffJourDate: state.diffJourDate || cleJourLocal(),
    };
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        reseaux: banques,
        startedAt: state.startedAt,
        savedAt: new Date().toISOString(),
        skinPremiumActif: state.skinPremiumActif || null,
      }, null, 2));
      stateDirty = false;
    } catch (e) { log('warn', t.sauvegardeKo(e.message)); }
  }

  setInterval(() => { if (stateDirty) saveState(); }, 15000);
  setInterval(() => verifierRolloverJour(), 60000); // capte le passage à minuit même sans share
  setInterval(() => {
    const now = Date.now();
    state.histRecord.push({ t: now, v: state.bestDiff });
    state.histHash.push({ t: now, v: Math.round(state.hashrate) });
    if (state.histRecord.length > 240) state.histRecord.shift();
    if (state.histHash.length > 240) state.histHash.shift();
  }, 30000);
  process.on('SIGINT', () => { saveState(); console.log('\n' + t.etatSauve); process.exit(0); });
  process.on('SIGTERM', () => { saveState(); process.exit(0); });

  function recordHashes(workerId, n) {
    state.totalHashes += n;
    stateDirty = true;
    const now = Date.now();
    state.hashEvents.push({ t: now, n });
    const cutoff = now - 60000;
    while (state.hashEvents.length && state.hashEvents[0].t < cutoff) state.hashEvents.shift();
    const sum = state.hashEvents.reduce((a, e) => a + e.n, 0);
    const span = Math.max(1000, now - (state.hashEvents[0] ? state.hashEvents[0].t : now));
    state.hashrate = sum / (span / 1000);
    // Throttling : hashrate par cœur actuel vs pic observé (uptime > 20 s, hors calibration,
    // et au moins 20 s depuis un éventuel changement de réseau — le temps que ça se stabilise)
    if (!state.calibEnCours && state.threads > 0
        && (now - state.startedAt) > 20000
        && (now - (state.reseauChangeAt || 0)) > 20000) {
      const parCoeur = state.hashrate / state.threads;
      if (parCoeur > state.hrParCoeurPic) state.hrParCoeurPic = parCoeur;
      else if (state.hrParCoeurPic > 0) {
        state.throttle = Math.max(0, 1 - parCoeur / state.hrParCoeurPic);
      }
    }
    // Fenêtre par thread
    let ev = perWorker.get(workerId);
    if (!ev) { ev = []; perWorker.set(workerId, ev); }
    ev.push({ t: now, n });
    while (ev.length && ev[0].t < cutoff) ev.shift();
  }

  function workerRate(workerId) {
    const ev = perWorker.get(workerId);
    if (!ev || !ev.length) return 0;
    const now = Date.now();
    const sum = ev.reduce((a, e) => a + e.n, 0);
    const span = Math.max(1000, now - ev[0].t);
    return sum / (span / 1000);
  }

  /* ------------------------------- Workers -------------------------------- */
  const workers = new Map();      // id → Worker
  const perWorker = new Map();    // id → [{t, n}]
  const detectedCores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  const maxThreads = Math.max(threads, detectedCores);
  const cpuModel = (os.cpus()[0] && os.cpus()[0].model) ? os.cpus()[0].model.trim() : 'CPU';
  let currentJobMsg = null;

  // ---------------------------- Essaim local (LAN) --------------------------
  // Chaque instance AXECUBE annonce spontanément sa présence en UDP broadcast
  // sur le réseau local, et écoute les annonces des autres -- sans configuration,
  // sans dépendre d'internet ni du pool. Découverte volontairement large (comme
  // NMMiner) : toute machine AXECUBE sur le même réseau apparaît, peu importe son
  // adresse BTC -- un voisin ou un ami sur le même Wi-Fi apparaîtra aussi.
  const SWARM_PORT = 41234;
  const SWARM_INTERVAL_MS = 4000;
  const SWARM_TIMEOUT_MS = 15000; // une machine disparaît de la liste si silencieuse 15s
  const swarmPeers = new Map(); // machineId -> {machineId, worker, cpu, hashrate, bestDiff, pool, ip, vu}
  let swarmSocket = null;
  try {
    swarmSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    swarmSocket.on('error', () => { /* réseau indisponible : essaim silencieusement désactivé */ });
    swarmSocket.on('message', (msg, rinfo) => {
      try {
        const j = JSON.parse(msg.toString('utf8'));
        if (j.type !== 'axecube-swarm' || !j.machineId || j.machineId === machineId) return;
        swarmPeers.set(j.machineId, {
          machineId: j.machineId, worker: String(j.worker || '').slice(0, 40),
          cpu: String(j.cpu || '').slice(0, 40), hashrate: Number(j.hashrate) || 0,
          bestDiff: Number(j.bestDiff) || 0, pool: String(j.pool || '').slice(0, 40),
          accepted: Number(j.accepted) || 0, rejected: Number(j.rejected) || 0,
          blocsTrouves: Number(j.blocsTrouves) || 0,
          ip: rinfo.address, vu: Date.now(),
        });
      } catch { /* paquet illisible, ignoré */ }
    });
    swarmSocket.bind(SWARM_PORT, () => { try { swarmSocket.setBroadcast(true); } catch {} });
    setInterval(() => {
      if (!swarmSocket) return;
      const paquet = Buffer.from(JSON.stringify({
        type: 'axecube-swarm', machineId, worker: workerName, cpu: cpuModel,
        hashrate: state.hashrate, bestDiff: state.bestDiff, pool: poolLabel,
        accepted: state.accepted, rejected: state.rejected,
        blocsTrouves: state.blocsTrouves || 0,
      }));
      swarmSocket.send(paquet, 0, paquet.length, SWARM_PORT, '255.255.255.255', () => {});
    }, SWARM_INTERVAL_MS);
    // Purge les machines qui ne se sont plus annoncées depuis trop longtemps (éteintes,
    // déconnectées du réseau, ou AXECUBE fermé chez elles).
    setInterval(() => {
      const maintenant = Date.now();
      for (const [cle, p] of swarmPeers) if (maintenant - p.vu > SWARM_TIMEOUT_MS) swarmPeers.delete(cle);
    }, 5000);
  } catch { /* dgram indisponible sur ce système : essaim simplement désactivé */ }

  function spawnWorker(id) {
    const w = new Worker(__filename, { workerData: { workerId: id } });
    w.on('message', (m) => {
      if (m.type === 'stats') recordHashes(id, m.hashes);
      else if (m.type === 'best') {
        let nouveauteAEnvoyer = false;
        // Garde : un candidat sous le plancher du pool utilisé (DIFF_PLANCHER_POOL, ex. 100
        // sur Mineshop) n'aurait jamais pu devenir un vrai share validé sur CE pool -- on ne
        // le retient donc pas comme record all-time (base des paliers/Cubes CPU), même s'il
        // dépasse un éventuel record à 0 (tout premier lancement). Reste toujours vrai pour
        // un mineur déjà lancé, puisque son record dépasse déjà largement ce plancher.
        if (m.diff > state.bestDiff && m.diff >= DIFF_PLANCHER_POOL && !enModeSimulation) {
          state.bestDiff = m.diff;
          state.bestProofHeader = m.headerHex || null;
          stateDirty = true;
          nouveauteAEnvoyer = true;
          if (m.diff >= 1) log('best', t.nouveauRecord(formatDiff(m.diff)));
          for (const p of PALIERS) {
            if (m.diff >= p.seuil && !state.paliersAtteints[p.cle]) {
              state.paliersAtteints[p.cle] = new Date().toISOString();
              log('best', `🏅 Palier ${p.nom} débloqué !`);
            }
          }
        }
        // Barre indépendante du record all-time : capture TOUT nouveau meilleur candidat,
        // même s'il ne bat pas le record de toujours -- c'est cette valeur qui alimente les
        // classements JOUR/SEMAINE/MOIS côté classement communautaire (le serveur se charge
        // du découpage calendaire et de la remise à zéro périodique, voir submit.js).
        if (m.diff > state.bestDiffRecent) {
          state.bestDiffRecent = m.diff;
          state.bestProofHeaderRecent = m.headerHex || null;
          nouveauteAEnvoyer = true;
          // Volontairement distinct du log "🏆 Nouveau record de difficulté" ci-dessus :
          // celui-ci n'est PAS un share validé par le pool (juste un candidat qui alimente le
          // classement JOUR/SEMAINE/MOIS), pour ne jamais laisser croire à un vrai gain payé.
          const sousLePlancher = m.diff < DIFF_PLANCHER_POOL ? ` — pas un share pool (< seuil ${DIFF_PLANCHER_POOL})` : '';
          log('info', `📈 Nouveau meilleur candidat (classement du jour) : ${formatDiff(m.diff)}${sousLePlancher}`);
        }
        if (nouveauteAEnvoyer) soumettreRecordLeaderboard();
      } else if (m.type === 'share') {
        submitShare(m);
      } else if (m.type === 'engine') {
        if (state.engine !== m.engine) {
          state.engine = m.engine;
          state.engineVariant = m.variant || null;
          log('info', m.engine === 'simd'
            ? t.moteurSimd(m.variant, (m.rate / 1e6).toFixed(1))
            : m.engine === 'wasm' ? t.moteurWasm : t.moteurRepli(m.reason || '?'));
        }
      }
    });
    w.on('error', (e) => log('err', t.workerErr(id, e.message)));
    workers.set(id, w);
    if (currentJobMsg) {
      w.postMessage(currentJobMsg);
      w.postMessage({ type: 'difficulty', value: state.poolDiff });
    }
  }

  /**
   * Balaie les paliers de cœurs, mesure le hashrate stabilisé de chacun,
   * et recommande le meilleur rendement (débit réel par watt de chaleur).
   */
  async function calibrer() {
    if (state.calibEnCours) return;
    state.calibEnCours = true;
    const memoThreads = state.threads;
    const max = maxThreads;
    // Paliers testés : 2, 4, 6 … jusqu'au max, + le max lui-même
    const paliers = [];
    for (let n = 2; n < max; n += 2) paliers.push(n);
    if (paliers[paliers.length - 1] !== max) paliers.push(max);
    if (paliers[0] !== 1) paliers.unshift(1);
    log('info', t.calibDebut(paliers.join(', ')));

    const mesures = [];
    const MESURE_MS = 14000;   // ~14 s par palier : 4 s de chauffe + 10 s de mesure
    const CHAUFFE_MS = 4000;
    for (const n of paliers) {
      setThreads(n);
      await new Promise(r => setTimeout(r, CHAUFFE_MS));
      // moyenne sur la fenêtre de mesure
      const t0 = Date.now(); let somme = 0, ech = 0;
      while (Date.now() - t0 < MESURE_MS - CHAUFFE_MS) {
        await new Promise(r => setTimeout(r, 1000));
        somme += state.hashrate; ech++;
      }
      const hr = ech ? somme / ech : state.hashrate;
      mesures.push({ threads: n, hashrate: hr });
      log('info', t.calibPalier(n, (hr / 1e6).toFixed(1)));
    }

    // Rendement : on cherche le point au-delà duquel ajouter des cœurs ne rapporte
    // presque plus (moins de 5 % de gain par cœur ajouté) → le "sweet spot".
    let best = mesures[0];
    for (const m of mesures) if (m.hashrate > best.hashrate) best = m;
    let optimal = mesures[0];
    for (let i = 1; i < mesures.length; i++) {
      const prev = mesures[i - 1].hashrate || 1;
      const gain = (mesures[i].hashrate - mesures[i - 1].hashrate) / prev;
      const surCoeurs = mesures[i].threads - mesures[i - 1].threads;
      // On s'arrête dès qu'un palier ajoute peu (<3 %/cœur) OU fait baisser le débit (throttling)
      if (gain <= 0 || gain / surCoeurs < 0.03) { optimal = mesures[i - 1]; break; }
      optimal = mesures[i];
    }
    // L'optimal ne dépasse jamais le palier réellement le plus rapide
    if (optimal.hashrate < best.hashrate * 0.97 && best.threads < optimal.threads) optimal = best;

    state.calibration = {
      mesures,
      max: best,
      optimal,
      quand: Date.now(),
    };
    state.calibEnCours = false;
    state.hrParCoeurPic = 0; state.throttle = 0;    // repart proprement
    setThreads(optimal.threads);
    log('ok', t.calibFin(optimal.threads, (optimal.hashrate / 1e6).toFixed(1),
      best.threads, (best.hashrate / 1e6).toFixed(1)));
    saveState();
  }

  function setThreads(n) {
    n = Math.max(1, Math.min(maxThreads, Math.floor(n)));
    while (workers.size < n) spawnWorker(workers.size);
    while (workers.size > n) {
      const id = workers.size - 1;
      const w = workers.get(id);
      workers.delete(id);
      perWorker.delete(id);
      w.terminate();
    }
    if (state.threads !== n) {
      log('info', t.threadsMaj(n));
      // Le nombre de cœurs vient de changer : le hashrate par cœur observé jusqu'ici
      // n'est plus une référence valable (mix d'ancien/nouveau dans la fenêtre glissante
      // de 60s). On repart proprement, comme pour un changement de réseau.
      state.hrParCoeurPic = 0;
      state.throttle = 0;
      state.reseauChangeAt = Date.now();
    }
    state.threads = n;
  }

  // controleThermiqueDesactive : volontairement PAS dans `state` (jamais persisté sur
  // disque, jamais sauvegardé). Une simple variable de ce process en mémoire vive --
  // donc à chaque redémarrage d'AXECUBE, ce drapeau repart TOUJOURS à false (protection
  // active par défaut). Impossible de rester bloqué en "désactivé" sans s'en rendre compte
  // d'une session à l'autre, par design. Contrôle le garde-fou thermique existant plus
  // bas (celui qui s'appuie sur lireEtatThermiqueReel), pas de système redondant ici.
  let controleThermiqueDesactive = false;

  let threadsAvantPause = threads;
  function basculerMinage(actif) {
    if (actif === state.actif) return;
    if (!actif) {
      // Pause : on coupe tous les workers, mais on retient combien il y en avait
      threadsAvantPause = Math.max(1, state.threads);
      for (const [id, w] of workers) { w.terminate(); }
      workers.clear();
      perWorker.clear();
      state.threads = 0;
      state.actif = false;
      state.hashrate = 0;
      state.hashEvents = [];
      state.hrParCoeurPic = 0;
      state.throttle = 0;
      log('warn', '⏸ Minage mis en pause.');
    } else {
      state.actif = true;
      for (let i = 0; i < threadsAvantPause; i++) spawnWorker(i);
      state.threads = threadsAvantPause;
      state.hrParCoeurPic = 0; state.throttle = 0; state.reseauChangeAt = Date.now();
      log('ok', '▶ Minage repris.');
    }
  }

  for (let i = 0; i < threads; i++) spawnWorker(i);

  // Régulation thermique automatique : si le démon de température tourne (voir
  // axecube-temp-daemon.sh) et détecte une vraie pression thermique élevée, on réduit
  // automatiquement le nombre de threads d'un cran pour laisser la puce respirer --
  // et on remonte progressivement vers la cible d'origine (${threads}) une fois que
  // la situation redevient normale pendant plusieurs vérifications d'affilée.
  // Entièrement silencieux/inactif si le démon n'est pas installé (lireEtatThermiqueReel
  // renvoie alors null à chaque fois).
  const SEUIL_TEMP_REDUCTION_C = Math.max(50, parseFloat(args['temp-max'] || process.env.AXECUBE_TEMP_MAX || '85'));
  let normalConsecutif = 0;
  setInterval(() => {
    if (!state.actif) return; // en pause, rien à ajuster
    if (controleThermiqueDesactive) return; // désactivé manuellement pour cette session (⚙ Paramètres)
    const etat = lireEtatThermiqueReel();
    if (!etat) return;
    const chaud = etat.type === 'temperature'
      ? etat.valeur >= SEUIL_TEMP_REDUCTION_C
      : etat.valeur.toLowerCase() !== 'nominal';
    const libelle = etat.type === 'temperature' ? etat.valeur.toFixed(0) + '°C' : etat.valeur;

    if (chaud) {
      normalConsecutif = 0;
      if (state.threads > 1) {
        setThreads(state.threads - 1);
        log('warn', `🌡️ Pression thermique élevée (${libelle}) — réduction automatique à ${state.threads} thread(s) pour protéger le matériel.`);
        saveState();
      }
    } else {
      normalConsecutif++;
      if (normalConsecutif >= 3 && state.threads < threads) {
        setThreads(state.threads + 1);
        log('info', `🌡️ Pression thermique redevenue normale (${libelle}) — remontée progressive à ${state.threads} thread(s).`);
        normalConsecutif = 0;
        saveState();
      }
    }
  }, 60000);

  function broadcast(msg) { for (const w of workers.values()) w.postMessage(msg); }

  /* ---------------------------- Client Stratum ---------------------------- */
  let socket = null;
  let msgId = 10;
  let extranonce1 = '';
  let extranonce2Size = 4;
  const pending = new Map(); // id → {type, share?}
  let rxBuffer = '';

  function send(obj) {
    if (socket && !socket.destroyed) socket.write(JSON.stringify(obj) + '\n');
  }

  // Difficulté suggérée au pool : basse au départ (adaptée à du CPU, pas de l'ASIC), mais
  // jamais en dessous du plancher connu du pool choisi (ex. 512 sur Braiins Solo, 10000 sur
  // CKPool) -- inutile de suggérer plus bas, le pool l'ignorerait de toute façon. Ensuite,
  // divisée par deux automatiquement si aucune part n'est acceptée pendant 90s (au lieu de
  // 4 min -- un CPU a besoin de converger plus vite vers une diff confortable), sans jamais
  // descendre sous ce plancher. Ça ne change rien aux vraies chances de trouver un bloc :
  // ça ne dépend que de la difficulté réseau, jamais de la difficulté de part -- un share à
  // diff 8 et un share à diff 100 réclament exactement le même travail réel pour trouver un
  // bloc, seule la FRÉQUENCE des shares "visibles" en tant que participation change.
  const DIFF_PLANCHER_POOL = (preset && preset.diffMin) || 1;
  const DIFF_SUGGESTION_INITIALE = Math.max(16, DIFF_PLANCHER_POOL);
  let diffSuggereeActuelle = DIFF_SUGGESTION_INITIALE;
  let accepteesAuDernierControle = 0;
  let minuteurAjustementDiff = null;
  function demarrerAjustementDiff() {
    diffSuggereeActuelle = DIFF_SUGGESTION_INITIALE;
    accepteesAuDernierControle = state.accepted;
    if (minuteurAjustementDiff) clearInterval(minuteurAjustementDiff);
    minuteurAjustementDiff = setInterval(() => {
      if (!state.connected) return;
      if (state.accepted === accepteesAuDernierControle && diffSuggereeActuelle > DIFF_PLANCHER_POOL) {
        diffSuggereeActuelle = Math.max(DIFF_PLANCHER_POOL, Math.floor(diffSuggereeActuelle / 2));
        send({ id: ++msgId, method: 'mining.suggest_difficulty', params: [diffSuggereeActuelle] });
        log('info', `⚙️ Aucune part acceptée depuis 90s — nouvelle difficulté suggérée au pool : ${diffSuggereeActuelle}`);
      }
      accepteesAuDernierControle = state.accepted;
    }, 90 * 1000);
  }

  function submitShare(share) {
    if (!state.connected) { log('warn', t.sharePerdu); return; }
    const id = ++msgId;
    pending.set(id, { type: 'submit', share });
    send({ id, method: 'mining.submit', params: [user, share.jobId, share.extranonce2, share.ntime, share.nonce] });
    log('share', t.shareSoumis(formatDiff(share.diff), share.nonce));
    if (state.netDiff > 0 && share.diff >= state.netDiff && !enModeSimulation) {
      state.blocsTrouves = (state.blocsTrouves || 0) + 1;
      stateDirty = true;
      log('block', t.blocTrouve);
    } else if (state.netDiff > 0 && share.diff >= state.netDiff && enModeSimulation) {
      log('block', '🧪 Bloc trouvé EN SIMULATION uniquement -- ne compte pas comme un vrai bloc, jamais sauvegardé.');
    }
  }

  function handleStratum(msg) {
    // Réponses à nos requêtes
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      const req = pending.get(msg.id);
      pending.delete(msg.id);
      if (req.type === 'subscribe') {
        const res = msg.result;
        extranonce1 = res[1];
        extranonce2Size = res[2];
        // Demande une difficulté adaptée à un CPU (le pool peut refuser), avec ajustement
        // automatique à la baisse si aucune part n'arrive après quelques minutes.
        send({ id: ++msgId, method: 'mining.suggest_difficulty', params: [DIFF_SUGGESTION_INITIALE] });
        demarrerAjustementDiff();
        const id = ++msgId;
        pending.set(id, { type: 'authorize' });
        send({ id, method: 'mining.authorize', params: [user, poolPassword] });
      } else if (req.type === 'authorize') {
        if (msg.result) log('ok', t.autorise(workerName));
        else log('err', t.autoRefus(JSON.stringify(msg.error)));
      } else if (req.type === 'submit') {
        if (msg.result === true) {
          // MÊME garde que pour bestDiff/blocsTrouves : une pool locale/simulation ne doit
          // JAMAIS alimenter les compteurs réels (accepted, historique de difficulté du
          // jour...) -- sinon une pool triviale (difficulté quasi nulle, comme un script de
          // test) peut faire grimper ces totaux à volonté, sans rapport avec un vrai travail
          // de minage sur un vrai pool. Corrige un trou où seul bestDiff était protégé.
          if (!enModeSimulation) {
            state.accepted++;
            verifierRolloverJour();
            state.diffTotalInfini = (state.diffTotalInfini || 0) + req.share.diff;
            state.diffJour = (state.diffJour || 0) + req.share.diff;
            if (req.share.diff > (state.bestDiffJour || 0)) state.bestDiffJour = req.share.diff;
            // Détail brut du jour en cours : chaque share accepté, horodaté -- conservé tel
            // quel pour être archivé dans le journal au changement de jour (voir
            // verifierRolloverJour), et consultable ensuite au clic sur une entrée du journal.
            // Plafonné à 5000 shares/jour par sécurité (mémoire), largement suffisant pour un CPU.
            if (!Array.isArray(state.detailJour)) state.detailJour = [];
            state.detailJour.push({ t: Date.now(), diff: req.share.diff });
            if (state.detailJour.length > 5000) state.detailJour.shift();
            stateDirty = true;
            log('ok', t.shareOk(formatDiff(req.share.diff), state.accepted));
          } else {
            log('ok', `🧪 Share accepté EN SIMULATION uniquement (${formatDiff(req.share.diff)}) -- ne compte pas dans le total réel.`);
          }
        } else {
          state.rejected++;
          stateDirty = true;
          log('err', t.shareKo(JSON.stringify(msg.error)));
        }
      }
      return;
    }
    // Notifications du pool
    if (msg.method === 'mining.set_difficulty') {
      state.poolDiff = Number(msg.params[0]);
      broadcast({ type: 'difficulty', value: state.poolDiff });
      log('info', t.diffPool(formatDiff(state.poolDiff)));
    } else if (msg.method === 'mining.notify') {
      const p = msg.params;
      const job = {
        jobId: p[0], prevhash: p[1], coinb1: p[2], coinb2: p[3],
        merkleBranch: p[4], version: p[5], nbits: p[6], ntime: p[7],
      };
      state.jobId = job.jobId;
      state.netDiff = nbitsToDifficulty(job.nbits);
      // Analyse réelle de la coinbase : sorties, montants, part revenant à l'utilisateur
      // (on attend d'avoir un extranonce1 réel : sinon le buffer est mal formé et
      //  l'adresse semble absente à tort, juste après la connexion)
      if (scriptAttendu && extranonce1) {
        const cbHex = (job.coinb1 + extranonce1 + '00'.repeat(extranonce2Size) + job.coinb2).toLowerCase();
        const v = verifierPaiement(cbHex, scriptAttendu);
        state.paiement = v;
        // Clé insensible aux variations de frais : seul un changement de situation compte
        const cle = v.etat + ':' + Math.round(v.part * 100);
        if (state.paiementCle !== cle) {
          state.paiementCle = cle;
          const btc = (v.satoshis / 1e8).toFixed(8);
          const pct = (v.part * 100).toFixed(1);
          if (v.etat === 'complet') log('ok', t.paieComplet(btc, pct, reseau.symbole));
          else if (v.etat === 'partiel') log(v.part >= 0.5 ? 'ok' : 'err', t.paiePartiel(btc, pct, reseau.symbole));
          else if (v.etat === 'absent') log('err', t.paieAbsent);
          else log('warn', t.paieIllisible);
        }
      }
      const h = parseBlockHeight(job.coinb1);
      if (h) {
        if (state.blockHeight && h > state.blockHeight) state.lastBlockAt = Date.now();
        else if (!state.blockHeight) state.lastBlockAt = Date.now();
        state.blockHeight = h;
      }
      // Hashrate réseau estimé depuis la difficulté : diff × 2^32 / 600 s
      if (state.netDiff > 0) state.netHashrate = state.netDiff * 4294967296 / 600;
      currentJobMsg = { type: 'job', job, extranonce1, extranonce2Size, difficulty: state.poolDiff };
      broadcast(currentJobMsg);
      if (p[8]) log('info', t.nouveauBloc(job.jobId, h ?? '?'));
    }
  }

  // Changement de pool à chaud, même principe que changerReseau : on garde le même record
  // (bestDiff) puisque c'est le même réseau/difficulté, on change juste où on soumet les
  // parts. Limité aux préréglages solo BTC connus -- passer à un pool "compte requis"
  // (ViaBTC, Braiins Pool) nécessiterait un identifiant de compte, pas juste l'adresse.
  // Persiste le choix dans .axecube-config (celui que le lanceur .command/.bat lit au
  // démarrage) pour qu'un changement fait en direct survive à un redémarrage -- sans ça,
  // relancer AXECUBE revenait toujours au pool d'origine choisi à la création.
  function mettreAJourConfigPool(presetCle) {
    try {
      const cheminConf = path.join(__dirname, '.axecube-config');
      let lignes = [];
      try { lignes = fs.readFileSync(cheminConf, 'utf8').split('\n'); } catch { /* pas de config existante */ }
      let trouve = false;
      lignes = lignes.map((l) => {
        if (/^POOLPRESET=/.test(l)) { trouve = true; return `POOLPRESET=${presetCle}`; }
        return l;
      }).filter((l) => l.trim() !== '');
      if (!trouve) lignes.push(`POOLPRESET=${presetCle}`);
      fs.writeFileSync(cheminConf, lignes.join('\n') + '\n');
    } catch { /* pas de lanceur officiel utilisé, ou dossier non accessible en écriture : pas grave */ }
  }

  function changerPool(nouveauPreset) {
    const p = PRESETS_POOL[nouveauPreset];
    if (!p || p.compte || reseauCle !== 'btc') return false;
    if (nouveauPreset === presetCle) return false; // déjà sur ce pool (presetCle = celui du lancement actuel)
    mettreAJourConfigPool(nouveauPreset);
    log('info', `🔀 Relance d'AXECUBE sur le pool ${nouveauPreset} (${p.host})…`);
    saveState(); // on ne perd pas le record en cours

    // On repart avec les mêmes arguments qu'au lancement, en remplaçant juste --pool-preset
    // (et en retirant --pool s'il était utilisé, pour éviter un conflit entre les deux).
    const argsActuels = process.argv.slice(2);
    const nouveauxArgs = [];
    for (let i = 0; i < argsActuels.length; i++) {
      const a = argsActuels[i];
      if (a === '--pool-preset' || a === '--pool') { i++; continue; }
      nouveauxArgs.push(a);
    }
    nouveauxArgs.push('--pool-preset', nouveauPreset);

    const { spawn } = require('child_process');
    let dejaRelance = false;
    function lancerEnfantEtQuitter() {
      if (dejaRelance) return;
      dejaRelance = true;
      try {
        const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
        const commande = `cd ${quote(__dirname)} && ${[process.execPath, __filename, ...nouveauxArgs].map(quote).join(' ')}`;
        if (process.platform === 'darwin') {
          // macOS : on demande à Terminal.app d'ouvrir une vraie fenêtre visible, comme au
          // premier lancement -- sans ça la relance est invisible (process détaché muet).
          const script = `tell application "Terminal" to do script "${commande.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
          spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'win32') {
          spawn('cmd.exe', ['/c', 'start', '""', 'cmd', '/k', process.execPath, __filename, ...nouveauxArgs],
            { detached: true, stdio: 'ignore', cwd: __dirname }).unref();
        } else {
          // Linux : pas de terminal universel -- on garde un process détaché silencieux,
          // avec les logs redirigés vers un fichier pour ne rien perdre.
          const fdLog = fs.openSync(path.join(__dirname, 'axecube.log'), 'a');
          spawn(process.execPath, [__filename, ...nouveauxArgs],
            { detached: true, stdio: ['ignore', fdLog, fdLog], cwd: __dirname }).unref();
        }
      } catch (e) { log('warn', `Échec de la relance automatique : ${e.message}`); }
      process.exit(0);
    }
    if (socket && !socket.destroyed) socket.destroy();
    server.close(lancerEnfantEtQuitter);
    setTimeout(lancerEnfantEtQuitter, 3000); // filet de sécurité si server.close tarde
    return true;
  }

  function changerSoloSplit(n) {
    const valeur = Math.max(0, Math.min(100, parseInt(n, 10)));
    if (Number.isNaN(valeur)) return false;
    log('info', `⚖️  Relance d'AXECUBE avec Solo Split à ${valeur}%…`);
    saveState(); // on ne perd pas le record en cours

    const argsActuels = process.argv.slice(2);
    const nouveauxArgs = [];
    for (let i = 0; i < argsActuels.length; i++) {
      const a = argsActuels[i];
      if (a === '--solo-split' || a === '--password') { i++; continue; }
      nouveauxArgs.push(a);
    }
    nouveauxArgs.push('--solo-split', String(valeur));

    const { spawn } = require('child_process');
    let dejaRelance = false;
    function lancerEnfantEtQuitter() {
      if (dejaRelance) return;
      dejaRelance = true;
      try {
        const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
        const commande = `cd ${quote(__dirname)} && ${[process.execPath, __filename, ...nouveauxArgs].map(quote).join(' ')}`;
        if (process.platform === 'darwin') {
          const script = `tell application "Terminal" to do script "${commande.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
          spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'win32') {
          spawn('cmd.exe', ['/c', 'start', '""', 'cmd', '/k', process.execPath, __filename, ...nouveauxArgs],
            { detached: true, stdio: 'ignore', cwd: __dirname }).unref();
        } else {
          const fdLog = fs.openSync(path.join(__dirname, 'axecube.log'), 'a');
          spawn(process.execPath, [__filename, ...nouveauxArgs],
            { detached: true, stdio: ['ignore', fdLog, fdLog], cwd: __dirname }).unref();
        }
      } catch (e) { log('warn', `Échec de la relance automatique : ${e.message}`); }
      process.exit(0);
    }
    if (socket && !socket.destroyed) socket.destroy();
    server.close(lancerEnfantEtQuitter);
    setTimeout(lancerEnfantEtQuitter, 3000);
    return true;
  }

  function changerReseau(cle) {
    if (!RESEAUX[cle] || cle === reseauCle) return false;
    log('info', t.changementReseau(RESEAUX[cle].label));
    saveState();                 // conserve le record du réseau qu'on quitte
    reseauCle = cle;
    reseau = RESEAUX[cle];
    poolHost = reseau.poolDefaut;
    poolPort = reseau.portDefaut;
    chargerBanque(cle);          // recharge le record propre à ce réseau (ou 0 si jamais miné)
    // Le reste est propre à la session de connexion en cours, jamais persisté
    state.netDiff = 0; state.netHashrate = 0; state.poolDiff = 0;
    state.blockHeight = null; state.lastBlockAt = 0; state.jobId = null;
    state.paiement = null; state.paiementCle = null;
    state.connected = false;
    // Le pic de hashrate/cœur d'un réseau n'a aucun sens pour l'autre : on repart à zéro,
    // avec un délai de grâce avant de recalculer le thermique (le temps que ça se stabilise).
    state.hrParCoeurPic = 0; state.throttle = 0;
    state.reseauChangeAt = Date.now();
    stateDirty = true; saveState();
    if (socket && !socket.destroyed) socket.destroy();
    setTimeout(connect, 400);
    return true;
  }

  function connect() {
    socket = net.connect(poolPort, poolHost);
    socket.setKeepAlive(true, 30000);

    socket.on('connect', () => {
      state.connected = true;
      log('info', t.connecte(poolHost));
      rxBuffer = '';
      const id = ++msgId;
      pending.set(id, { type: 'subscribe' });
      send({ id, method: 'mining.subscribe', params: ['axecube/1.0'] });
      // À chaque connexion (démarrage, reconnexion, changement de pool), on redemande
      // au pool sa meilleure difficulté connue pour cette adresse.
      setTimeout(synchroniserRecordEtStats, 2000);
    });

    socket.on('data', (chunk) => {
      rxBuffer += chunk.toString('utf8');
      let idx;
      while ((idx = rxBuffer.indexOf('\n')) >= 0) {
        const line = rxBuffer.slice(0, idx).trim();
        rxBuffer = rxBuffer.slice(idx + 1);
        if (!line) continue;
        try { handleStratum(JSON.parse(line)); }
        catch (e) { log('warn', t.poolIllisible(line.slice(0, 120))); }
      }
    });

    socket.on('error', (e) => {
      let detail = e && e.message;
      if (!detail && e && e.errors && e.errors.length) detail = e.errors.map(x => x.code || x.message).join(', ');
      if (!detail) detail = (e && (e.code || e.toString())) || 'inconnue';
      log('err', t.reseauErr(detail));
    });
    socket.on('close', () => {
      if (state.connected) log('warn', t.deconnecte);
      state.connected = false;
      setTimeout(connect, 5000);
    });
  }

  /* ------------------------------ Formatage ------------------------------- */
  function formatHashrate(h) {
    if (h >= 1e12) return (h / 1e12).toFixed(2) + ' TH/s';
    if (h >= 1e9) return (h / 1e9).toFixed(2) + ' GH/s';
    if (h >= 1e6) return (h / 1e6).toFixed(2) + ' MH/s';
    if (h >= 1e3) return (h / 1e3).toFixed(2) + ' kH/s';
    return h.toFixed(0) + ' H/s';
  }
  function formatDiff(d) {
    if (!isFinite(d)) return '∞';
    if (d >= 1e12) return (d / 1e12).toFixed(2) + ' T';
    if (d >= 1e9) return (d / 1e9).toFixed(2) + ' G';
    if (d >= 1e6) return (d / 1e6).toFixed(2) + ' M';
    if (d >= 1e3) return (d / 1e3).toFixed(2) + ' k';
    return d >= 100 ? d.toFixed(0) : d.toPrecision(3);
  }

  /* ------------------------------ Dashboard ------------------------------- */
  const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#05070a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="AXECUBE">
<meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.json${jeton ? '?token=' + jeton : ''}">
<link rel="icon" href="/icon.svg${jeton ? '?token=' + jeton : ''}" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg${jeton ? '?token=' + jeton : ''}">
<title>AXECUBE</title>
<style>
  :root{
    --chassis:#0e0f12; --bezel:#17191f; --edge:#242832; --plate:#0a0b0e;
    --oled:#05070a; --amber:#96f01f; --amber-dim:rgba(150,240,31,.78);
    --amber-faint:rgba(150,240,31,.5); --glow:0 0 10px rgba(150,240,31,.35);
    --white:#e8edf5; --white-dim:rgba(232,237,245,.62); --white-faint:rgba(232,237,245,.38);
    --led-ok:#4dffc3; --led-ko:#ff4d5e;
    --mono:ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{background:#000;display:flex;justify-content:center;align-items:stretch;
       font-family:var(--mono);padding:10px;-webkit-text-size-adjust:100%;
       padding-top:max(10px,env(safe-area-inset-top));
       padding-bottom:max(10px,env(safe-area-inset-bottom))}
  /* Téléphones : format appareil conservé, contenu resserré, console défilante */
  @media(max-width:560px), (max-height:820px){
    body{padding:5px}
    .device{border-radius:16px;padding:9px 9px 6px}
    .screen{gap:8px;padding:12px 11px 9px}
    .brand-logo{height:32px}
    .plate{padding:1px 2px 8px;gap:6px}
    .serial{font-size:8px;max-width:70px}
    .btns{gap:3px}
    .plate-right{gap:4px;padding-left:3px}
    .netbtn{min-width:44px;font-size:8px;padding:0 5px}
    .hero .hr{font-size:34px}
    canvas{height:32px}
    .cores{height:13px;margin-top:5px}
    .record{padding:6px 0 4px}
    .record .val{font-size:27px}
    .cup-big{font-size:19px}
    .rows{gap:4px;font-size:11.5px}
    .row .k{font-size:8.5px;letter-spacing:.16em}
    .odds{font-size:9.5px;line-height:1.5}
    .console{font-size:10px;line-height:1.65;min-height:150px;max-height:220px;
             overflow-y:auto;overflow-x:hidden;flex:none;-webkit-overflow-scrolling:touch}
    .tbtn,.mini-btn{width:27px;height:27px}
    .foot{padding-top:6px;font-size:7.5px}
  }
  /* ===== Châssis ===== */
  .device{width:min(400px,100%);display:flex;flex-direction:column;position:relative;
          background:linear-gradient(160deg,#14161b,var(--chassis) 40%);
          border:1px solid var(--edge);border-radius:22px;
          box-shadow:0 12px 40px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.05);
          padding:14px 14px 10px}
  #confettiZone{position:absolute;left:0;right:0;top:0;height:0;overflow:visible;pointer-events:none;z-index:80}
  .confettiPiece{position:absolute;top:0;left:var(--x);width:var(--taille);height:calc(var(--taille)*.4);
    background:var(--coul);opacity:0;border-radius:1px;
    animation:tomberConfetti var(--dur) cubic-bezier(.25,.46,.45,.94) var(--delai) forwards}
  @keyframes tomberConfetti{
    0%{opacity:1;transform:translate(0,-14px) rotate(0deg)}
    12%{opacity:1}
    100%{opacity:0;transform:translate(var(--derive),var(--chute)) rotate(var(--tours))}
  }
  .plate{display:flex;align-items:center;gap:11px;padding:3px 4px 13px;flex-wrap:wrap;row-gap:8px}
  .led{width:9px;height:9px;border-radius:50%;background:var(--led-ko);
       box-shadow:0 0 8px var(--led-ko)}
  .led.on{background:var(--led-ok);box-shadow:0 0 8px var(--led-ok)}
  .brand-logo{height:42px;width:auto;display:block}
  .logo-net-stack{display:flex;flex-direction:column;align-items:center;gap:5px;flex:0 0 auto}
  .mini-btn{background:none;border:1px solid #333a47;color:#8a94a6;
            font-family:var(--mono);font-size:15px;line-height:1;width:28px;height:28px;
            border-radius:6px;cursor:pointer;flex:0 0 auto;display:flex;align-items:center;justify-content:center}
  .mini-btn:hover{border-color:var(--amber);color:var(--amber)}
  .mini-btn:focus-visible{outline:1px solid var(--amber);outline-offset:2px}
  .mini-btn.on{border-color:var(--amber);color:var(--amber)}
  #pausebtn.on{border-color:#ff5d5d;color:#ff5d5d}
  .copy-btn{background:none;border:1px solid #333a47;color:#8a94a6;
            font-family:var(--mono);font-size:15px;line-height:1;width:26px;height:26px;
            border-radius:6px;cursor:pointer;flex:0 0 auto;margin-left:4px;
            display:flex;align-items:center;justify-content:center}
  .copy-btn:hover{border-color:var(--amber);color:var(--amber)}
  .copy-btn.ok{border-color:var(--amber);color:var(--amber)}
  .icon-group{display:flex;gap:6px;flex:0 0 auto}
  .icon-group .copy-btn{margin-left:0}
  #cardcanvas{display:none}
  /* Panneau flottant */
  .pip{font-family:var(--mono);background:var(--oled);color:var(--amber);
       padding:11px 13px;height:100%;display:flex;flex-direction:column;gap:7px;
       box-sizing:border-box}
  .pip .l{font-size:8px;letter-spacing:.24em;color:var(--white-dim)}
  .pip .hr{font-size:26px;font-weight:700;line-height:1;text-shadow:var(--glow);
           font-variant-numeric:tabular-nums}
  .pip .rec{font-size:17px;font-weight:700;text-shadow:var(--glow)}
  .pip .row{display:flex;justify-content:space-between;font-size:10px;align-items:baseline}
  .pip .row span:first-child{color:var(--white-dim);font-size:8px;letter-spacing:.2em}
  .pip .sep{border-top:1px dashed rgba(150,240,31,.3);margin:1px 0}
  .pip .phead{display:flex;align-items:center;gap:7px;margin-bottom:1px}
  .pip .plogo{height:20px;width:auto}
  .pip .pled{width:6px;height:6px;border-radius:50%;background:#ff4d5e;margin-left:auto}
  .pip .pled.on{background:#4dffc3;box-shadow:0 0 6px #4dffc3}
  .pip .pcores{display:flex;gap:2px;align-items:flex-end;height:11px;margin-top:6px}
  .pip .pcores i{flex:0 0 6px;background:var(--amber-faint);border-radius:1px}
  .pip .prec{display:flex;justify-content:space-between;align-items:center}
  .pip .cup{font-size:13px;filter:drop-shadow(0 0 4px rgba(150,240,31,.5))}
  .pip .pjack{font-size:9px;color:var(--white-dim);margin-top:auto;padding-top:4px;
              border-top:1px solid rgba(150,240,31,.12)}
  .pip .pjack b{color:var(--amber)}
  .serial{font-size:9.5px;color:#7a8496;letter-spacing:.08em;white-space:nowrap;
          overflow:hidden;text-overflow:ellipsis;min-width:0}
  .plate-right{display:flex;align-items:center;flex-wrap:nowrap;justify-content:flex-end;
               gap:6px;margin-left:auto;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;
               scrollbar-width:none;padding-left:4px}
  .plate-right::-webkit-scrollbar{display:none}
  .btns{display:flex;align-items:center;gap:5px;flex:0 0 auto;
        padding-left:8px;border-left:1px solid #262b35}
  .netsel{position:relative;flex:0 0 auto}
  .netBtnActuel{background:none;border:1px solid var(--amber);color:var(--amber);
          font-family:var(--mono);font-size:9px;letter-spacing:.06em;padding:0 10px;height:24px;
          min-width:44px;border-radius:6px;cursor:pointer;background:rgba(150,240,31,.08)}
  .netSelect{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:9px}
  .netbtn{background:none;border:1px solid #333a47;color:#8a94a6;font-family:var(--mono);
          font-size:9px;letter-spacing:.06em;padding:0 8px;height:24px;min-width:52px;
          border-radius:6px;cursor:pointer;text-align:center}
  .netbtn.on{border-color:var(--amber);color:var(--amber);background:rgba(150,240,31,.08)}
  .netbtn:disabled{opacity:.5;cursor:default}
  /* ===== Écran OLED ===== */
  .screen{flex:1;display:flex;flex-direction:column;gap:12px;overflow:hidden;
          background:var(--oled);border-radius:12px;border:1px solid #10141a;
          box-shadow:inset 0 0 30px rgba(0,0,0,.9);
          padding:16px 14px 12px;color:var(--amber);position:relative}
  .screen::after{content:'';position:absolute;inset:0;pointer-events:none;border-radius:12px;
          background:repeating-linear-gradient(0deg,transparent 0 2px,rgba(0,0,0,.14) 2px 3px)}
  .screenScroll{flex:1;display:flex;flex-direction:column;gap:12px;min-height:0;
                overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch}
  .lbl{font-size:9px;letter-spacing:.28em;color:var(--white-dim)}
  .hero{position:relative}
  .hero .hr{font-size:44px;font-weight:700;line-height:1.05;text-shadow:var(--glow);
            font-variant-numeric:tabular-nums;margin-top:4px}
  .hero .sub{font-size:10px;color:var(--white-dim);margin-top:5px}
  .blocBadge{position:absolute;top:0;right:0;text-align:center;line-height:1.15}
  .blocBadge .n{font-size:24px;font-weight:800;color:var(--amber);text-shadow:var(--glow);
                font-variant-numeric:tabular-nums;transition:color .15s}
  .blocBadge .l{font-size:8.5px;letter-spacing:.18em;color:var(--white-dim);margin-top:1px}
  @keyframes blocPulse{0%,100%{opacity:1}50%{opacity:.45}}
  @keyframes blocFlash{0%{transform:scale(1)}15%{transform:scale(1.7)}30%{transform:scale(1)}
    45%{transform:scale(1.5)}60%{transform:scale(1)}100%{transform:scale(1)}}
  .blocBadge.trouve .n{animation:blocPulse 1.1s ease-in-out 6}
  .blocBadge.flash .n{animation:blocFlash 1.6s ease-in-out, blocPulse 1.1s ease-in-out infinite;color:#fff}
  canvas{width:100%;height:44px;display:block;opacity:.9}
  .cores{display:flex;gap:4px;align-items:flex-end;height:18px;margin-top:8px}
  .cores i{flex:0 0 12px;background:var(--amber-faint);border-radius:1px;min-height:2px}
  /* Record : le trophée central */
  .record{text-align:center;padding:5px 0 3px;border-top:1px dashed rgba(150,240,31,.3)}
  .record .val{font-size:34px;font-weight:700;text-shadow:var(--glow);
               font-variant-numeric:tabular-nums;display:flex;align-items:center;
               justify-content:center;gap:10px}
  .cup-big{font-size:26px;filter:drop-shadow(0 0 6px rgba(150,240,31,.5))}
  .planete{font-size:20px;cursor:pointer;margin-left:6px;filter:drop-shadow(0 0 4px rgba(150,240,31,.4));
           display:inline-block;animation:tournePlanete 12s linear infinite}
  .planete:hover{filter:drop-shadow(0 0 8px rgba(150,240,31,.7))}
  @keyframes tournePlanete{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
  /* Aperçu classement communautaire (top 3) */
  .badgeChip{display:flex;align-items:center;gap:8px;width:100%;margin:0 0 5px;padding:6px 10px;
             background:rgba(150,240,31,.06);border:1px solid var(--amber-faint);border-radius:8px;
             font-family:var(--mono);cursor:pointer;text-align:left}
  .badgeChip:hover{border-color:var(--amber);background:rgba(150,240,31,.1)}
  #badgeChipIcone{font-size:15px}
  #badgeChipTexte{flex:1;font-size:10px;font-weight:800;letter-spacing:.1em;color:var(--amber)}
  .badgeChipVoir{font-size:8.5px;color:var(--white-dim);letter-spacing:.05em}
  .palierPopup{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);
               z-index:999;align-items:center;justify-content:center;padding:20px}
  .palierPopupCard{background:var(--chassis);border:1px solid var(--edge);border-radius:16px;
                    padding:20px;text-align:center;max-width:340px;
                    box-shadow:0 20px 60px rgba(0,0,0,.8)}
  .palierPopupCard img{width:100%;max-width:260px;border-radius:10px;
                        animation:popScale .5s cubic-bezier(.34,1.56,.64,1)}
  .palierImgWrap{position:relative;width:100%;max-width:260px;margin:0 auto}
  .palierImgWrap img{display:block}
  .palierRecordBandeau{margin-top:10px;padding:10px 14px;background:rgba(150,240,31,.06);
                        border:1px solid var(--amber-faint);border-radius:10px;
                        display:flex;align-items:center;justify-content:space-between}
  .palierOverlayDiff{font-size:20px;font-weight:800;color:var(--amber);text-shadow:var(--glow);
                      font-variant-numeric:tabular-nums}
  .palierOverlayDate{font-size:10px;color:var(--white-dim);letter-spacing:.03em}
  .palierPopupNext{margin-top:8px;font-size:9.5px;color:var(--white-dim);letter-spacing:.05em}
  @keyframes popScale{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
  .palierPopupTitre{margin-top:14px;font-size:15px;font-weight:800;color:var(--amber);
                     text-shadow:var(--glow)}
  .palierPopupFermer{margin-top:16px;background:none;border:1px solid var(--amber-faint);
                      color:var(--amber);font-family:var(--mono);font-size:10px;
                      letter-spacing:.1em;padding:9px 18px;border-radius:8px;cursor:pointer}
  .palierPopupFermer:hover{border-color:var(--amber);background:rgba(150,240,31,.08)}
  .donPopup{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);
            z-index:999;align-items:center;justify-content:center;padding:20px}
  .donPopupCard{background:var(--chassis);border:1px solid var(--edge);border-radius:16px;
                padding:24px;text-align:left;max-width:360px;max-height:88vh;overflow-y:auto;
                box-shadow:0 20px 60px rgba(0,0,0,.8);animation:popScale .4s cubic-bezier(.34,1.56,.64,1)}
  .donPopupTitre{font-size:16px;font-weight:800;color:var(--amber);text-shadow:var(--glow);
                 margin-bottom:10px;display:flex;align-items:center;gap:8px}
  .donPopupTexte{font-size:12.5px;color:var(--white-dim);line-height:1.6;margin-bottom:14px}
  .donPopupAdresse{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.04);
                    border:1px solid var(--edge);border-radius:8px;padding:10px 12px;
                    margin-bottom:14px;min-width:0}
  .donPopupAdresse span{font-size:11px;color:var(--white);white-space:nowrap;overflow:hidden;
                         text-overflow:ellipsis;min-width:0;flex:1 1 auto}
  .donPopupAdresse button{flex:0 0 auto;background:none;border:1px solid var(--amber-faint);
                           color:var(--amber);font-family:var(--mono);font-size:10px;
                           padding:6px 10px;border-radius:6px;cursor:pointer}
  .donPopupAdresse button:hover{border-color:var(--amber);background:rgba(150,240,31,.08)}
  .donPopupActions{display:flex;gap:8px;justify-content:flex-end}
  .donPopupFermer{background:none;border:1px solid var(--edge);color:var(--white-dim);
                   font-family:var(--mono);font-size:10px;letter-spacing:.05em;
                   padding:9px 16px;border-radius:8px;cursor:pointer}
  .donPopupFermer:hover{border-color:var(--white-dim)}
  .donPopupFermer.actif{border-color:var(--amber);color:var(--amber);background:rgba(150,240,31,.08)}
  .leadPreview{padding:8px 0 6px;border-bottom:1px dashed rgba(150,240,31,.3)}
  .leadPreview .lbl{text-align:center}
  .lp-list{display:flex;flex-direction:column;gap:4px;margin-top:6px;font-size:11px}
  .lp-row{display:flex;align-items:center;gap:8px;justify-content:space-between}
  .lp-row .lp-who{display:flex;align-items:center;gap:6px;color:var(--white-dim);overflow:hidden;
                   text-overflow:ellipsis;white-space:nowrap}
  .lp-row.me{color:var(--amber)}
  .lp-row.me .lp-who{color:var(--amber)}
  .lp-row b{font-variant-numeric:tabular-nums}
  .calib-btn{background:none;border:1px solid var(--amber-faint);color:var(--amber);
             font-family:var(--mono);font-size:8.5px;letter-spacing:.12em;padding:0 7px;
             height:24px;border-radius:6px;cursor:pointer;margin-left:4px}
  .calib-btn:hover{border-color:var(--amber)}
  .calib-btn:disabled{opacity:.5;cursor:default}
  .calibbox{margin-top:2px;padding:8px 10px;border:1px dashed rgba(150,240,31,.25);
            border-radius:8px;font-size:10px;color:var(--white-dim)}
  .calibbox .cbar{display:flex;align-items:center;gap:6px;margin:3px 0}
  .calibbox .cbar .cn{width:52px;color:var(--white-dim);font-size:9px}
  .calibbox .cbar .ctrack{flex:1;height:8px;background:var(--panel2,#151a23);border-radius:2px;overflow:hidden}
  .calibbox .cbar .cfill{height:100%;background:var(--amber-faint);border-radius:2px}
  .calibbox .cbar.best .cfill{background:var(--amber);box-shadow:0 0 6px rgba(150,240,31,.5)}
  .calibbox .cbar .cval{width:60px;text-align:right;font-size:9px;color:var(--amber)}
  .calibbox .creco{margin-top:6px;color:var(--amber);font-size:10px}
  /* Données */
  .rows{display:flex;flex-direction:column;gap:7px;font-size:12px}
  .row{display:flex;justify-content:space-between;align-items:baseline}
  .row .k{color:var(--white-dim);font-size:9.5px;letter-spacing:.22em}
  .row .v{font-variant-numeric:tabular-nums}
  .row .v .dim{color:var(--white-dim)}
  .tctl{display:flex;align-items:center;gap:10px}
  .tbtn{background:none;border:1px solid var(--amber-faint);color:var(--amber);
        font-family:var(--mono);width:24px;height:24px;border-radius:6px;
        font-size:14px;line-height:1;cursor:pointer}
  .tbtn:hover{border-color:var(--amber)}
  .tbtn:focus-visible{outline:1px solid var(--amber);outline-offset:2px}
  .odds{font-size:10px;line-height:1.65;color:var(--white-dim)}
  .odds b{color:var(--amber);font-weight:600}
  .console{flex:1;min-height:74px;overflow-y:auto;overflow-x:hidden;
           font-size:9.5px;line-height:1.8;color:var(--white);
           scrollbar-width:thin;scrollbar-color:rgba(150,240,31,.35) transparent}
  .console::-webkit-scrollbar{width:5px}
  .console::-webkit-scrollbar-track{background:transparent}
  .console::-webkit-scrollbar-thumb{background:rgba(150,240,31,.3);border-radius:3px}
  .console::-webkit-scrollbar-thumb:hover{background:rgba(150,240,31,.55)}
  .conin{min-height:100%;display:flex;flex-direction:column;justify-content:flex-end}
  .console .t{color:var(--white-faint);margin-right:6px}
  .console .ok,.console .block{color:var(--amber);text-shadow:var(--glow)}
  .console .share{color:#ff9d2e}
  .console .best{color:#ffc233;text-shadow:0 0 10px rgba(255,194,51,.4)}
  .console .warn{color:#ffd166}
  .console .err{color:#ff6a78}
  
  .foot{text-align:center;padding-top:9px;font-size:8.5px;letter-spacing:.3em;color:#626c7e}
  .device.pip-actif{display:none}
  .pip-placeholder{display:none;max-width:380px;margin:60px auto;text-align:center;
                    font-family:var(--mono);color:var(--white-dim);padding:24px}
  .pip-placeholder b{color:var(--amber)}
  .pip-placeholder button{margin-top:16px;background:none;border:1px solid var(--amber-faint);
                           color:var(--amber);font-family:var(--mono);font-size:11px;
                           padding:9px 18px;border-radius:8px;cursor:pointer}
  .pip-placeholder button:hover{border-color:var(--amber);background:rgba(150,240,31,.08)}
  @media(prefers-reduced-motion:no-preference){
    .led.on{animation:pulse 3s ease-in-out infinite}
    @keyframes pulse{50%{box-shadow:0 0 12px var(--led-ok)}}
  }
  .don-btn{color:#ff4d6a;border-color:rgba(255,77,106,.35)}
  .don-btn:hover{border-color:#ff4d6a;background:rgba(255,77,106,.1)}
  @media(prefers-reduced-motion:no-preference){
    .don-btn{animation:donbeat 1.8s ease-in-out infinite}
    @keyframes donbeat{
      0%,100%{transform:scale(1)}
      14%{transform:scale(1.28)}
      28%{transform:scale(1)}
      42%{transform:scale(1.2)}
      56%{transform:scale(1)}
    }
  }
</style></head><body>
<div id="pipPlaceholder" class="pip-placeholder">
  💚 Le panneau flottant est actif.<br>
  Il continue de tourner même si tu fermes ou mets de côté cette fenêtre.<br>
  <button onclick="fermerModeMini()">Revenir au dashboard complet</button>
</div>
<div class="device">
  <div id="confettiZone" aria-hidden="true"></div>
  <div class="plate">
    <div class="led" id="led"></div>
    <img class="brand-logo" src="data:image/png;base64,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" alt="AXECUBE">
    <div class="serial" id="serial">—</div>
    <div class="icon-group">
      <button class="copy-btn" id="copybtn" onclick="copierAdresse()" title="Copier l'adresse">⧉</button>
      <button class="copy-btn" id="notifbtn" onclick="basculeNotif()" title="${t.ui.notif}">🔔</button>
      <button class="copy-btn" id="minibtn" onclick="modeMini()" title="${t.ui.pipTitre}">▣</button>
    </div>
    <div class="plate-right">
      <div class="netsel" id="netsel">
        <button class="netBtnActuel" id="netBtnActuel" type="button">BTC</button>
        <select class="netSelect" id="netSelect" aria-label="Choisir le réseau"></select>
      </div>
      <button class="mini-btn don-btn" onclick="ouvrirPopupDon()" title="Soutenir le projet">❤️</button>
      <div class="btns">
        <button class="mini-btn" id="pausebtn" onclick="basculerMinage()" title="Mettre en pause / reprendre le minage">⏸</button>
        <button class="mini-btn" id="detailsbtn" onclick="location.href='/details'+Q" title="${t.ui.details}">☰</button>
        <button class="mini-btn" id="sharebtn" onclick="carteRecord()" title="${t.ui.partager}">⤴</button>
        <button class="mini-btn" id="phonebtn" onclick="lienTelephone()" title="Lien pour votre téléphone" style="display:none">📱</button>
        <button class="mini-btn" id="exportbtn" onclick="exporterLogs()" title="Exporter les logs (.txt)">⬇</button>
        <button class="mini-btn" onclick="location.href='/decouvrir'+Q" title="Découvrir le minage Bitcoin">?</button>
        <button class="mini-btn" onclick="recupererRecompenses()" title="Récupérer les images des paliers gagnés">🎁</button>
        <button class="mini-btn" onclick="ouvrirPopupParametres()" title="Paramètres" style="font-size:19px">⚙</button>
        <button class="mini-btn" onclick="location.href='/visite'+Q" title="Visite guidée interactive">🧭</button>
      </div>
    </div>
  </div>
  <div class="screen">
    <div class="hero">
      <div class="lbl">${t.ui.hashrate}</div>
      <div class="hr" id="hashrate">0 H/s</div>
      <div class="sub" id="sub">${t.ui.demarrage}</div>
      <div class="cores" id="cores"></div>
      <div class="blocBadge" title="Blocs potentiellement trouvés depuis le début">
        <div class="n" id="blocsN">0</div>
        <div class="l">BLOC</div>
      </div>
    </div>
    <canvas id="spark" width="360" height="44"></canvas>
    <div class="record">
      <div class="lbl">${t.ui.record}</div>
      <div class="val"><span id="best">—</span><span class="cup-big">🏆</span><span class="planete" id="planeteBtn" onclick="location.href=LEADER_URL+(LEADER_URL.includes('?')?'&':'?')+'back='+encodeURIComponent(location.origin+'/details'+Q)" title="Voir le classement communautaire" style="display:none">🌍</span><span class="planete" id="boutiqueBtn" onclick="window.open(LEADER_URL+'/boutique.html?machineId='+encodeURIComponent(MACHINE_ID),'_blank')" title="Découvrir la collection Premium" style="display:none">🛒</span></div>
    </div>
    <button class="badgeChip" id="badgeChip" style="display:none" onclick="ouvrirPopupPalier(PALIERS_CLIENT[dernierPalierIdx],true)">
      <span id="badgeChipIcone">🥉</span>
      <span id="badgeChipTexte">BRONZE</span>
      <span class="badgeChipVoir">voir ›</span>
    </button>
    <div class="leadPreview" id="leadPreview" style="display:none">
      <div class="lbl">🏆 TOP 3 AXECUBE <span id="lp_moi" style="color:var(--amber-dim);font-weight:normal"></span></div>
      <div id="lp_list" class="lp-list"></div>
    </div>
    <div class="screenScroll">
    <div class="rows">
      <div class="row"><span class="k">${t.ui.shares}</span>
        <span class="v"><span id="acc">0</span> <span class="dim">${t.ui.acceptes} ·</span> <span id="rej">0</span> <span class="dim">${t.ui.rejetes}</span></span></div>
      <div class="row" style="margin-top:-4px">
        <span class="k" style="opacity:0"></span>
        <span class="v" style="font-size:9px;color:var(--white-dim);font-weight:normal" id="depuis"></span></div>
      <div class="row"><span class="k">${t.ui.difficulte}</span>
        <span class="v"><span id="pdiff">—</span> <span class="dim">${t.ui.poolMot} ·</span> <span id="ndiff">—</span> <span class="dim">${t.ui.reseauMot}</span></span></div>
      <div class="row"><span class="k">POOL</span>
        <span class="v" id="poolNom" style="font-size:11px">—</span></div>
      <div class="row" style="margin-top:-4px" id="poolAdapteLigne">
        <span class="k" style="opacity:0"></span>
        <span class="v" id="poolAdapte" style="font-size:9px;font-weight:normal"></span></div>
      <div class="row"><span class="k">🌐 RÉSEAU LOCAL</span>
        <span class="v" id="swarmResume" style="font-size:11px">—</span></div>
      <div class="row" style="margin-top:-4px">
        <span class="k" style="opacity:0"></span>
        <span class="v" style="font-size:9px;font-weight:normal">
          <a id="poolStatsLien" href="#" target="_blank" rel="noopener"
             style="color:var(--amber-dim);text-decoration:none;display:none">🔗 Voir mes stats sur le pool ›</a>
        </span></div>
      <div class="row" id="statsPoolLigne" style="display:none;margin-top:-2px">
        <span class="k" style="opacity:0"></span>
        <span class="v" id="statsPoolTexte" style="font-size:9px;color:var(--white-dim);font-weight:normal"></span></div>
      <div class="row"><span class="k">${t.ui.bloc}</span>
        <span class="v"><span id="height">—</span> <span class="dim" id="blockage"></span></span></div>
      <div class="row"><span class="k">${t.ui.reseau}</span>
        <span class="v" id="nethash">—</span></div>
      <div class="row"><span class="k">${t.ui.coeurs}</span>
        <span class="v tctl">
          <button class="tbtn" onclick="chgThreads(-1)">−</button>
          <span id="threads">—</span>
          <button class="tbtn" onclick="chgThreads(1)">+</button>
          <button class="calib-btn" id="calibbtn" onclick="lancerCalib()" title="${t.ui.calibExplique}">${t.ui.calibrerCourt}</button>
        </span></div>
      <div class="calibbox" id="calibbox" style="display:none"></div>
      <div class="row"><span class="k">${t.ui.uptime}</span>
        <span class="v" id="uptime">—</span></div>
      <div class="row" id="rowthr"><span class="k">${t.ui.throttle}
        <span title="Échelle macOS (du meilleur au pire) :&#10;🟢 Nominal — aucune contrainte, pleine puissance&#10;🟡 Fair/Moderate — léger réchauffement, impact quasi invisible&#10;🔴 Heavy — le système réduit activement la fréquence pour gérer la chaleur, perte de perf réelle&#10;🔴 Trapping — restrictions plus agressives&#10;🔴 Sleeping — niveau extrême, mise en veille forcée de composants" style="cursor:help;opacity:.6">ⓘ</span></span>
        <span class="v" id="thr">—</span></div>
      <div class="row" style="margin-top:-4px" id="thrExpliqueLigne">
        <span class="k" style="opacity:0"></span>
        <span class="v" id="thrExplique" style="font-size:9px;color:var(--white-dim);font-weight:normal"></span></div>
      <div class="row" id="rowbtc" style="display:none"><span class="k">${t.ui.cours}</span>
        <span class="v" id="btcprice">—</span></div>
      <div class="row" id="rowpay" style="display:none"><span class="k">${t.ui.paiement}</span>
        <span class="v" id="pay">—</span></div>
    </div>
    <div class="odds" id="odds">${t.ui.calibrage}</div>
    <div class="odds" id="avisFractal" style="display:none;color:#ffd166"></div>
    <div class="console" id="console"><div class="conin" id="conin"></div></div>
    <a id="classementBandeau" href="#" onclick="location.href='/details'+Q;return false"
       style="display:none;text-align:center;padding:10px;margin-top:8px;
       border:1px solid var(--amber-faint);border-radius:8px;text-decoration:none;
       color:var(--amber);font-size:11px;background:rgba(150,240,31,.05)">
       🏆 Voir le classement communautaire complet ›
    </a>
    </div>
  </div>
  <div class="foot">${t.ui.pied}</div>
</div>
<div id="palierPopup" class="palierPopup" onclick="if(event.target===this)fermerPopupPalier()">
  <div class="palierPopupCard">
    <div class="palierImgWrap">
      <img id="palierPopupImg" src="" alt="">
    </div>
    <div class="palierRecordBandeau">
      <div class="palierOverlayDiff" id="palierOverlayDiff">—</div>
      <div class="palierOverlayDate" id="palierOverlayDate"></div>
    </div>
    <div class="palierPopupTitre" id="palierPopupTitre"></div>
    <div class="palierPopupNext" id="palierPopupNext"></div>
    <button class="palierPopupFermer" onclick="fermerPopupPalier()">Continuer le minage</button>
  </div>
</div>
<div id="donPopup" class="donPopup" onclick="if(event.target===this)fermerPopupDon()">
  <div class="donPopupCard">
    <div class="donPopupTitre">💚 Soutenir AXECUBE</div>
    <div class="donPopupTexte">
      AXECUBE est gratuit, sans publicité, et le restera toujours. Si ce petit mineur t'a
      fait sourire — un nouveau record, un badge débloqué, le frisson du tirage — c'est tout
      ce qu'on lui demandait. Un don libre (même minime) aide simplement à financer le temps
      passé à le construire et à l'améliorer. Et qui sait — peut-être qu'un jour, ce sera
      <b style="color:var(--amber)">toi</b> qui décroches le bloc entier et ses ~3,125 BTC.
      Aucune obligation, aucune pression : juste une porte ouverte pour ceux qui veulent dire
      merci autrement qu'en mots. Pensez à nous 🙂
    </div>
    <div class="donPopupAdresse"><span id="donPopupAdr" title="${DON_BTC_ADRESSE}">${DON_BTC_ADRESSE}</span>
      <button onclick="navigator.clipboard.writeText(${JSON.stringify(DON_BTC_ADRESSE)});this.textContent='✓ copié'">copier</button>
    </div>
    <div class="donPopupActions">
      <button class="donPopupFermer" onclick="location.href='/soutenir'+Q" style="color:var(--amber);border-color:var(--amber-faint)">en savoir plus ›</button>
      <button class="donPopupFermer" onclick="fermerPopupDon()">Fermer</button>
    </div>
  </div>
</div>
<div id="qrPopup" class="donPopup" onclick="if(event.target===this)fermerPopupQR()">
  <div class="donPopupCard">
    <div class="donPopupTitre">📱 Voir AXECUBE sur votre téléphone</div>
    <div id="qrOnglets" style="display:none;gap:6px;margin-top:8px">
      <button id="qrOngletLocal" class="donPopupFermer actif" style="flex:1;font-size:11px" onclick="afficherQR(lanCourant.ip,'local')">🏠 Réseau local</button>
      <button id="qrOngletTailscale" class="donPopupFermer" style="flex:1;font-size:11px" onclick="afficherQR(lanCourant.ipTailscale,'tailscale')">🌐 Tailscale (partout)</button>
    </div>
    <div class="donPopupTexte" id="qrTexteExplication" style="margin-top:10px">
      Scannez ce code avec l'appareil photo de votre téléphone (même réseau Wi-Fi que
      cet ordinateur). Le lien reste strictement local à votre réseau -- rien n'est
      envoyé sur internet pour générer ce code, tout est calculé ici, dans le navigateur.
    </div>
    <div id="qrConteneur" style="display:flex;justify-content:center;padding:16px;background:#fff;border-radius:10px;margin-top:10px"></div>
    <div class="donPopupAdresse" style="margin-top:10px"><span id="qrLienTexte" style="word-break:break-all;font-size:11px"></span>
      <button onclick="const t=document.getElementById('qrLienTexte').textContent;navigator.clipboard.writeText(t);this.textContent='✓ copié'">copier</button>
    </div>
    <div class="donPopupActions">
      <button class="donPopupFermer" onclick="fermerPopupQR()">Fermer</button>
    </div>
  </div>
</div>
<div id="paramPopup" class="donPopup" onclick="if(event.target===this)fermerPopupParametres()">
  <div class="donPopupCard">
    <div class="donPopupTitre">⚙ Paramètres</div>
    <div class="donPopupTexte">
      Le badge "BLOC" (en haut à droite du taux de hash) pulse en continu et joue une petite
      fanfare dès qu'un bloc est potentiellement trouvé. Le bouton ci-dessous rejoue cette
      célébration à titre d'aperçu, <b style="color:var(--amber)">sans jamais toucher</b> à
      tes vraies statistiques ni au compteur réel de blocs.
    </div>
    <div class="donPopupActions">
      <button class="donPopupFermer" onclick="testerCelebrationBloc()" style="color:var(--amber);border-color:var(--amber-faint)">🎉 Simuler un bloc trouvé (test)</button>
    </div>
    <div class="donPopupTexte" style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
      <b style="color:var(--amber)">🌡️ Contrôle thermique automatique</b> — réduit les cœurs
      actifs si une vraie sonde de température détecte une surchauffe, puis les remonte
      une fois refroidi. <span id="thermiqueEtat" style="color:var(--white-dim)">…</span>
      <div style="color:var(--mut);font-size:11px;margin-top:6px">
        ⚠️ Si tu le désactives, ça ne dure QUE pour cette session -- redevient actif
        automatiquement au prochain démarrage d'AXECUBE. Jamais bloqué en mode désactivé
        d'une session à l'autre, par sécurité.
      </div>
    </div>
    <div class="donPopupActions">
      <button class="donPopupFermer" id="btnThermiqueToggle" onclick="basculerControleThermique()" style="color:var(--amber);border-color:var(--amber-faint)">…</button>
    </div>
    <div class="donPopupTexte" style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
      <b style="color:var(--amber)">🛒 Gestion Boutique Premium (admin)</b> — définis le
      statut de vente d'une pièce de la collection (gratuit / à venir / achat + remise),
      directement depuis ta machine. Nécessite ton mot de passe admin (configuré côté
      Netlify).
      <div style="color:var(--mut);font-size:10.5px;margin-top:8px;line-height:1.5">
        ⚠️ Le champ ci-dessous attend l'<b style="color:var(--white-dim)">identifiant technique du fichier</b>
        (celui utilisé pour le nom de fichier, ex: <code style="color:var(--amber)">machine-51</code>) --
        <b>pas</b> le nom d'affichage (ex: "Aurora Cyber" ne fonctionnera pas). Minuscules,
        chiffres et tirets uniquement, aucun espace.
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:10px">
        <input type="text" id="adminItemId" placeholder="ex: machine-51 (pas le nom d'affichage)"
          oninput="this.style.borderColor = /^[a-z0-9-]*$/.test(this.value) ? 'var(--line)' : '#e05a5a'"
          style="background:var(--panel2);border:1px solid var(--line);color:var(--white);padding:7px 9px;border-radius:6px;font-family:inherit;font-size:11px">
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <select id="adminStatut" onchange="basculerChampsAdminPrix()"
            style="background:var(--panel2);border:1px solid var(--line);color:var(--white);padding:7px 9px;border-radius:6px;font-family:inherit;font-size:11px">
            <option value="a_venir">À venir</option>
            <option value="gratuit">Gratuit</option>
            <option value="achat">Achat</option>
          </select>
          <div id="adminChampsPrix" style="display:none;gap:6px">
            <input type="number" id="adminPrix" placeholder="Prix €" min="0"
              style="width:80px;background:var(--panel2);border:1px solid var(--line);color:var(--white);padding:7px 9px;border-radius:6px;font-family:inherit;font-size:11px">
            <input type="number" id="adminRemise" placeholder="Remise %" min="0" max="90"
              style="width:80px;background:var(--panel2);border:1px solid var(--line);color:var(--white);padding:7px 9px;border-radius:6px;font-family:inherit;font-size:11px">
          </div>
        </div>
        <input type="password" id="adminMotDePasse" placeholder="Mot de passe admin"
          style="background:var(--panel2);border:1px solid var(--line);color:var(--white);padding:7px 9px;border-radius:6px;font-family:inherit;font-size:11px">
      </div>
      <div id="adminBoutiqueEtat" style="font-size:11px;margin-top:8px;min-height:16px"></div>
    </div>
    <div class="donPopupActions">
      <button class="donPopupFermer" onclick="enregistrerOffreAdmin()" style="color:var(--amber);border-color:var(--amber-faint)">💾 Enregistrer cette offre</button>
    </div>
    <div class="donPopupTexte" style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
      <b style="color:var(--amber)">🎨 Skin Premium (ma machine)</b> — remplace uniquement
      l'apparence de <b style="color:var(--white-dim)">ta</b> carte affichée ici. Ton vrai
      palier Genèse (cube gagné, couleur, effet arc-en-ciel) n'est <b style="color:var(--amber)">jamais
      modifié</b> par ce choix, et ta machine des récompenses continue de figurer normalement
      sur "Mes récompenses gagnées". Choisis parmi les pièces que tu <b style="color:var(--white-dim)">possèdes
      réellement</b> (obtenues via le bouton 🛒 boutique) -- l'image n'est <b style="color:var(--amber)">jamais
      enregistrée sur ton disque</b>, elle reste chargée à la demande depuis le service en
      ligne, qui revérifie ta possession à chaque fois (utile le jour où tu revends la pièce).
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
        <select id="skinPremiumSelect"
          style="flex:1;min-width:160px;background:var(--panel2);border:1px solid var(--line);color:var(--white);padding:7px 9px;border-radius:6px;font-family:inherit;font-size:11px">
          <option value="">Aucun (palier Genèse)</option>
        </select>
      </div>
      <div id="skinPremiumEtat" style="font-size:11px;margin-top:8px;min-height:16px;color:var(--white-dim)"></div>
    </div>
    <div class="donPopupActions">
      <button class="donPopupFermer" onclick="appliquerSkinPremium()" style="color:var(--amber);border-color:var(--amber-faint)">✨ Activer ce skin</button>
      <button class="donPopupFermer" onclick="retirerSkinPremium()">↩️ Revenir au palier Genèse</button>
    </div>
    <div class="donPopupTexte" style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
      <b style="color:var(--amber)">⚖ Solo Split</b> — uniquement sur SoloPool.com. Dose le
      ratio entre minage solo (jackpot complet) et minage pool (petits paiements réguliers),
      part par part. <span id="soloSplitEtat" style="color:var(--white-dim)"></span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
      <input type="range" id="soloSplitRange" min="0" max="100" value="100" style="flex:1"
        oninput="document.getElementById('soloSplitVal').textContent=this.value+'%'">
      <span id="soloSplitVal" style="font-family:var(--mono);color:var(--amber);min-width:38px;text-align:right">100%</span>
    </div>
    <div class="donPopupActions">
      <button class="donPopupFermer" onclick="appliquerSoloSplit()" style="color:var(--amber);border-color:var(--amber-faint)">Appliquer (relance le mineur)</button>
      <button class="donPopupFermer" onclick="fermerPopupParametres()">Fermer</button>
    </div>
  </div>
</div>
<canvas id="cardcanvas" width="1200" height="675"></canvas>
<div style="display:none">
</div>
<script>
const L=${JSON.stringify(t.ui)};const TOK=${JSON.stringify(jeton || '')};const Q=TOK?('?token='+TOK):'';
function ouvrirPopupDon(){document.getElementById('donPopup').style.display='flex';}
function fermerPopupDon(){document.getElementById('donPopup').style.display='none';}
function ouvrirPopupParametres(){
  document.getElementById('paramPopup').style.display='flex';
  majAffichageThermique();
  chargerSkinPremiumLocal();
}
/** Peuple le sélecteur avec les pièces Premium RÉELLEMENT présentes dans assets/premium/
 *  sur cette machine (jamais une pièce non téléchargée), et présélectionne le skin
 *  actuellement actif s'il y en a un. */
async function chargerSkinPremiumLocal(){
  const sel=document.getElementById('skinPremiumSelect');
  const etat=document.getElementById('skinPremiumEtat');
  if(!sel) return;
  try{
    const [rDispo,rDetails]=await Promise.all([
      fetch('/api/premium-disponibles'+Q).then(r=>r.json()).catch(()=>({items:[]})),
      fetch('/api/details'+Q).then(r=>r.ok?r.json():null).catch(()=>null)
    ]);
    const actif=(rDetails&&rDetails.skinPremiumActif)||'';
    const possedees=(rDispo.items||[]).slice().sort();
    sel.innerHTML='<option value="">Aucun (palier Genèse)</option>'
      +possedees.map(id=>'<option value="'+id+'"'+(id===actif?' selected':'')+'>'+id+'</option>').join('');
    etat.textContent=actif?('Skin actif actuellement : '+actif):'Aucun skin Premium actif -- affichage du palier Genèse normal.';
    etat.style.color=actif?'var(--amber)':'var(--white-dim)';
    if(!possedees.length){
      etat.textContent='Tu ne possèdes aucune pièce Premium pour l\\'instant -- obtiens-en une depuis le bouton 🛒.';
    }
  }catch(e){
    etat.textContent='⚠️ Impossible de charger la liste des pièces Premium.';
    etat.style.color='#e05a5a';
  }
}
async function appliquerSkinPremium(){
  const sel=document.getElementById('skinPremiumSelect');
  const etat=document.getElementById('skinPremiumEtat');
  const id=sel?sel.value:'';
  if(!id){ etat.textContent='Choisis d\\'abord une pièce dans la liste (ou utilise "Revenir au palier Genèse" pour retirer un skin déjà actif).'; etat.style.color='#e0a05a'; return; }
  etat.textContent='⏳ Activation en cours (récupération interne si besoin)...'; etat.style.color='var(--white-dim)';
  try{
    // Une seule route : télécharge en interne (si pas déjà présent) PUIS active --
    // aucun fichier ne passe par le dossier Téléchargements du navigateur.
    const r=await fetch('/api/activer-skin-premium?id='+encodeURIComponent(id)+(Q?'&'+Q.slice(1):''));
    const j=await r.json();
    if(!r.ok||!j.ok){ etat.textContent='⚠️ '+(j.erreur||'échec inconnu'); etat.style.color='#e05a5a'; return; }
    etat.textContent='✅ Skin "'+id+'" activé -- ton vrai palier Genèse n\\'a pas changé.';
    etat.style.color='var(--amber)';
    tick();
  }catch(e){ etat.textContent='⚠️ Erreur réseau.'; etat.style.color='#e05a5a'; }
}
async function retirerSkinPremium(){
  const etat=document.getElementById('skinPremiumEtat');
  etat.textContent='⏳ Retrait en cours...'; etat.style.color='var(--white-dim)';
  try{
    const r=await fetch('/api/skin-premium?id='+(Q?'&'+Q.slice(1):''));
    const j=await r.json();
    if(!r.ok||!j.ok){ etat.textContent='⚠️ '+(j.erreur||'échec inconnu'); etat.style.color='#e05a5a'; return; }
    etat.textContent='↩️ Retour à l\\'affichage automatique du palier Genèse.';
    etat.style.color='var(--white-dim)';
    const sel=document.getElementById('skinPremiumSelect'); if(sel) sel.value='';
    tick();
  }catch(e){ etat.textContent='⚠️ Erreur réseau.'; etat.style.color='#e05a5a'; }
}
async function recupererRecompenses(){
  const btn=[...document.querySelectorAll('.mini-btn')].find(b=>b.title==='Récupérer les images des paliers gagnés');
  const texteOriginal=btn?btn.textContent:'';
  if(btn){btn.textContent='⏳';btn.disabled=true;}
  try{
    const r=await fetch('/api/recuperer-recompenses'+Q);
    const j=await r.json();
    if(!j.ok){ alert('Erreur : '+(j.erreur||'inconnue')); return; }
    if(j.niveauGagne<1){
      alert('Aucun palier atteint pour l\\'instant -- continuez à miner !');
    } else if(j.telecharges.length){
      alert('🎁 '+j.telecharges.length+' image(s) récupérée(s) avec succès !\\n\\n'+j.telecharges.join('\\n')
        +(j.echecs.length?'\\n\\n⚠️ Échecs :\\n'+j.echecs.join('\\n'):''));
    } else if(j.echecs.length){
      alert('⚠️ Aucune nouvelle image récupérée.\\n\\nÉchecs :\\n'+j.echecs.join('\\n'));
    } else {
      alert('✅ Toutes vos récompenses sont déjà installées (palier '+j.niveauGagne+').');
    }
  }catch(e){
    alert('Erreur réseau, réessayez.');
  }finally{
    if(btn){btn.textContent=texteOriginal||'🎁';btn.disabled=false;}
  }
}
function majAffichageThermique(){
  const actif = dernierStats ? (dernierStats.controleThermiqueActif!==false) : true;
  const etatEl=document.getElementById('thermiqueEtat');
  const btnEl=document.getElementById('btnThermiqueToggle');
  if(!etatEl||!btnEl) return;
  etatEl.textContent = actif ? '— actuellement ACTIF.' : '— actuellement DÉSACTIVÉ pour cette session.';
  btnEl.textContent = actif ? '🌡️ Désactiver pour cette session' : '🌡️ Réactiver maintenant';
}
async function basculerControleThermique(){
  const actif = dernierStats ? (dernierStats.controleThermiqueActif!==false) : true;
  const route = actif ? '/api/thermique-desactiver' : '/api/thermique-activer';
  try{
    const r=await fetch(route+Q);
    const j=await r.json();
    if(dernierStats) dernierStats.controleThermiqueActif = j.controleThermiqueActif;
    majAffichageThermique();
  }catch(e){}
}
function basculerChampsAdminPrix(){
  const statut=document.getElementById('adminStatut').value;
  document.getElementById('adminChampsPrix').style.display = statut==='achat' ? 'flex' : 'none';
}
// Mémorisé juste le temps de cette page ouverte -- jamais écrit sur disque, jamais
// dans localStorage. Rouvrir AXECUBE (ou recharger la page) le fait oublier, par sécurité.
let _motDePasseAdminSession='';
async function enregistrerOffreAdmin(){
  const etatEl=document.getElementById('adminBoutiqueEtat');
  if(!LEADER_URL){ etatEl.textContent='Classement communautaire non configuré.'; etatEl.style.color='#e05a5a'; return; }
  const itemId=document.getElementById('adminItemId').value.trim();
  const statut=document.getElementById('adminStatut').value;
  const prix=document.getElementById('adminPrix').value;
  const remise=document.getElementById('adminRemise').value;
  const mdpSaisi=document.getElementById('adminMotDePasse').value;
  const motDePasse = mdpSaisi || _motDePasseAdminSession;
  if(!itemId){ etatEl.textContent='Identifiant de pièce requis.'; etatEl.style.color='#e05a5a'; return; }
  if(!/^[a-z0-9-]+$/i.test(itemId)){
    etatEl.textContent='❌ Identifiant invalide -- utilise le nom technique du fichier (ex: machine-51), pas le nom d\\'affichage.';
    etatEl.style.color='#e05a5a';
    return;
  }
  if(!motDePasse){ etatEl.textContent='Mot de passe admin requis.'; etatEl.style.color='#e05a5a'; return; }
  etatEl.textContent='Enregistrement…'; etatEl.style.color='var(--white-dim)';
  try{
    const r=await fetch(LEADER_URL+'/.netlify/functions/admin-offres', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({motDePasse, itemId, statut, prix, remise})
    });
    const j=await r.json();
    if(j.ok){
      _motDePasseAdminSession=motDePasse; // évite de la ressaisir pour la prochaine pièce, cette session
      document.getElementById('adminMotDePasse').value='';
      etatEl.textContent='✅ Enregistré : '+itemId+' → '+statut;
      etatEl.style.color='var(--amber)';
    } else {
      etatEl.textContent='❌ '+(j.erreur||'erreur inconnue');
      etatEl.style.color='#e05a5a';
    }
  }catch(e){
    etatEl.textContent='❌ Erreur réseau.';
    etatEl.style.color='#e05a5a';
  }
}
function fermerPopupParametres(){document.getElementById('paramPopup').style.display='none';}
// Palette vive et lisible sur fond sombre -- couleurs du thème (ambre) + quelques teintes
// franches pour que ça "pète" sans jurer avec le reste du dashboard.
const COULEURS_CONFETTI=['#96f01f','#ffb020','#ff5d8f','#39c0ff','#c084fc','#ffffff'];
/** Fait tomber une pluie de confettis depuis le haut de la carte machine, avec rotation et
 *  léger balancement horizontal aléatoires par pièce -- purement décoratif (CSS anime tout,
 *  le JS ne fait que poser les pièces avec des valeurs aléatoires puis les retire après). */
function lancerConfettis(){
  const zone=document.getElementById('confettiZone');
  if(!zone) return;
  const N=48;
  for(let i=0;i<N;i++){
    const p=document.createElement('div');
    p.className='confettiPiece';
    const taille=(6+Math.random()*7).toFixed(1)+'px';
    const x=(Math.random()*100).toFixed(1)+'%';
    const derive=Math.round((Math.random()-0.5)*140)+'px'; // léger balancement gauche/droite
    const chute=Math.round(220+Math.random()*260)+'px'; // hauteur de chute, variable
    const tours=Math.round(360*(2+Math.random()*3)*(Math.random()<0.5?-1:1))+'deg';
    const dur=(1.4+Math.random()*1.1).toFixed(2)+'s';
    const delai=(Math.random()*0.5).toFixed(2)+'s';
    const coul=COULEURS_CONFETTI[Math.floor(Math.random()*COULEURS_CONFETTI.length)];
    p.style.cssText='--taille:'+taille+';--x:'+x+';--derive:'+derive+';--chute:'+chute
      +';--tours:'+tours+';--dur:'+dur+';--delai:'+delai+';--coul:'+coul;
    zone.appendChild(p);
    // Nettoie chaque pièce une fois son animation terminée -- évite d'accumuler des
    // éléments morts dans le DOM si plusieurs blocs sont trouvés coup sur coup.
    const dureeMs=(parseFloat(dur)+parseFloat(delai))*1000+100;
    setTimeout(()=>p.remove(), dureeMs);
  }
}
let derniereCelebrationBloc=0;
let confettiInterval=null;
function celebrerBloc(permanent){
  const badge=document.querySelector('.blocBadge');
  if(!badge)return;
  if(permanent)badge.classList.add('trouve');
  // La classe "flash" n'est plus jamais retirée -- le clignotement (blocPulse, déjà en
  // boucle infinie dans le CSS tant que la classe est présente) continue donc pour de bon,
  // jusqu'à ce que la page soit rechargée ou qu'on la quitte.
  badge.classList.add('flash');
  lancerConfettis();
  [0,300,600].forEach(d=>setTimeout(()=>bip(1320,0.5),d));
  // Pluie continue : une nouvelle salve toutes les ~900ms, indéfiniment -- un seul
  // intervalle actif à la fois même si celebrerBloc() est rappelée (plusieurs blocs
  // trouvés coup sur coup, ou test relancé).
  if(!confettiInterval){
    confettiInterval=setInterval(lancerConfettis, 900);
  }
}
function testerCelebrationBloc(){ fermerPopupParametres(); celebrerBloc(false); }
async function appliquerSoloSplit(){
  const n=document.getElementById('soloSplitRange').value;
  if(!confirm('Relancer AXECUBE avec Solo Split à '+n+'% ?'))return;
  fermerPopupParametres();
  try{await fetch('/api/solo-split?n='+n+(Q?'&token='+TOK:''));}catch(e){}
}
const LEADER_URL=${JSON.stringify(leaderboardUrl || '')};
const MACHINE_ID=${JSON.stringify(machineId || '')};
const hist=[];let curThreads=0,maxThreads=1;let pipWin=null,pipDoc=null;let changementEnCours=false;
let adresseCourante='',lanCourant=null;
function exporterLogs(){
  if(!dernierStats||!dernierStats.log||!dernierStats.log.length){
    alert('Aucun log disponible pour le moment.');return;
  }
  const lignes=dernierStats.log.map(e=>{
    const h=new Date(e.t).toLocaleString('fr-FR');
    return '['+h+'] '+(e.msg||'');
  });
  const contenu='AXECUBE — export des logs\\n'+new Date().toLocaleString('fr-FR')+'\\n'+'='.repeat(40)+'\\n\\n'+lignes.join('\\n');
  const blob=new Blob([contenu],{type:'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download='axecube-logs-'+Date.now()+'.txt';
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
let minageActif=true;
async function basculerMinage(){
  const btn=document.getElementById('pausebtn');
  const cible=!minageActif;
  if(!cible){
    if(!confirm('Mettre le minage en pause ? Le calcul s\\'arrête jusqu\\'à ce que vous le repreniez.'))return;
  }
  const r=await(await fetch('/api/minage?actif='+(cible?1:0)+Q.replace('?','&'))).json();
  minageActif=r.actif;
  btn.textContent=minageActif?'⏸':'▶';
  btn.classList.toggle('on',!minageActif);
  btn.title=minageActif?'Mettre en pause le minage':'Reprendre le minage';
}
async function copierAdresse(){
  if(!adresseCourante)return;
  const btn=document.getElementById('copybtn');
  try{
    await navigator.clipboard.writeText(adresseCourante);
    btn.textContent='✓';btn.classList.add('ok');
    setTimeout(()=>{btn.textContent='⧉';btn.classList.remove('ok');},1500);
  }catch(e){
    prompt('Copiez votre adresse :',adresseCourante);
  }
}
// Bibliothèque QR Code -- qrcode-generator (Kazuhiko Arase, MIT), intégrée telle
// quelle (minifiée) pour générer le QR code du lien téléphone ENTIÈREMENT en local,
// sans jamais envoyer le lien (qui contient le token d'accès) à un service tiers.
var qrcode=function(){var t=function(t,r){var e=t,n=g[r],o=null,i=0,a=null,u=[],f={},c=function(t,r){o=function(t){for(var r=new Array(t),e=0;e<t;e+=1){r[e]=new Array(t);for(var n=0;n<t;n+=1)r[e][n]=null}return r}(i=4*e+17),l(0,0),l(i-7,0),l(0,i-7),s(),h(),d(t,r),e>=7&&v(t),null==a&&(a=p(e,n,u)),w(a,r)},l=function(t,r){for(var e=-1;e<=7;e+=1)if(!(t+e<=-1||i<=t+e))for(var n=-1;n<=7;n+=1)r+n<=-1||i<=r+n||(o[t+e][r+n]=0<=e&&e<=6&&(0==n||6==n)||0<=n&&n<=6&&(0==e||6==e)||2<=e&&e<=4&&2<=n&&n<=4)},h=function(){for(var t=8;t<i-8;t+=1)null==o[t][6]&&(o[t][6]=t%2==0);for(var r=8;r<i-8;r+=1)null==o[6][r]&&(o[6][r]=r%2==0)},s=function(){for(var t=B.getPatternPosition(e),r=0;r<t.length;r+=1)for(var n=0;n<t.length;n+=1){var i=t[r],a=t[n];if(null==o[i][a])for(var u=-2;u<=2;u+=1)for(var f=-2;f<=2;f+=1)o[i+u][a+f]=-2==u||2==u||-2==f||2==f||0==u&&0==f}},v=function(t){for(var r=B.getBCHTypeNumber(e),n=0;n<18;n+=1){var a=!t&&1==(r>>n&1);o[Math.floor(n/3)][n%3+i-8-3]=a}for(n=0;n<18;n+=1){a=!t&&1==(r>>n&1);o[n%3+i-8-3][Math.floor(n/3)]=a}},d=function(t,r){for(var e=n<<3|r,a=B.getBCHTypeInfo(e),u=0;u<15;u+=1){var f=!t&&1==(a>>u&1);u<6?o[u][8]=f:u<8?o[u+1][8]=f:o[i-15+u][8]=f}for(u=0;u<15;u+=1){f=!t&&1==(a>>u&1);u<8?o[8][i-u-1]=f:u<9?o[8][15-u-1+1]=f:o[8][15-u-1]=f}o[i-8][8]=!t},w=function(t,r){for(var e=-1,n=i-1,a=7,u=0,f=B.getMaskFunction(r),c=i-1;c>0;c-=2)for(6==c&&(c-=1);;){for(var g=0;g<2;g+=1)if(null==o[n][c-g]){var l=!1;u<t.length&&(l=1==(t[u]>>>a&1)),f(n,c-g)&&(l=!l),o[n][c-g]=l,-1==(a-=1)&&(u+=1,a=7)}if((n+=e)<0||i<=n){n-=e,e=-e;break}}},p=function(t,r,e){for(var n=A.getRSBlocks(t,r),o=b(),i=0;i<e.length;i+=1){var a=e[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var u=0;for(i=0;i<n.length;i+=1)u+=n[i].dataCount;if(o.getLengthInBits()>8*u)throw"code length overflow. ("+o.getLengthInBits()+">"+8*u+")";for(o.getLengthInBits()+4<=8*u&&o.put(0,4);o.getLengthInBits()%8!=0;)o.putBit(!1);for(;!(o.getLengthInBits()>=8*u||(o.put(236,8),o.getLengthInBits()>=8*u));)o.put(17,8);return function(t,r){for(var e=0,n=0,o=0,i=new Array(r.length),a=new Array(r.length),u=0;u<r.length;u+=1){var f=r[u].dataCount,c=r[u].totalCount-f;n=Math.max(n,f),o=Math.max(o,c),i[u]=new Array(f);for(var g=0;g<i[u].length;g+=1)i[u][g]=255&t.getBuffer()[g+e];e+=f;var l=B.getErrorCorrectPolynomial(c),h=k(i[u],l.getLength()-1).mod(l);for(a[u]=new Array(l.getLength()-1),g=0;g<a[u].length;g+=1){var s=g+h.getLength()-a[u].length;a[u][g]=s>=0?h.getAt(s):0}}var v=0;for(g=0;g<r.length;g+=1)v+=r[g].totalCount;var d=new Array(v),w=0;for(g=0;g<n;g+=1)for(u=0;u<r.length;u+=1)g<i[u].length&&(d[w]=i[u][g],w+=1);for(g=0;g<o;g+=1)for(u=0;u<r.length;u+=1)g<a[u].length&&(d[w]=a[u][g],w+=1);return d}(o,n)};f.addData=function(t,r){var e=null;switch(r=r||"Byte"){case"Numeric":e=M(t);break;case"Alphanumeric":e=x(t);break;case"Byte":e=m(t);break;case"Kanji":e=L(t);break;default:throw"mode:"+r}u.push(e),a=null},f.isDark=function(t,r){if(t<0||i<=t||r<0||i<=r)throw t+","+r;return o[t][r]},f.getModuleCount=function(){return i},f.make=function(){if(e<1){for(var t=1;t<40;t++){for(var r=A.getRSBlocks(t,n),o=b(),i=0;i<u.length;i++){var a=u[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var g=0;for(i=0;i<r.length;i++)g+=r[i].dataCount;if(o.getLengthInBits()<=8*g)break}e=t}c(!1,function(){for(var t=0,r=0,e=0;e<8;e+=1){c(!0,e);var n=B.getLostPoint(f);(0==e||t>n)&&(t=n,r=e)}return r}())},f.createTableTag=function(t,r){t=t||2;var e="";e+='<table style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: "+(r=void 0===r?4*t:r)+"px;",e+='">',e+="<tbody>";for(var n=0;n<f.getModuleCount();n+=1){e+="<tr>";for(var o=0;o<f.getModuleCount();o+=1)e+='<td style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: 0px;",e+=" width: "+t+"px;",e+=" height: "+t+"px;",e+=" background-color: ",e+=f.isDark(n,o)?"#000000":"#ffffff",e+=";",e+='"/>';e+="</tr>"}return e+="</tbody>",e+="</table>"},f.createSvgTag=function(t,r,e,n){var o={};"object"==typeof arguments[0]&&(t=(o=arguments[0]).cellSize,r=o.margin,e=o.alt,n=o.title),t=t||2,r=void 0===r?4*t:r,(e="string"==typeof e?{text:e}:e||{}).text=e.text||null,e.id=e.text?e.id||"qrcode-description":null,(n="string"==typeof n?{text:n}:n||{}).text=n.text||null,n.id=n.text?n.id||"qrcode-title":null;var i,a,u,c,g=f.getModuleCount()*t+2*r,l="";for(c="l"+t+",0 0,"+t+" -"+t+",0 0,-"+t+"z ",l+='<svg version="1.1" xmlns="http://www.w3.org/2000/svg"',l+=o.scalable?"":' width="'+g+'px" height="'+g+'px"',l+=' viewBox="0 0 '+g+" "+g+'" ',l+=' preserveAspectRatio="xMinYMin meet"',l+=n.text||e.text?' role="img" aria-labelledby="'+y([n.id,e.id].join(" ").trim())+'"':"",l+=">",l+=n.text?'<title id="'+y(n.id)+'">'+y(n.text)+"</title>":"",l+=e.text?'<description id="'+y(e.id)+'">'+y(e.text)+"</description>":"",l+='<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>',l+='<path d="',a=0;a<f.getModuleCount();a+=1)for(u=a*t+r,i=0;i<f.getModuleCount();i+=1)f.isDark(a,i)&&(l+="M"+(i*t+r)+","+u+c);return l+='" stroke="transparent" fill="black"/>',l+="</svg>"},f.createDataURL=function(t,r){t=t||2,r=void 0===r?4*t:r;var e=f.getModuleCount()*t+2*r,n=r,o=e-r;return I(e,e,function(r,e){if(n<=r&&r<o&&n<=e&&e<o){var i=Math.floor((r-n)/t),a=Math.floor((e-n)/t);return f.isDark(a,i)?0:1}return 1})},f.createImgTag=function(t,r,e){t=t||2,r=void 0===r?4*t:r;var n=f.getModuleCount()*t+2*r,o="";return o+="<img",o+=' src="',o+=f.createDataURL(t,r),o+='"',o+=' width="',o+=n,o+='"',o+=' height="',o+=n,o+='"',e&&(o+=' alt="',o+=y(e),o+='"'),o+="/>"};var y=function(t){for(var r="",e=0;e<t.length;e+=1){var n=t.charAt(e);switch(n){case"<":r+="&lt;";break;case">":r+="&gt;";break;case"&":r+="&amp;";break;case'"':r+="&quot;";break;default:r+=n}}return r};return f.createASCII=function(t,r){if((t=t||1)<2)return function(t){t=void 0===t?2:t;var r,e,n,o,i,a=1*f.getModuleCount()+2*t,u=t,c=a-t,g={"██":"█","█ ":"▀"," █":"▄","  ":" "},l={"██":"▀","█ ":"▀"," █":" ","  ":" "},h="";for(r=0;r<a;r+=2){for(n=Math.floor((r-u)/1),o=Math.floor((r+1-u)/1),e=0;e<a;e+=1)i="█",u<=e&&e<c&&u<=r&&r<c&&f.isDark(n,Math.floor((e-u)/1))&&(i=" "),u<=e&&e<c&&u<=r+1&&r+1<c&&f.isDark(o,Math.floor((e-u)/1))?i+=" ":i+="█",h+=t<1&&r+1>=c?l[i]:g[i];h+="\\n"}return a%2&&t>0?h.substring(0,h.length-a-1)+Array(a+1).join("▀"):h.substring(0,h.length-1)}(r);t-=1,r=void 0===r?2*t:r;var e,n,o,i,a=f.getModuleCount()*t+2*r,u=r,c=a-r,g=Array(t+1).join("██"),l=Array(t+1).join("  "),h="",s="";for(e=0;e<a;e+=1){for(o=Math.floor((e-u)/t),s="",n=0;n<a;n+=1)i=1,u<=n&&n<c&&u<=e&&e<c&&f.isDark(o,Math.floor((n-u)/t))&&(i=0),s+=i?g:l;for(o=0;o<t;o+=1)h+=s+"\\n"}return h.substring(0,h.length-1)},f.renderTo2dContext=function(t,r){r=r||2;for(var e=f.getModuleCount(),n=0;n<e;n++)for(var o=0;o<e;o++)t.fillStyle=f.isDark(n,o)?"black":"white",t.fillRect(o*r,n*r,r,r)},f};t.stringToBytes=(t.stringToBytesFuncs={default:function(t){for(var r=[],e=0;e<t.length;e+=1){var n=t.charCodeAt(e);r.push(255&n)}return r}}).default,t.createStringToBytes=function(t,r){var e=function(){for(var e=S(t),n=function(){var t=e.read();if(-1==t)throw"eof";return t},o=0,i={};;){var a=e.read();if(-1==a)break;var u=n(),f=n()<<8|n();i[String.fromCharCode(a<<8|u)]=f,o+=1}if(o!=r)throw o+" != "+r;return i}(),n="?".charCodeAt(0);return function(t){for(var r=[],o=0;o<t.length;o+=1){var i=t.charCodeAt(o);if(i<128)r.push(i);else{var a=e[t.charAt(o)];"number"==typeof a?(255&a)==a?r.push(a):(r.push(a>>>8),r.push(255&a)):r.push(n)}}return r}};var r,e,n,o,i,a=1,u=2,f=4,c=8,g={L:1,M:0,Q:3,H:2},l=0,h=1,s=2,v=3,d=4,w=5,p=6,y=7,B=(r=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],e=1335,n=7973,i=function(t){for(var r=0;0!=t;)r+=1,t>>>=1;return r},(o={}).getBCHTypeInfo=function(t){for(var r=t<<10;i(r)-i(e)>=0;)r^=e<<i(r)-i(e);return 21522^(t<<10|r)},o.getBCHTypeNumber=function(t){for(var r=t<<12;i(r)-i(n)>=0;)r^=n<<i(r)-i(n);return t<<12|r},o.getPatternPosition=function(t){return r[t-1]},o.getMaskFunction=function(t){switch(t){case l:return function(t,r){return(t+r)%2==0};case h:return function(t,r){return t%2==0};case s:return function(t,r){return r%3==0};case v:return function(t,r){return(t+r)%3==0};case d:return function(t,r){return(Math.floor(t/2)+Math.floor(r/3))%2==0};case w:return function(t,r){return t*r%2+t*r%3==0};case p:return function(t,r){return(t*r%2+t*r%3)%2==0};case y:return function(t,r){return(t*r%3+(t+r)%2)%2==0};default:throw"bad maskPattern:"+t}},o.getErrorCorrectPolynomial=function(t){for(var r=k([1],0),e=0;e<t;e+=1)r=r.multiply(k([1,C.gexp(e)],0));return r},o.getLengthInBits=function(t,r){if(1<=r&&r<10)switch(t){case a:return 10;case u:return 9;case f:case c:return 8;default:throw"mode:"+t}else if(r<27)switch(t){case a:return 12;case u:return 11;case f:return 16;case c:return 10;default:throw"mode:"+t}else{if(!(r<41))throw"type:"+r;switch(t){case a:return 14;case u:return 13;case f:return 16;case c:return 12;default:throw"mode:"+t}}},o.getLostPoint=function(t){for(var r=t.getModuleCount(),e=0,n=0;n<r;n+=1)for(var o=0;o<r;o+=1){for(var i=0,a=t.isDark(n,o),u=-1;u<=1;u+=1)if(!(n+u<0||r<=n+u))for(var f=-1;f<=1;f+=1)o+f<0||r<=o+f||0==u&&0==f||a==t.isDark(n+u,o+f)&&(i+=1);i>5&&(e+=3+i-5)}for(n=0;n<r-1;n+=1)for(o=0;o<r-1;o+=1){var c=0;t.isDark(n,o)&&(c+=1),t.isDark(n+1,o)&&(c+=1),t.isDark(n,o+1)&&(c+=1),t.isDark(n+1,o+1)&&(c+=1),0!=c&&4!=c||(e+=3)}for(n=0;n<r;n+=1)for(o=0;o<r-6;o+=1)t.isDark(n,o)&&!t.isDark(n,o+1)&&t.isDark(n,o+2)&&t.isDark(n,o+3)&&t.isDark(n,o+4)&&!t.isDark(n,o+5)&&t.isDark(n,o+6)&&(e+=40);for(o=0;o<r;o+=1)for(n=0;n<r-6;n+=1)t.isDark(n,o)&&!t.isDark(n+1,o)&&t.isDark(n+2,o)&&t.isDark(n+3,o)&&t.isDark(n+4,o)&&!t.isDark(n+5,o)&&t.isDark(n+6,o)&&(e+=40);var g=0;for(o=0;o<r;o+=1)for(n=0;n<r;n+=1)t.isDark(n,o)&&(g+=1);return e+=Math.abs(100*g/r/r-50)/5*10},o),C=function(){for(var t=new Array(256),r=new Array(256),e=0;e<8;e+=1)t[e]=1<<e;for(e=8;e<256;e+=1)t[e]=t[e-4]^t[e-5]^t[e-6]^t[e-8];for(e=0;e<255;e+=1)r[t[e]]=e;var n={glog:function(t){if(t<1)throw"glog("+t+")";return r[t]},gexp:function(r){for(;r<0;)r+=255;for(;r>=256;)r-=255;return t[r]}};return n}();function k(t,r){if(void 0===t.length)throw t.length+"/"+r;var e=function(){for(var e=0;e<t.length&&0==t[e];)e+=1;for(var n=new Array(t.length-e+r),o=0;o<t.length-e;o+=1)n[o]=t[o+e];return n}(),n={getAt:function(t){return e[t]},getLength:function(){return e.length},multiply:function(t){for(var r=new Array(n.getLength()+t.getLength()-1),e=0;e<n.getLength();e+=1)for(var o=0;o<t.getLength();o+=1)r[e+o]^=C.gexp(C.glog(n.getAt(e))+C.glog(t.getAt(o)));return k(r,0)},mod:function(t){if(n.getLength()-t.getLength()<0)return n;for(var r=C.glog(n.getAt(0))-C.glog(t.getAt(0)),e=new Array(n.getLength()),o=0;o<n.getLength();o+=1)e[o]=n.getAt(o);for(o=0;o<t.getLength();o+=1)e[o]^=C.gexp(C.glog(t.getAt(o))+r);return k(e,0).mod(t)}};return n}var A=function(){var t=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],r=function(t,r){var e={};return e.totalCount=t,e.dataCount=r,e},e={};return e.getRSBlocks=function(e,n){var o=function(r,e){switch(e){case g.L:return t[4*(r-1)+0];case g.M:return t[4*(r-1)+1];case g.Q:return t[4*(r-1)+2];case g.H:return t[4*(r-1)+3];default:return}}(e,n);if(void 0===o)throw"bad rs block @ typeNumber:"+e+"/errorCorrectionLevel:"+n;for(var i=o.length/3,a=[],u=0;u<i;u+=1)for(var f=o[3*u+0],c=o[3*u+1],l=o[3*u+2],h=0;h<f;h+=1)a.push(r(c,l));return a},e}(),b=function(){var t=[],r=0,e={getBuffer:function(){return t},getAt:function(r){var e=Math.floor(r/8);return 1==(t[e]>>>7-r%8&1)},put:function(t,r){for(var n=0;n<r;n+=1)e.putBit(1==(t>>>r-n-1&1))},getLengthInBits:function(){return r},putBit:function(e){var n=Math.floor(r/8);t.length<=n&&t.push(0),e&&(t[n]|=128>>>r%8),r+=1}};return e},M=function(t){var r=a,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+2<r.length;)t.put(o(r.substring(n,n+3)),10),n+=3;n<r.length&&(r.length-n==1?t.put(o(r.substring(n,n+1)),4):r.length-n==2&&t.put(o(r.substring(n,n+2)),7))}},o=function(t){for(var r=0,e=0;e<t.length;e+=1)r=10*r+i(t.charAt(e));return r},i=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);throw"illegal char :"+t};return n},x=function(t){var r=u,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+1<r.length;)t.put(45*o(r.charAt(n))+o(r.charAt(n+1)),11),n+=2;n<r.length&&t.put(o(r.charAt(n)),6)}},o=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);if("A"<=t&&t<="Z")return t.charCodeAt(0)-"A".charCodeAt(0)+10;switch(t){case" ":return 36;case"$":return 37;case"%":return 38;case"*":return 39;case"+":return 40;case"-":return 41;case".":return 42;case"/":return 43;case":":return 44;default:throw"illegal char :"+t}};return n},m=function(r){var e=f,n=t.stringToBytes(r),o={getMode:function(){return e},getLength:function(t){return n.length},write:function(t){for(var r=0;r<n.length;r+=1)t.put(n[r],8)}};return o},L=function(r){var e=c,n=t.stringToBytesFuncs.SJIS;if(!n)throw"sjis not supported.";!function(){var t=n("友");if(2!=t.length||38726!=(t[0]<<8|t[1]))throw"sjis not supported."}();var o=n(r),i={getMode:function(){return e},getLength:function(t){return~~(o.length/2)},write:function(t){for(var r=o,e=0;e+1<r.length;){var n=(255&r[e])<<8|255&r[e+1];if(33088<=n&&n<=40956)n-=33088;else{if(!(57408<=n&&n<=60351))throw"illegal char at "+(e+1)+"/"+n;n-=49472}n=192*(n>>>8&255)+(255&n),t.put(n,13),e+=2}if(e<r.length)throw"illegal char at "+(e+1)}};return i},D=function(){var t=[],r={writeByte:function(r){t.push(255&r)},writeShort:function(t){r.writeByte(t),r.writeByte(t>>>8)},writeBytes:function(t,e,n){e=e||0,n=n||t.length;for(var o=0;o<n;o+=1)r.writeByte(t[o+e])},writeString:function(t){for(var e=0;e<t.length;e+=1)r.writeByte(t.charCodeAt(e))},toByteArray:function(){return t},toString:function(){var r="";r+="[";for(var e=0;e<t.length;e+=1)e>0&&(r+=","),r+=t[e];return r+="]"}};return r},S=function(t){var r=t,e=0,n=0,o=0,i={read:function(){for(;o<8;){if(e>=r.length){if(0==o)return-1;throw"unexpected end of file./"+o}var t=r.charAt(e);if(e+=1,"="==t)return o=0,-1;t.match(/^\\s$/)||(n=n<<6|a(t.charCodeAt(0)),o+=6)}var i=n>>>o-8&255;return o-=8,i}},a=function(t){if(65<=t&&t<=90)return t-65;if(97<=t&&t<=122)return t-97+26;if(48<=t&&t<=57)return t-48+52;if(43==t)return 62;if(47==t)return 63;throw"c:"+t};return i},I=function(t,r,e){for(var n=function(t,r){var e=t,n=r,o=new Array(t*r),i={setPixel:function(t,r,n){o[r*e+t]=n},write:function(t){t.writeString("GIF87a"),t.writeShort(e),t.writeShort(n),t.writeByte(128),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(255),t.writeByte(255),t.writeByte(255),t.writeString(","),t.writeShort(0),t.writeShort(0),t.writeShort(e),t.writeShort(n),t.writeByte(0);var r=a(2);t.writeByte(2);for(var o=0;r.length-o>255;)t.writeByte(255),t.writeBytes(r,o,255),o+=255;t.writeByte(r.length-o),t.writeBytes(r,o,r.length-o),t.writeByte(0),t.writeString(";")}},a=function(t){for(var r=1<<t,e=1+(1<<t),n=t+1,i=u(),a=0;a<r;a+=1)i.add(String.fromCharCode(a));i.add(String.fromCharCode(r)),i.add(String.fromCharCode(e));var f,c,g,l=D(),h=(f=l,c=0,g=0,{write:function(t,r){if(t>>>r!=0)throw"length over";for(;c+r>=8;)f.writeByte(255&(t<<c|g)),r-=8-c,t>>>=8-c,g=0,c=0;g|=t<<c,c+=r},flush:function(){c>0&&f.writeByte(g)}});h.write(r,n);var s=0,v=String.fromCharCode(o[s]);for(s+=1;s<o.length;){var d=String.fromCharCode(o[s]);s+=1,i.contains(v+d)?v+=d:(h.write(i.indexOf(v),n),i.size()<4095&&(i.size()==1<<n&&(n+=1),i.add(v+d)),v=d)}return h.write(i.indexOf(v),n),h.write(e,n),h.flush(),l.toByteArray()},u=function(){var t={},r=0,e={add:function(n){if(e.contains(n))throw"dup key:"+n;t[n]=r,r+=1},size:function(){return r},indexOf:function(r){return t[r]},contains:function(r){return void 0!==t[r]}};return e};return i}(t,r),o=0;o<r;o+=1)for(var i=0;i<t;i+=1)n.setPixel(i,o,e(i,o));var a=D();n.write(a);for(var u=function(){var t=0,r=0,e=0,n="",o={},i=function(t){n+=String.fromCharCode(a(63&t))},a=function(t){if(t<0);else{if(t<26)return 65+t;if(t<52)return t-26+97;if(t<62)return t-52+48;if(62==t)return 43;if(63==t)return 47}throw"n:"+t};return o.writeByte=function(n){for(t=t<<8|255&n,r+=8,e+=1;r>=6;)i(t>>>r-6),r-=6},o.flush=function(){if(r>0&&(i(t<<6-r),t=0,r=0),e%3!=0)for(var o=3-e%3,a=0;a<o;a+=1)n+="="},o.toString=function(){return n},o}(),f=a.toByteArray(),c=0;c<f.length;c+=1)u.writeByte(f[c]);return u.flush(),"data:image/gif;base64,"+u};return t}();qrcode.stringToBytesFuncs["UTF-8"]=function(t){return function(t){for(var r=[],e=0;e<t.length;e++){var n=t.charCodeAt(e);n<128?r.push(n):n<2048?r.push(192|n>>6,128|63&n):n<55296||n>=57344?r.push(224|n>>12,128|n>>6&63,128|63&n):(e++,n=65536+((1023&n)<<10|1023&t.charCodeAt(e)),r.push(240|n>>18,128|n>>12&63,128|n>>6&63,128|63&n))}return r}(t)},function(t){"function"==typeof define&&define.amd?define([],t):"object"==typeof exports&&(module.exports=t())}(function(){return qrcode});
async function lienTelephone(){
  if(!lanCourant||!lanCourant.ip)return;
  const onglets=document.getElementById('qrOnglets');
  if(onglets) onglets.style.display=lanCourant.ipTailscale?'flex':'none';
  afficherQR(lanCourant.ip, 'local');
}
/** Construit et affiche le QR pour une adresse donnée -- 'local' (Wi-Fi, ne marche que
 *  chez soi) ou 'tailscale' (accessible depuis n'importe où, si Tailscale est actif des
 *  deux côtés). Même page cible dans les deux cas : /machines?solo=1 (la vraie carte
 *  visuelle), jamais la page texte basique. */
function afficherQR(ip, type){
  if(!ip) return;
  const lien='http://'+ip+':'+lanCourant.port+'/machines?solo=1'+(TOK?'&token='+TOK:'');
  document.getElementById('qrLienTexte').textContent=lien;
  const conteneur=document.getElementById('qrConteneur');
  conteneur.innerHTML='';
  try{
    const qr=qrcode(0,'M');
    qr.addData(lien);
    qr.make();
    conteneur.innerHTML=qr.createSvgTag({cellSize:5,margin:2});
  }catch(e){
    conteneur.innerHTML='<span style="color:#900;font-size:12px">QR code indisponible -- utilisez le lien ci-dessous.</span>';
  }
  const btnLocal=document.getElementById('qrOngletLocal'), btnTs=document.getElementById('qrOngletTailscale');
  if(btnLocal&&btnTs){
    btnLocal.classList.toggle('actif', type==='local');
    btnTs.classList.toggle('actif', type==='tailscale');
  }
  const texte=document.getElementById('qrTexteExplication');
  if(texte){
    texte.textContent = type==='tailscale'
      ? 'Ce lien passe par Tailscale : accessible depuis n\\'importe où (bureau, 4G...), tant que votre téléphone est connecté au même compte Tailscale que cet ordinateur.'
      : 'Scannez avec l\\'appareil photo de votre téléphone (même réseau Wi-Fi que cet ordinateur). Rien n\\'est envoyé sur internet pour générer ce code -- tout est calculé ici, dans le navigateur.';
  }
  document.getElementById('qrPopup').style.display='flex';
}
function fermerPopupQR(){document.getElementById('qrPopup').style.display='none';}
async function changerReseau(cle){
  if(changementEnCours)return;
  if(!confirm((L.confirmReseau||'Changer de réseau ?')+' → '+cle.toUpperCase()))return;
  changementEnCours=true;
  try{await fetch('/api/network?net='+cle+(Q?'&token='+TOK:''));}catch(e){}
  setTimeout(()=>{changementEnCours=false;tick();},1500);
}
let notifOn=false,dernierRecord=null,dernierBloc=false,dernierBlocsTrouves=null;

/* ---------- Notifications ---------- */
async function basculeNotif(){
  const b=document.getElementById('notifbtn');
  if(notifOn){notifOn=false;b.classList.remove('on');return;}
  if(!('Notification' in window)){alert('Notifications non disponibles dans ce navigateur.');return;}
  let p=Notification.permission;
  if(p!=='granted')p=await Notification.requestPermission();
  if(p==='granted'){notifOn=true;b.classList.add('on');
    notifier('AXECUBE',L.notif+' ✓');
  }else if(p==='denied'){
    alert('Notifications bloquees pour ce site.\\nCliquez sur le cadenas pres de l\\'adresse dans le navigateur, puis Notifications -> Autoriser, et reessayez.');
  }
}
function notifier(titre,corps){
  if(!notifOn||Notification.permission!=='granted')return;
  try{new Notification(titre,{body:corps,silent:false});}catch(e){}
}
function bip(freq,duree){
  try{const C=window.AudioContext||window.webkitAudioContext;if(!C)return;
    const c=new C(),o=c.createOscillator(),g=c.createGain();
    o.connect(g);g.connect(c.destination);o.type='sine';o.frequency.value=freq;
    g.gain.setValueAtTime(0.001,c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.09,c.currentTime+0.02);
    g.gain.exponentialRampToValueAtTime(0.0001,c.currentTime+duree);
    o.start();o.stop(c.currentTime+duree);}catch(e){}
}
function surveiller(s){
  if(dernierRecord!==null&&s.bestDiff>dernierRecord){
    notifier('🏆 '+L.notifRecord,fmtD(s.bestDiff));bip(880,0.28);}
  dernierRecord=s.bestDiff;
  const bloc=s.netDiff>0&&s.bestDiff>=s.netDiff;
  if(bloc&&!dernierBloc){
    notifier('🎉 '+L.notifBloc,L.notifBlocTexte);
    [0,300,600].forEach(d=>setTimeout(()=>bip(1320,0.5),d));}
  dernierBloc=bloc;
}

/* ---------- Carte de partage ---------- */
function carteRecord(){
  const cv=document.getElementById('cardcanvas'),x=cv.getContext('2d');
  const W=cv.width,H=cv.height;
  x.fillStyle='#05070a';x.fillRect(0,0,W,H);
  // grille de fond
  x.strokeStyle='rgba(150,240,31,.07)';x.lineWidth=1;
  for(let i=0;i<W;i+=40){x.beginPath();x.moveTo(i,0);x.lineTo(i,H);x.stroke();}
  for(let i=0;i<H;i+=40){x.beginPath();x.moveTo(0,i);x.lineTo(W,i);x.stroke();}
  // cadre
  x.strokeStyle='rgba(150,240,31,.35)';x.lineWidth=2;x.strokeRect(24,24,W-48,H-48);
  const M='ui-monospace,Menlo,Consolas,monospace';
  // record
  x.textAlign='center';
  x.fillStyle='rgba(232,237,245,.65)';x.font='500 26px '+M;
  x.fillText(L.carteRecord.toUpperCase(),W/2,190);
  x.shadowColor='rgba(150,240,31,.55)';x.shadowBlur=34;
  x.fillStyle='#96f01f';x.font='700 168px '+M;
  x.fillText(derniereStat?fmtD(derniereStat.bestDiff):'—',W/2,340);
  x.shadowBlur=0;
  x.font='64px '+M;x.fillText('🏆',W/2,420);
  // sous-titre
  if(derniereStat){
    x.fillStyle='rgba(232,237,245,.85)';x.font='400 30px '+M;
    const j=Math.floor(derniereStat.uptime/86400),h=Math.floor(derniereStat.uptime%86400/3600);
    const duree=j?j+L.j+' '+h+L.h:h+L.h;
    x.fillText(fmtHR(derniereStat.hashrate)+' '+L.carteEn+' '+duree+' '+L.carteDe,W/2,492);
    x.fillStyle='rgba(150,240,31,.75)';x.font='400 24px '+M;
    x.fillText(derniereStat.accepted+' '+L.acceptes+'  ·  '+L.bloc+' '+
      (derniereStat.blockHeight||'—'),W/2,536);
  }
  // logo
  const lg=document.querySelector('.brand-logo');
  const fin=()=>{cv.toBlob(b=>{const u=URL.createObjectURL(b),a=document.createElement('a');
    a.href=u;a.download='axecube-record.png';a.click();
    setTimeout(()=>URL.revokeObjectURL(u),4000);});};
  if(lg&&lg.complete&&lg.naturalWidth){
    const w=360,h=w*lg.naturalHeight/lg.naturalWidth;
    x.drawImage(lg,(W-w)/2,58,w,h);fin();
  } else fin();
}
let derniereStat=null;
const PIP_HTML='<div class="pip">'+
  '<div class="phead"><img class="plogo" id="p_logo"><span class="pled" id="p_led"></span></div>'+
  '<div><div class="l">'+L.hashrate+'</div><div class="hr" id="p_hr">—</div>'+
  '<div class="pcores" id="p_cores"></div></div>'+
  '<div class="sep"></div>'+
  '<div class="prec"><span class="l">'+L.recordCourt+'</span>'+
  '<span class="rec"><span id="p_best">—</span> <span class="cup">🏆</span></span></div>'+
  '<div class="sep"></div>'+
  '<div class="row"><span>'+L.shares+'</span><span id="p_sh">—</span></div>'+
  '<div class="row"><span>'+L.coeurs+'</span><span id="p_cores_n">—</span></div>'+
  '<div class="row"><span>'+L.bloc+'</span><span id="p_blk">—</span></div>'+
  '<div class="row"><span>'+L.depuis+'</span><span id="p_age">—</span></div>'+
  '<div class="row"><span>'+L.cours+'</span><span id="p_btc">—</span></div>'+
  '<div class="pjack" id="p_jack"></div>'+
  '</div>';
async function modeMini(largeur,hauteur,modeTest){
  if(pipWin){fermerModeMini();return;}
  if(!window.documentPictureInPicture){
    document.body.classList.toggle('compact');
    alert(L.pipSafari);
    return;}
  try{
    // Fenêtre flottante réelle (au-dessus des autres apps, sans barre de navigateur ni
    // onglets -- rien qui trahisse "page web"), au format portrait de la vraie carte
    // machine plutôt que l'ancien format texte compact.
    // Proportions EXACTES du visuel réel de la carte (1023x1537, comme le fichier image
    // d'origine) -- toute autre proportion crée une bande vide, même minime. Les
    // paramètres largeur/hauteur permettent de tester d'autres tailles au besoin.
    pipWin=await documentPictureInPicture.requestWindow({width:largeur||326,height:hauteur||490});
    pipDoc=pipWin.document;
    pipDoc.title='AXECUBE';
    // Sans hauteur explicite sur le document EXTÉRIEUR (celui de la fenêtre flottante
    // elle-même), l'iframe ci-dessous ne sait pas qu'il doit remplir toute la fenêtre --
    // son "height:100%" reste sans effet, d'où le vide en bas malgré la bonne fenêtre.
    pipDoc.documentElement.style.height='100%';
    pipDoc.body.style.cssText='margin:0;height:100%;background:#05070a;overflow:hidden;position:relative';
    // La vraie carte animée (skin actif, ventilo, glow) vit sur /machines -- on la charge
    // ici en mode solo (ma carte seule, sans grille ni en-tête) via un simple <iframe>,
    // qui se rafraîchit tout seul (même logique que le dashboard complet). Aucun code à
    // dupliquer : le skin, les animations, tout suit automatiquement.
    const ifr=pipDoc.createElement('iframe');
    ifr.src='/machines?solo=1'+(Q?('&'+Q.slice(1)):'');
    ifr.style.cssText='border:0;width:100%;height:100%;display:block;background:#05070a';
    pipDoc.body.appendChild(ifr);
    pipWin.addEventListener('pagehide',()=>{pipWin=null;pipDoc=null;basculerAffichagePip(false);});
    if(modeTest){
      // Mode test : PAS de recadrage automatique (sinon impossible d'atteindre la taille
      // qui casse), à la place un repère en direct affiche la taille exacte en pixels
      // pendant que tu tires les bords -- note la valeur au moment où ça casse.
      const repere=pipDoc.createElement('div');
      repere.style.cssText='position:absolute;top:6px;left:6px;z-index:9999;background:rgba(0,0,0,.75);'
        +'color:#96f01f;font-family:ui-monospace,Menlo,monospace;font-size:13px;padding:4px 8px;'
        +'border-radius:6px;border:1px solid rgba(150,240,31,.4);pointer-events:none';
      pipDoc.body.appendChild(repere);
      const majRepere=()=>{repere.textContent=pipWin.innerWidth+' x '+pipWin.innerHeight+' px';};
      majRepere();
      pipWin.addEventListener('resize',majRepere);
    } else {
      // Verrouille les proportions de la fenêtre elle-même (pas juste le contenu à
      // l'intérieur) : si l'utilisateur l'étire dans une forme trop éloignée de la vraie
      // carte (1023x1537), on la recadre automatiquement -- évite les bugs de rendu que le
      // CSS seul ne peut pas rattraper proprement dans les cas extrêmes (fenêtre très large
      // et basse, ou très haute et étroite).
      const RATIO_CARTE=1023/1537;
      let recadrageEnCours=false;
      pipWin.addEventListener('resize',()=>{
        if(recadrageEnCours||!pipWin) return;
        const w=pipWin.innerWidth,h=pipWin.innerHeight;
        if(!w||!h) return;
        const ratioActuel=w/h;
        if(Math.abs(ratioActuel-RATIO_CARTE)<0.02) return; // déjà correct, rien à faire
        let nW,nH;
        if(w/RATIO_CARTE<=h){nW=w;nH=Math.round(w/RATIO_CARTE);}
        else{nH=h;nW=Math.round(h*RATIO_CARTE);}
        recadrageEnCours=true;
        try{pipWin.resizeTo(nW,nH);}catch(e){}
        setTimeout(()=>{recadrageEnCours=false;},120);
      });
    }
    basculerAffichagePip(true);
  }catch(e){pipWin=null;}
}
function fermerModeMini(){
  if(pipWin){pipWin.close();}
  pipWin=null;pipDoc=null;
  basculerAffichagePip(false);
}
function basculerAffichagePip(actif){
  const dev=document.querySelector('.device');
  const ph=document.getElementById('pipPlaceholder');
  if(dev) dev.classList.toggle('pip-actif',actif);
  if(ph) ph.style.display=actif?'block':'none';
}
function majPip(s){
  if(!pipDoc)return;
  const set=(id,v)=>{const e=pipDoc.getElementById(id);if(e)e.textContent=v;};
  const led=pipDoc.getElementById('p_led');
  if(led)led.className='pled'+(s.connected?' on':'');
  const lg=pipDoc.getElementById('p_logo');
  if(lg&&!lg.src){const src=document.querySelector('.brand-logo');if(src)lg.src=src.src;}
  set('p_hr',fmtHR(s.hashrate));
  set('p_best',fmtD(s.bestDiff));
  set('p_sh',s.accepted+' '+L.acceptes);
  set('p_cores_n',s.threads+'/'+s.maxThreads);
  set('p_blk',s.blockHeight?s.blockHeight.toLocaleString('fr-FR'):'—');
  set('p_btc',s.btcPrice?Math.round(s.btcPrice).toLocaleString('fr-FR')+' '+s.btcSymbol:'—');
  const j=pipDoc.getElementById('p_jack');
  if(j)j.innerHTML=(s.btcPrice&&s.reseau.symbole==='BTC')?'🎰 '+L.jackpot+' <b>'+Math.round(s.reseau.recompense*s.btcPrice).toLocaleString('fr-FR')+' '+s.btcSymbol+'</b>':'';
  const mx=Math.max(...s.perThread.map(t=>t.rate),1);
  const c=pipDoc.getElementById('p_cores');
  if(c)c.innerHTML=s.perThread.map(t=>'<i style="height:'+Math.max(14,Math.round(t.rate/mx*100))+'%"></i>').join('');
  majPipAge();
}
function majPipAge(){
  if(!pipDoc)return;
  const e=pipDoc.getElementById('p_age');if(!e)return;
  if(!lastBlockAt){e.textContent='—';return;}
  const t=Math.max(0,Math.round((Date.now()-lastBlockAt)/1000));
  const m=Math.floor(t/60),h=Math.floor(m/60);
  e.textContent=h?h+' '+L.h+' '+(m%60)+' '+L.min:m?m+' '+L.min+' '+(t%60)+' '+L.s:t+' '+L.s;
}
function fmtHR(h){if(h>=1e12)return(h/1e12).toFixed(2)+' TH/s';if(h>=1e9)return(h/1e9).toFixed(2)+' GH/s';
  if(h>=1e6)return(h/1e6).toFixed(2)+' MH/s';if(h>=1e3)return(h/1e3).toFixed(2)+' kH/s';return h.toFixed(0)+' H/s'}
function fmtD(d){if(!d)return'—';if(d>=1e12)return(d/1e12).toFixed(2)+' T';if(d>=1e9)return(d/1e9).toFixed(2)+' G';
  if(d>=1e6)return(d/1e6).toFixed(2)+' M';if(d>=1e3)return(d/1e3).toFixed(2)+' k';return d>=100?d.toFixed(0):d.toPrecision(3)}
function fmtUp(s){const j=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return (j?j+L.j+' ':'')+String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')}
function fmtBig(x){if(x<1e6)return Math.round(x).toLocaleString('fr-FR');
  const e=Math.floor(Math.log10(x));return (x/Math.pow(10,e)).toFixed(1).replace('.',',')+' × 10^'+e}
async function lancerCalib(){
  if(!confirm(L.calibExplique+'\\n\\nOK ?'))return;
  await fetch('/api/calibrer'+Q);tick();
}
async function chgThreads(d){const n=Math.max(1,Math.min(maxThreads,curThreads+d));
  if(n===curThreads)return;await fetch('/api/threads?n='+n+(TOK?'&token='+TOK:''));tick();}
function spark(){const c=document.getElementById('spark'),x=c.getContext('2d');
  x.clearRect(0,0,c.width,c.height);if(hist.length<2)return;
  const min=Math.min(...hist),max=Math.max(...hist);
  const ecart=(max-min)||1; // évite une division par zéro si tout est parfaitement identique
  x.strokeStyle='#96f01f';x.lineWidth=1.5;x.shadowColor='rgba(150,240,31,.5)';x.shadowBlur=4;x.beginPath();
  hist.forEach((v,i)=>{const px=2+i*(c.width-4)/(hist.length-1),py=c.height-4-((v-min)/ecart)*(c.height-10);
    i?x.lineTo(px,py):x.moveTo(px,py)});x.stroke()}
let leadTick=0;
async function majLead(s){
  const box=document.getElementById('leadPreview');
  document.getElementById('planeteBtn').style.display=LEADER_URL?'inline-block':'none';
  document.getElementById('boutiqueBtn').style.display=LEADER_URL?'inline-block':'none';
  document.getElementById('classementBandeau').style.display=LEADER_URL?'block':'none';
  if(!LEADER_URL||!s){box.style.display='none';return;}
  leadTick++;
  if(leadTick%15!==1)return; // ~30s (tick toutes les 2s)
  try{
    const base=LEADER_URL.endsWith('/')?LEADER_URL.slice(0,-1):LEADER_URL;
    fetch(base+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({worker:s.worker,bestDiff:s.bestDiff,hashrate:s.hashrate,cpu:s.cpuModel,machineId:s.machineId,pool:s.pool,
                            headerHex:s.bestProofHeader||null,
                            diffPeriode:s.bestDiffRecent||0,headerHexPeriode:s.bestProofHeaderRecent||null,
                            accepted:s.accepted||0,totalHashes:s.totalHashes||0})}).catch(()=>{});
    const j=await(await fetch(base+'/top')).json();
    const list=(j.top||j||[]).slice(0,3);
    if(!list.length){box.style.display='none';return;}
    box.style.display='';
    const medailles=['🥇','🥈','🥉'];
    document.getElementById('lp_list').innerHTML=list.map((e,i)=>
      '<div class="lp-row'+(e.worker===s.worker?' me':'')+'"><span class="lp-who">'+medailles[i]+' '+
      (e.worker||'anon')+(e.poolRecord?' <span style="color:var(--mut);font-size:10px">('+e.poolRecord+')</span>':'')+
      '</span><b>'+fmtD(e.bestDiff)+'</b></div>').join('');
    const monRang=(j.top||j||[]).findIndex(e=>e.worker===s.worker)+1;
    document.getElementById('lp_moi').textContent=monRang>3?('· vous êtes '+monRang+'ᵉ'):'';
  }catch(e){box.style.display='none';}
}
const PALIERS_CLIENT=[
  {cle:'bronze',nom:'BRONZE',icone:'🥉',seuil:100},
  {cle:'argent',nom:'ARGENT',icone:'🥈',seuil:1000},
  {cle:'or',nom:'OR',icone:'🥇',seuil:10000},
  {cle:'platine',nom:'PLATINE',icone:'💠',seuil:100000},
  {cle:'diamant',nom:'DIAMANT',icone:'💎',seuil:1000000},
  {cle:'legende',nom:'LÉGENDE',icone:'🔥',seuil:10000000},
];
function palierPour(diff){
  let idx=-1;
  for(let i=0;i<PALIERS_CLIENT.length;i++) if(diff>=PALIERS_CLIENT[i].seuil) idx=i;
  return idx;
}
let dernierPalierIdx=null,dernierStats=null;
function majBadge(s){
  dernierStats=s;
  const chip=document.getElementById('badgeChip');
  // Le badge affiché ne se fie JAMAIS à la seule valeur locale (state.bestDiff /
  // recordExterne), modifiable en éditant miner-state.json à la main -- il se fie
  // uniquement à bestDiffVerifie, revérifié côté serveur (voir mon-record.js). Léger
  // délai possible juste après le lancement (~12s, le temps du premier appel serveur) :
  // préférable à un badge qui pourrait être affiché sans être réellement gagné.
  const meilleurAffiche=s.bestDiffVerifie||0;
  const idx=palierPour(meilleurAffiche);
  if(idx<0){chip.style.display='none';return;}
  const p=PALIERS_CLIENT[idx];
  chip.style.display='';
  document.getElementById('badgeChipIcone').textContent=p.icone;
  document.getElementById('badgeChipTexte').textContent=p.nom;
  if(dernierPalierIdx!==null && idx>dernierPalierIdx) ouvrirPopupPalier(PALIERS_CLIENT[idx],false);
  dernierPalierIdx=idx;
}
function ouvrirPopupPalier(p,manuel){
  if(!p)return;
  const s=dernierStats||{};
  document.getElementById('palierPopupImg').src='/badges/'+p.cle+'.png'+Q;
  document.getElementById('palierPopupTitre').textContent=manuel?('Palier '+p.nom):('Palier '+p.nom+' débloqué !');
  document.getElementById('palierOverlayDiff').textContent=fmtD(Math.max(s.bestDiff||0,s.recordExterne||0));
  const dateISO=(s.paliersAtteints||{})[p.cle];
  document.getElementById('palierOverlayDate').textContent=dateISO
    ? new Date(dateISO).toLocaleDateString('fr-FR').toUpperCase() : '';
  const idxP=PALIERS_CLIENT.findIndex(x=>x.cle===p.cle);
  const suivant=PALIERS_CLIENT[idxP+1];
  document.getElementById('palierPopupNext').textContent=suivant
    ? ('Prochain palier : '+suivant.nom+' à '+fmtD(suivant.seuil)) : 'Palier maximum atteint !';
  document.getElementById('palierPopup').style.display='flex';
  if(!manuel){
    notifier('🏅 Nouveau palier !', p.nom+' débloqué');
    bip(660,0.15);setTimeout(()=>bip(880,0.15),160);setTimeout(()=>bip(1100,0.3),320);
  }
}
function fermerPopupPalier(){document.getElementById('palierPopup').style.display='none';}
async function tick(){try{
  const s=await(await fetch('/api/stats'+Q)).json();
  curThreads=s.threads;maxThreads=s.maxThreads;
  document.getElementById('led').className='led'+(s.connected?' on':'');
  document.getElementById('serial').textContent='№ '+s.user.slice(0,9)+'…'+s.user.slice(-7).replace(/\..*/,'');
  adresseCourante=s.user.split('.')[0];
  lanCourant=s.lan||null;
  document.getElementById('phonebtn').style.display=(lanCourant&&lanCourant.ouvert&&lanCourant.ip)?'':'none';
  if(typeof s.actif==='boolean'){
    minageActif=s.actif;
    const pb=document.getElementById('pausebtn');
    pb.textContent=minageActif?'⏸':'▶';
    pb.classList.toggle('on',!minageActif);
  }
  document.getElementById('hashrate').textContent=fmtHR(s.hashrate);
  const bn=document.getElementById('blocsN');
  if(bn) bn.textContent=(s.blocsTrouves||0).toLocaleString('fr-FR');
  if(typeof s.blocsTrouves==='number'){
    if(dernierBlocsTrouves!==null && s.blocsTrouves>dernierBlocsTrouves) celebrerBloc(true);
    else if(s.blocsTrouves>0) document.querySelector('.blocBadge')?.classList.add('trouve');
    else document.querySelector('.blocBadge')?.classList.remove('trouve');
    dernierBlocsTrouves=s.blocsTrouves;
  }
  {
    const etat=document.getElementById('soloSplitEtat');
    const range=document.getElementById('soloSplitRange');
    const val=document.getElementById('soloSplitVal');
    if(etat&&range&&val){
      const surLeBonPool=s.presetCle==='solopool-com';
      const actuel=(s.soloSplit!==null&&s.soloSplit!==undefined)?s.soloSplit:100;
      range.disabled=!surLeBonPool; range.value=actuel; val.textContent=actuel+'%';
      etat.textContent=surLeBonPool?'Réglage actuel : '+actuel+'%.':'(pool actuel non compatible -- passe sur SoloPool.com d\\'abord)';
    }
  }
  // Sélecteur de réseau -- un seul bouton compact + <select> natif superposé (évite tout
  // débordement horizontal, contrairement à l'ancienne rangée d'un bouton par réseau).
  if(s.reseau){
    const sel=document.getElementById('netSelect');
    const ETIQUETTES_RESEAU={fractal:'FB'};
    const INFOBULLES_RESEAU={fractal:'Fractal Bitcoin'};
    if(sel.children.length!==s.reseau.reseaux.length){
      sel.innerHTML=s.reseau.reseaux.map(k=>'<option value="'+k+'">'
        +(ETIQUETTES_RESEAU[k]||k.toUpperCase())+(INFOBULLES_RESEAU[k]?' — '+INFOBULLES_RESEAU[k]:'')
        +'</option>').join('');
      sel.addEventListener('change',()=>{ if(sel.value!==s.reseau.cle) changerReseau(sel.value); else sel.value=s.reseau.cle; });
    }
    sel.value=s.reseau.cle;
    sel.disabled=changementEnCours;
    const btn=document.getElementById('netBtnActuel');
    btn.textContent=ETIQUETTES_RESEAU[s.reseau.cle]||s.reseau.cle.toUpperCase();
    btn.title=INFOBULLES_RESEAU[s.reseau.cle]||'';
  }
  document.getElementById('sub').textContent=s.cpuModel+(s.engine==='simd'?' · WASM SIMD':s.engine==='wasm'?' · WASM':'')+(s.reseau.symbole!=='BTC'?' · '+s.reseau.label:'');
  const mx=Math.max(...s.perThread.map(t=>t.rate),1);
  document.getElementById('cores').innerHTML=s.perThread.map(t=>
    '<i style="height:'+Math.max(8,Math.round(t.rate/mx*100))+'%" title="T'+t.id+' '+fmtHR(t.rate)+'"></i>').join('');
  document.getElementById('best').textContent=fmtD(Math.max(s.bestDiff||0,s.recordExterne||0));
  majBadge(s);
  document.getElementById('acc').textContent=s.accepted;
  document.getElementById('rej').textContent=s.rejected;
  const depuisEl=document.getElementById('depuis');
  if(depuisEl){
    depuisEl.textContent='depuis ce lancement';
  }
  document.getElementById('pdiff').textContent=fmtD(s.poolDiff);
  document.getElementById('poolNom').textContent=s.pool||'—';
  {
    // Explique en une phrase simple pourquoi les shares sont fréquents ou rares : la
    // difficulté imposée par le pool compte bien plus que le hashrate lui-même pour ça.
    const pa=document.getElementById('poolAdapte'), d=s.poolDiff||0;
    if(!d){ pa.textContent=''; }
    else if(d<=10){ pa.style.color='var(--amber)'; pa.textContent='🟢 Difficulté adaptée à un CPU — shares fréquents attendus.'; }
    else if(d<=200){ pa.style.color='#e8b64a'; pa.textContent='🟡 Difficulté moyenne — shares plus espacés, c\\'est normal en CPU.'; }
    else { pa.style.color='#ff5d5d'; pa.textContent='🔴 Difficulté élevée (pensée pour de l\\'ASIC) — shares rares en CPU. Un pool comme public-pool.io serait plus adapté.'; }
  }
  {
    const lienEl=document.getElementById('poolStatsLien');
    const host=(s.pool||'').split(':')[0];
    const adr=(s.user||'').split('.')[0];
    let url=null;
    if(host.includes('ckpool.org')) url='https://solo.ckpool.org/users/'+adr;
    else if(host.includes('mineshop.eu')) url='https://solo.mineshop.eu/miner/?wallet='+adr;
    else if(host.includes('public-pool.io')) url='https://web.public-pool.io/';
    else if(host.includes('braiins.com')) url='https://pool.braiins.com/';
    else if(host.includes('axeminer.com')) url='https://axeminer.com/#/app/'+adr;
    if(url&&adr){lienEl.href=url;lienEl.style.display='inline';}
    else{lienEl.style.display='none';}
  }
  {
    const ligne=document.getElementById('statsPoolLigne');
    const texte=document.getElementById('statsPoolTexte');
    if(s.statsExternesPool){
      const p=s.statsExternesPool;
      texte.textContent='Pool officiel : '+(p.hashrate1hr||'—')+' (1h) · '+(p.shares!=null?p.shares:'—')+' shares · meilleure '+(p.bestshare!=null?Number(p.bestshare).toFixed(1):'—');
      ligne.style.display='';
    } else { ligne.style.display='none'; }
  }
  document.getElementById('ndiff').textContent=fmtD(s.netDiff);
  document.getElementById('height').textContent=s.blockHeight?s.blockHeight.toLocaleString('fr-FR'):'—';
  lastBlockAt=s.lastBlockAt||0;
  document.getElementById('nethash').textContent=s.netHashrate?fmtHR(s.netHashrate):'—';
  document.getElementById('threads').textContent=s.threads+'/'+s.maxThreads;
  document.getElementById('uptime').textContent=fmtUp(s.uptime);
  // Indicateur thermique : donnée matérielle réelle si le démon est installé, sinon
  // repli sur l'estimation logicielle par dégradation du hashrate (comme avant).
  {
    document.getElementById('rowthr').style.display='';
    const e=document.getElementById('thr'), expl=document.getElementById('thrExplique');
    if(s.thermalReel){
      const tr=s.thermalReel;
      if(tr.type==='temperature'){
        const v=tr.valeur;
        if(v<70){e.innerHTML='🟢 '+v.toFixed(0)+'°C';e.style.color='';expl.textContent='Aucune contrainte, pleine puissance.';}
        else if(v<85){e.innerHTML='🟡 '+v.toFixed(0)+'°C';e.style.color='#ffd166';expl.textContent='Léger réchauffement, impact quasi invisible.';}
        else{e.innerHTML='🔴 '+v.toFixed(0)+'°C';e.style.color='#ff6a78';expl.textContent='Le système réduit la fréquence pour gérer la chaleur -- baisse de perf réelle.';}
      } else {
        const p=tr.valeur, pl=p.toLowerCase();
        if(pl==='nominal'){e.innerHTML='🟢 '+p;e.style.color='';expl.textContent='Aucune contrainte, pleine puissance.';}
        else if(pl==='fair'||pl==='moderate'){e.innerHTML='🟡 '+p;e.style.color='#ffd166';expl.textContent='Léger réchauffement, impact quasi invisible.';}
        else{e.innerHTML='🔴 '+p;e.style.color='#ff6a78';expl.textContent='Le système réduit la fréquence pour gérer la chaleur -- baisse de perf réelle. Réduction auto des threads si ça persiste.';}
      }
    } else {
      const pct=Math.round((s.throttle||0)*100);
      expl.textContent='';
      if(pct<3){e.innerHTML='🟢 '+L.thrOk;e.style.color='';}
      else if(pct<15){e.innerHTML='🟡 '+L.thrLeger+' (−'+pct+'%)';e.style.color='#ffd166';}
      else{e.innerHTML='🔴 '+L.thrFort+' (−'+pct+'%)';e.style.color='#ff6a78';}
    }
  }
  // Bouton et résultats de calibration
  const cb=document.getElementById('calibbtn');
  if(cb){cb.disabled=s.calibEnCours;cb.textContent=s.calibEnCours?L.calibEnCours:L.calibrerCourt;}
  if(s.calibration){
    const box=document.getElementById('calibbox');box.style.display='';
    const m=s.calibration.mesures,max=Math.max(...m.map(x=>x.hashrate),1);
    box.innerHTML=m.map(x=>{
      const best=x.threads===s.calibration.optimal.threads;
      return '<div class="cbar'+(best?' best':'')+'"><span class="cn">'+x.threads+' '+L.coeurs.toLowerCase()+
        '</span><span class="ctrack"><span class="cfill" style="width:'+Math.round(x.hashrate/max*100)+'%"></span></span>'+
        '<span class="cval">'+(x.hashrate/1e6).toFixed(1)+'</span></div>';
    }).join('')+
    '<div class="creco">➜ '+L.calibReco+' : <b>'+s.calibration.optimal.threads+' '+L.coeurs.toLowerCase()+
    '</b> ('+(s.calibration.optimal.hashrate/1e6).toFixed(1)+' MH/s)</div>';
  }
  if(s.paiement){
    document.getElementById('rowpay').style.display='';
    const e=document.getElementById('pay'),p=s.paiement;
    const btc=(p.satoshis/1e8).toFixed(4).replace(/0+$/,'').replace(/\\.$/,'');
    if(p.etat==='complet'){e.textContent='🔒 '+btc+' '+s.reseau.symbole+' → '+L.versVous;e.style.color='';}
    else if(p.etat==='partiel'){e.textContent=(p.part>=0.5?'🔎 ':'⚠ ')+btc+' '+s.reseau.symbole+' · '+
      (p.part*100).toFixed(0)+'% '+L.desSorties;e.style.color=p.part>=0.5?'':'#ff6a78';}
    else if(p.etat==='absent'){e.textContent='⚠ '+L.absent;e.style.color='#ff6a78';}
    else{e.textContent='· '+L.nonVerifie;e.style.color='';}}
  if(s.btcPrice){
    document.getElementById('rowbtc').style.display='';
    document.getElementById('btcprice').textContent=
      Math.round(s.btcPrice).toLocaleString('fr-FR')+' '+s.btcSymbol;}
  if(s.netDiff>0&&s.hashrate>0){
    const perBlock=s.netDiff*4294967296/(s.hashrate*600), yrs=s.netDiff*4294967296/s.hashrate/31557600;
    const pot=(s.btcPrice&&s.reseau.symbole==='BTC')?' <span class="dim">≈ '+Math.round(s.reseau.recompense*s.btcPrice).toLocaleString('fr-FR')+' '+s.btcSymbol+'</span>':'';
    document.getElementById('odds').innerHTML=
      '🎰 <b>1 '+L.chance+' '+fmtBig(perBlock)+'</b> '+L.parBloc+' · '+L.tempsMoyen+' <b>'+fmtBig(yrs)+' '+L.ans+'</b> · '+L.jackpot+' <b>~'+s.reseau.recompense+' '+s.reseau.symbole+'</b>'+pot;}
  const avisEl=document.getElementById('avisFractal');
  if(avisEl){
    if(s.reseau&&s.reseau.symbole==='FB'&&s.accepted===0&&s.poolDiff>0&&s.hashrate>0){
      const secs=s.poolDiff*4294967296/s.hashrate;
      const h=secs/3600;
      const txt=h>=1?(h>=24?(h/24).toFixed(1)+(L.j||' j'):h.toFixed(1)+' '+L.h):Math.round(secs/60)+' '+L.min;
      avisEl.textContent=L.avisFractal(txt);avisEl.style.display='';
    } else avisEl.style.display='none';
  }
  derniereStat=s;surveiller(s);
  majLead(s);
  majPip(s);
  if(hist.length===0 && s.histHash && s.histHash.length) hist.push(...s.histHash);
  hist.push(s.hashrate);if(hist.length>50)hist.shift();spark();
  const box=document.getElementById('console'),cin=document.getElementById('conin');
  const enBas=box.scrollHeight-box.scrollTop-box.clientHeight<12;
  const avant=box.scrollHeight,pos=box.scrollTop;
  cin.innerHTML=s.log.map(e=>
    '<div><span class="t">'+new Date(e.t).toLocaleTimeString(L.h==='h'?'fr-FR':'en-GB')+'</span><span class="'+e.kind+'">'+
    e.msg.replace(/</g,'&lt;')+'</span></div>').join('');
  if(enBas)box.scrollTop=box.scrollHeight;
  else box.scrollTop=pos+(box.scrollHeight-avant);
}catch(e){document.getElementById('led').className='led'}}
let lastBlockAt=0;
function majAge(){const e=document.getElementById('blockage');if(!e)return;
  if(!lastBlockAt){e.textContent='';return;}
  const s=Math.max(0,Math.round((Date.now()-lastBlockAt)/1000));
  const m=Math.floor(s/60), h=Math.floor(m/60);
  e.textContent='· '+(L.ilya?L.ilya+' ':'')+(h?h+' '+L.h+' '+(m%60)+' '+L.min:m?m+' '+L.min+' '+(s%60)+' '+L.s:s+' '+L.s);}
setInterval(()=>{majAge();majPipAge();},1000);
async function majSwarm(){
  try{
    const r=await(await fetch('/api/swarm'+Q)).json();
    const el=document.getElementById('swarmResume');
    if(!el)return;
    const n=(r.machines||[]).length;
    if(!n){ el.textContent='Aucune autre machine détectée'; return; }
    const total=(r.machines||[]).reduce((a,m)=>a+(m.hashrate||0),0)+(r.moi?r.moi.hashrate||0:0);
    el.textContent=n+' autre'+(n>1?'s':'')+' détectée'+(n>1?'s':'')+' · '+fmtHR(total)+' cumulé';
  }catch(e){}
}
setInterval(tick,2000);tick();
setInterval(majSwarm,6000);majSwarm();
</script></body></html>`;

  const SOUTENIR_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AXECUBE — Soutenir le projet</title>
<style>
  :root{
    --bg:#07090c; --panel:#0d1014; --panel2:#12161c; --line:#1c2029;
    --amber:#96f01f; --amber-dim:rgba(150,240,31,.6); --amber-faint:rgba(150,240,31,.32);
    --glow:0 0 10px rgba(150,240,31,.35);
    --white:#e8edf5; --white-dim:rgba(232,237,245,.65); --mut:#6b7686;
    --mono:ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--white);font-family:var(--mono);
       padding:24px;padding-top:max(24px,env(safe-area-inset-top));line-height:1.65}
  .wrap{max-width:720px;margin:0 auto}
  header{display:flex;align-items:center;gap:12px;padding-bottom:20px;
         border-bottom:1px solid var(--line);margin-bottom:28px}
  header a{color:var(--white-dim);text-decoration:none;font-size:11px;letter-spacing:.1em}
  header a:hover{color:var(--amber)}
  h1{font-size:22px;letter-spacing:.02em;margin-bottom:6px}
  h1 b{color:var(--amber);text-shadow:var(--glow)}
  .tagline{color:var(--white-dim);font-size:13px;margin-bottom:36px}
  h2{font-size:14px;letter-spacing:.1em;color:var(--amber);text-transform:uppercase;
     margin:36px 0 12px;display:flex;align-items:center;gap:8px}
  p{color:var(--white-dim);font-size:14px;margin-bottom:14px}
  p b{color:var(--white);font-weight:600}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
        padding:20px 22px;margin-bottom:16px}
  .adresse-box{display:flex;align-items:center;gap:10px;background:var(--panel2);
               border:1px solid var(--line);border-radius:8px;padding:12px 14px;
               font-size:12px;word-break:break-all;margin-top:10px}
  .adresse-box button{flex:0 0 auto;background:none;border:1px solid var(--amber-faint);
                       color:var(--amber);font-family:var(--mono);font-size:11px;
                       padding:6px 12px;border-radius:6px;cursor:pointer}
  .adresse-box button:hover{border-color:var(--amber);background:rgba(150,240,31,.08)}
  .cta{display:inline-block;margin-top:8px;background:rgba(150,240,31,.08);
       border:1px solid var(--amber-faint);color:var(--amber);text-decoration:none;
       padding:10px 20px;border-radius:8px;font-size:12px;letter-spacing:.08em}
  .cta:hover{border-color:var(--amber);background:rgba(150,240,31,.14)}
  .cta.desactive{opacity:.4;pointer-events:none;border-style:dashed}
  .badge-affilie{font-size:9px;letter-spacing:.08em;color:var(--mut);
                  border:1px solid var(--line);border-radius:10px;padding:2px 8px;margin-left:8px}
  .foot{margin-top:40px;padding-top:20px;border-top:1px solid var(--line);
        text-align:center;font-size:10px;color:var(--mut);letter-spacing:.08em}
  .avert{background:rgba(232,237,245,.04);border-left:2px solid var(--mut);
         padding:12px 16px;font-size:12px;color:var(--mut);margin:16px 0;border-radius:0 8px 8px 0}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <a href="/">← retour au tableau de bord</a>
  </header>

  <h1>Soutenir <b>AXECUBE</b></h1>
  <div class="tagline">Le projet reste et restera toujours gratuit. Voici comment aider si vous le souhaitez — sans aucune obligation.</div>

  <h2>💚 Faire un don (Bitcoin)</h2>
  <div class="card">
    <p>AXECUBE ne contient aucune publicité et ne vend rien. Si le projet vous a plu, un don libre — même minime — aide à financer le temps de développement.</p>
    ${DON_BTC_ADRESSE === 'VOTRE_ADRESSE_BTC_DE_DON_ICI'
      ? '<div class="avert">⚙️ Adresse de don pas encore configurée par le créateur du projet.</div>'
      : '<div class="adresse-box"><span id="donAdr">' + DON_BTC_ADRESSE + '</span><button data-adr="' + DON_BTC_ADRESSE + '" onclick="navigator.clipboard.writeText(this.dataset.adr);this.textContent=String.fromCodePoint(10003)+ ' + JSON.stringify(' copié') + '">copier</button></div>'}
  </div>

  <h2>🛒 Aller plus loin — matériel de minage sérieux</h2>
  <div class="card">
    <p>Si l'expérience CPU vous a plu et que vous voulez de <b>vraies chances</b>, un Bitaxe (ASIC dédié, ~100-230 €) change complètement l'équation — voir la page <a href="/decouvrir" style="color:var(--amber)">Découvrir</a> pour les chiffres détaillés.</p>
    <p>Nous recommandons <b>Mineshop.eu</b>, revendeur européen spécialisé depuis 2016 (livraison rapide UE, note 4,8/5 sur Trustpilot, 1400+ avis).</p>
    <p style="text-align:center;margin:16px 0">
      <a class="cta${LIEN_MINESHOP_AFFILIATION === 'VOTRE_LIEN_AFFILIATION_ICI' ? ' desactive' : ''}"
         href="${LIEN_MINESHOP_AFFILIATION === 'VOTRE_LIEN_AFFILIATION_ICI' ? '#' : LIEN_MINESHOP_AFFILIATION}"
         target="_blank" rel="noopener">🛒 Voir les Bitaxe sur Mineshop.eu</a>
      <span class="badge-affilie">lien d'affiliation</span>
    </p>
    ${LIEN_MINESHOP_AFFILIATION === 'VOTRE_LIEN_AFFILIATION_ICI'
      ? '<div class="avert">' + JSON.stringify('⚙️ Lien d\'affiliation pas encore configure.').slice(1,-1) + '</div>' : ''}
    <p style="font-size:11.5px">Autres revendeurs européens sérieux, sans lien d'affiliation de notre part : <a href="https://d-central.tech" target="_blank" rel="noopener" style="color:var(--white-dim)">D-Central</a> (Canada, expédition internationale), <a href="https://shop.btcdirect.eu" target="_blank" rel="noopener" style="color:var(--white-dim)">BTC Direct</a> (fabrication allemande).</p>
  </div>

  <div class="avert">ℹ️ Transparence : les liens marqués « affiliation » nous rapportent une commission si vous achetez via ce lien, sans coût supplémentaire pour vous. Rien n'est jamais obligatoire pour utiliser AXECUBE.</div>

  <a class="cta" href="/">▸ Retourner miner</a>

  <div class="foot">AXECUBE · MINEUR LOTTERY · GRATUIT, TOUJOURS</div>
</div>
</body>
</html>`;

  const DECOUVRIR_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AXECUBE — Découvrir le minage Bitcoin</title>
<style>
  :root{
    --bg:#07090c; --panel:#0d1014; --panel2:#12161c; --line:#1c2029;
    --amber:#96f01f; --amber-dim:rgba(150,240,31,.6); --amber-faint:rgba(150,240,31,.32);
    --glow:0 0 10px rgba(150,240,31,.35);
    --white:#e8edf5; --white-dim:rgba(232,237,245,.65); --mut:#6b7686;
    --mono:ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--white);font-family:var(--mono);
       padding:24px;padding-top:max(24px,env(safe-area-inset-top));line-height:1.65}
  .wrap{max-width:720px;margin:0 auto}
  header{display:flex;align-items:center;gap:12px;padding-bottom:20px;
         border-bottom:1px solid var(--line);margin-bottom:28px}
  header a{color:var(--white-dim);text-decoration:none;font-size:11px;letter-spacing:.1em}
  header a:hover{color:var(--amber)}
  h1{font-size:22px;letter-spacing:.02em;margin-bottom:6px}
  h1 b{color:var(--amber);text-shadow:var(--glow)}
  .tagline{color:var(--white-dim);font-size:13px;margin-bottom:36px}
  h2{font-size:14px;letter-spacing:.1em;color:var(--amber);text-transform:uppercase;
     margin:36px 0 12px;display:flex;align-items:center;gap:8px}
  p{color:var(--white-dim);font-size:14px;margin-bottom:14px}
  p b{color:var(--white);font-weight:600}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
        padding:20px 22px;margin-bottom:16px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}
  @media(max-width:560px){.grid{grid-template-columns:1fr}}
  .mini{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .mini .k{font-size:9.5px;letter-spacing:.12em;color:var(--mut);margin-bottom:6px}
  .mini .v{font-size:13px;color:var(--white)}
  .quote{border-left:2px solid var(--amber-faint);padding-left:16px;margin:20px 0;
         color:var(--white-dim);font-style:italic;font-size:13.5px}
  .cta{display:inline-block;margin-top:8px;background:rgba(150,240,31,.08);
       border:1px solid var(--amber-faint);color:var(--amber);text-decoration:none;
       padding:10px 20px;border-radius:8px;font-size:12px;letter-spacing:.08em}
  .cta:hover{border-color:var(--amber);background:rgba(150,240,31,.14)}
  .foot{margin-top:40px;padding-top:20px;border-top:1px solid var(--line);
        text-align:center;font-size:10px;color:var(--mut);letter-spacing:.08em}
  .analogie{background:var(--panel2);border-radius:10px;padding:16px 18px;margin:14px 0;
            border:1px dashed var(--amber-faint);font-size:13px;color:var(--white-dim)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <a href="/">← retour au tableau de bord</a>
  </header>

  <h1>Bienvenue dans l'univers <b>Bitcoin</b></h1>
  <div class="tagline">Une petite présentation pour comprendre le minage — sans jargon inutile, sans rien acheter.</div>

  <h2>⛏️ Le minage, en une idée</h2>
  <p>Miner du Bitcoin, c'est participer à une <b>vaste loterie mondiale</b> où chaque ordinateur essaie, en continu, de deviner un nombre presque impossible à trouver. Toutes les ~10 minutes, quelqu'un sur Terre tombe sur le bon nombre — et gagne la récompense du bloc (actuellement environ 3,125 BTC, plusieurs centaines de milliers d'euros).</p>
  <div class="analogie">💡 <b>Analogie simple</b> : imagine des millions de personnes qui lancent des dés en même temps, encore et encore. Celui qui tombe le premier sur une combinaison précise remporte le lot. Plus tu as de dés (de puissance de calcul), plus tu lances souvent — mais chaque lancer reste indépendant du précédent.</div>

  <h2>🎉 Un exemple réel — pas juste une théorie</h2>
  <p>Le 10 juillet 2026, un petit boîtier de minage (un <b>Bitaxe Gamma</b>, ~1 TH/s — accessible pour ~150 €) connecté en solo sur <b>public-pool.io</b> a trouvé le <b>bloc #957 382</b>. Récompense : <b>3,1382 BTC</b>, environ <b>200 000 €</b> à ce moment-là. Intégralité chez lui, sans partage — c'est le principe du minage solo.</p>
  <div class="analogie">✅ <b>Vérifiable par toi-même, pas juste une affirmation</b> — la blockchain Bitcoin est publique. Ouvre le lien ci-dessous : tu verras la transaction de récompense (3,138 BTC) arriver directement sur l'adresse du mineur, avec plus de 2000 confirmations. Impossible à falsifier, impossible à annuler.</div>
  <p style="text-align:center;margin:18px 0">
    <a class="cta" href="https://mempool.space/address/bc1q0pp74ghs25vpn2ah6auz4vkehvzy8z8ddyzts7" target="_blank" rel="noopener">🔍 Vérifier ce bloc sur mempool.space</a>
  </p>
  <p><b>Ce que cet exemple montre vraiment</b> : le minage solo n'est pas une fiction marketing — des gens, avec du matériel modeste, gagnent réellement, de temps en temps. Ce que ça ne montre pas : la fréquence. Ce genre d'événement reste extrêmement rare (voir la section "vraies chances" plus bas) — mais "extrêmement rare" ne veut pas dire "jamais". C'est exactement l'esprit d'AXECUBE : te montrer le vrai mécanisme, sans mentir sur les probabilités.</p>

  <h2>🔒 Pourquoi c'est sécurisé</h2>
  <p>Ce mécanisme (la <b>preuve de travail</b>) est ce qui protège Bitcoin depuis 2009 sans banque ni autorité centrale : falsifier la blockchain demanderait de refaire, plus vite que tout le reste du monde réuni, un travail de calcul représentant des centaines d'exajoules d'énergie déjà dépensés. C'est ce qui rend le réseau digne de confiance.</p>

  <h2>🎯 Pourquoi AXECUBE existe</h2>
  <p>La plupart des gens pensent que miner du Bitcoin nécessite du matériel spécialisé coûteux (les fameux ASIC). <b>C'est vrai pour miner de façon compétitive</b> — mais ce n'est pas vrai pour <b>découvrir comment ça marche pour de vrai</b>.</p>
  <p>AXECUBE fait tourner un vrai moteur de minage (SHA-256, le même algorithme que les machines industrielles) directement sur le processeur de ton ordinateur actuel. <b>Aucun achat, aucune inscription, aucune carte bancaire.</b> Juste ton adresse Bitcoin et un clic.</p>

  <div class="grid">
    <div class="mini"><div class="k">CE QUE ÇA COÛTE</div><div class="v">0 € — tu utilises déjà ton ordinateur</div></div>
    <div class="mini"><div class="k">CE QUE ÇA CALCULE</div><div class="v">De vrais hashs, pas une simulation</div></div>
    <div class="mini"><div class="k">TES VRAIES CHANCES</div><div class="v">Minuscules, mais réelles et honnêtes</div></div>
    <div class="mini"><div class="k">CE QUE ÇA T'APPREND</div><div class="v">Difficulté, pools, blocs, récompenses — en pratique</div></div>
  </div>

  <div class="quote">"Le but n'est pas de devenir riche en minant sur un CPU — c'est astronomiquement improbable, et AXECUBE ne le cache jamais. Le but, c'est de rendre un concept abstrait concret : voir un vrai hashrate, un vrai record de difficulté, une vraie vérification de paiement, en quelques minutes, gratuitement."</div>

  <h2>🚀 Et si tu veux aller plus loin</h2>
  <p>Si l'expérience te plaît et que tu veux de <b>vraies chances</b> plutôt que symboliques, la seule voie qui change vraiment la donne, c'est du matériel dédié (un Bitaxe, environ 100-230 €) — mais ce n'est <b>jamais obligatoire</b>. AXECUBE reste entièrement fonctionnel et amusant sans jamais dépenser un centime.</p>
  <p style="text-align:center"><a class="cta" href="/soutenir">💚 Voir comment aller plus loin</a></p>

  <h2>🏆 Ce qu'AXECUBE ajoute à l'expérience</h2>
  <p>Au-delà du simple calcul : un <b>tableau de bord en temps réel</b>, une <b>vérification en direct</b> de ce que tu toucherais si un bloc était trouvé, un système de <b>badges de progression</b> par paliers de difficulté, et un <b>classement communautaire</b> vérifié cryptographiquement (personne ne peut tricher sur son score).</p>

  <a class="cta" href="/">▸ Retourner miner</a>

  <div class="foot">AXECUBE · MINEUR LOTTERY · DÉMOCRATISER LE MINAGE, UN CPU À LA FOIS</div>
</div>
</body>
</html>`;

  const DETAILS_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#05070a">
<title>AXECUBE — Détails</title>
<style>
  :root{
    --bg:#07090c; --panel:#0d1014; --panel2:#12161c; --line:#1c2029;
    --amber:#96f01f; --amber-dim:rgba(150,240,31,.6); --amber-faint:rgba(150,240,31,.32);
    --glow:0 0 10px rgba(150,240,31,.35);
    --white:#e8edf5; --white-dim:rgba(232,237,245,.6); --mut:#6b7686;
    --mono:ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--white);font-family:var(--mono);
       padding:20px;padding-top:max(20px,env(safe-area-inset-top));line-height:1.5}
  .wrap{max-width:1080px;margin:0 auto}
  header{display:flex;align-items:center;gap:14px;padding-bottom:18px;
         border-bottom:1px solid var(--line);margin-bottom:22px;flex-wrap:wrap}
  header img{height:30px}
  header .sp{margin-left:auto;display:flex;gap:8px}
  .lien{color:var(--amber);text-decoration:none;font-size:12px;border:1px solid var(--amber-faint);
        padding:7px 13px;border-radius:8px}
  .lien:hover{border-color:var(--amber)}
  h2{font-size:11px;letter-spacing:.24em;color:var(--amber);margin:26px 0 12px;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .card.clic{cursor:pointer;transition:border-color .2s,transform .15s}
  .card.clic:hover{border-color:var(--amber);transform:translateY(-1px)}
  .card.clic:active{transform:translateY(0)}
  @keyframes flashJournal{0%{box-shadow:0 0 0 0 rgba(255,255,255,0)}
    20%{box-shadow:0 0 0 3px var(--amber);border-color:var(--amber)}
    100%{box-shadow:0 0 0 0 rgba(255,255,255,0);border-color:var(--line)}}
  .flash-cible{animation:flashJournal 1.4s ease-out}
  .card .k{font-size:9px;letter-spacing:.16em;color:var(--white-dim);margin-bottom:6px}
  .card .v{font-size:19px;font-variant-numeric:tabular-nums}
  .card .v.big{font-size:26px;color:var(--amber);text-shadow:var(--glow)}
  .card .v.sm{font-size:13px;word-break:break-all;line-height:1.4}
  .card .v.ok{color:var(--amber)} .card .v.bad{color:#ff6a78}
  .card .sub{font-size:10px;color:var(--mut);margin-top:4px}
  .full{grid-column:1/-1}
  canvas{width:100%;height:150px;background:var(--panel2);border:1px solid var(--line);border-radius:8px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
  th{color:var(--amber-faint);font-size:9px;letter-spacing:.14em;font-weight:600}
  td{color:var(--white-dim);font-variant-numeric:tabular-nums}
  td.me{color:var(--amber)}
  .ligneJournal:hover{background:rgba(150,240,31,.05)}
  .ligneJournal.ligneVide{opacity:.5}
  .lienJournal{color:var(--white-dim);text-decoration:none}
  .lienJournal:hover{color:var(--amber);text-decoration:underline}
  .moisJournal{border-bottom:1px solid var(--line)}
  .moisJournal:last-child{border-bottom:none}
  .moisJournal summary{cursor:pointer;padding:9px 6px;font-size:11px;letter-spacing:.1em;
    color:var(--amber-dim);list-style:none;user-select:none;display:flex;align-items:center;gap:6px}
  .moisJournal summary::-webkit-details-marker{display:none}
  .moisJournal summary::before{content:'▸';color:var(--amber-faint);font-size:10px;transition:transform .15s}
  .moisJournal[open] summary::before{transform:rotate(90deg)}
  .moisJournal summary:hover{color:var(--amber)}
  .moisJournal .moisCompte{color:var(--mut);font-size:9px;letter-spacing:normal;font-weight:400}
  .moisJournal table{margin-bottom:4px}
  .lead-tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
  .lead-tab{background:none;border:1px solid var(--line);color:var(--white-dim);font-family:inherit;
            font-size:10px;letter-spacing:.1em;padding:5px 12px;border-radius:6px;cursor:pointer}
  .lead-tab:hover{border-color:var(--amber-faint);color:var(--amber-dim)}
  .lead-tab.on{border-color:var(--amber);color:var(--amber);background:rgba(150,240,31,.08)}
  .badge{display:inline-block;font-size:9px;padding:2px 7px;border-radius:10px;
         background:rgba(150,240,31,.12);color:var(--amber);margin-left:6px}
  .off{background:rgba(255,106,120,.12);color:#ff6a78}
  .loading{color:var(--mut);font-size:12px;padding:10px 0}
  .foot{margin-top:30px;padding-top:16px;border-top:1px solid var(--line);
        font-size:10px;color:var(--mut);text-align:center;line-height:1.7}
</style></head><body><div class="wrap">
<header>
  <img id="logo" alt="AXECUBE">
  <span id="statut" class="badge">···</span>
  <div class="sp">
    <a class="lien" href="/" id="lretour">← Tableau de bord</a>
    <a class="lien" id="lmempool" target="_blank" rel="noopener">Voir sur mempool.space ↗</a>
  </div>
</header>

<h2 id="h_perf">PERFORMANCE</h2>
<div class="grid">
  <div class="card"><div class="k" id="k_hr">TAUX DE HASH</div><div class="v big" id="d_hr">—</div><div class="sub" id="d_hrsub"></div></div>
  <div class="card"><div class="k" id="k_rec">RECORD</div><div class="v big" id="d_rec">—</div><div class="k" id="d_recsub" style="margin-top:2px"></div></div>
  <div class="card"><div class="k" id="k_sh">SHARES</div><div class="v" id="d_sh">—</div><div class="sub" id="d_shsub"></div></div>
  <div class="card"><div class="k" id="k_thr">THERMIQUE</div><div class="v" id="d_thr">—</div></div>
  <div class="card"><div class="k" id="k_tot">TICKETS JOUÉS</div><div class="v" id="d_tot">—</div></div>
  <div class="card"><div class="k" id="k_up">SESSION</div><div class="v" id="d_up">—</div></div>
  <div class="card"><div class="k" id="k_recjour">MEILLEURE DIFF DU JOUR</div><div class="v big" id="d_recjour">—</div></div>
  <div class="card"><div class="k" id="k_diffjour">TOTAL DIFFICULTÉS DU JOUR</div><div class="v big" id="d_diffjour">—</div></div>
  <div class="card"><div class="k" id="k_code">CODE D'ACCÈS (POUR MES RÉCOMPENSES)</div><div class="v" id="d_code" style="cursor:pointer;font-size:16px" onclick="copierCode()" title="Cliquer pour copier">—</div><div class="sub" id="d_codesub">Sert à rattacher cette machine à votre wallet sur "Mes récompenses gagnées"</div></div>
  <div class="card clic" id="c_cubs" onclick="allerAuJournal()" title="Cliquer pour voir le détail jour par jour"><div class="k" id="k_cubs">CUB'S (TOTAL CUMULÉ)</div><div style="display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:4px"><div class="v big" id="d_cubs" style="margin:0">—</div><img src="data:image/png;base64,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" alt="CUB'S" style="width:64px;height:64px;flex:0 0 auto"></div><div class="sub" id="d_cubssub"></div></div>
</div>

<h2 id="h_graph">RECORD AU FIL DU TEMPS</h2>
<canvas id="graph" width="1040" height="150"></canvas>

<h2 id="h_journal">📖 JOURNAL DES GAINS <span style="font-size:9px;color:var(--mut)">— un bloc par jour, comme un registre</span></h2>
<div class="card full"><div id="d_journal" class="loading">Chargement…</div></div>

<h2 id="h_cores">CŒURS</h2>
<div class="card full"><table id="t_cores"><tbody></tbody></table></div>

<h2 id="h_pool">POOL & STRATUM</h2>
<div class="grid" id="g_pool"></div>

<h2 id="h_net">RÉSEAU BITCOIN</h2>
<div class="grid" id="g_net"></div>

<h2 id="h_pay">PAIEMENT DU BLOC</h2>
<div class="grid" id="g_pay"></div>

<h2 id="h_workers">MES MACHINES SUR LE POOL <span id="w_via" style="font-size:9px;color:var(--mut)"></span></h2>
<div style="margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
  <span style="font-size:10px;color:var(--mut)">CHANGER DE POOL :</span>
  <select id="sel_pool" style="background:var(--bg2);color:var(--fg);border:1px solid var(--line);border-radius:8px;
    padding:5px 8px;font-family:inherit;font-size:11px">
    <option value="">— choisir —</option>
    <option value="solopool">public-pool.io — 🟢 Idéal CPU</option>
    <option value="nmminer-solo">NMMiner Solo — 🟢 Idéal CPU (pensé pour ESP32)</option>
    <option value="nerdminer-solo">NerdMiner Pool — 🟢 Idéal CPU (communauté active depuis 2023)</option>
    <option value="axeminer">AxeMiner Pool — 🟢 Idéal CPU (port dédié petits mineurs)</option>
    <option value="ocean">OCEAN — 🟡 Réputé (fondé par Luke Dashjr), 2% de frais sur bloc trouvé</option>
    <option value="solopool-com">SoloPool.com (EU) — 🟢 Client CPU dédié, ratio Solo Split ajustable</option>
    <option value="mineshop-solo">Mineshop.eu — 🟡 Correct, shares moyens</option>
    <option value="braiins-solo">Braiins Solo — 🟠 Shares rares en CPU</option>
    <option value="ckpool">CKPool — 🔴 Pensé pour ASIC</option>
  </select>
</div>
<div id="poolNote" style="font-size:10px;color:var(--white-dim);margin-bottom:10px;max-width:480px"></div>
<div id="poolLinks" style="display:none;margin-bottom:10px;gap:8px;flex-wrap:wrap"></div>
<div class="card full"><div id="d_workers" class="loading">Interrogation du pool…</div></div>

<h2 id="h_swarm">🌐 ESSAIM LOCAL (RÉSEAU) <span style="font-size:9px;color:var(--mut)">autres machines AXECUBE détectées sur ce réseau</span>
  <a id="l_machines" href="/machines" rel="noopener" style="font-size:9px;color:var(--amber-dim);text-decoration:none;margin-left:8px">↗ vue cartes (essai)</a></h2>
<div class="card full"><div id="d_swarm" class="loading">Recherche sur le réseau local…</div></div>

<h2 id="h_leader">CLASSEMENT AXECUBE <a id="l_via" href="#" style="font-size:9px;color:var(--amber-dim);text-decoration:none"></a></h2>
<div class="card full"><div id="d_leader" class="loading">—</div></div>

<div class="foot" id="foot"></div>
</div>
<script>
const TOK=${JSON.stringify(jeton || '')};const Q=TOK?('?token='+TOK):'';
const LEADER_URL=${JSON.stringify(leaderboardUrl || '')};
const MACHINE_ID=${JSON.stringify(machineId || '')};
let T={};
function fmtHR(h){if(!h)return'0 H/s';if(h>=1e12)return(h/1e12).toFixed(2)+' TH/s';if(h>=1e9)return(h/1e9).toFixed(2)+' GH/s';
  if(h>=1e6)return(h/1e6).toFixed(2)+' MH/s';if(h>=1e3)return(h/1e3).toFixed(2)+' kH/s';return h.toFixed(0)+' H/s'}
function fmtD(d){if(!d)return'—';if(d>=1e12)return(d/1e12).toFixed(2)+' T';if(d>=1e9)return(d/1e9).toFixed(2)+' G';
  if(d>=1e6)return(d/1e6).toFixed(2)+' M';if(d>=1e3)return(d/1e3).toFixed(2)+' k';return d>=100?d.toFixed(0):d.toPrecision(3)}
function fmtUp(s){const j=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return (j?j+'j ':'')+h+'h '+m+'min'}
function copierCode(){
  const texte=document.getElementById('d_code').textContent;
  if(!texte||texte.indexOf('(pas encore')>=0) return;
  navigator.clipboard.writeText(texte).then(()=>{
    const el=document.getElementById('d_code');
    const original=el.textContent;
    el.textContent='✅ Copié !';
    setTimeout(()=>{ el.textContent=original; }, 1200);
  }).catch(()=>{ /* copie manuelle si l'API échoue */ });
}
function allerAuJournal(){
  const cible=document.getElementById('h_journal');
  if(!cible) return;
  cible.scrollIntoView({behavior:'smooth',block:'start'});
  const carteCible=cible.nextElementSibling; // le <div class="card full"> qui suit le titre
  if(carteCible){
    carteCible.classList.remove('flash-cible');
    void carteCible.offsetWidth; // force reflow pour rejouer l'animation si déjà jouée
    carteCible.classList.add('flash-cible');
    setTimeout(()=>{ carteCible.classList.remove('flash-cible'); }, 1500);
  }
}
function card(k,v,cls){return '<div class="card"><div class="k">'+k+'</div><div class="v '+(cls||'')+'">'+v+'</div></div>'}
function graphe(hist){
  const c=document.getElementById('graph'),x=c.getContext('2d'),W=c.width,H=c.height;
  x.clearRect(0,0,W,H);if(!hist||hist.length<2){x.fillStyle='#6b7686';x.font='12px monospace';
    x.fillText('Le graphe se remplit (un point toutes les 30 s)…',16,H/2);return;}
  const vals=hist.map(p=>p.v),max=Math.max(...vals,1);
  x.strokeStyle='rgba(150,240,31,.15)';for(let i=0;i<=4;i++){const y=H-10-(H-20)*i/4;
    x.beginPath();x.moveTo(0,y);x.lineTo(W,y);x.stroke();}
  x.strokeStyle='#96f01f';x.lineWidth=2;x.shadowColor='rgba(150,240,31,.5)';x.shadowBlur=5;x.beginPath();
  hist.forEach((p,i)=>{const px=i*W/(hist.length-1),py=H-10-(p.v/max)*(H-20);i?x.lineTo(px,py):x.moveTo(px,py)});
  x.stroke();x.shadowBlur=0;x.fillStyle='#96f01f';x.font='11px monospace';x.fillText('max '+fmtD(max),8,16);
}
async function charger(){
  // On fige la position de lecture : la reconstruction du DOM ci-dessous
  // peut légèrement changer la hauteur de plusieurs blocs (journal, workers,
  // classement...), ce qui décale tout le contenu en dessous et fait perdre
  // sa place à l'utilisateur. On capture le scroll ici et on le restaure une
  // fois toutes les mises à jour (y compris les appels async) terminées.
  const scrollAvant=window.scrollY;
  const restaurerScroll=()=>{ requestAnimationFrame(()=>window.scrollTo(0,scrollAvant)); };
  let d;
  try{
    const rep=await fetch('/api/details'+Q);
    if(rep.status===401){
      document.getElementById('d_workers').innerHTML=
        '<span style="color:#ff6a78">⚠ Accès refusé (401) — le lien contient un ancien jeton, probablement '
        +'périmé depuis un redémarrage du mineur. <a href="/" style="color:var(--amber)">Retour au tableau de bord</a> '
        +'pour récupérer le lien à jour.</span>';
      return;
    }
    if(!rep.ok){
      document.getElementById('d_workers').innerHTML=
        '<span style="color:#ff6a78">⚠ Le mineur a répondu avec une erreur (HTTP '+rep.status+'). Nouvelle tentative dans 5s…</span>';
      return;
    }
    d=await rep.json();
  }catch(e){
    document.getElementById('d_workers').innerHTML=
      '<span style="color:#ff6a78">⚠ Mineur injoignable (arrêté, ou page ouverte avant son démarrage). '
      +'Nouvelle tentative automatique dans 5s…</span>';
    return;
  }
  const lg=document.getElementById('logo');if(!lg.src){
    try{const dash=await(await fetch('/'+Q)).text();const i=dash.indexOf('brand-logo');
      if(i>=0){const s2=dash.indexOf('src="',i)+5,e2=dash.indexOf('"',s2);if(s2>4&&e2>s2)lg.src=dash.slice(s2,e2);}}catch(e){}}
  document.getElementById('lretour').href='/'+Q;
  const st=document.getElementById('statut');
  st.textContent=d.stratum.connecte?'● EN LIGNE':'○ HORS LIGNE';
  st.className='badge'+(d.stratum.connecte?'':' off');
  document.getElementById('lmempool').href='https://mempool.space/address/'+d.adresse;

  // Performance
  document.getElementById('d_hr').textContent=fmtHR(d.perf.hashrate);
  document.getElementById('d_hrsub').textContent=d.machine.cpu+' · '+(d.moteur.variante||d.moteur.nom);
  const meilleurAffiche=Math.max(d.loterie.bestDiff||0, d.loterie.recordExterne||0);
  document.getElementById('d_rec').textContent=fmtD(meilleurAffiche);
  document.getElementById('d_recsub').textContent=
    (d.loterie.recordExterne>d.loterie.bestDiff)
      ? 'vu sur le pool, pas encore prouvé localement'
      : '';
  document.getElementById('d_sh').innerHTML=d.loterie.accepted+' <span style="color:var(--mut);font-size:12px">acc.</span> · '+d.loterie.rejected+' <span style="color:var(--mut);font-size:12px">rej.</span>';
  document.getElementById('d_shsub').textContent='depuis ce lancement';
  const thr=Math.round((d.perf.throttle||0)*100);
  if(d.perf.thermalReel){
    const tr=d.perf.thermalReel;
    document.getElementById('d_thr').innerHTML=tr.type==='temperature'
      ? tr.valeur.toFixed(0)+'°C'
      : tr.valeur;
  } else {
    document.getElementById('d_thr').innerHTML=thr>2?('−'+thr+'%'):'<span style="color:var(--amber)">nominal</span>';
  }
  document.getElementById('d_tot').textContent=fmtHR(d.perf.totalHashes).replace('/s','');
  document.getElementById('d_up').textContent=fmtUp(d.uptime);

  // Diff du jour + Cub's (total infini, 1 Cub's = 1 satoshi) -- fmtD est déjà défini
  // plus haut dans ce même fichier pour formater les difficultés (k/M/G...).
  document.getElementById('d_recjour').textContent=fmtD(d.loterie.bestDiffJour||0);
  document.getElementById('d_diffjour').textContent=fmtD(d.loterie.diffJour||0);
  if(d.loterie.codeAccesClassement){
    document.getElementById('d_code').textContent=d.loterie.codeAccesClassement;
  } else {
    document.getElementById('d_code').textContent='(pas encore généré)';
  }
  if(d.machine&&d.machine.machineId){
    document.getElementById('d_codesub').textContent=
      'Identifiant machine : '+d.machine.machineId+' — cliquez sur le code pour le copier';
  }
  const cubsTotal=d.loterie.diffTotalInfini||0;
  document.getElementById('d_cubs').textContent=cubsTotal.toLocaleString('fr-FR',{maximumFractionDigits:2})+" CUB'S";
  {
    const sats=Math.floor(cubsTotal);
    const btcEquiv=sats/1e8;
    const sub=[sats.toLocaleString('fr-FR')+' sats'];
    if(d.marche&&d.marche.btcPrice){
      sub.push('≈ '+(btcEquiv*d.marche.btcPrice).toLocaleString('fr-FR',{maximumFractionDigits:2})+' '+d.marche.btcSymbol);
    }
    if(d.loterie.diffInfiniDepuis){
      const dt=new Date(d.loterie.diffInfiniDepuis);
      sub.push('depuis le '+dt.toLocaleDateString('fr-FR'));
    }
    document.getElementById('d_cubssub').textContent=sub.join(' · ');
  }

  // Journal des gains : groupé par mois, façon registre chronologique.
  // Chaque mois est un bloc repliable (accordéon natif <details>) ; le mois
  // en cours est ouvert par défaut, les mois passés sont repliés pour garder
  // la lecture lisible même après des mois/années d'historique.
  {
    const journal=d.loterie.journalJour||[];
    const boiteJournal=document.getElementById('d_journal');
    if(!journal.length){
      boiteJournal.innerHTML='<span style="color:var(--mut)">Aucun jour archivé pour le moment -- le premier bloc apparaitra demain.</span>';
    } else {
      const trie=[...journal].reverse(); // plus récent en premier
      // Regroupement par clé AAAA-MM, en conservant l'ordre du plus récent au plus ancien
      const groupes=[];
      const parMois={};
      trie.forEach((j,i)=>{
        const cle=j.date.slice(0,7);
        if(!parMois[cle]){
          const g={cle, entrees:[]};
          parMois[cle]=g;
          groupes.push(g);
        }
        parMois[cle].entrees.push({j, numeroBloc:journal.length-i});
      });
      const moisCourantCle=new Date().toISOString().slice(0,7);
      if(journalPremierRendu){ moisJournalOuverts.add(moisCourantCle); journalPremierRendu=false; }
      // On mémorise la position de scroll du bloc journal avant de le
      // reconstruire, pour ne pas faire "sauter" la lecture au rafraîchissement.
      const ancienScroll=document.getElementById('d_journalScroll');
      const scrollJournalAvant=ancienScroll?ancienScroll.scrollTop:0;
      const blocsMois=groupes.map(g=>{
        const dtMois=new Date(g.cle+'-01T00:00:00');
        const labelMois=dtMois.toLocaleDateString('fr-FR',{month:'long',year:'numeric'}).toUpperCase();
        const nbJours=g.entrees.length;
        const ouvert=(moisJournalOuverts.has(g.cle))?' open':'';
        const lignes=g.entrees.map(({j,numeroBloc})=>{
          const dt=new Date(j.date+'T00:00:00');
          const dateAffichee=dt.toLocaleDateString('fr-FR',{weekday:'short',day:'2-digit',month:'short',year:'numeric'});
          const lienJour='/details/jour?date='+j.date+(Q?Q.replace('?','&'):'');
          const vide=!!j.sansActivite;
          return '<tr class="ligneJournal'+(vide?' ligneVide':'')+'" data-date="'+j.date+'"'+(vide?' title="Aucune activité de minage ce jour-l\u00e0"':'')+'>'
            +'<td style="color:var(--mut);font-size:11px">#'+numeroBloc+'</td>'
            +'<td><a class="lienJournal" href="'+lienJour+'" target="_blank" rel="noopener" title="Ouvrir le détail de cette journée dans un nouvel onglet">'+dateAffichee+'</a></td>'
            +'<td>'+(vide?'<span style="color:var(--mut)">— (inactif)</span>':fmtD(j.bestDiff||0))+'</td>'
            +'<td>'+(vide?'<span style="color:var(--mut)">—</span>':fmtD(j.diffTotal||0))+'</td>'
            +'</tr>';
        }).join('');
        return '<details class="moisJournal" data-mois="'+g.cle+'"'+ouvert+'>'
          +'<summary>'+labelMois+' <span class="moisCompte">('+nbJours+' jour'+(nbJours>1?'s':'')+')</span></summary>'
          +'<table><thead><tr><th>BLOC</th><th>DATE</th><th>MEILLEURE DIFF</th><th>TOTAL DIFF</th></tr></thead>'
          +'<tbody>'+lignes+'</tbody></table></details>';
      }).join('');
      boiteJournal.innerHTML='<div id="d_journalScroll" style="max-height:480px;overflow-y:auto;border:1px solid var(--line);border-radius:8px;padding:2px 4px">'
        +blocsMois+'</div>';
      // On restaure la position de scroll interne du bloc journal.
      const nouveauScroll=document.getElementById('d_journalScroll');
      if(nouveauScroll) nouveauScroll.scrollTop=scrollJournalAvant;
      // On mémorise chaque ouverture/fermeture manuelle d'un mois, pour que
      // ça survive au prochain rafraîchissement automatique.
      document.querySelectorAll('.moisJournal').forEach(det=>{
        det.addEventListener('toggle',()=>{
          const cle=det.getAttribute('data-mois');
          if(det.open) moisJournalOuverts.add(cle); else moisJournalOuverts.delete(cle);
        });
      });
    }
  }

  graphe(d.histRecord);

  // Cœurs
  const mx=Math.max(...d.perf.perThread.map(t=>t.rate),1);
  document.querySelector('#t_cores tbody').innerHTML=
    '<tr><th>CŒUR</th><th>HASHRATE</th><th style="width:45%">PART</th></tr>'+
    d.perf.perThread.map(t=>'<tr><td>T'+t.id+'</td><td>'+fmtHR(t.rate)+
      '</td><td><div style="background:var(--panel2);border-radius:2px;height:8px"><div style="width:'+
      Math.round(t.rate/mx*100)+'%;height:100%;background:var(--amber-faint);border-radius:2px"></div></div></td></tr>').join('');

  // Pool & Stratum
  document.getElementById('g_pool').innerHTML=
    card('POOL',d.pool.nom)+card('PORT',d.pool.port)+
    card('CONNEXION',d.stratum.connecte?'établie':'coupée',d.stratum.connecte?'ok':'bad')+
    card('DIFFICULTÉ POOL',fmtD(d.stratum.poolDiff))+
    card('EXTRANONCE1',d.stratum.extranonce1||'—','sm')+
    card('JOB EN COURS',d.stratum.jobId||'—','sm');

  // Réseau
  document.getElementById('g_net').innerHTML=
    card('HASHRATE RÉSEAU',fmtHR(d.loterie.netHashrate))+
    card('DIFFICULTÉ RÉSEAU',fmtD(d.loterie.netDiff))+
    card('BLOC EN COURS',d.bloc.hauteur?d.bloc.hauteur.toLocaleString('fr-FR'):'—')+
    card('COURS BTC',d.marche.btcPrice?Math.round(d.marche.btcPrice).toLocaleString('fr-FR')+' '+d.marche.btcSymbol:'—');

  // Paiement
  const p=d.paiement;
  if(p){const btc=(p.satoshis/1e8).toFixed(8);const sym=d.reseau?d.reseau.symbole:'BTC';
    let et=p.etat==='complet'?'intégral':p.etat==='partiel'?(Math.round(p.part*100)+'% des sorties'):p.etat;
    document.getElementById('g_pay').innerHTML=
      card('CE QUI VOUS REVIENDRAIT',btc+' '+sym,p.etat==='complet'?'ok':(p.part>=0.5?'':'bad'))+
      card('PART',et,p.part>=0.99?'ok':(p.part>=0.5?'':'bad'))+
      card('VALEUR ESTIMÉE',(d.marche.btcPrice&&sym==='BTC')?Math.round(p.satoshis/1e8*d.marche.btcPrice).toLocaleString('fr-FR')+' '+d.marche.btcSymbol:'—')+
      card('VOTRE ADRESSE',d.adresse,'sm');}
  else document.getElementById('g_pay').innerHTML='<div class="loading">En attente d\\'un job du pool…</div>';

  // Workers du pool (appel direct navigateur → API public-pool)
  chargerWorkers(d).then(restaurerScroll);
  chargerSwarm().then(restaurerScroll);
  chargerLeader(d).then(restaurerScroll);
  const lienMachines=document.getElementById('l_machines');
  if(lienMachines) lienMachines.href='/machines'+Q;
  const HOTE_VERS_PRESET={'public-pool.io':'solopool','solo.stratum.braiins.com':'braiins-solo',
    'solo.ckpool.org':'ckpool','stratum-de.solo.mineshop.eu':'mineshop-solo','solobtc.nmminer.com':'nmminer-solo','pool.nerdminer.io':'nerdminer-solo','pool.axeminer.com':'axeminer','mine.ocean.xyz':'ocean','eu.solopool.com':'solopool-com'};
  const selPool=document.getElementById('sel_pool');
  const cleActuelle=HOTE_VERS_PRESET[d.pool.hote]||'';
  if(selPool && document.activeElement!==selPool){ selPool.value=cleActuelle; afficherNotePool(cleActuelle); }
  restaurerScroll();
}
const NOTES_POOL={
  solopool:{c:'var(--amber)',t:'🟢 Difficulté minimale de 1, ajustée automatiquement à votre hashrate (vardiff) -- '
    +'le plus adapté pour un CPU, vous verrez des shares régulièrement.'},
  'nmminer-solo':{c:'var(--amber)',t:'🟢 Fork de public-pool.io conçu à l\\'origine pour des puces ESP32 (quelques '
    +'centaines de kH/s) -- plancher de difficulté très bas, shares très fréquents attendus sur un CPU.'},
  'nerdminer-solo':{c:'var(--amber)',t:'🟢 Pool communautaire établi depuis 2023, très actif (Bitaxe, NMMiner, '
    +'NerdAxe et Multi NerdMiner y cohabitent) -- outil de vérification publique par adresse disponible sur '
    +'pool.nerdminer.io.'},
  axeminer:{c:'var(--amber)',t:'🟢 "Where Small Miners Make Big Swings" -- port 7777 officiellement dédié aux '
    +'petits mineurs USB (NMMiner, NerdMiner, ESP-32), difficulté plancher confirmée à 0.01 -- shares très '
    +'fréquents attendus sur CPU.'},
  ocean:{c:'#e8b64a',t:'🟡 Pool réputé fondé par Luke Dashjr (développeur Bitcoin Core) et soutenu par Jack '
    +'Dorsey -- design non-custodial, aucun compte requis. 2% de frais, mais uniquement prélevés si un bloc '
    +'est réellement trouvé -- jamais sur les parts normales.'},
  'solopool-com':{c:'var(--amber)',t:'🟢 Possède un client CPU dédié en open-source (SHA256-NI). Fonctionnalité '
    +'unique "Solo Split" : dose librement le ratio solo/pool via le mot de passe. 2% de frais dev, '
    +'uniquement prélevés sur un bloc réellement trouvé.'},
  'mineshop-solo':{c:'#e8b64a',t:'🟡 Difficulté minimale de 100 imposée par le pool -- shares moins fréquents que sur '
    +'public-pool.io, mais tout à fait normal.'},
  'braiins-solo':{c:'#e8a64a',t:'🟠 Difficulté minimale de 512 imposée par le pool -- les shares seront rares avec '
    +'un hashrate CPU.'},
  ckpool:{c:'#ff5d5d',t:'🔴 Difficulté minimale de 10 000 -- ce pool cible les machines ASIC. À hashrate CPU, vos '
    +'shares resteront probablement invisibles la plupart du temps.'},
};
function afficherNotePool(cle){
  const el=document.getElementById('poolNote'); if(!el)return;
  const n=NOTES_POOL[cle];
  if(!n){ el.textContent=''; return; }
  el.style.color=n.c; el.textContent=n.t;
}
async function chargerWorkers(d){
  const box=document.getElementById('d_workers');
  const hote=d.pool.hote||'';
  const estPublicPool=/public-pool\\.io/i.test(hote);
  const estMineshop=/mineshop\\.eu/i.test(hote);
  const estNmminer=/nmminer\\.com/i.test(hote);
  const estSolopool=/solopool\\.com/i.test(hote);
  const estNerdminer=/nerdminer\\.io/i.test(hote);
  const estAxeminer=/axeminer\\.com/i.test(hote);
  document.getElementById('w_via').textContent=estPublicPool?'(via public-pool.io)':estMineshop?'(via mineshop.eu)':estNmminer?'(via nmminer.com)':estSolopool?'(via solopool.com)':estNerdminer?'(via nerdminer.io)':estAxeminer?'(via axeminer.com)':'';
  const liens=document.getElementById('poolLinks');
  if(estPublicPool){
    liens.style.display='flex';
    liens.innerHTML=
      '<a href="https://web.public-pool.io/#/app/'+d.adresse+'" target="_blank" rel="noopener" '+
      'style="font-size:11px;color:var(--amber);border:1px solid rgba(150,240,31,.3);padding:6px 12px;'+
      'border-radius:8px;text-decoration:none">📊 Voir sur public-pool.io ↗</a>'+
      '<a href="https://public-pool.io:40557/api/client/'+d.adresse+'" target="_blank" rel="noopener" '+
      'style="font-size:11px;color:var(--white-dim);border:1px solid var(--line);padding:6px 12px;'+
      'border-radius:8px;text-decoration:none">{ } Données brutes (JSON) ↗</a>';
  } else if(estMineshop){
    liens.style.display='flex';
    liens.innerHTML=
      '<a href="https://solo.mineshop.eu/miner/?wallet='+d.adresse+'" target="_blank" rel="noopener" '+
      'style="font-size:11px;color:var(--amber);border:1px solid rgba(150,240,31,.3);padding:6px 12px;'+
      'border-radius:8px;text-decoration:none">📊 Voir sur mineshop.eu ↗</a>'+
      '<a href="https://solo.mineshop.eu/api/miner.php?wallet='+d.adresse+'" target="_blank" rel="noopener" '+
      'style="font-size:11px;color:var(--white-dim);border:1px solid var(--line);padding:6px 12px;'+
      'border-radius:8px;text-decoration:none">{ } Données brutes (JSON) ↗</a>';
  } else if(estNmminer){
    liens.style.display='flex';
    liens.innerHTML=
      '<a href="https://solobtc.nmminer.com/#/app/'+d.adresse+'" target="_blank" rel="noopener" '+
      'style="font-size:11px;color:var(--amber);border:1px solid rgba(150,240,31,.3);padding:6px 12px;'+
      'border-radius:8px;text-decoration:none">📊 Voir sur solobtc.nmminer.com ↗</a>'+
      '<a href="https://solobtc.nmminer.com/api/client/'+d.adresse+'" target="_blank" rel="noopener" '+
      'style="font-size:11px;color:var(--white-dim);border:1px solid var(--line);padding:6px 12px;'+
      'border-radius:8px;text-decoration:none">{ } Données brutes (JSON) ↗</a>';
  } else if(estSolopool){
    liens.style.display='flex';
    liens.innerHTML=
      '<a href="https://solopool.com/user.html?network=mainnet&address='+d.adresse+'" target="_blank" rel="noopener" '+
      'style="font-size:11px;color:var(--amber);border:1px solid rgba(150,240,31,.3);padding:6px 12px;'+
      'border-radius:8px;text-decoration:none">📊 Voir sur solopool.com ↗</a>'+
      '<a href="https://solopool.com/web-api.php?endpoint=miner/mainnet/'+d.adresse+'" target="_blank" rel="noopener" '+
      'style="font-size:11px;color:var(--white-dim);border:1px solid var(--line);padding:6px 12px;'+
      'border-radius:8px;text-decoration:none">{ } Données brutes (JSON) ↗</a>';
  } else if(estNerdminer){
    liens.style.display='flex';
    liens.innerHTML=
      '<a href="https://pool.nerdminer.io/" target="_blank" rel="noopener" '+
      'style="font-size:11px;color:var(--amber);border:1px solid rgba(150,240,31,.3);padding:6px 12px;'+
      'border-radius:8px;text-decoration:none">📊 Voir sur pool.nerdminer.io ↗</a>'+
      '<a href="https://pool.nerdminer.io/api/miner?address='+d.adresse+'" target="_blank" rel="noopener" '+
      'style="font-size:11px;color:var(--white-dim);border:1px solid var(--line);padding:6px 12px;'+
      'border-radius:8px;text-decoration:none">{ } Données brutes (JSON) ↗</a>';
  } else if(estAxeminer){
    liens.style.display='flex';
    liens.innerHTML=
      '<a href="https://axeminer.com/#/app/'+d.adresse+'" target="_blank" rel="noopener" '+
      'style="font-size:11px;color:var(--amber);border:1px solid rgba(150,240,31,.3);padding:6px 12px;'+
      'border-radius:8px;text-decoration:none">📊 Voir sur axeminer.com ↗</a>'+
      '<a href="https://axeminer.com/api/client/'+d.adresse+'" target="_blank" rel="noopener" '+
      'style="font-size:11px;color:var(--white-dim);border:1px solid var(--line);padding:6px 12px;'+
      'border-radius:8px;text-decoration:none">{ } Données brutes (JSON) ↗</a>';
  } else liens.style.display='none';
  if(!estPublicPool && !estMineshop && !estNmminer && !estSolopool && !estNerdminer && !estAxeminer){box.innerHTML='<span style="color:var(--mut)">Disponible uniquement sur public-pool.io, Mineshop.eu, NMMiner Solo, SoloPool.com, NerdMiner Pool ou AxeMiner.</span>';return;}
  try{
    if(estPublicPool || estNmminer){
      // NMMiner Solo est un fork de public-pool.io -- même schéma de données (tableau
      // "workers", bestDifficulty), MAIS PAS le même port : contrairement à public-pool.io
      // (qui expose son API sur le port 40557), ce fork sert son API directement sur le
      // domaine principal, sans port dédié -- confirmé en inspectant les requêtes réseau
      // du site officiel solobtc.nmminer.com le 03/08/2026.
      const urlApi = estPublicPool ? 'https://public-pool.io:40557/api/client/'+d.adresse
                                    : 'https://solobtc.nmminer.com/api/client/'+d.adresse;
      const r=await fetch(urlApi);
      const j=await r.json();
      const w=j.workers||[];
      if(!w.length){box.innerHTML='<span style="color:var(--mut)">Aucun worker actif signalé par le pool (délai de quelques minutes).</span>';return;}
      box.innerHTML='<table><tr><th>WORKER</th><th>HASHRATE (pool)</th><th>MEILLEURE DIFF</th><th>DIFF SESSION</th></tr>'+
        w.map(x=>{const moi=x.name===d.worker;
          return '<tr><td class="'+(moi?'me':'')+'">'+(x.name||'—')+(moi?' ◄ vous':'')+'</td><td>'+
          fmtHR(parseFloat(x.hashRate)||0)+'</td><td>'+fmtD(parseFloat(x.bestDifficulty)||0)+
          '</td><td>'+fmtD(parseFloat(x.sessionDifficulty)||0)+'</td></tr>';}).join('')+'</table>'+
        (j.bestDifficulty?'<div style="margin-top:10px;font-size:11px;color:var(--amber-dim)">Meilleure difficulté tous workers confondus : <b style="color:var(--amber)">'+fmtD(parseFloat(j.bestDifficulty))+'</b></div>':'');
    } else if(estMineshop || estNerdminer){ // Mineshop.eu ET NerdMiner Pool partagent le même
      // schéma CKPool classique (objet racine + tableau "worker") -- confirmé le 04/08/2026
      // via les requêtes réseau du site officiel pool.nerdminer.io.
      const urlCk = estMineshop ? 'https://solo.mineshop.eu/api/miner.php?wallet='+d.adresse
                                 : 'https://pool.nerdminer.io/api/miner?address='+d.adresse;
      const r=await fetch(urlCk);
      const j=await r.json();
      const w=Array.isArray(j.worker)?j.worker:(j.worker?[j.worker]:[]);
      if(!w.length){box.innerHTML='<span style="color:var(--mut)">Aucun worker actif signalé par le pool (délai de quelques minutes).</span>';return;}
      box.innerHTML='<table><tr><th>WORKER</th><th>HASHRATE (1h)</th><th>MEILLEURE DIFF</th></tr>'+
        w.map(x=>{
          const nom=(x.workername||'').indexOf('.')>=0?x.workername.split('.').slice(1).join('.'):(x.workername||'—');
          const moi=nom===d.worker;
          return '<tr><td class="'+(moi?'me':'')+'">'+nom+(moi?' ◄ vous':'')+'</td><td>'+
          (x.hashrate1hr||'—')+'</td><td>'+fmtD(Number(x.bestever)||Number(x.bestshare)||0)+'</td></tr>';
        }).join('')+'</table>'+
        ((j.bestever||j.bestshare)?'<div style="margin-top:10px;font-size:11px;color:var(--amber-dim)">Meilleure difficulté tous workers confondus : <b style="color:var(--amber)">'+fmtD(Number(j.bestever)||Number(j.bestshare))+'</b></div>':'');
    } else if(estSolopool){
      // Schéma confirmé le 04/08/2026 via les requêtes réseau du site officiel :
      // networks.mainnet.workers[] avec workername (deja au format adresse.worker),
      // hashrate_1hr, best_share -- et un bloc payout.if_you_find_sats pratique en bonus.
      const r=await fetch('https://solopool.com/web-api.php?endpoint=miner/mainnet/'+d.adresse);
      const j=await r.json();
      const infos=(j.networks&&j.networks.mainnet)||null;
      const w=(infos&&infos.workers)||[];
      if(!w.length){box.innerHTML='<span style="color:var(--mut)">Aucun worker actif signalé par le pool (délai de quelques minutes).</span>';return;}
      box.innerHTML='<table><tr><th>WORKER</th><th>HASHRATE (1h)</th><th>MEILLEURE DIFF</th><th>PARTS (accept./rejet.)</th></tr>'+
        w.map(x=>{
          const nom=(x.workername||'').indexOf('.')>=0?x.workername.split('.').slice(1).join('.'):(x.workername||'—');
          const moi=nom===d.worker;
          return '<tr><td class="'+(moi?'me':'')+'">'+nom+(moi?' ◄ vous':'')+'</td><td>'+
          (x.hashrate_1hr||'—')+'</td><td>'+fmtD(Number(x.best_share)||0)+
          '</td><td>'+(x.lifetime_accepts||0)+' / '+(x.lifetime_rejects||0)+'</td></tr>';
        }).join('')+'</table>'+
        (infos.bestshare?'<div style="margin-top:10px;font-size:11px;color:var(--amber-dim)">Meilleure difficulté tous workers confondus : <b style="color:var(--amber)">'+fmtD(Number(infos.bestshare))+'</b></div>':'')+
        (infos.payout&&infos.payout.if_you_find_sats?'<div style="margin-top:4px;font-size:11px;color:var(--white-dim)">Si un bloc est trouvé maintenant : <b style="color:var(--amber)">'+Number(infos.payout.if_you_find_sats).toLocaleString('fr-FR')+' sats</b> pour toi</div>':'');
    } else if(estAxeminer){
      // AxeMiner garde un historique PAR SESSION (chaque redémarrage crée une nouvelle
      // entrée avec sa propre bestDifficulty repartie de 0) -- on regroupe donc par nom de
      // worker : la MEILLEURE difficulté retenue est le maximum toutes sessions confondues
      // (même logique que côté serveur, voir synchroniserRecordEtStats), et le hashrate
      // affiché est celui de la session la plus récente (lastSeen le plus proche).
      const r=await fetch('https://axeminer.com/api/client/'+d.adresse);
      const j=await r.json();
      const brut=j.workers||[];
      if(!brut.length){box.innerHTML='<span style="color:var(--mut)">Aucun worker actif signalé par le pool (délai de quelques minutes).</span>';return;}
      const parNom={};
      for(const s of brut){
        const nom=s.name||'—';
        if(!parNom[nom]) parNom[nom]={meilleure:0,hashrate:0,dernierVu:0};
        const diff=parseFloat(s.bestDifficulty)||0;
        if(diff>parNom[nom].meilleure) parNom[nom].meilleure=diff;
        const vu=s.lastSeen?new Date(s.lastSeen).getTime():0;
        if(vu>=parNom[nom].dernierVu){ parNom[nom].dernierVu=vu; parNom[nom].hashrate=parseFloat(s.hashRate)||0; }
      }
      const noms=Object.keys(parNom);
      let meilleurGlobal=0;
      box.innerHTML='<table><tr><th>WORKER</th><th>HASHRATE (session récente)</th><th>MEILLEURE DIFF (toutes sessions)</th></tr>'+
        noms.map(nom=>{
          const info=parNom[nom];
          if(info.meilleure>meilleurGlobal) meilleurGlobal=info.meilleure;
          const moi=nom===d.worker;
          return '<tr><td class="'+(moi?'me':'')+'">'+nom+(moi?' ◄ vous':'')+'</td><td>'+
          fmtHR(info.hashrate)+'</td><td>'+fmtD(info.meilleure)+'</td></tr>';
        }).join('')+'</table>'+
        (meilleurGlobal?'<div style="margin-top:10px;font-size:11px;color:var(--amber-dim)">Meilleure difficulté tous workers confondus (toutes sessions) : <b style="color:var(--amber)">'+fmtD(meilleurGlobal)+'</b></div>':'');
    }
  }catch(e){box.innerHTML='<span style="color:var(--mut)">Pool injoignable (CORS ou hors ligne). Vos données restent visibles ci-dessus.</span>';}
}
let leaderData=null, leaderFenetre='mois', leaderCategorie='cpu';
function rendreLeader(d){
  const box=document.getElementById('d_leader');
  if(!leaderData)return;
  const bloc=leaderData[leaderCategorie]||{jour:[],semaine:[],mois:[],allTime:[]};
  const list=bloc[leaderFenetre]||[];
  const categories=[['cpu','🧠 CPU'],['asic','⚡ ASIC / BITAXE']];
  const barreCat='<div class="lead-tabs">'+categories.map(([cle,lbl])=>
    '<button class="lead-tab'+(cle===leaderCategorie?' on':'')+'" data-cat="'+cle+'">'+lbl+'</button>').join('')+'</div>';
  const onglets=[['jour','JOUR'],['semaine','SEMAINE'],['mois','MOIS'],['allTime','TOUJOURS']];
  const barre='<div class="lead-tabs">'+onglets.map(([cle,lbl])=>
    '<button class="lead-tab'+(cle===leaderFenetre?' on':'')+'" data-fen="'+cle+'">'+lbl+'</button>').join('')+'</div>';
  const tableau=list.length
    ? '<table><tr><th>#</th><th>MINEUR</th><th>MACHINE</th><th>POOL</th><th>MEILLEURE DIFF</th></tr>'+
      list.slice(0,50).map((e,i)=>'<tr><td>'+(i+1)+'</td><td>'+(e.worker||'anon')+'</td><td style="color:var(--mut)">'+
      (e.cpu||'—')+'</td><td style="color:var(--mut);font-size:11px">'+(e.poolRecord||'—')+'</td><td class="'+(e.worker===d.worker?'me':'')+'">'+fmtD(e.bestDiff)+'</td></tr>').join('')+'</table>'
    : '<span style="color:var(--mut)">Aucun record sur cette période pour l\\'instant'+(leaderCategorie==='asic'?' (aucun ASIC recensé)':'')+'.</span>';
  box.innerHTML=barreCat+barre+tableau;
  box.querySelectorAll('.lead-tab[data-cat]').forEach(b=>b.addEventListener('click',()=>{
    leaderCategorie=b.dataset.cat; rendreLeader(d);
  }));
  box.querySelectorAll('.lead-tab[data-fen]').forEach(b=>b.addEventListener('click',()=>{
    leaderFenetre=b.dataset.fen; rendreLeader(d);
  }));
}
// Mois du journal ouverts manuellement par l'utilisateur (clé AAAA-MM) --
// persiste entre les rafraîchissements pour ne pas refermer un mois que
// l'utilisateur a volontairement déplié.
const moisJournalOuverts=new Set();
let journalPremierRendu=true;
async function chargerSwarm(){
  const box=document.getElementById('d_swarm');
  try{
    const r=await(await fetch('/api/swarm'+Q)).json();
    const liste=r.machines||[];
    if(!liste.length){
      box.innerHTML='<span style="color:var(--mut)">Aucune autre machine AXECUBE détectée sur ce réseau local pour l\\'instant.</span>';
      return;
    }
    box.innerHTML='<table><tr><th>MACHINE</th><th>CPU</th><th>ADRESSE IP</th><th>HASHRATE</th><th>MEILLEURE DIFF</th><th>POOL</th></tr>'+
      liste.map(m=>'<tr><td>'+(m.worker||'—')+'</td><td>'+(m.cpu||'—')+'</td><td>'+(m.ip||'—')+'</td><td>'+
        fmtHR(m.hashrate||0)+'</td><td>'+fmtD(m.bestDiff||0)+'</td><td>'+(m.pool||'—')+'</td></tr>').join('')+'</table>';
  }catch(e){box.innerHTML='<span style="color:var(--mut)">Recherche réseau indisponible.</span>';}
}
async function chargerLeader(d){
  const box=document.getElementById('d_leader');
  if(!LEADER_URL){box.innerHTML='<span style="color:var(--mut)">Classement communautaire non configuré. '+
    'Pour l\\'activer, lancez AXECUBE avec <code style="color:var(--amber)">--leaderboard https://votre-serveur</code>.</span>';return;}
  // Lien de retour : quand on clique depuis le classement public sur "retour au mineur",
  // cette URL (avec le token si le dashboard est protégé) permet de revenir directement ici,
  // sur cette même machine/onglet -- au lieu d'atterrir sur une page générique sans contexte.
  const retour=encodeURIComponent(location.origin+'/details'+Q);
  const via=LEADER_URL.startsWith('https://')?LEADER_URL.slice(8):LEADER_URL.startsWith('http://')?LEADER_URL.slice(7):LEADER_URL;
  const lienVia=document.getElementById('l_via');
  lienVia.textContent='(via '+via+' ↗)';
  lienVia.href=LEADER_URL+(LEADER_URL.includes('?')?'&':'?')+'back='+retour;
  try{
    // publie mon record puis récupère les classements (jour/semaine/mois/toujours), séparés
    // entre petits mineurs CPU et grosses machines (ASIC type Bitaxe)
    const base=LEADER_URL.endsWith('/')?LEADER_URL.slice(0,-1):LEADER_URL;
    await fetch(base+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({worker:d.worker,bestDiff:d.loterie.bestDiff,hashrate:d.perf.hashrate,cpu:d.machine.cpu,machineId:d.machineId,pool:d.pool.nom,
                            headerHex:d.loterie.bestProofHeader||null,
                            diffPeriode:d.loterie.bestDiffRecent||0,headerHexPeriode:d.loterie.bestProofHeaderRecent||null,
                            accepted:d.loterie.accepted||0,totalHashes:d.perf.totalHashes||0})}).catch(()=>{});
    const j=await(await fetch(base+'/top')).json();
    leaderData={
      cpu: j.cpu || {jour:j.jour||[],semaine:j.semaine||[],mois:j.mois||[],allTime:j.allTime||j.top||j||[]},
      asic: j.asic || {jour:[],semaine:[],mois:[],allTime:[]},
    };
    rendreLeader(d);
  }catch(e){box.innerHTML='<span style="color:var(--mut)">Serveur de classement injoignable.</span>';}
}
document.getElementById('foot').textContent='AXECUBE · minage solo réel · les données du pool proviennent directement de public-pool.io, celles du réseau sont déduites de la difficulté.';
document.getElementById('sel_pool').addEventListener('change', async (e)=>{
  const val=e.target.value; if(!val) return;
  afficherNotePool(val);
  e.target.disabled=true;
  try{ await fetch('/api/pool?preset='+encodeURIComponent(val)+(TOK?'&token='+TOK:'')); }catch(_){}
  setTimeout(()=>{e.target.disabled=false;}, 3000);
});
charger();setInterval(charger,5000);
</script></body></html>`;

  function genererMachinesHTML() {
    const cv = configVisuel;
    return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#05070a">
<title>AXECUBE — Machines connectées</title>
<style>
  :root{
    --bg:#07090c; --line:#1c2029;
    --amber:#96f01f; --amber-dim:rgba(150,240,31,.6); --amber-faint:rgba(150,240,31,.32);
    --glow:0 0 10px rgba(150,240,31,.35);
    --white:#e8edf5; --white-dim:rgba(232,237,245,.6); --mut:#6b7686;
    --mono:ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--white);font-family:var(--mono);
       padding:20px;padding-top:max(20px,env(safe-area-inset-top));line-height:1.5}
  .wrap{max-width:1300px;margin:0 auto}
  header{display:flex;align-items:center;gap:14px;padding-bottom:18px;
         border-bottom:1px solid var(--line);margin-bottom:28px;flex-wrap:wrap}
  .lien{color:var(--amber);text-decoration:none;font-size:12px;border:1px solid var(--amber-faint);
        padding:7px 13px;border-radius:8px}
  .lien:hover{border-color:var(--amber)}
  h1{font-size:16px;font-weight:600;color:var(--amber);text-shadow:var(--glow)}
  .sub{font-size:11px;color:var(--mut);margin-top:8px;flex-basis:100%}
  .grille{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:18px;justify-items:center}
  /* Mode solo (panneau flottant) : plus d'en-tête, plus de grille -- une seule carte,
     bien centrée, fond transparent pour se fondre dans la fenêtre flottante. */
  /* Mode solo (panneau flottant) : une seule carte, qui remplit toute la fenêtre en
     gardant ses proportions -- centrée, sans bande vide ni découpe, quelle que soit la
     taille réelle de la fenêtre flottante (le navigateur ne respecte pas toujours
     exactement la taille demandée à l'ouverture). display:contents sur .wrap/.grille
     retire leur boîte (marges/paddings d'origine) pour laisser .carteMachine se
     dimensionner librement par rapport au corps de la page, pas par rapport à eux.*/
  html.solo,html.solo body{height:100%;margin:0}
  html.solo,html.solo body{height:100vh;height:100dvh} /* dvh = hauteur RÉELLEMENT
    visible sur mobile (barre d'adresse comprise/exclue selon son état) -- 100vh seul
    est peu fiable sur Safari iOS, qui le calcule contre la fenêtre repliée même quand la
    barre est affichée, laissant un vide en bas de la vraie zone visible. La ligne
    height:100vh sert de repli pour les navigateurs (rares) qui ne connaissent pas dvh. */
  html.solo body{padding:0;background:#05070a;display:flex;align-items:center;justify-content:center;overflow:hidden}
  html.solo header,html.solo .sub{display:none}
  html.solo .wrap,html.solo .grille{all:unset;display:contents}
  /* Technique "contain" standard : width/height à 100%, bornés chacun par une valeur
     dérivée de l'AUTRE dimension de la fenêtre (via vw/dvh) selon le vrai ratio de la
     carte -- contrairement à un simple width:auto+height:100%, ça ne se contredit
     jamais, quelle que soit la forme de la fenêtre (même très haute et étroite, ou très
     large et basse, y compris sur mobile). aspect-ratio verrouille le résultat.
     min-width/min-height : seuil vérifié manuellement (mode test ?configPip=1) --
     218x330 encore propre, en dessous le texte de l'écran commence à se chevaucher. */
  html.solo .carteMachine{width:100%;height:100%;
    max-width:calc(100vh*1023/1537);max-height:calc(100vw*1537/1023);
    max-width:calc(100dvh*1023/1537);
    min-width:218px;min-height:330px;aspect-ratio:1023/1537;margin:auto}
  .carteMachine{position:relative;width:100%;max-width:215px;aspect-ratio:1023/1537;container-type:size;container-name:carte;
    background-image:var(--carte-image, url('/assets/bitaxe-board.png?v=${CACHE_CARTE}${jeton ? '&token='+jeton : ''}'));background-size:contain;background-repeat:no-repeat;
    filter:drop-shadow(0 10px 24px rgba(0,0,0,.55))}
  .carteMachine.hors-ligne{filter:grayscale(1) opacity(.45)}
  .carteMachine.hors-ligne .contourGlow,.carteMachine.hors-ligne .barreGlow{animation-play-state:paused;opacity:.15}
  /* Fond noir rond : cache l'hélice imprimée sur la photo d'origine, pour que seul le
     ventilateur animé (ci-dessous) soit visible en train de tourner par-dessus. */
  .fondNoir{position:absolute;left:var(--z-fondnoir-left,${cv.fondNoir.left}%);top:var(--z-fondnoir-top,${cv.fondNoir.top}%);width:var(--z-fondnoir-width,${cv.fondNoir.width}%);aspect-ratio:1/1;
    border-radius:50%;background:#000}
  /* Ventilateur : disque de pales, tourne par-dessus le fond noir et le cadre fixe de la photo.
     Trois états : tourne à pleine vitesse (par défaut), ralentit progressivement au moment
     précis où la machine tombe hors ligne (joué une seule fois), puis reste immobile. */
  .ventilo{position:absolute;left:var(--z-ventilo-left,${cv.ventilo.left}%);top:var(--z-ventilo-top,${cv.ventilo.top}%);width:var(--z-ventilo-width,${cv.ventilo.width}%);aspect-ratio:1/1;
    background-image:var(--fan-blade, url('/assets/fan-blade.png?v=${CACHE_VENTILO}${jeton ? '&token='+jeton : ''}'));background-size:contain;background-repeat:no-repeat;
    animation-name:tournerVentilo;animation-duration:var(--z-ventilo-vitesse,.1s);animation-timing-function:linear;animation-iteration-count:infinite;
    transform-origin:var(--z-ventilo-pivotx,${cv.ventilo.pivotX}%) var(--z-ventilo-pivoty,${cv.ventilo.pivotY}%);
    filter:blur(var(--z-ventilo-flou,1.8px));will-change:transform}
  .ventilo.ralentit{animation:ralentirVentilo 1.8s cubic-bezier(.25,.1,.25,1) 1 forwards;filter:blur(1.2px)}
  .ventilo.arrete{animation:none;transform:rotate(0deg);filter:none}
  /* Logo : enfant du ventilateur, donc tourne automatiquement avec lui (solidaire des pales).
     mix-blend-mode:screen fait disparaître son fond noir sans avoir besoin de détourage.
     Masqué entièrement sur les skins dont l'hélice contient déjà son propre logo dessiné
     (voir carteMachine.sans-logo-ventilo, posée quand cube.zonesSkin.logoVentilo est null). */
  .logoVentilo{position:absolute;left:var(--z-logo-left,${cv.logoVentilo.left}%);top:var(--z-logo-top,${cv.logoVentilo.top}%);width:var(--z-logo-width,${cv.logoVentilo.width}%);aspect-ratio:1/1;
    background-image:var(--logo-cube, url('/assets/logo-ventilo.png?v=${CACHE_LOGO_VENTILO}${jeton ? '&token='+jeton : ''}'));background-size:contain;background-repeat:no-repeat;
    mix-blend-mode:screen}
  .carteMachine.sans-logo-ventilo .logoVentilo{display:none}
  @keyframes tournerVentilo{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
  @keyframes ralentirVentilo{from{transform:rotate(0deg)}to{transform:rotate(1080deg)}}
  /* Liseré du contour de la carte : couleur = palier de cube atteint (variable CSS
     --couleur-cube posée sur .carteMachine, verte par défaut si aucun cube). Pulse
     franc façon néon sous tension. Peu de blanc mélangé (délaverait une couleur foncée) --
     on intensifie via brightness/saturate, qui éclaircissent sans désaturer vers le blanc. */
  .contourGlow{position:absolute;left:var(--z-contour-left,${cv.contourGlow.left}%);top:var(--z-contour-top,${cv.contourGlow.top}%);width:var(--z-contour-width,${cv.contourGlow.width}%);height:var(--z-contour-height,${cv.contourGlow.height}%);border-radius:4.5%/3.8%;
    pointer-events:none;
    box-shadow:0 0 0 0.55cqw color-mix(in srgb, var(--couleur-cube,#96f01f) 96%, white 8%),
               0 0 1.2cqw 0.3cqw var(--couleur-cube,#96f01f),
               0 0 3cqw 0.7cqw color-mix(in srgb, var(--couleur-cube,#96f01f) 85%, transparent),
               0 0 6cqw 1.6cqw color-mix(in srgb, var(--couleur-cube,#96f01f) 50%, transparent);
    filter:brightness(1.7) saturate(1.5) contrast(1.1);
    animation:respirerGlow 1.7s ease-in-out infinite}
  /* Barre LED du socle : bande nette (façon strip LED) + halo qui rayonne autour. On évite
     de mélanger trop de blanc (color-mix avec du blanc DÉLAVE une couleur foncée en gris
     pâle plutôt que de la faire briller) -- on préfère intensifier la teinte d'origine via
     brightness/saturate/contrast, qui l'éclaircissent sans la désaturer vers le blanc. */
  .barreGlow{position:absolute;left:var(--z-barre-left,${cv.barreGlow.left}%);top:var(--z-barre-top,${cv.barreGlow.top}%);width:var(--z-barre-width,${cv.barreGlow.width}%);height:var(--z-barre-height,${cv.barreGlow.height}%);border-radius:50%;
    pointer-events:none;
    background:linear-gradient(90deg, transparent 0%,
               color-mix(in srgb, var(--couleur-cube,#96f01f) 95%, white 8%) 12%,
               color-mix(in srgb, var(--couleur-cube,#96f01f) 100%, white 15%) 50%,
               color-mix(in srgb, var(--couleur-cube,#96f01f) 95%, white 8%) 88%, transparent 100%);
    box-shadow:0 0 0.8cqw 0.15cqw var(--couleur-cube,#96f01f),
               0 0 2.2cqw 0.5cqw color-mix(in srgb, var(--couleur-cube,#96f01f) 95%, transparent),
               0 0 4.5cqw 1cqw color-mix(in srgb, var(--couleur-cube,#96f01f) 65%, transparent);
    filter:brightness(2.1) saturate(1.7) contrast(1.15);animation:respirerGlow 1.7s ease-in-out infinite;animation-delay:.3s}
  @keyframes respirerGlow{0%,100%{opacity:.85}50%{opacity:1}}
  /* Paliers "rainbow" (Multicolore I/II, Multi-Gemmes II) : le liseré cycle toutes les
     couleurs au lieu d'une teinte fixe, pour bien les distinguer des paliers unis. */
  .carteMachine.rainbow-tier .contourGlow,.carteMachine.rainbow-tier .barreGlow{animation-name:respirerGlow,arcEnCiel;animation-duration:1.7s,4s;animation-timing-function:ease-in-out,linear;animation-iteration-count:infinite,infinite}
  .carteMachine.rainbow-tier .ecranLogo{animation:arcEnCiel 4s linear infinite}
  @keyframes arcEnCiel{from{filter:hue-rotate(0deg) saturate(1.4)}to{filter:hue-rotate(360deg) saturate(1.4)}}
  /* Badge "bloc trouvé" : cachée par défaut, apparaît seulement si blocsTrouves>0 */
  .badgeBloc{display:none;align-items:center;gap:4px;background:rgba(150,240,31,.16);color:var(--amber);
    border:1px solid rgba(150,240,31,.5);font-size:min(4.4cqw,13cqh,13px);font-weight:700;letter-spacing:.06em;
    padding:2px 7px;border-radius:8px;animation:respirerGlow 1.4s ease-in-out infinite;flex-shrink:0;white-space:nowrap}
  .badgeBloc.actif{display:inline-flex}
  /* Badge "skin Premium actif" -- petit rappel discret que la plaque affichée n'est pas
     celle du palier Genèse réel (visible uniquement quand un skin est appliqué). */
  .badgeSkinPremium{display:inline-flex;align-items:center;font-size:min(4.4cqw,13cqh,13px);
    flex-shrink:0;filter:drop-shadow(0 0 3px rgba(255,255,255,.5))}
  .ecran{position:absolute;left:var(--z-ecran-left,${cv.ecran.left}%);top:var(--z-ecran-top,${cv.ecran.top}%);width:var(--z-ecran-width,${cv.ecran.width}%);height:var(--z-ecran-height,${cv.ecran.height}%);
    container-type:size;container-name:ecran;
    border-radius:2%/1.6%;overflow:hidden;background:#05070a;
    padding:var(--marge-v,2%) var(--marge-h,2.5%);box-sizing:border-box}
  .ecran.vitrine{background:transparent;padding:0}
  .eLigne{height:9%;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;min-width:0}
  /* Zone libre : chaque champ (.celluleEcran) s'y positionne en absolu selon CE (config
     éditable en direct via le bouton "🛠 Écran") -- remplace l'ancienne grille figée. */
  .zoneChamps{position:relative;width:100%;height:calc(100% - 9% - 3%);margin-top:3%}
  .celluleEcran{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:2%}
  .ecranLogo{display:flex;align-items:center;gap:5px;font-weight:700;color:var(--z-couleur-logo,var(--couleur-cube,var(--white)));font-size:min(9.5cqw,29cqh,29px);
    min-width:0;flex-shrink:1;overflow:hidden;white-space:nowrap;filter:brightness(1.6) saturate(1.3)}
  .ecranLogo span{overflow:hidden;text-overflow:ellipsis}
  .ecranLogo svg{width:1.1em;height:1.1em}
  .statut{color:var(--amber);display:flex;align-items:center;gap:4px;font-weight:700;font-size:min(8.3cqw,27cqh,23px);
    min-width:0;flex-shrink:1;overflow:hidden}
  .statut span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .statut .pt{width:6px;height:6px;border-radius:50%;background:var(--amber);flex-shrink:0}
  .statut.off{color:var(--mut)}
  .statut.off .pt{background:var(--mut)}
  .ecranLabel{font-size:calc(min(6cqw,18cqh,19px)*var(--t,1));color:var(--mut);letter-spacing:.1em;line-height:1.2;
    overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .blocsInline{font-size:calc(min(6cqw,18cqh,19px)*var(--t,1)*.75);color:var(--mut);letter-spacing:.05em;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .blocsInline b{font-weight:700;color:var(--amber)}
  .ecranHash{font-weight:800;color:var(--white);font-size:calc(min(19cqw,32cqh,76px)*var(--t,1));line-height:1;display:flex;align-items:baseline;gap:5px;overflow:hidden;min-width:0;flex-shrink:0}
  .ecranHash span{font-size:min(8cqw,15cqh,29px);font-weight:700;color:var(--amber);white-space:nowrap;flex-shrink:0}
  .spark{display:none;width:100%;flex:1 1 0;min-height:0;margin-top:2%}
  .spark svg{width:100%;height:100%;display:block}
  @container carte (min-height: 520px){
    .spark{display:block}
  }
  .celluleEcran span{font-size:calc(min(5.4cqw,16cqh,17px)*var(--t,1));color:var(--mut);letter-spacing:.08em;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .celluleEcran b{font-size:calc(min(6.8cqw,19cqh,23px)*var(--t,1));color:var(--white);font-weight:700;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .celluleEcran.accent b{color:var(--amber)}
  .badgesRangee{display:flex;gap:2px;align-items:center;margin-top:2%}
  .celluleEcran .badgeMini{font-size:calc(15px*var(--ti,1));filter:grayscale(1) brightness(.5);opacity:.45;transition:filter .2s,opacity .2s}
  .badgeMini.atteint{filter:none;opacity:1}
  .miniCube{width:calc(15px*var(--ti,1));height:calc(15px*var(--ti,1));vertical-align:middle;object-fit:contain;margin-right:3px}
  .nomCube{display:block;font-size:0.72em;font-weight:400;color:var(--couleur-cube,var(--amber));
    letter-spacing:.04em;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;filter:brightness(1.6) saturate(1.3)}
  .blocHash{margin-top:3%}
  .eGrid{display:grid;grid-template-columns:1fr 1fr;gap:2%;margin-top:3%;min-width:0}
  .eGrid>div{display:flex;flex-direction:column;gap:2%;min-width:0}
  .eGrid span{font-size:min(5.4cqw,16cqh,17px);color:var(--mut);letter-spacing:.08em;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .eGrid b{font-size:min(6.8cqw,19cqh,23px);color:var(--white);font-weight:700;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .eGrid .accent b{color:var(--amber)}
  .eGrid .rej{color:var(--mut);font-weight:400;font-size:0.8em}
  .nomMachine{position:absolute;left:4%;right:4%;bottom:-26px;text-align:center;font-size:11px;color:var(--white-dim);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .flechePage{position:absolute;right:26%;top:13%;width:6%;aspect-ratio:1/1;z-index:3;
    background:rgba(5,7,10,.55);border:1px solid rgba(150,240,31,.4);border-radius:50%;
    color:var(--amber);cursor:pointer;display:flex;align-items:center;justify-content:center;
    font-size:min(5cqw,15cqh,15px);line-height:1;padding:0;font-family:inherit}
  .flechePage:hover{background:rgba(150,240,31,.18);border-color:var(--amber)}
  .pool-nom{overflow:hidden}
  .pool-nom b{display:inline-block;white-space:nowrap;overflow:visible;text-overflow:clip}
  /* Boucle continue, toujours de gauche à droite : le texte du <b> est dupliqué en JS
     (voir activerDefilementPool) avec un séparateur, puis on fait glisser exactement de
     la largeur d'une seule copie -- au moment où la 1re copie sort à gauche, la 2e est
     déjà pile à sa place, donnant l'illusion d'un flux ininterrompu, sans jamais revenir
     brutalement au début. */
  .pool-nom.defile b{animation:defilerPool linear infinite}
  @keyframes defilerPool{
    0%{transform:translateX(0)}
    100%{transform:translateX(var(--defilement,0px))}
  }
  .badgeMoi{display:inline-block;background:rgba(150,240,31,.14);color:var(--amber);border:1px solid rgba(150,240,31,.4);
    font-size:9px;font-weight:700;letter-spacing:.06em;padding:1px 6px;border-radius:8px;margin-right:5px;vertical-align:middle}
  .boutonVentilo{position:absolute;left:var(--z-bouton-left,${cv.boutonVentilo.left}%);top:var(--z-bouton-top,${cv.boutonVentilo.top}%);width:var(--z-bouton-width,${cv.boutonVentilo.width}%);aspect-ratio:1/1;border-radius:50%;
    cursor:pointer;background:transparent;border:none;padding:0;z-index:2}
  .boutonVentilo:hover{filter:brightness(1.3)}
  .boutonVentilo:active{filter:brightness(0.8)}
  .vide{color:var(--mut);font-size:12px;padding:30px 0}
  .carteMachine{cursor:pointer;transition:transform .15s}
  .carteMachine:hover{transform:translateY(-3px)}
  .modalCarte{display:none;position:fixed;inset:0;z-index:50;align-items:center;justify-content:center;padding:30px}
  .modalCarte.ouverte{display:flex}
  .modalFond{position:absolute;inset:0;background:rgba(3,5,4,.82);backdrop-filter:blur(3px)}
  .modalContenu{position:relative;width:min(80vw,440px)}
  .modalContenu .carteMachine{cursor:default;max-width:none}
  .modalContenu .carteMachine:hover{transform:none}
  .modalFermer{position:absolute;top:-38px;right:0;background:none;border:1px solid var(--amber-faint);
    color:var(--amber);width:30px;height:30px;border-radius:50%;font-size:14px;cursor:pointer;font-family:inherit}
  .modalFermer:hover{border-color:var(--amber)}

  /* --- Mode édition intégré --- */
  .panneauEdition{display:none;position:fixed;inset:0;z-index:60;align-items:center;justify-content:center;padding:20px}
  .panneauEditionEcran{display:none;position:fixed;top:0;left:0;right:0;z-index:70;background:rgba(10,12,16,.96);
    border-bottom:1px solid var(--edge);padding:10px 16px;backdrop-filter:blur(6px);align-items:center;gap:14px;flex-wrap:wrap}
  .panneauEditionEcran.ouvert{display:flex}
  .panneauEditionEcran>span:first-child{color:var(--amber);font-weight:700;font-size:12px}
  .editEcranPages{display:flex;gap:6px}
  .editEcranPages button{background:none;border:1px solid var(--edge);color:var(--white-dim);padding:5px 10px;
    border-radius:6px;font-family:var(--mono);font-size:11px;cursor:pointer}
  .editEcranPages button.actif{border-color:var(--amber);color:var(--amber)}
  .editEcranAide{color:var(--white-dim);font-size:11px}
  .editEcranChamps{display:flex;gap:12px;align-items:center;background:rgba(150,240,31,.06);
    border:1px solid var(--amber-faint);border-radius:8px;padding:6px 12px}
  .editEcranChamps label{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--white-dim)}
  .editEcranChamps input{width:56px;background:var(--panel2,#0d1015);border:1px solid var(--edge);
    color:var(--white);padding:3px 5px;border-radius:5px;font-family:var(--mono);font-size:11px}
  .editEcranChamps b{color:var(--amber)}
  #editEcranStatut{color:var(--amber);font-size:11px;margin-left:auto}
  html.editEcranMode #modalCarteHote .celluleEcran{outline:1px dashed rgba(150,240,31,.55);cursor:move}
  html.editEcranMode #modalCarteHote .celluleEcran.selectionnee{outline:2px solid #96f01f;z-index:6}
  html.editEcranMode .carteMachine{margin-top:44px}
  .panneauEdition.ouvert{display:flex}
  .editFond{position:absolute;inset:0;background:rgba(3,5,4,.92)}
  .editContenu{position:relative;display:flex;gap:24px;max-width:1000px;width:100%;max-height:94vh}
  .editColGauche{display:flex;flex-direction:column;gap:8px;flex-shrink:0}
  .editZoomBar{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--mut)}
  .editZoomBar input[type=range]{width:110px;accent-color:#96f01f}
  .editZoomBar button{font-size:10px;padding:4px 8px}
  .editZone{position:relative;width:420px;max-height:70vh;overflow:auto;border:1px solid var(--line);border-radius:8px}
  .editZoneInterne{position:relative;width:100%;transform-origin:top left}
  .editBoard{width:100%;display:block;user-select:none;-webkit-user-drag:none}
  .editForme{position:absolute;outline:2px dashed;box-sizing:border-box;cursor:move}
  .apercuFondNoir{position:absolute;border-radius:50%;background:#000;pointer-events:none}
  .apercuVentilo{position:absolute;background-size:contain;background-repeat:no-repeat;background-position:center;pointer-events:none}
  .apercuVentilo.tourne{animation:tourner .1s linear infinite}
  .apercuLogoVentilo{position:absolute;background-size:contain;background-repeat:no-repeat;background-position:center;mix-blend-mode:screen;pointer-events:none}
  .editForme.editRonde{border-radius:50%;aspect-ratio:1/1}
  .editForme.selectionnee{outline-width:3px;z-index:4}
  .editForme.editEnfant{z-index:5}
  .editPoignee{position:absolute;right:-7px;bottom:-7px;width:14px;height:14px;border-radius:50%;
    cursor:nwse-resize;border:2px solid #fff;z-index:6}
  .editPivot{position:absolute;width:18px;height:18px;margin-left:-9px;margin-top:-9px;cursor:crosshair;z-index:7;display:none}
  .editPivot::before,.editPivot::after{content:'';position:absolute;background:#00e5ff}
  .editPivot::before{left:50%;top:0;width:2px;height:100%;margin-left:-1px}
  .editPivot::after{top:50%;left:0;height:2px;width:100%;margin-top:-1px}
  .editPivotRond{position:absolute;left:50%;top:50%;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;
    border-radius:50%;border:2px solid #00e5ff;background:rgba(0,229,255,.3)}
  .editForme[data-cle="ventilo"].selectionnee .editPivot{display:block}
  .editForme.tourne{animation:tourner .1s linear infinite;filter:blur(1.5px);cursor:default}
  .editForme.tourne .editPoignee,.editForme.tourne .editPivot{display:none}
  @keyframes tourner{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
  .editPanneau{width:280px;flex-shrink:0;overflow-y:auto;font-size:11px;color:var(--white-dim);line-height:1.6}
  .editPanneau h1{font-size:14px;color:var(--amber);margin-bottom:6px}
  .editPanneau .sous{color:var(--mut);margin-bottom:14px}
  .editLigne{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:8px;cursor:pointer}
  .editLigne.selectionnee{border-color:var(--amber);background:rgba(150,240,31,.06)}
  .editLigne .nom{display:flex;align-items:center;gap:6px;font-weight:700;color:var(--white);margin-bottom:6px}
  .editLigne .puce{width:9px;height:9px;border-radius:50%;flex-shrink:0}
  .editChamps{display:none;gap:6px;flex-wrap:wrap}
  .editLigne.selectionnee .editChamps{display:flex}
  .editChamps label{display:flex;flex-direction:column;gap:2px;font-size:9px;color:var(--mut)}
  .editChamps input{width:58px;background:var(--panel2);border:1px solid var(--line);color:var(--white);
    padding:2px 4px;font-family:inherit;font-size:10px;border-radius:4px}
  .editBtns{margin-top:14px;display:flex;flex-direction:column;gap:6px}
  .editBtns button{background:none;border:1px solid var(--line);color:var(--white-dim);padding:8px 10px;
    border-radius:6px;font-family:inherit;cursor:pointer;font-size:11px}
  .editBtns button:hover{border-color:var(--amber-faint)}
  .editBtns button.principal{border-color:rgba(150,240,31,.5);color:var(--amber)}
  .editBtns button.principal:hover{border-color:var(--amber)}
  .editBtns button.actif{background:rgba(150,240,31,.15)}
  .editStatut{margin-top:10px;font-size:11px;min-height:16px}
  .editStatut.succes{color:var(--amber)}
  .editStatut.erreur{color:#ff6a78}
</style></head>
<body><div class="wrap">
<header>
  <h1>Machines connectées</h1>
  <div style="margin-left:auto;display:flex;gap:8px">
    <button type="button" class="lien" id="btnEdition">🛠 Mode édition</button>
    <button type="button" class="lien" id="btnEditionSkin" style="display:none">🎯 Zones du skin</button>
    <button type="button" class="lien" id="btnEditionEcran">🛠 Écran</button>
    <a class="lien" id="retour" href="/details">← Retour au tableau de bord</a>
  </div>
  <div class="sub">Essai d'affichage façon carte ASIC — une machine AXECUBE connectée = une carte. Données réelles, rafraîchies toutes les 5 secondes.</div>
</header>
<div id="grille" class="grille"><div class="vide">Recherche des machines sur le réseau local…</div></div>
<div id="panneauEditionEcran" class="panneauEditionEcran">
  <span>🛠 Édition de l'écran</span>
  <div class="editEcranPages">
    <button type="button" id="btnPageEdit0" class="actif">Page 1</button>
    <button type="button" id="btnPageEdit1">Page 2</button>
  </div>
  <span class="editEcranAide">Glisse un champ pour le déplacer · règle largeur/taille avec les champs ci-contre</span>
  <div class="editEcranChamps">
    <label>Marge H % <input type="number" id="inMargeH" min="0" max="20" step="0.5"></label>
    <label>Marge V % <input type="number" id="inMargeV" min="0" max="20" step="0.5"></label>
  </div>
  <div id="editEcranChamps" class="editEcranChamps" style="display:none">
    <label>Sélection : <b id="editEcranNomChamp">—</b></label>
    <label>Largeur % <input type="number" id="inLargeur" min="5" max="100" step="1"></label>
    <label>Taille texte <input type="number" id="inTaille" min="0.4" max="3" step="0.05"></label>
    <label id="labelTailleIcone">Taille icônes <input type="number" id="inTailleIcone" min="0.4" max="4" step="0.05"></label>
  </div>
  <button type="button" id="btnEditEcranEnregistrer" class="lien principal">💾 Enregistrer</button>
  <button type="button" id="btnEditEcranFermer" class="lien">Fermer</button>
  <span id="editEcranStatut"></span>
</div>
<div id="modalCarte" class="modalCarte">
  <div class="modalFond"></div>
  <div class="modalContenu">
    <button class="modalFermer" aria-label="Fermer">✕</button>
    <div id="modalCarteHote"></div>
  </div>
</div>
<div id="panneauEdition" class="panneauEdition">
  <div class="editFond"></div>
  <div class="editContenu">
    <div class="editColGauche">
      <div class="editZoomBar">
        Zoom : <input type="range" id="editZoom" min="100" max="400" value="100" step="10">
        <span id="editZoomVal">100%</span>
        <button type="button" id="btnRecentrerZone" style="display:none">🎯 Centrer sur l'hélice</button>
      </div>
      <div class="editZone">
        <div class="editZoneInterne">
          <img class="editBoard" src="/assets/bitaxe-board.png?v=${CACHE_CARTE}${jeton ? '&token='+jeton : ''}">
          <div class="apercuFondNoir"></div>
          <div class="apercuVentilo"><div class="apercuLogoVentilo"></div></div>
          <div class="editForme" data-cle="ecran" style="outline-color:#e0e0e0"><div class="editPoignee" style="background:#e0e0e0"></div></div>
          <div class="editForme editRonde" data-cle="fondNoir" style="outline-color:#0096ff"><div class="editPoignee" style="background:#0096ff"></div></div>
          <div class="editForme editRonde" data-cle="ventilo" style="outline-color:#ff0096">
            <div class="editPoignee" style="background:#ff0096"></div>
            <div class="editPivot"><div class="editPivotRond"></div></div>
            <div class="editForme editRonde editEnfant" data-cle="logoVentilo" style="outline-color:#ffdc00">
              <div class="editPoignee" style="background:#ffdc00"></div>
            </div>
          </div>
          <div class="editForme" data-cle="contourGlow" style="outline-color:#96f01f"><div class="editPoignee" style="background:#96f01f"></div></div>
          <div class="editForme editRonde" data-cle="barreGlow" style="outline-color:#ff8800"><div class="editPoignee" style="background:#ff8800"></div></div>
          <div class="editForme editRonde" data-cle="boutonVentilo" style="outline-color:#c800ff"><div class="editPoignee" style="background:#c800ff"></div></div>
        </div>
      </div>
    </div>
    <div class="editPanneau">
      <h1>Mode édition</h1>
      <div class="sous">Clique une forme pour la sélectionner, glisse-la ou tire sa poignée. La liste ci-dessous distingue chaque élément par sa couleur.</div>
      <label id="editSansLogoLigne" style="display:none;align-items:center;gap:8px;font-size:12px;margin:4px 0 10px;cursor:pointer">
        <input type="checkbox" id="chkSansLogoVentilo"> L'hélice de ce skin a déjà son propre logo dessiné (ne pas superposer le cube)
      </label>
      <button type="button" id="btnExtraireHelice" style="display:none;margin-bottom:6px">✂️ Extraire l'hélice depuis cette image</button>
      <div id="editHeliceUploadLigne" style="display:none;margin-bottom:10px">
        <input type="file" id="fHeliceSkin" accept="image/png" style="display:none">
        <button type="button" id="btnChoisirHeliceSkin" style="font-size:11px">📁 ...ou fournir un PNG déjà détouré</button>
        <span id="heliceSkinStatut" style="font-size:10.5px;color:var(--mut);margin-left:6px"></span>
      </div>
      <label id="editCouleurLigne" style="display:none;align-items:center;gap:8px;font-size:12px;margin:4px 0 10px">
        Couleur d'ambiance du skin (liseré, barre LED) :
        <input type="color" id="inCouleurSkin" value="#96f01f">
        <button type="button" id="btnCouleurSkinDefaut" style="font-size:10.5px">↺ Suivre le vrai palier</button>
      </label>
      <label id="editCouleurLogoLigne" style="display:none;align-items:center;gap:8px;font-size:12px;margin:4px 0 10px">
        Couleur du logo/marque AXECUBE dans l'écran :
        <input type="color" id="inCouleurLogoSkin" value="#96f01f">
        <button type="button" id="btnCouleurLogoSkinDefaut" style="font-size:10.5px">↺ Suivre l'ambiance</button>
      </label>
      <label id="editVitesseLigne" style="display:none;align-items:center;gap:8px;font-size:12px;margin:4px 0 10px">
        Durée d'un tour de l'hélice (secondes) :
        <input type="range" id="inVitesseVentilo" min="0.03" max="0.6" step="0.01" value="0.1">
        <span id="valVitesseVentilo" style="font-size:10.5px;color:var(--mut)">0.10s</span>
      </label>
      <label id="editFlouLigne" style="display:none;align-items:center;gap:8px;font-size:12px;margin:4px 0 10px">
        Flou de rotation (0 = image toujours nette) :
        <input type="range" id="inFlouVentilo" min="0" max="3" step="0.1" value="0.4">
        <span id="valFlouVentilo" style="font-size:10.5px;color:var(--mut)">0.4px</span>
      </label>
      <div id="editCubeLigne" style="display:none;margin-bottom:10px">
        <label style="font-size:10.5px;color:var(--mut);letter-spacing:.05em;text-transform:uppercase;display:block;margin-bottom:6px">
          Cube (logo central), fourni séparément de l'hélice</label>
        <input type="file" id="fCubeSkin" accept="image/png" style="display:none">
        <button type="button" id="btnChoisirCubeSkin" style="font-size:11px">📁 Choisir un PNG</button>
        <span id="cubeSkinStatut" style="font-size:10.5px;color:var(--mut);margin-left:6px"></span>
      </div>
      <div id="editListe"></div>
      <div class="editBtns">
        <button type="button" id="btnEditTourner">▶ Tester la rotation</button>
        <button type="button" id="btnEditEnregistrer" class="principal">💾 Enregistrer</button>
        <button type="button" id="btnEditFermer">Fermer sans enregistrer</button>
      </div>
      <div id="editStatut" class="editStatut"></div>
    </div>
  </div>
</div>
</div>
<script>
const TOK=${JSON.stringify(jeton || '')};const Q=TOK?('?token='+TOK):'';
// Position/taille de chaque champ texte de l'écran, par page (0/1) -- éditable en direct
// via le bouton "🛠 Écran" (voir plus bas). Rechargé côté serveur à l'ouverture ; les
// modifications faites dans l'éditeur mettent aussi à jour cette même variable en direct,
// pour un aperçu immédiat sans recharger la page.
let CE=${JSON.stringify(configEcran)};
// Mode "solo" : URL avec ?solo=1 -- masque l'en-tête et la grille réseau, n'affiche QUE
// ma propre carte, en grand, centrée. Sert de contenu au panneau flottant (voir modeMini()
// sur le dashboard principal, qui charge cette page dans un <iframe> à l'intérieur d'une
// vraie fenêtre flottante sans barre de navigateur).
const SOLO=new URLSearchParams(location.search).get('solo')==='1';
if(SOLO) document.documentElement.classList.add('solo');
function fmtHR(h){if(!h)return'0 H/s';if(h>=1e12)return(h/1e12).toFixed(2)+' TH/s';if(h>=1e9)return(h/1e9).toFixed(2)+' GH/s';
  if(h>=1e6)return(h/1e6).toFixed(2)+' MH/s';if(h>=1e3)return(h/1e3).toFixed(2)+' kH/s';return h.toFixed(0)+' H/s'}
function fmtD(d){if(!d)return'—';if(d>=1e12)return(d/1e12).toFixed(2)+' T';if(d>=1e9)return(d/1e9).toFixed(2)+' G';
  if(d>=1e6)return(d/1e6).toFixed(2)+' M';if(d>=1e3)return(d/1e3).toFixed(2)+' k';return d>=100?d.toFixed(0):d.toPrecision(3)}
function fmtN(n){n=n||0;if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return String(Math.round(n))}
/** Génère une cellule positionnée librement dans l'écran, selon CE (config éditable en
 *  direct via le bouton "🛠 Écran") -- remplace l'ancienne grille figée. page: 0 ou 1.
 *  champ: clé dans CE.page0/CE.page1. html: contenu (span+b, ou bloc spécial). accent:
 *  colore la valeur en ambre (mêmes cas qu'avant : MEILLEURE, COURS ₿, BLOCS TROUVÉS). */
function celda(page,champ,html,opts){
  const cfg=(CE&&CE['page'+page]&&CE['page'+page][champ])||{left:0,top:0,width:50,size:1,sizeIcone:1};
  const accent=opts===true||(opts&&opts.accent);
  const defile=opts&&opts.defile;
  return '<div class="celluleEcran'+(accent?' accent':'')+(defile?' pool-nom':'')+'" data-champ="'+champ+'" data-page="'+page+'" '
    +'style="left:'+cfg.left+'%;top:'+cfg.top+'%;width:'+cfg.width+'%;--t:'+(cfg.size||1)+';--ti:'+(cfg.sizeIcone||1)+'">'+html+'</div>';
}
// Seuils des 6 badges de palier (bronze -> légende) -- doivent rester identiques à
// PALIERS_CLIENT (page principale) et PALIERS (serveur, submit.js). Copie locale car
// cette page a son propre <script>, indépendant de celui du dashboard principal.
const PALIERS_ECRAN=[
  {nom:'BRONZE',icone:'🥉',seuil:100},
  {nom:'ARGENT',icone:'🥈',seuil:1000},
  {nom:'OR',icone:'🥇',seuil:10000},
  {nom:'PLATINE',icone:'💠',seuil:100000},
  {nom:'DIAMANT',icone:'💎',seuil:1000000},
  {nom:'LÉGENDE',icone:'🔥',seuil:10000000},
];
/** Rangée des 6 badges de palier -- allumé seulement si bestDiffVerifie (contrôlé côté
 *  serveur, jamais la seule valeur locale) atteint le seuil. Voir la discussion sur la
 *  sécurité des badges : même principe que le badge chip du dashboard principal. */
function celdaBadges(m){
  const verifie=m.bestDiffVerifie||0;
  const items=PALIERS_ECRAN.map(p=>{
    const atteint=verifie>=p.seuil;
    return '<span class="badgeMini'+(atteint?' atteint':'')+'" title="'+p.nom+(atteint?' \u2014 d\u00e9bloqu\u00e9':' \u2014 pas encore d\u00e9bloqu\u00e9')+'">'+p.icone+'</span>';
  }).join('');
  return '<span>PALIERS</span><span class="badgesRangee">'+items+'</span>';
}
/** Libellé court pour l'état thermique : statut de limitation (déduit du hashrate réel
 *  vs le pic mesuré) + température/pression réelle si le démon de mesure tourne. */
function libelleThermique(m){
  const t=m.throttle||0;
  const statut=t<=0.05?'OK':(t<=0.3?'Léger':'Fort');
  if(m.thermalReel){
    const v=m.thermalReel.type==='temperature'?Math.round(m.thermalReel.valeur)+'°C':m.thermalReel.valeur;
    return statut+' · '+v;
  }
  return statut;
}
/** Libellé court pour la vérification du paiement : la récompense d'un bloc irait-elle
 *  bien intégralement à ton adresse avec la configuration actuelle de la pool ? Jamais
 *  affiché sur la carte avant -- pourtant l'info la plus concrètement rassurante. */
function libellePaiement(m){
  if(!m||!m.paiement) return '—';
  const pct=Math.round((m.paiement.part||0)*100);
  if(m.paiement.etat==='complet') return '✓ Complet';
  if(m.paiement.etat==='partiel') return 'Partiel '+pct+'%';
  if(m.paiement.etat==='absent') return '⚠ Absent';
  return '—';
}
function fmtPrix(p,sym){if(!p)return'—';return Math.round(p).toLocaleString('fr-FR')+(sym||'')}
function fmtUp(s){if(!s)return'—';s=Math.round(s);const j=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return (j?j+'j ':'')+h+'h'+String(m).padStart(2,'0')}
const LOGO_SVG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2l8 4.6v9.8L12 22l-8-4.6V6.6z"/><path d="M12 2v9M12 11L4 6.6M12 11l8-4.4"/></svg>';

// --- Grille des 22 cubes CPU (loterie sur bestDiff) -- identique à recompenses.html,
// pour que la couleur d'une carte corresponde exactement au cube réellement affiché
// sur le classement en ligne.
const SEUILS_CPU=[
  200,300,500,750,1000,1500,2500,4000,
  6000,10000,15000,25000,40000,
  60000,
  100000,150000,
  200000,
  300000,400000,500000,
  750000,1000000
];
const NOMS_CUBE=[
  'Néon I','Néon II','Néon III','Néon IV','Néon V','Néon VI','Néon VII','Néon VIII',
  'Bicolore I','Bicolore II','Bicolore III','Bicolore IV','Bicolore V',
  'Tricolore',
  'Multicolore I','Multicolore II',
  'Diamant',
  'Diamant Émeraude','Diamant Saphir','Diamant Ruby',
  'Multi-Gemmes I','Multi-Gemmes II'
];
const COULEURS_CUBE=[
  '#8cff2e','#2e9bff','#0a278b','#fc33b4','#2effe0','#ff9c2e','#ff2ea0','#fd5f00',
  '#2effb0','#8c2eff','#ffb02e','#ff2ee0','#c8ff2e',
  '#e8f0ff',
  'rainbow','rainbow',
  '#bff5ff',
  '#10b981','#2563eb','#e11d48',
  'rainbow','rainbow'
];
function niveauDe(bestDiff){
  bestDiff = bestDiff||0;
  let niveau = 0;
  for(let i=0; i<SEUILS_CPU.length; i++){
    if(bestDiff >= SEUILS_CPU[i]) niveau = i+1; else break;
  }
  return niveau;
}
// Renvoie {couleur, nom, niveau, rainbow, imageCarte, imageLogo} pour un bestDiff donné.
// Sous le niveau 1 (< 200 de difficulté), on reste sur le vert AXECUBE, la carte et le
// logo par défaut -- pas de "faux cube".
const CACHE_MACHINES='${CACHE_MACHINES}';
const CACHE_CUBES='${CACHE_CUBES}';
function infosCube(bestDiff){
  const n=niveauDe(bestDiff);
  if(n<1) return {couleur:'#96f01f', nom:null, niveau:0, rainbow:false, imageCarte:null, imageLogo:null};
  const c=COULEURS_CUBE[n-1];
  const numero=String(n).padStart(2,'0');
  // Le token (Q) doit être ajouté ici aussi : en mode LAN, TOUTE requête d'image exige
  // le jeton (sauf manifest/icon) -- sans lui, ces images sont rejetées (401) dès qu'on
  // accède au dashboard depuis un autre appareil (téléphone via QR code, etc.).
  return {
    couleur: c==='rainbow' ? '#96f01f' : c,
    nom:NOMS_CUBE[n-1],
    niveau:n,
    rainbow: c==='rainbow',
    imageCarte:'/assets/machines/niveau-'+numero+'.png?v='+CACHE_MACHINES+(TOK?'&token='+TOK:''),
    imageLogo:'/assets/cubes/cube-p'+numero+'.png?v='+CACHE_CUBES+(TOK?'&token='+TOK:'')
  };
}
document.getElementById('retour').href='/details'+Q;

// Sparkline SVG à partir d'un vrai historique (histHash), pas de données inventées.
// Retourne une chaîne vide si aucun historique n'est disponible (ex: machines distantes).
function sparkSVG(hist){
  if(!hist || hist.length<2) return '';
  const w=200,h=44;
  const mn=Math.min(...hist), mx=Math.max(...hist);
  const range=(mx-mn)||1;
  const pts=hist.map((v,i)=>{
    const x=i/(hist.length-1)*w;
    const y=h-((v-mn)/range)*h*0.85-h*0.05;
    return x+','+y;
  });
  const path='M'+pts.join(' L');
  const fillPts=pts.concat([w+','+h, '0,'+h]).join(' L');
  return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'
    +'<polyline points="'+fillPts+'" fill="rgba(150,240,31,.14)" stroke="none"/>'
    +'<polyline points="'+pts.join(' ')+'" fill="none" stroke="#96f01f" stroke-width="2" '
    +'stroke-linejoin="round" stroke-linecap="round"/>'
    +'</svg>';
}

// Identifiant STABLE d'une machine (nom du worker, ou machineId à défaut) -- contrairement
// à sa position dans la liste (idx), qui peut changer d'un rafraîchissement à l'autre si
// l'ordre des machines bouge (tri par hashrate). Utilisé pour toute mémoire censée survivre
// aux rafraîchissements (page affichée, pause manuelle du ventilo) -- jamais pour indexer
// dans donneesActuelles, où l'index numérique reste nécessaire.
function cleStableDe(m, estMoi, idxSecours){
  return (estMoi ? 'MOI' : (m.worker || m.machineId || ('idx'+idxSecours))) + '';
}

// Zones par skin Premium : la plupart des skins (les 22 paliers de base, et la majorité
// des Premium) respectent le gabarit standard -- seule une poignée de Premium générés
// par IA ont légèrement dévié (écran un peu agrandi) et ont besoin d'un réglage propre à
// EUX. zonesSkin (format exporté par le builder de skins) ne doit donc contenir QUE les
// zones qui diffèrent du gabarit par défaut -- toute zone absente ou à null retombe sur cv
// via les var(--z-...,défaut) posées dans le style. logoVentilo:null = l'hélice contient
// déjà son propre logo dessiné -> on masque l'overlay .logoVentilo (classe sans-logo-ventilo).
// TODO Chris : brancher la vraie source de zonesSkin une fois le stockage retrouvé/créé
// (probablement à côté de imageCarte/imageFanBlade dans les métadonnées de chaque skin).
function stylesZonesSkin(zonesSkin){
  if(!zonesSkin) return '';
  let css='';
  const z=zonesSkin;
  if(z.ecran) css+='--z-ecran-left:'+z.ecran.left+'%;--z-ecran-top:'+z.ecran.top+'%;--z-ecran-width:'+z.ecran.width+'%;--z-ecran-height:'+z.ecran.height+'%;';
  if(z.ventilo) css+='--z-ventilo-left:'+z.ventilo.left+'%;--z-ventilo-top:'+z.ventilo.top+'%;--z-ventilo-width:'+z.ventilo.width+'%;--z-ventilo-pivotx:'+(z.ventilo.pivotX!=null?z.ventilo.pivotX:50)+'%;--z-ventilo-pivoty:'+(z.ventilo.pivotY!=null?z.ventilo.pivotY:50)+'%;';
  if(z.fondNoir) css+='--z-fondnoir-left:'+z.fondNoir.left+'%;--z-fondnoir-top:'+z.fondNoir.top+'%;--z-fondnoir-width:'+z.fondNoir.width+'%;';
  if(z.contourGlow) css+='--z-contour-left:'+z.contourGlow.left+'%;--z-contour-top:'+z.contourGlow.top+'%;--z-contour-width:'+z.contourGlow.width+'%;--z-contour-height:'+z.contourGlow.height+'%;';
  if(z.barreGlow) css+='--z-barre-left:'+z.barreGlow.left+'%;--z-barre-top:'+z.barreGlow.top+'%;--z-barre-width:'+z.barreGlow.width+'%;--z-barre-height:'+z.barreGlow.height+'%;';
  if(z.boutonVentilo) css+='--z-bouton-left:'+z.boutonVentilo.left+'%;--z-bouton-top:'+z.boutonVentilo.top+'%;--z-bouton-width:'+z.boutonVentilo.width+'%;';
  if(z.logoVentilo) css+='--z-logo-left:'+z.logoVentilo.left+'%;--z-logo-top:'+z.logoVentilo.top+'%;--z-logo-width:'+z.logoVentilo.width+'%;';
  if(z.vitesse) css+='--z-ventilo-vitesse:'+z.vitesse+'s;';
  if(z.flou!=null) css+='--z-ventilo-flou:'+z.flou+'px;';
  if(z.couleurLogo) css+='--z-couleur-logo:'+z.couleurLogo+';';
  return css;
}
function classeSansLogoVentilo(zonesSkin){
  return (zonesSkin && zonesSkin.logoVentilo===null) ? ' sans-logo-ventilo' : '';
}

// Carte complète : utilisée pour MA machine, dont on connaît tous les détails
// (uptime, threads, difficulté, acceptation, historique réel...).
function carteComplete(m, estMoi, idx, ventiloClasse){
  const enLigne=(m.hashrate||0)>0;
  const acceptance=(m.accepted!=null && m.rejected!=null && (m.accepted+m.rejected)>0)
    ? ((m.accepted/(m.accepted+m.rejected))*100).toFixed(1)+'%' : '—';
  const blocBadge=(m.blocsTrouves>0)?'<span class="badgeBloc actif" title="'+m.blocsTrouves+' bloc'+(m.blocsTrouves>1?'s':'')+' trouv\u00e9'+(m.blocsTrouves>1?'s':'')+'">\ud83c\udfc6 '+m.blocsTrouves+'</span>':'';
  const cleStable=cleStableDe(m, estMoi, idx);
  const page=pageActuelle.get(cleStable)||0;
  const cube=infosCube(m.bestDiff||0);
  const nomCubeHtml=cube.nom?'<span class="nomCube">'+cube.nom+'</span>':'';
  // Skin Premium actif (choix local de l'utilisateur, uniquement sur SA propre carte) :
  // remplace UNIQUEMENT l'image de la plaque affichée. La couleur du cube, le logo au
  // centre du ventilo et l'effet rainbow-tier restent STRICTEMENT pilotés par le vrai
  // palier Genèse réellement atteint (cube, dérivé de m.bestDiff) -- changer de skin ne
  // modifie et ne simule jamais une progression de palier.
  const imageCartePlaque=(estMoi && m.skinPremiumActif) ? ('/assets/premium/'+m.skinPremiumActif+'.png'+(TOK?'?token='+TOK:'')) : cube.imageCarte;
  const badgeSkinHtml=(estMoi && m.skinPremiumActif) ? '<span class="badgeSkinPremium" title="Skin Premium actif -- le palier Gen\u00e8se r\u00e9el reste '+(cube.nom||('palier '+cube.niveau))+'">\u2728</span>' : '';
  // Zones propres à ce skin Premium, si ce skin dévie du gabarit standard -- réglées en
  // local via le bouton "🎯 Zones du skin" sur /machines (assets/zones-premium.json),
  // transmises par /api/details sous m.zonesSkinActif.
  const zonesSkinActif=(estMoi && m.skinPremiumActif) ? m.zonesSkinActif : null;
  const heliceSkinUrl=(estMoi && m.skinPremiumActif && m.heliceSkinDisponible)
    ? ('/assets/helices-premium/'+m.skinPremiumActif+'.png?v='+m.heliceSkinVersion+(TOK?'&token='+TOK:'')) : null;
  const cubeSkinUrl=(estMoi && m.skinPremiumActif && m.cubeSkinDisponible)
    ? ('/assets/cubes-premium/'+m.skinPremiumActif+'.png?v='+m.cubeSkinVersion+(TOK?'&token='+TOK:'')) : null;
  const imgStyle=(imageCartePlaque?('--carte-image:url(\\''+imageCartePlaque+'\\');'):'')+(cubeSkinUrl?('--logo-cube:url(\\''+cubeSkinUrl+'\\');'):(cube.imageLogo?('--logo-cube:url(\\''+cube.imageLogo+'\\');'):''))+(heliceSkinUrl?('--fan-blade:url(\\''+heliceSkinUrl+'\\');'):(cube.imageFanBlade?('--fan-blade:url(\\''+cube.imageFanBlade+'\\');'):''))+stylesZonesSkin(zonesSkinActif);
  const couleurCarte=(zonesSkinActif && zonesSkinActif.couleur) ? zonesSkinActif.couleur : cube.couleur;
  return '<div class="carteMachine'+(enLigne?'':' hors-ligne')+(cube.rainbow?' rainbow-tier':'')+classeSansLogoVentilo(zonesSkinActif)+'"'+(idx!=null?' data-idx="'+idx+'"':'')+' data-cle="'+cleStable+'" style="--couleur-cube:'+couleurCarte+';'+imgStyle+'">'
    +'<div class="fondNoir"></div>'
    +'<div class="ventilo'+(ventiloClasse?' '+ventiloClasse:'')+'"><div class="logoVentilo"></div></div>'+'<button type="button" class="boutonVentilo" onclick="toggleVentilo(event)" title="Arr\u00eater/relancer le ventilateur (visuel)" aria-label="Basculer le ventilateur"></button>'
    +'<div class="contourGlow"></div>'
    +'<div class="barreGlow"></div>'
    +'<div class="ecran'+(page===2?' vitrine':'')+'" style="--marge-h:'+(CE.margeH!=null?CE.margeH:2.5)+'%;--marge-v:'+(CE.margeV!=null?CE.margeV:2)+'%">'
      +(page===2 ? '' : (
        '<div class="eLigne"><div class="ecranLogo">'+LOGO_SVG+'AXECUBE</div>'
          +blocBadge+badgeSkinHtml
          +'<div class="statut'+(enLigne?'':' off')+'"><span class="pt"></span><span>'+(enLigne?'MINING':'HORS LIGNE')+'</span></div></div>'
        +'<div class="zoneChamps">'
        +(page===0?(
            celda(0,'hashLabel','<div class="ecranLabel">HASHRATE</div>')
          + celda(0,'blocs','<span class="blocsInline" title="Blocs trouv\u00e9s">BLOCS <b>'+(m.blocsTrouves||0)+'</b></span>')
          + celda(0,'hashValeur','<div class="ecranHash">'+fmtHR(m.hashrate||0).replace(/ .*/,'')+'<span>'+ (fmtHR(m.hashrate||0).split(' ')[1]||'') +'</span></div><div class="spark">'+sparkSVG(m.hist)+'</div>')
          + celda(0,'uptime','<span>UPTIME</span><b>'+fmtUp(m.uptime)+'</b>')
          + celda(0,'threads','<span>THREADS</span><b>'+(m.threads||'—')+'</b>')
          + celda(0,'pool','<span>POOL</span><b>'+(m.pool||'—')+'</b>',{defile:true})
          + celda(0,'difficulte','<span>DIFFICULTÉ</span><b>'+fmtD(m.poolDiff||0)+'</b>')
          + celda(0,'meilleure','<span>\ud83c\udfc6 MEILLEURE</span><b>'+fmtD(m.bestDiff||0)+nomCubeHtml+'</b>',true)
          + celda(0,'shares','<span>SHARES</span><b>'+fmtN(m.accepted||0)+' <span class="rej">· '+fmtN(m.rejected||0)+'</span></b>')
          + celda(0,'acceptation','<span>ACCEPTATION</span><b>'+acceptance+'</b>')
          + celda(0,'cours','<span>COURS ₿</span><b>'+fmtPrix(m.btcPrice, m.btcSymbol)+'</b>',true)
        ):(
            celda(1,'blocAMiner','<span>BLOC À MINER</span><b>'+(m.blocHauteur?m.blocHauteur.toLocaleString('fr-FR'):'—')+'</b>')
          + celda(1,'blocsTrouves','<span>BLOCS TROUV\u00c9S</span><b>'+(m.blocsTrouves||0)+'</b>',true)
          + celda(1,'thermique','<span>\ud83c\udf21\ufe0f THERMIQUE</span><b>'+libelleThermique(m)+'</b>',{defile:true})
          + celda(1,'paiement','<span>\ud83d\udcb0 PAIEMENT</span><b>'+libellePaiement(m)+'</b>')
          + celda(1,'difficulteReseau','<span>DIFFICULT\u00c9 R\u00c9SEAU</span><b>'+fmtD(m.netDiff||0)+'</b>')
          + celda(1,'recordJour','<span>RECORD DU JOUR</span><b>'+fmtD(m.bestDiffJour||0)+'</b>')
          + celda(1,'skinActif','<span>SKIN ACTIF</span><b>'+(m.skinPremiumActif||('Palier Gen\u00e8se atteint : '+(cube.nom||'—')))+'</b>',{defile:true})
          + celda(1,'progression','<span>VERS UN BLOC</span><b>'+((m.netDiff>0)?((m.bestDiff||0)/m.netDiff*100).toFixed(6)+'%':'—')+'</b>')
          + celda(1,'travailTotal','<span>TRAVAIL TOTAL</span><b>'+fmtD(m.totalHashes||0)+'H</b>')
          + celda(1,'badges',celdaBadges(m))
          + celda(1,'niveauGenese','<span>PALIER GEN\u00c8SE</span><b>'+(cube.imageLogo?'<img src="'+cube.imageLogo+'" class="miniCube" alt="">':'')+' '+(cube.niveau||0)+'/22</b>')
        ))
        +'</div>'
      ))
    +'</div>'
    +'<button type="button" class="flechePage" onclick="pageSuivante(event,'+idx+')" title="Voir plus d\u2019infos" aria-label="Page suivante">\u203a</button>'
    +'<div class="nomMachine">'+(estMoi?'<span class="badgeMoi">MOI</span> ':'')+(m.worker||'—')+' · '+(m.cpu||'—')+'</div>'
  +'</div>';
}

// Carte allégée : utilisée pour les autres machines du réseau, dont on ne connaît
// que ce qu'elles diffusent réellement (pas d'uptime, threads ni température --
// on ne les invente pas).
function carteLegere(m, idx, ventiloClasse){
  const enLigne=(m.hashrate||0)>0;
  const blocBadge=(m.blocsTrouves>0)?'<span class="badgeBloc actif" title="'+m.blocsTrouves+' bloc'+(m.blocsTrouves>1?'s':'')+' trouv\u00e9'+(m.blocsTrouves>1?'s':'')+'">\ud83c\udfc6 '+m.blocsTrouves+'</span>':'';
  const cleStable=cleStableDe(m, false, idx);
  const page=pageActuelle.get(cleStable)||0;
  const cube=infosCube(m.bestDiff||0);
  const nomCubeHtml=cube.nom?'<span class="nomCube">'+cube.nom+'</span>':'';
  const imgStyle=(cube.imageCarte?('--carte-image:url(\\''+cube.imageCarte+'\\');'):'')+(cube.imageLogo?('--logo-cube:url(\\''+cube.imageLogo+'\\');'):'')+(cube.imageFanBlade?('--fan-blade:url(\\''+cube.imageFanBlade+'\\');'):'');
  return '<div class="carteMachine'+(enLigne?'':' hors-ligne')+(cube.rainbow?' rainbow-tier':'')+'"'+(idx!=null?' data-idx="'+idx+'"':'')+' data-cle="'+cleStable+'" style="--couleur-cube:'+cube.couleur+';'+imgStyle+'">'
    +'<div class="fondNoir"></div>'
    +'<div class="ventilo'+(ventiloClasse?' '+ventiloClasse:'')+'"><div class="logoVentilo"></div></div>'+'<button type="button" class="boutonVentilo" onclick="toggleVentilo(event)" title="Arr\u00eater/relancer le ventilateur (visuel)" aria-label="Basculer le ventilateur"></button>'
    +'<div class="contourGlow"></div>'
    +'<div class="barreGlow"></div>'
    +'<div class="ecran">'
      +'<div class="eLigne"><div class="ecranLogo">'+LOGO_SVG+'AXECUBE</div>'
        +blocBadge
        +'<div class="statut'+(enLigne?'':' off')+'"><span class="pt"></span><span>'+(enLigne?'MINING':'HORS LIGNE')+'</span></div></div>'
      +'<div class="blocHash"><div class="ecranLabel">HASHRATE</div>'
        +'<div class="ecranHash">'+fmtHR(m.hashrate||0).replace(/ .*/,'')+'<span>'+ (fmtHR(m.hashrate||0).split(' ')[1]||'') +'</span></div></div>'
      +(page===0?(
        '<div class="eGrid"><div class="accent"><span>\ud83c\udfc6 MEILLEURE</span><b>'+fmtD(m.bestDiff||0)+nomCubeHtml+'</b></div>'
          +'<div><span>SHARES</span><b>'+fmtN(m.accepted||0)+' <span class="rej">· '+fmtN(m.rejected||0)+'</span></b></div></div>'
        +'<div class="eGrid"><div class="pool-nom"><span>POOL</span><b>'+(m.pool||'—')+'</b></div>'
          +'<div class="accent"><span>COURS ₿</span><b>'+fmtPrix(m.btcPrice, m.btcSymbol)+'</b></div></div>'
      ):(
        '<div class="eGrid"><div><span>BLOC À MINER</span><b>'+(m.blocHauteur?m.blocHauteur.toLocaleString('fr-FR'):'—')+'</b></div>'
          +'<div><span>BLOCS TROUV\u00c9S</span><b class="accent">'+(m.blocsTrouves||0)+'</b></div></div>'
        +'<div class="eGrid"><div class="pool-nom" style="grid-column:1/-1"><span>POOL (COMPLET)</span><b>'+(m.pool||'—')+'</b></div></div>'
      ))
    +'</div>'
    +'<button type="button" class="flechePage" onclick="pageSuivante(event,'+idx+')" title="Voir plus d\u2019infos" aria-label="Page suivante">\u203a</button>'
    +'<div class="nomMachine">'+(m.worker||'—')+' · '+(m.cpu||'—')+(m.ip?' · '+m.ip:'')+'</div>'
  +'</div>';
}

// Mémorise la page actuellement affichée (0 ou 1) pour chaque carte, par machine --
// pour que le choix de page survive aux rafraîchissements automatiques (5s).
const pageActuelle=new Map();
// Même principe pour la pause manuelle du ventilo (bouton) : sans cette mémoire, le
// rafraîchissement automatique (5s) effacerait la pause en régénérant la carte avec
// l'état "en marche" par défaut à chaque fois.
const ventiloPauseManuelle=new Map();
function pageSuivante(e, idx){
  e.stopPropagation();
  const d=donneesActuelles[idx];
  if(!d) return;
  const cleStable=cleStableDe(d.m, d.estMoi, idx);
  const actuelle=pageActuelle.get(cleStable)||0;
  // 3 pages (stats / stats détaillées / vitrine) pour les cartes complètes -- seulement
  // 2 pour les cartes légères des autres machines du réseau (pas les mêmes données).
  const maxPage=d.complete?2:1;
  pageActuelle.set(cleStable, actuelle>=maxPage?0:actuelle+1);
  // Ré-affiche immédiatement cette carte avec la nouvelle page, sans attendre le
  // prochain rafraîchissement automatique.
  const carte=e.currentTarget.closest('.carteMachine');
  const vClasse=(d.m.hashrate||0)>0?'':'arrete';
  carte.outerHTML = d.complete?carteComplete(d.m,d.estMoi,idx,vClasse):carteLegere(d.m,idx,vClasse);
  activerDefilementPool();
}
// Active un défilement en boucle continue (toujours de gauche à droite, jamais de retour
// brutal) sur les noms trop longs pour tenir dans leur case.
function activerDefilementPool(){
  const VITESSE_PX_PAR_SEC=40; // vitesse constante, quelle que soit la longueur du texte
  document.querySelectorAll('.pool-nom').forEach(el=>{
    const b=el.querySelector('b');
    if(!b) return;
    el.classList.remove('defile');
    b.style.removeProperty('--defilement');
    b.style.removeProperty('animation-duration');
    // Retire une éventuelle duplication posée lors d'un précédent appel, pour repartir
    // d'un texte propre avant de mesurer (sinon la mesure inclurait déjà la copie).
    if(b.dataset.texteOriginal!=null) b.textContent=b.dataset.texteOriginal;
    if(b.scrollWidth > el.clientWidth + 2){
      const texte=b.textContent;
      b.dataset.texteOriginal=texte;
      // Duplique le texte avec un séparateur bien visible -- au moment où la 1re copie
      // sort complètement à gauche, la 2e est pile à sa place d'origine : la boucle est
      // invisible, on dirait un flux ininterrompu.
      const separateur='    •    ';
      b.textContent=texte+separateur+texte;
      const largeurUneCopie=b.scrollWidth/2; // approx. -- les deux copies ont la même largeur
      b.style.setProperty('--defilement', (-largeurUneCopie)+'px');
      const dureeSec=Math.max(2, largeurUneCopie/VITESSE_PX_PAR_SEC);
      b.style.animationDuration=dureeSec+'s';
      el.classList.add('defile');
      // charger() remplace la carte entière toutes les 5s (nouveau DOM = animation qui
      // repart de zéro par défaut) -- sans ça, l'oeil perçoit une micro-saccade à chaque
      // rafraîchissement. On calcule où l'animation DEVRAIT en être selon l'horloge
      // réelle, et on la fait reprendre pile à ce point avec un délai négatif -- elle
      // paraît donc continue d'un rafraîchissement à l'autre.
      const decalageSec=(Date.now()/1000)%dureeSec;
      b.style.animationDelay='-'+decalageSec+'s';
    }
  });
}

let donneesActuelles=[]; // {m, estMoi, complete} pour chaque carte affichée, indexé comme le rendu
// Mémorise le dernier statut en-ligne connu de chaque machine (clé = worker, ou "MOI")
// pour ne déclencher l'animation de ralenti du ventilo qu'au moment exact où elle
// tombe hors ligne, et pas à chaque rafraîchissement tant qu'elle le reste.
const dernierStatut=new Map();
function calculerClasseVentilo(cle, enLigne){
  const etaitEnLigne=dernierStatut.has(cle)?dernierStatut.get(cle):enLigne;
  dernierStatut.set(cle, enLigne);
  if(enLigne) return '';
  return etaitEnLigne ? 'ralentit' : 'arrete';
}
async function charger(){
  // Pendant l'édition de l'écran (glisser/redimensionner un champ), on suspend le
  // rafraîchissement automatique -- sinon il écraserait la carte en plein milieu du geste.
  if(typeof editEcranActif!=='undefined' && editEcranActif) return;
  const grille=document.getElementById('grille');
  try{
    const [repDetails, repSwarm]=await Promise.all([
      fetch('/api/details'+Q).then(r=>r.ok?r.json():null).catch(()=>null),
      fetch('/api/swarm'+Q).then(r=>r.ok?r.json():null).catch(()=>null)
    ]);
    const btcPrice=repDetails && repDetails.marche && repDetails.marche.btcPrice;
    const btcSymbol=(repDetails && repDetails.marche && repDetails.marche.btcSymbol)||'$';
    // La hauteur de bloc en cours est une donnée de la blockchain elle-même -- globale,
    // identique pour toutes les machines, pas la peine de la redemander par machine.
    const blocHauteur=repDetails && repDetails.bloc && repDetails.bloc.hauteur;
    let html='';
    donneesActuelles=[];
    // Ma propre machine (celle qui sert ce dashboard) — pas incluse dans /api/swarm
    // qui ne liste que les *autres* machines détectées sur le réseau.
    if(repDetails && repDetails.perf){
      const moi={
        worker: repDetails.worker,
        cpu: repDetails.machine && repDetails.machine.cpu,
        hashrate: repDetails.perf.hashrate,
        hist: repDetails.histHash,
        uptime: repDetails.uptime,
        threads: repDetails.machine && (repDetails.machine.coeursActifs+'/'+repDetails.machine.coeursMax),
        pool: repDetails.pool && repDetails.pool.nom,
        poolDiff: repDetails.stratum && repDetails.stratum.poolDiff,
        bestDiff: repDetails.loterie && repDetails.loterie.bestDiff,
        accepted: repDetails.loterie && repDetails.loterie.accepted,
        rejected: repDetails.loterie && repDetails.loterie.rejected,
        blocsTrouves: repDetails.loterie && repDetails.loterie.blocsTrouves,
        blocHauteur,
        btcPrice, btcSymbol,
        skinPremiumActif: repDetails.skinPremiumActif || null,
        zonesSkinActif: repDetails.zonesSkinActif || null,
        heliceSkinDisponible: repDetails.heliceSkinDisponible || false,
        heliceSkinVersion: repDetails.heliceSkinVersion || '',
        cubeSkinDisponible: repDetails.cubeSkinDisponible || false,
        cubeSkinVersion: repDetails.cubeSkinVersion || '',
        // Nouveau, jamais affiché sur la carte jusqu'ici -- voir panneau 2.
        throttle: repDetails.perf && repDetails.perf.throttle,
        thermalReel: repDetails.perf && repDetails.perf.thermalReel,
        paiement: repDetails.paiement || null,
        netDiff: repDetails.loterie && repDetails.loterie.netDiff,
        bestDiffJour: repDetails.loterie && repDetails.loterie.bestDiffJour,
        totalHashes: repDetails.loterie && repDetails.loterie.totalHashes,
        bestDiffVerifie: repDetails.bestDiffVerifie || 0
      };
      donneesActuelles.push({m:moi, estMoi:true, complete:true});
      const idxMoi=donneesActuelles.length-1;
      // Le bouton "🎯 Zones du skin" n'a de sens que si un skin Premium est actif sur
      // MA carte -- masqué sinon (retenu pour le bouton, pas pour du rendu de carte).
      window._moiSkinActif = moi.skinPremiumActif || null;
      window._moiHeliceSkinDisponible = moi.heliceSkinDisponible || false;
      window._moiHeliceSkinVersion = moi.heliceSkinVersion || '';
      window._moiCubeSkinDisponible = moi.cubeSkinDisponible || false;
      window._moiCubeSkinVersion = moi.cubeSkinVersion || '';
      const btnEditionSkinEl = document.getElementById('btnEditionSkin');
      if(btnEditionSkinEl) btnEditionSkinEl.style.display = moi.skinPremiumActif ? '' : 'none';
      let vClasse=calculerClasseVentilo('MOI', (moi.hashrate||0)>0);
      if(ventiloPauseManuelle.get(cleStableDe(moi, true, idxMoi))) vClasse='arrete';
      html+=carteComplete(moi, true, idxMoi, vClasse);
    }
    const liste=SOLO?[]:((repSwarm && repSwarm.machines)||[]);
    // Le cours BTC et la hauteur de bloc ne sont pas diffusés par chaque machine (ce sont
    // des données globales, identiques partout) -- on les réutilise pour toutes.
    liste.forEach(m0=>{
      const m=Object.assign({},m0,{btcPrice,btcSymbol,blocHauteur});
      donneesActuelles.push({m, estMoi:false, complete:false});
      const idxM=donneesActuelles.length-1;
      let vClasse=calculerClasseVentilo(m.worker||m.machineId||('idx'+idxM), (m.hashrate||0)>0);
      // La pause manuelle (bouton) prime sur l'état détecté automatiquement, et survit
      // ainsi au rafraîchissement de la carte toutes les 5s -- sans ça, le ventilo
      // repartirait tout seul dès le prochain refresh alors que la machine mine toujours.
      // Clé STABLE (nom du worker), pas la position dans la liste -- qui peut changer
      // d'un rafraîchissement à l'autre si l'ordre des machines bouge (tri par hashrate).
      if(ventiloPauseManuelle.get(cleStableDe(m, false, idxM))) vClasse='arrete';
      html+=carteLegere(m, idxM, vClasse);
    });
    if(!html){
      grille.innerHTML='<div class="vide">Aucune machine AXECUBE détectée pour l\\'instant.</div>';
      return;
    }
    grille.innerHTML=html;
    activerDefilementPool();
    // Si la modale est ouverte, on rafraîchit aussi son contenu avec les données à jour
    // (pas seulement au premier clic), pour que le zoom reste "vivant".
    if(indexOuvert!=null && donneesActuelles[indexOuvert]) afficherModale(indexOuvert, false);
  }catch(e){
    grille.innerHTML='<div class="vide">Recherche réseau indisponible.</div>';
  }
}

// --- Agrandissement d'une carte au clic ---
let indexOuvert=null;
const modal=document.getElementById('modalCarte');
const modalHote=document.getElementById('modalCarteHote');
function afficherModale(idx, animer){
  const d=donneesActuelles[idx];
  if(!d) return;
  indexOuvert=idx;
  let vClasse=(d.m.hashrate||0)>0 ? '' : 'arrete';
  if(ventiloPauseManuelle.get(cleStableDe(d.m, d.estMoi, idx))) vClasse='arrete';
  modalHote.innerHTML=d.complete?carteComplete(d.m,d.estMoi,idx,vClasse):carteLegere(d.m,idx,vClasse);
  activerDefilementPool();
  if(animer!==false) modal.classList.add('ouverte');
}
function fermerModale(){
  indexOuvert=null;
  modal.classList.remove('ouverte');
  // Si on ferme la modale pendant l'édition de l'écran (croix, clic en dehors...), on
  // quitte aussi proprement le mode édition -- sinon le bandeau resterait affiché alors
  // que la carte qu'il édite n'est plus visible.
  if(typeof editEcranActif!=='undefined' && editEcranActif) quitterEditionEcran();
}
// Bouton blanc de la carte : arrête/relance le ventilo de cette carte précise, sans
// ouvrir la fenêtre agrandie (stopPropagation) -- pratique pour vérifier le calibrage
// visuel sans le flou de la rotation.
function toggleVentilo(e){
  e.stopPropagation();
  const carte=e.currentTarget.closest('.carteMachine');
  const vent=carte && carte.querySelector('.ventilo');
  if(!vent) return;
  const cle=carte.getAttribute('data-cle');
  const arrete = vent.classList.contains('arrete') || vent.classList.contains('ralentit');
  if(!arrete){
    // Coupure : on rejoue le vrai ralenti progressif (même animation que lors d'une
    // vraie déconnexion) plutôt qu'un arrêt net, pour un effet réaliste. Seul le
    // ventilateur s'assombrit à l'arrêt (déjà géré par .ventilo.arrete) -- l'écran
    // reste stable, pour éviter toute incohérence au rafraîchissement automatique.
    if(cle!=null) ventiloPauseManuelle.set(cle, true);
    vent.classList.remove('arrete');
    vent.classList.add('ralentit');
    clearTimeout(vent._minuteurArret);
    vent._minuteurArret = setTimeout(()=>{
      vent.classList.remove('ralentit');
      vent.classList.add('arrete');
    }, 1800); // durée exacte de l'animation ralentirVentilo
  } else {
    // Redémarrage : retour direct à pleine vitesse.
    if(cle!=null) ventiloPauseManuelle.delete(cle);
    clearTimeout(vent._minuteurArret);
    vent.classList.remove('ralentit','arrete');
  }
}
document.getElementById('grille').addEventListener('click', e=>{
  const carte=e.target.closest('.carteMachine');
  if(!carte) return;
  const idx=carte.getAttribute('data-idx');
  if(idx!=null) afficherModale(parseInt(idx,10));
});
modal.querySelector('.modalFond').addEventListener('click', fermerModale);
modal.querySelector('.modalFermer').addEventListener('click', fermerModale);
document.addEventListener('keydown', e=>{ if(e.key==='Escape') fermerModale(); });

// ============================================================================
// MODE ÉDITION : ajuster position/taille de tous les calques directement sur
// cette page, sans repasser par un outil externe. "Enregistrer" écrit la config
// dans assets/config-visuel.json côté serveur, relue au prochain rafraîchissement.
// ============================================================================
const configInitiale = ${JSON.stringify(cv)};
const DEFINITIONS_EDITION = [
  {cle:'ecran',        label:'ÉCRAN (contenu)',        couleur:'#e0e0e0', parent:'board', hauteur:true},
  {cle:'fondNoir',      label:'FOND NOIR (cache hélice)',couleur:'#0096ff', parent:'board', hauteur:false},
  {cle:'ventilo',       label:'VENTILATEUR (tourne)',    couleur:'#ff0096', parent:'board', hauteur:false, pivot:true},
  {cle:'logoVentilo',   label:'LOGO (solidaire ventilo)',couleur:'#ffdc00', parent:'ventilo', hauteur:false},
  {cle:'contourGlow',   label:'LISERÉ VERT (contour)',   couleur:'#96f01f', parent:'board', hauteur:true},
  {cle:'barreGlow',     label:'BARRE LED (socle)',       couleur:'#ff8800', parent:'board', hauteur:true},
  {cle:'boutonVentilo', label:'BOUTON BLANC (cliquable)',couleur:'#c800ff', parent:'board', hauteur:false},
];
let configEnCours = JSON.parse(JSON.stringify(configInitiale));
let formeSelectionnee = null;

const panneauEdition=document.getElementById('panneauEdition');
const editBoard=panneauEdition.querySelector('.editBoard');
const CARTE_DEFAUT_SRC=editBoard.src; // capturé avant toute modification, pour pouvoir y revenir

// Zoom du panneau d'édition : agrandit editZoneInterne en pixels réels (pas de transform)
// pour que l'overflow:auto du parent .editZone permette de défiler naturellement, et pour
// que les formes (positionnées en %) grossissent proportionnellement avec l'image --
// utile en particulier pour bien caler le cercle de l'hélice sur des pales petites/fines.
const editZoneEl = panneauEdition.querySelector('.editZone');
const editZoneInterne = panneauEdition.querySelector('.editZoneInterne');
const editZoom = document.getElementById('editZoom');
const editZoomVal = document.getElementById('editZoomVal');
const LARGEUR_EDIT_BASE = 420;
editZoom.addEventListener('input', ()=>{
  const pct = Number(editZoom.value);
  editZoneInterne.style.width = (LARGEUR_EDIT_BASE * pct/100) + 'px';
  editZoomVal.textContent = pct+'%';
});
const btnRecentrerZone = document.getElementById('btnRecentrerZone');
btnRecentrerZone.addEventListener('click', ()=>{
  const v = configEnCours.ventilo;
  const rect = editZoneInterne.getBoundingClientRect();
  const cx = (v.left + v.width/2)/100 * rect.width;
  const cy = (v.top/100)*rect.height + (v.width/100)*rect.width/2; // ventilo carré : hauteur en px = largeur en px
  editZoneEl.scrollLeft = cx - editZoneEl.clientWidth/2;
  editZoneEl.scrollTop = cy - editZoneEl.clientHeight/2;
});

const editVentiloEl=panneauEdition.querySelector('.editForme[data-cle="ventilo"]');
const apercuFondNoirEl=panneauEdition.querySelector('.apercuFondNoir');
const apercuVentiloEl=panneauEdition.querySelector('.apercuVentilo');
const apercuLogoVentiloEl=panneauEdition.querySelector('.apercuLogoVentilo');
// URLs locales (dataURL) dès qu'un fichier est choisi cette session, AVANT même l'envoi
// au serveur -- pour un aperçu instantané. Repli sur l'asset déjà enregistré côté serveur
// si présent, puis sur le calque par défaut sinon.
let heliceApercuLocal = null, cubeApercuLocal = null;
function heliceApercuUrl(){
  if(heliceApercuLocal) return heliceApercuLocal;
  if(editCiblageSkin && window._moiHeliceSkinDisponible) return '/assets/helices-premium/'+encodeURIComponent(editCiblageSkin)+'.png?v='+window._moiHeliceSkinVersion+Q;
  return '/assets/fan-blade.png'+Q;
}
function cubeApercuUrl(){
  if(cubeApercuLocal) return cubeApercuLocal;
  if(editCiblageSkin && window._moiCubeSkinDisponible) return '/assets/cubes-premium/'+encodeURIComponent(editCiblageSkin)+'.png?v='+window._moiCubeSkinVersion+Q;
  return '/assets/logo-ventilo.png'+Q;
}
function mettreAJourApercuReel(){
  const f=configEnCours.fondNoir, v=configEnCours.ventilo, l=configEnCours.logoVentilo;
  apercuFondNoirEl.style.left=f.left+'%'; apercuFondNoirEl.style.top=f.top+'%';
  apercuFondNoirEl.style.width=f.width+'%'; apercuFondNoirEl.style.aspectRatio='1/1';
  apercuVentiloEl.style.left=v.left+'%'; apercuVentiloEl.style.top=v.top+'%';
  apercuVentiloEl.style.width=v.width+'%'; apercuVentiloEl.style.aspectRatio='1/1';
  apercuVentiloEl.style.backgroundImage="url('"+heliceApercuUrl()+"')";
  apercuVentiloEl.style.animationDuration=(inVitesseVentilo?inVitesseVentilo.value:0.1)+'s';
  apercuVentiloEl.style.filter = 'blur('+(inFlouVentilo?inFlouVentilo.value:0.4)+'px)';
  const masque = chkSansLogoVentilo.checked;
  apercuLogoVentiloEl.style.display = masque ? 'none' : '';
  if(!masque){
    apercuLogoVentiloEl.style.left=l.left+'%'; apercuLogoVentiloEl.style.top=l.top+'%';
    apercuLogoVentiloEl.style.width=l.width+'%'; apercuLogoVentiloEl.style.aspectRatio='1/1';
    apercuLogoVentiloEl.style.backgroundImage="url('"+cubeApercuUrl()+"')";
  }
}
const editListe=document.getElementById('editListe');
const editStatut=document.getElementById('editStatut');

function appliquerFormeDepuisConfig(cle){
  const def=DEFINITIONS_EDITION.find(d=>d.cle===cle);
  const el=panneauEdition.querySelector('.editForme[data-cle="'+cle+'"]');
  const c=configEnCours[cle];
  el.style.left=c.left+'%'; el.style.top=c.top+'%'; el.style.width=c.width+'%';
  if(def.hauteur) el.style.height=c.height+'%';
  if(def.pivot){
    let pivot=el.querySelector(':scope > .editPivot');
    pivot.style.left=c.pivotX+'%'; pivot.style.top=c.pivotY+'%';
    el.style.transformOrigin=c.pivotX+'% '+c.pivotY+'%';
  }
}
DEFINITIONS_EDITION.forEach(d=>appliquerFormeDepuisConfig(d.cle));

function construireLigne(def){
  const div=document.createElement('div');
  div.className='editLigne';
  div.dataset.cle=def.cle;
  const c=configEnCours[def.cle];
  let champs = '<label>LEFT %<input type="number" step="0.01" data-champ="left" value="'+c.left+'"></label>'
    +'<label>TOP %<input type="number" step="0.01" data-champ="top" value="'+c.top+'"></label>'
    +'<label>WIDTH %<input type="number" step="0.01" data-champ="width" value="'+c.width+'"></label>';
  if(def.hauteur) champs += '<label>HEIGHT %<input type="number" step="0.01" data-champ="height" value="'+c.height+'"></label>';
  if(def.pivot){
    champs += '<label>PIVOT X %<input type="number" step="0.01" data-champ="pivotX" value="'+c.pivotX+'"></label>'
      +'<label>PIVOT Y %<input type="number" step="0.01" data-champ="pivotY" value="'+c.pivotY+'"></label>';
  }
  div.innerHTML = '<div class="nom"><span class="puce" style="background:'+def.couleur+'"></span>'+def.label+'</div>'
    +'<div class="editChamps">'+champs+'</div>';
  div.addEventListener('click', e=>{
    if(e.target.tagName!=='INPUT') selectionnerForme(def.cle);
  });
  div.querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const champ=inp.dataset.champ;
      configEnCours[def.cle][champ]=parseFloat(inp.value)||0;
      appliquerFormeDepuisConfig(def.cle);
      mettreAJourApercuReel();
    });
  });
  return div;
}
DEFINITIONS_EDITION.forEach(def=> editListe.appendChild(construireLigne(def)) );

function selectionnerForme(cle){
  formeSelectionnee=cle;
  panneauEdition.querySelectorAll('.editForme').forEach(el=>el.classList.toggle('selectionnee', el.dataset.cle===cle));
  editListe.querySelectorAll('.editLigne').forEach(el=>el.classList.toggle('selectionnee', el.dataset.cle===cle));
}
panneauEdition.querySelectorAll('.editForme').forEach(el=>{
  el.addEventListener('mousedown', e=>{
    if(el.classList.contains('tourne')) return;
    if(e.target.classList.contains('editPoignee') || e.target.closest('.editPivot')) return;
    // Ne sélectionne pas le parent si on clique sur son enfant imbriqué (logo)
    if(el.dataset.cle==='ventilo' && e.target.closest('[data-cle="logoVentilo"]')) return;
    selectionnerForme(el.dataset.cle);
  });
});

function rafraichirChampsListe(cle){
  const ligne=editListe.querySelector('.editLigne[data-cle="'+cle+'"]');
  const c=configEnCours[cle];
  ligne.querySelectorAll('input').forEach(inp=>{ inp.value=c[inp.dataset.champ]; });
}

// Glisser / redimensionner chaque forme
let glisse=null, dxG=0, dyG=0, redim=null;
panneauEdition.addEventListener('mousedown', e=>{
  const poignee=e.target.closest('.editPoignee');
  const pivotEl=e.target.closest('.editPivot');
  const forme=e.target.closest('.editForme');
  if(pivotEl){
    const cle=pivotEl.closest('.editForme').dataset.cle;
    if(configEnCours[cle] && 'pivotX' in configEnCours[cle]){
      glissePivotCle=cle; e.preventDefault(); e.stopPropagation();
    }
    return;
  }
  if(poignee){
    const cle=poignee.parentElement.dataset.cle;
    if(panneauEdition.querySelector('.editForme[data-cle="'+cle+'"]').classList.contains('tourne')) return;
    redim=cle; e.preventDefault(); e.stopPropagation();
    return;
  }
  if(forme){
    if(forme.classList.contains('tourne')) return;
    if(forme.dataset.cle==='ventilo' && e.target.closest('[data-cle="logoVentilo"]')) return;
    const cle=forme.dataset.cle;
    glisse=cle;
    const r=forme.getBoundingClientRect();
    dxG=e.clientX-r.left; dyG=e.clientY-r.top;
    e.preventDefault();
  }
});
let glissePivotCle=null;
window.addEventListener('mousemove', e=>{
  if(glisse){
    const def=DEFINITIONS_EDITION.find(d=>d.cle===glisse);
    const refEl = def.parent==='ventilo' ? editVentiloEl : editBoard;
    const br=refEl.getBoundingClientRect();
    let x=e.clientX-br.left-dxG, y=e.clientY-br.top-dyG;
    configEnCours[glisse].left=parseFloat((x/br.width*100).toFixed(2));
    configEnCours[glisse].top=parseFloat((y/br.height*100).toFixed(2));
    appliquerFormeDepuisConfig(glisse); rafraichirChampsListe(glisse); mettreAJourApercuReel();
  }
  if(redim){
    const def=DEFINITIONS_EDITION.find(d=>d.cle===redim);
    const refEl = def.parent==='ventilo' ? editVentiloEl : editBoard;
    const br=refEl.getBoundingClientRect();
    const formeEl=panneauEdition.querySelector('.editForme[data-cle="'+redim+'"]');
    const fr=formeEl.getBoundingClientRect();
    const w=e.clientX-fr.left;
    configEnCours[redim].width=parseFloat(Math.max(0.5,w/br.width*100).toFixed(2));
    if(def.hauteur){
      const h=e.clientY-fr.top;
      configEnCours[redim].height=parseFloat(Math.max(0.5,h/br.height*100).toFixed(2));
    }
    appliquerFormeDepuisConfig(redim); rafraichirChampsListe(redim); mettreAJourApercuReel();
  }
  if(glissePivotCle){
    const formeEl=panneauEdition.querySelector('.editForme[data-cle="'+glissePivotCle+'"]');
    const vr=formeEl.getBoundingClientRect();
    let x=e.clientX-vr.left, y=e.clientY-vr.top;
    configEnCours[glissePivotCle].pivotX=parseFloat((x/vr.width*100).toFixed(2));
    configEnCours[glissePivotCle].pivotY=parseFloat((y/vr.height*100).toFixed(2));
    appliquerFormeDepuisConfig(glissePivotCle); rafraichirChampsListe(glissePivotCle); mettreAJourApercuReel();
  }
});
window.addEventListener('mouseup', ()=>{ glisse=null; redim=null; glissePivotCle=null; });

// Ouvrir / fermer le panneau
// editCiblageSkin : null = édition du gabarit global (comportement d'origine),
// sinon itemId du skin Premium en cours d'ajustement (voir bouton "🎯 Zones du skin").
let editCiblageSkin = null;
const editSansLogoLigne = document.getElementById('editSansLogoLigne');
const chkSansLogoVentilo = document.getElementById('chkSansLogoVentilo');
const editLogoFormeEl = panneauEdition.querySelector('.editForme[data-cle="logoVentilo"]');
chkSansLogoVentilo.addEventListener('change', ()=>{
  editLogoFormeEl.style.display = chkSansLogoVentilo.checked ? 'none' : '';
  const ligneListe = editListe.querySelector('.editLigne[data-cle="logoVentilo"]');
  if(ligneListe) ligneListe.style.display = chkSansLogoVentilo.checked ? 'none' : '';
  mettreAJourApercuReel();
});
const btnExtraireHelice = document.getElementById('btnExtraireHelice');
const editCouleurLigne = document.getElementById('editCouleurLigne');
const editVitesseLigne = document.getElementById('editVitesseLigne');
const editFlouLigne = document.getElementById('editFlouLigne');
const inCouleurSkin = document.getElementById('inCouleurSkin');
const btnCouleurSkinDefaut = document.getElementById('btnCouleurSkinDefaut');
let couleurSkinSuitPalier = true; // true = pas de surcharge, on garde la couleur du vrai palier
inCouleurSkin.addEventListener('input', ()=>{ couleurSkinSuitPalier = false; });
btnCouleurSkinDefaut.addEventListener('click', ()=>{ couleurSkinSuitPalier = true; });
const editCouleurLogoLigne = document.getElementById('editCouleurLogoLigne');
const inCouleurLogoSkin = document.getElementById('inCouleurLogoSkin');
const btnCouleurLogoSkinDefaut = document.getElementById('btnCouleurLogoSkinDefaut');
let couleurLogoSkinSuitAmbiance = true;
inCouleurLogoSkin.addEventListener('input', ()=>{ couleurLogoSkinSuitAmbiance = false; });
btnCouleurLogoSkinDefaut.addEventListener('click', ()=>{ couleurLogoSkinSuitAmbiance = true; });
const inVitesseVentilo = document.getElementById('inVitesseVentilo');
const valVitesseVentilo = document.getElementById('valVitesseVentilo');
inVitesseVentilo.addEventListener('input', ()=>{
  valVitesseVentilo.textContent = Number(inVitesseVentilo.value).toFixed(2)+'s';
  apercuVentiloEl.style.animationDuration = inVitesseVentilo.value+'s';
});
const inFlouVentilo = document.getElementById('inFlouVentilo');
const valFlouVentilo = document.getElementById('valFlouVentilo');
inFlouVentilo.addEventListener('input', ()=>{
  valFlouVentilo.textContent = Number(inFlouVentilo.value).toFixed(1)+'px';
  apercuVentiloEl.style.filter = 'blur('+inFlouVentilo.value+'px)';
});
const editCubeLigne = document.getElementById('editCubeLigne');
const fCubeSkin = document.getElementById('fCubeSkin');
const cubeSkinStatut = document.getElementById('cubeSkinStatut');
document.getElementById('btnChoisirCubeSkin').addEventListener('click', ()=> fCubeSkin.click());
fCubeSkin.addEventListener('change', ()=>{
  const fichier = fCubeSkin.files[0];
  if(!fichier || !editCiblageSkin) return;
  cubeSkinStatut.textContent = 'Envoi…';
  const lecteur = new FileReader();
  lecteur.onload = async (e)=>{
    cubeApercuLocal = e.target.result; mettreAJourApercuReel();
    try{
      const r = await fetch('/api/cube-skin'+Q, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ itemId: editCiblageSkin, cube: e.target.result })
      });
      const j = await r.json();
      cubeSkinStatut.textContent = j.ok ? '✓ Cube enregistré' : 'Erreur : '+(j.erreur||'inconnue');
    }catch(err){ cubeSkinStatut.textContent = 'Erreur réseau'; }
  };
  lecteur.readAsDataURL(fichier);
});
const editHeliceUploadLigne = document.getElementById('editHeliceUploadLigne');
const fHeliceSkin = document.getElementById('fHeliceSkin');
const heliceSkinStatut = document.getElementById('heliceSkinStatut');
document.getElementById('btnChoisirHeliceSkin').addEventListener('click', ()=> fHeliceSkin.click());
fHeliceSkin.addEventListener('change', ()=>{
  const fichier = fHeliceSkin.files[0];
  if(!fichier || !editCiblageSkin) return;
  heliceSkinStatut.textContent = 'Envoi…';
  const lecteur = new FileReader();
  lecteur.onload = async (e)=>{
    heliceApercuLocal = e.target.result; mettreAJourApercuReel();
    try{
      const r = await fetch('/api/helice-skin'+Q, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ itemId: editCiblageSkin, helice: e.target.result })
      });
      const j = await r.json();
      heliceSkinStatut.textContent = j.ok ? '✓ Hélice enregistrée' : 'Erreur : '+(j.erreur||'inconnue');
    }catch(err){ heliceSkinStatut.textContent = 'Erreur réseau'; }
  };
  lecteur.readAsDataURL(fichier);
});
btnExtraireHelice.addEventListener('click', async ()=>{
  if(!editCiblageSkin) return;
  btnExtraireHelice.disabled = true; const texteOrigine = btnExtraireHelice.textContent;
  btnExtraireHelice.textContent = 'Découpage…';
  try{
    const v = configEnCours.ventilo;
    const nw = editBoard.naturalWidth, nh = editBoard.naturalHeight;
    const srcSize = (v.width/100) * nw;
    const srcX = (v.left/100) * nw, srcY = (v.top/100) * nh;
    const outSize = Math.max(200, Math.min(1000, Math.round(srcSize)));
    const off = document.createElement('canvas'); off.width = outSize; off.height = outSize;
    const ctx = off.getContext('2d');
    ctx.save();
    ctx.beginPath(); ctx.arc(outSize/2, outSize/2, outSize/2*0.98, 0, Math.PI*2); ctx.clip();
    ctx.drawImage(editBoard, srcX, srcY, srcSize, srcSize, 0, 0, outSize, outSize);
    ctx.restore();
    heliceApercuLocal = off.toDataURL('image/png'); mettreAJourApercuReel();
    const r = await fetch('/api/helice-skin'+Q, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ itemId: editCiblageSkin, helice: off.toDataURL('image/png') })
    });
    const j = await r.json();
    btnExtraireHelice.textContent = j.ok ? '✓ Hélice extraite et enregistrée' : 'Erreur : '+(j.erreur||'inconnue');
    setTimeout(()=>{ btnExtraireHelice.textContent = texteOrigine; btnExtraireHelice.disabled = false; }, 2200);
  }catch(e){
    btnExtraireHelice.textContent = 'Erreur, réessaie'; 
    setTimeout(()=>{ btnExtraireHelice.textContent = texteOrigine; btnExtraireHelice.disabled = false; }, 2200);
  }
});
document.getElementById('btnEdition').addEventListener('click', ()=>{
  editCiblageSkin = null;
  editBoard.src = CARTE_DEFAUT_SRC;
  panneauEdition.querySelector('.editPanneau > h1').textContent = 'Mode édition';
  editSansLogoLigne.style.display = 'none';
  btnExtraireHelice.style.display = 'none';
  editCouleurLigne.style.display = 'none';
  editCouleurLogoLigne.style.display = 'none';
  editVitesseLigne.style.display = 'none';
  editFlouLigne.style.display = 'none';
  editCubeLigne.style.display = 'none';
  editHeliceUploadLigne.style.display = 'none';
  btnRecentrerZone.style.display = 'none';
  editZoom.value = 100; editZoomVal.textContent = '100%'; editZoneInterne.style.width = LARGEUR_EDIT_BASE+'px';
  editZoneEl.scrollLeft = 0; editZoneEl.scrollTop = 0;
  configEnCours = JSON.parse(JSON.stringify(configVisuelActuelle()));
  heliceApercuLocal = null; cubeApercuLocal = null;
  DEFINITIONS_EDITION.forEach(d=>{ appliquerFormeDepuisConfig(d.cle); rafraichirChampsListe(d.cle); });
  mettreAJourApercuReel();
  panneauEdition.classList.add('ouvert');
  editStatut.textContent=''; editStatut.className='editStatut';
});
// Mode "🎯 Zones du skin" : même panneau, mais superposé à l'image du skin Premium actif
// sur MA carte, et enregistré en local (assets/zones-premium.json) au lieu du gabarit
// global -- ne concerne que l'affichage de cette carte, jamais Netlify.
document.getElementById('btnEditionSkin').addEventListener('click', async ()=>{
  const itemId = window._moiSkinActif;
  if(!itemId) return;
  editCiblageSkin = itemId;
  editBoard.src = '/assets/premium/'+encodeURIComponent(itemId)+'.png'+Q;
  panneauEdition.querySelector('.editPanneau > h1').textContent = 'Zones du skin : '+itemId;
  editSansLogoLigne.style.display = 'flex';
  btnExtraireHelice.style.display = '';
  editCouleurLigne.style.display = 'flex';
  editCouleurLogoLigne.style.display = 'flex';
  editVitesseLigne.style.display = 'flex';
  editFlouLigne.style.display = 'flex';
  editCubeLigne.style.display = '';
  cubeSkinStatut.textContent = '';
  editHeliceUploadLigne.style.display = '';
  heliceSkinStatut.textContent = '';
  btnRecentrerZone.style.display = '';
  editZoom.value = 100; editZoomVal.textContent = '100%'; editZoneInterne.style.width = LARGEUR_EDIT_BASE+'px';
  editZoneEl.scrollLeft = 0; editZoneEl.scrollTop = 0;
  editStatut.textContent='Chargement…'; editStatut.className='editStatut';
  try{
    const r = await fetch('/api/zones-skin?itemId='+encodeURIComponent(itemId));
    const j = await r.json();
    const partiel = (j.ok && j.zones) ? j.zones : {};
    configEnCours = JSON.parse(JSON.stringify(configInitiale));
    for(const cle of Object.keys(partiel)){
      if(partiel[cle] && typeof partiel[cle]==='object') Object.assign(configEnCours[cle], partiel[cle]);
    }
    couleurSkinSuitPalier = !partiel.couleur;
    inCouleurSkin.value = partiel.couleur || '#96f01f';
    couleurLogoSkinSuitAmbiance = !partiel.couleurLogo;
    inCouleurLogoSkin.value = partiel.couleurLogo || partiel.couleur || '#96f01f';
    inVitesseVentilo.value = partiel.vitesse || 0.1;
    valVitesseVentilo.textContent = Number(inVitesseVentilo.value).toFixed(2)+'s';
    inFlouVentilo.value = (partiel.flou!=null) ? partiel.flou : 0.4;
    valFlouVentilo.textContent = Number(inFlouVentilo.value).toFixed(1)+'px';
    chkSansLogoVentilo.checked = (partiel.logoVentilo === null);
    editLogoFormeEl.style.display = chkSansLogoVentilo.checked ? 'none' : '';
    const ligneLogo = editListe.querySelector('.editLigne[data-cle="logoVentilo"]');
    if(ligneLogo) ligneLogo.style.display = chkSansLogoVentilo.checked ? 'none' : '';
    heliceApercuLocal = null; cubeApercuLocal = null;
    DEFINITIONS_EDITION.forEach(d=>{ appliquerFormeDepuisConfig(d.cle); rafraichirChampsListe(d.cle); });
    mettreAJourApercuReel();
    panneauEdition.classList.add('ouvert');
    editStatut.textContent=''; editStatut.className='editStatut';
  }catch(e){
    editStatut.textContent='Erreur de chargement, réessaie.'; editStatut.className='editStatut erreur';
    panneauEdition.classList.add('ouvert');
  }
});
function configVisuelActuelle(){
  // Repart de la config actuellement enregistrée côté serveur si on l'a déjà rechargée,
  // sinon celle injectée au chargement de la page.
  return window._configVisuelServeur || configInitiale;
}
document.getElementById('btnEditFermer').addEventListener('click', ()=>{
  panneauEdition.classList.remove('ouvert');
  editLogoFormeEl.style.display = '';
  const ligneLogo = editListe.querySelector('.editLigne[data-cle="logoVentilo"]');
  if(ligneLogo) ligneLogo.style.display = '';
  editVentiloEl.classList.remove('tourne');
  apercuVentiloEl.classList.remove('tourne');
  btnEditTourner.textContent = '▶ Tester la rotation';
  btnEditTourner.classList.remove('actif');
});

// Tester la rotation (ventilo + logo enfant tournent ensemble, comme en prod)
const btnEditTourner=document.getElementById('btnEditTourner');
btnEditTourner.addEventListener('click', ()=>{
  const t=editVentiloEl.classList.toggle('tourne');
  apercuVentiloEl.classList.toggle('tourne', t);
  btnEditTourner.textContent = t ? '⏸ Arrêter' : '▶ Tester la rotation';
  btnEditTourner.classList.toggle('actif', t);
});

// Enregistrer : envoie la config au serveur, qui l'écrit sur disque et l'applique
// immédiatement (sans redémarrage nécessaire). Route selon editCiblageSkin : config
// globale (/api/config-visuel) ou zones d'un skin précis (/api/zones-skin), toutes deux
// 100% locales.
document.getElementById('btnEditEnregistrer').addEventListener('click', async ()=>{
  editStatut.textContent='Enregistrement…'; editStatut.className='editStatut';
  try{
    let r;
    if(editCiblageSkin){
      const zonesAEnvoyer = JSON.parse(JSON.stringify(configEnCours));
      if(chkSansLogoVentilo.checked) zonesAEnvoyer.logoVentilo = null;
      if(!couleurSkinSuitPalier) zonesAEnvoyer.couleur = inCouleurSkin.value;
      if(!couleurLogoSkinSuitAmbiance) zonesAEnvoyer.couleurLogo = inCouleurLogoSkin.value;
      zonesAEnvoyer.vitesse = Number(inVitesseVentilo.value);
      zonesAEnvoyer.flou = Number(inFlouVentilo.value);
      r = await fetch('/api/zones-skin'+Q, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({itemId: editCiblageSkin, zones: zonesAEnvoyer})
      });
    } else {
      r = await fetch('/api/config-visuel'+Q, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(configEnCours)
      });
    }
    const j=await r.json();
    if(j.ok){
      if(!editCiblageSkin) window._configVisuelServeur = configEnCours;
      editStatut.textContent='Enregistré ! Rechargement de la page…';
      editStatut.className='editStatut succes';
      setTimeout(()=>location.reload(), 900);
    } else {
      editStatut.textContent='Erreur : '+(j.erreur||'inconnue');
      editStatut.className='editStatut erreur';
    }
  }catch(e){
    editStatut.textContent='Erreur réseau, réessaie.';
    editStatut.className='editStatut erreur';
  }
});

// --- Édition de l'écran (page 1 / page 2) -----------------------------------------------
// Repositionne/redimensionne en direct les champs de MA carte (celda(), voir plus haut) et
// enregistre le résultat dans CE, persisté côté serveur. Le rafraîchissement automatique
// (charger(), toutes les 5s) est suspendu tant que ce mode est actif (voir tout début de
// charger()), pour ne jamais écraser un glisser-déposer en cours. L'édition se fait TOUJOURS
// dans la vue agrandie (modale) -- jamais sur la petite carte de la grille, trop petite pour
// être manipulée précisément, et dont le DOM est de toute façon distinct de la modale.
let editEcranActif=false, pageEdition=0, champGlisse=null;
// Plus de poignées de glisser pour largeur/taille -- trop peu fiables (angle du geste
// ambigu, difficile à cibler). Remplacées par des champs numériques directs dans le
// bandeau (voir #editEcranChamps), bien plus précis. La position, elle, reste réglable
// en glissant la cellule directement (ça, ça fonctionne bien).
function ajouterPoigneesEdition(){ /* conservé pour compat d'appel, ne fait plus rien */ }
function forcerPageEdition(page){
  pageEdition=page;
  document.getElementById('btnPageEdit0').classList.toggle('actif', page===0);
  document.getElementById('btnPageEdit1').classList.toggle('actif', page===1);
  const idxMoi=donneesActuelles.findIndex(d=>d.estMoi);
  if(idxMoi<0) return;
  const cleStable=cleStableDe(donneesActuelles[idxMoi].m, true, idxMoi);
  pageActuelle.set(cleStable, page);
  const vClasse=(donneesActuelles[idxMoi].m.hashrate||0)>0?'':'arrete';
  modalHote.innerHTML=carteComplete(donneesActuelles[idxMoi].m, true, idxMoi, vClasse);
  ajouterPoigneesEdition();
  document.getElementById('inMargeH').value=CE.margeH!=null?CE.margeH:2.5;
  document.getElementById('inMargeV').value=CE.margeV!=null?CE.margeV:2;
}
document.getElementById('inMargeH').addEventListener('input', function(){
  const v=Math.max(0,Math.min(20,parseFloat(this.value)||0));
  CE.margeH=v;
  const ecran=modalHote.querySelector('.ecran');
  if(ecran) ecran.style.setProperty('--marge-h', v+'%');
});
document.getElementById('inMargeV').addEventListener('input', function(){
  const v=Math.max(0,Math.min(20,parseFloat(this.value)||0));
  CE.margeV=v;
  const ecran=modalHote.querySelector('.ecran');
  if(ecran) ecran.style.setProperty('--marge-v', v+'%');
});
document.getElementById('btnEditionEcran').addEventListener('click', ()=>{
  const idxMoi=donneesActuelles.findIndex(d=>d.estMoi);
  if(idxMoi<0){ alert('Ta machine n\\'est pas encore charg\\u00e9e -- réessaie dans quelques secondes.'); return; }
  editEcranActif=true;
  document.documentElement.classList.add('editEcranMode');
  document.getElementById('panneauEditionEcran').classList.add('ouvert');
  afficherModale(idxMoi, true);
  forcerPageEdition(pageEdition);
});
document.getElementById('btnPageEdit0').addEventListener('click', ()=>forcerPageEdition(0));
document.getElementById('btnPageEdit1').addEventListener('click', ()=>forcerPageEdition(1));
function quitterEditionEcran(){
  editEcranActif=false;
  document.documentElement.classList.remove('editEcranMode');
  document.getElementById('panneauEditionEcran').classList.remove('ouvert');
  charger();
}
document.getElementById('btnEditEcranFermer').addEventListener('click', ()=>{
  quitterEditionEcran();
  fermerModale();
});
document.getElementById('btnEditEcranEnregistrer').addEventListener('click', async ()=>{
  const statut=document.getElementById('editEcranStatut');
  statut.textContent='⏳ Enregistrement...';
  try{
    const r=await fetch('/api/config-ecran?set='+encodeURIComponent(JSON.stringify(CE))+(Q?'&'+Q.slice(1):''));
    const j=await r.json();
    statut.textContent=(j&&j.ok)?'✅ Enregistré.':'⚠️ Échec : '+(j&&j.erreur||'inconnu');
  }catch(e){ statut.textContent='⚠️ Erreur réseau.'; }
});
// Cellules ayant des icônes (donc concernées par le champ "Taille icônes") -- les autres
// n'ont que du texte, ce champ n'aurait aucun effet visible dessus.
const CHAMPS_AVEC_ICONES=new Set(['badges','niveauGenese']);
function selectionnerCellule(cellule){
  modalHote.querySelectorAll('.celluleEcran').forEach(el=>el.classList.remove('selectionnee'));
  cellule.classList.add('selectionnee');
  const champ=cellule.dataset.champ, page=cellule.dataset.page;
  const cfg=CE['page'+page][champ];
  document.getElementById('editEcranNomChamp').textContent=champ;
  document.getElementById('inLargeur').value=cfg.width;
  document.getElementById('inTaille').value=cfg.size||1;
  document.getElementById('inTailleIcone').value=cfg.sizeIcone||1;
  document.getElementById('labelTailleIcone').style.display=CHAMPS_AVEC_ICONES.has(champ)?'flex':'none';
  document.getElementById('editEcranChamps').style.display='flex';
}
document.getElementById('inLargeur').addEventListener('input', function(){
  const cellule=modalHote.querySelector('.celluleEcran.selectionnee');
  if(!cellule) return;
  const champ=cellule.dataset.champ, page=cellule.dataset.page;
  const v=Math.max(5,Math.min(100,parseFloat(this.value)||5));
  CE['page'+page][champ].width=v;
  cellule.style.width=v+'%';
});
document.getElementById('inTaille').addEventListener('input', function(){
  const cellule=modalHote.querySelector('.celluleEcran.selectionnee');
  if(!cellule) return;
  const champ=cellule.dataset.champ, page=cellule.dataset.page;
  const v=Math.max(.4,Math.min(3,parseFloat(this.value)||1));
  CE['page'+page][champ].size=v;
  cellule.style.setProperty('--t', v);
});
document.getElementById('inTailleIcone').addEventListener('input', function(){
  const cellule=modalHote.querySelector('.celluleEcran.selectionnee');
  if(!cellule) return;
  const champ=cellule.dataset.champ, page=cellule.dataset.page;
  const v=Math.max(.4,Math.min(4,parseFloat(this.value)||1));
  CE['page'+page][champ].sizeIcone=v;
  cellule.style.setProperty('--ti', v);
});
document.addEventListener('mousedown', e=>{
  if(!editEcranActif) return;
  // Ne pas démarrer un glisser si on clique DANS les champs numériques du bandeau.
  if(e.target.closest('.editEcranChamps')) return;
  const cellule=e.target.closest('.celluleEcran');
  if(cellule){
    selectionnerCellule(cellule);
    champGlisse=cellule;
    e.preventDefault();
  }
});
document.addEventListener('mousemove', e=>{
  if(!editEcranActif || !champGlisse) return;
  const zone=modalHote.querySelector('.zoneChamps');
  if(!zone) return;
  const br=zone.getBoundingClientRect();
  const champ=champGlisse.dataset.champ, page=champGlisse.dataset.page;
  let left=Math.max(0,Math.min(100,(e.clientX-br.left)/br.width*100));
  let top=Math.max(0,Math.min(100,(e.clientY-br.top)/br.height*100));
  left=parseFloat(left.toFixed(2)); top=parseFloat(top.toFixed(2));
  CE['page'+page][champ].left=left; CE['page'+page][champ].top=top;
  champGlisse.style.left=left+'%'; champGlisse.style.top=top+'%';
});
document.addEventListener('mouseup', ()=>{ champGlisse=null; });

charger();setInterval(charger,5000);
</script></body></html>`;
  }

  const JOUR_DETAIL_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#05070a">
<title>AXECUBE — Détail du jour</title>
<style>
  :root{
    --bg:#07090c; --panel:#0d1014; --panel2:#12161c; --line:#1c2029;
    --amber:#96f01f; --amber-dim:rgba(150,240,31,.6); --amber-faint:rgba(150,240,31,.32);
    --glow:0 0 10px rgba(150,240,31,.35); --led-ok:#4dffc3;
    --white:#e8edf5; --white-dim:rgba(232,237,245,.6); --mut:#6b7686;
    --mono:ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--white);font-family:var(--mono);
       padding:20px;padding-top:max(20px,env(safe-area-inset-top));line-height:1.5}
  .wrap{max-width:720px;margin:0 auto}
  header{display:flex;align-items:center;gap:14px;padding-bottom:18px;
         border-bottom:1px solid var(--line);margin-bottom:22px;flex-wrap:wrap}
  .lien{color:var(--amber);text-decoration:none;font-size:12px;border:1px solid var(--amber-faint);
        padding:7px 13px;border-radius:8px}
  .lien:hover{border-color:var(--amber)}
  h1{font-size:16px;font-weight:600;color:var(--amber);text-shadow:var(--glow)}
  .sub{font-size:11px;color:var(--mut);margin-top:8px}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:18px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
  th{color:var(--amber-faint);font-size:9px;letter-spacing:.14em;font-weight:600}
  td{color:var(--white-dim);font-variant-numeric:tabular-nums}
  tr.partMeilleure td{color:var(--amber);font-weight:600;text-shadow:var(--glow)}
  tr.partForte td{color:var(--led-ok)}
  .badge-diff{display:inline-block;font-size:9px;letter-spacing:.06em;padding:1px 6px;
    border-radius:10px;margin-left:8px;font-weight:600;vertical-align:middle}
  .badge-meilleure{background:rgba(150,240,31,.14);color:var(--amber);border:1px solid rgba(150,240,31,.4)}
  .badge-forte{background:rgba(77,255,195,.12);color:var(--led-ok);border:1px solid rgba(77,255,195,.35)}
  .loading{color:var(--mut);font-size:12px;padding:20px 0}
</style></head>
<body><div class="wrap">
<header>
  <h1 id="titre">Détail du jour</h1>
  <div style="margin-left:auto"><a class="lien" id="retour" href="/details">← Retour au tableau de bord</a></div>
</header>
<div id="zone" class="loading">Chargement…</div>
</div>
<script>
const TOK=${JSON.stringify(jeton || '')};const Q=TOK?('?token='+TOK):'';
function fmtD(d){if(!d)return'—';if(d>=1e12)return(d/1e12).toFixed(2)+' T';if(d>=1e9)return(d/1e9).toFixed(2)+' G';
  if(d>=1e6)return(d/1e6).toFixed(2)+' M';if(d>=1e3)return(d/1e3).toFixed(2)+' k';return d>=100?d.toFixed(0):d.toPrecision(3)}
(async function(){
  const params=new URLSearchParams(location.search);
  const dateISO=params.get('date')||'';
  document.getElementById('retour').href='/details'+Q;
  const zone=document.getElementById('zone');
  if(!dateISO){ zone.innerHTML='<span style="color:var(--mut)">Aucune date fournie.</span>'; return; }
  try{
    const rep=await fetch('/api/journal-jour?date='+encodeURIComponent(dateISO)+(Q?Q.replace('?','&'):''));
    if(rep.status===401){
      zone.innerHTML='<span style="color:#ff6a78">⚠ Accès refusé (401) — le lien contient un ancien jeton, probablement '
        +'périmé depuis un redémarrage du mineur. <a href="/" style="color:var(--amber)">Retour au tableau de bord</a> '
        +'pour récupérer le lien à jour.</span>';
      return;
    }
    const r=await rep.json();
    const e=r.entree;
    const dt=new Date(dateISO+'T00:00:00');
    const dateAffichee=dt.toLocaleDateString('fr-FR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
    document.getElementById('titre').textContent='Détail du '+dateAffichee;
    document.title='AXECUBE — '+dateAffichee;
    if(!e || !e.detail || !e.detail.length){
      zone.innerHTML='<span style="color:var(--mut)">Aucun détail brut disponible pour cette journée (probablement archivée avant cette fonctionnalité).</span>';
      return;
    }
    const meilleureDiff=Math.max(...e.detail.map(s=>s.diff||0));
    const lignes=e.detail.map(s=>{
      const heure=new Date(s.t).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const diff=s.diff||0;
      let classe='', badge='';
      if(diff===meilleureDiff && meilleureDiff>0){
        classe=' class="partMeilleure"';
        badge=' <span class="badge-diff badge-meilleure">★ MEILLEURE</span>';
      } else if(diff>100){
        classe=' class="partForte"';
        badge=' <span class="badge-diff badge-forte">▲ +100</span>';
      }
      return '<tr'+classe+'><td style="color:var(--mut);font-size:11px">'+heure+'</td><td>'+fmtD(diff)+badge+'</td></tr>';
    }).join('');
    zone.outerHTML='<div class="sub">'+e.detail.length+' share(s) accepté(s)</div>'
      +'<table id="zone"><tr><th>HEURE</th><th>DIFFICULTÉ</th></tr>'+lignes+'</table>';
  }catch(err){ zone.innerHTML='<span style="color:var(--mut)">Détail indisponible pour le moment.</span>'; }
})();
</script></body></html>`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // En mode réseau, toute requête distante exige le jeton -- sauf le manifeste et
    // l'icône PWA, ressources publiques non sensibles que Chrome/Edge doivent pouvoir
    // récupérer pour proposer l'installation en application (pas toujours fiable avec
    // un paramètre ?token dans ce genre de requête interne au navigateur).
    if (ouvertLan && url.pathname !== '/manifest.json' && url.pathname !== '/icon.svg') {
      const dist = req.socket.remoteAddress || '';
      const local = dist === '127.0.0.1' || dist === '::1' || dist === '::ffff:127.0.0.1';
      const fourni = url.searchParams.get('token') || req.headers['x-axecube-token'] || '';
      if (!local && fourni !== jeton) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(t.jetonManquant);
        return;
      }
    }
    if (/^\/badges\/[a-z]+\.png$/.test(url.pathname)) {
      const nomFichier = url.pathname.slice('/badges/'.length);
      const cleBadge = nomFichier.replace('.png', '');
      if (!PALIERS.some(p => p.cle === cleBadge)) { res.writeHead(404); res.end(); return; }
      const cheminBadge = path.join(__dirname, 'assets', 'badges', nomFichier);
      fs.readFile(cheminBadge, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      });
      return;
    }
    if (url.pathname === '/assets/bitaxe-board.png') {
      const cheminCarte = path.join(__dirname, 'assets', 'bitaxe-board.png');
      fs.readFile(cheminCarte, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      });
      return;
    }
    if (url.pathname === '/assets/fan-blade.png') {
      const cheminVentilo = path.join(__dirname, 'assets', 'fan-blade.png');
      fs.readFile(cheminVentilo, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      });
      return;
    }
    if (url.pathname === '/assets/logo-ventilo.png') {
      const cheminLogo = path.join(__dirname, 'assets', 'logo-ventilo.png');
      fs.readFile(cheminLogo, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      });
      return;
    }
    if (/^\/assets\/helices-premium\/[a-z0-9-]{1,60}\.png$/i.test(url.pathname)) {
      const chemin = path.join(DOSSIER_HELICES_PREMIUM, path.basename(url.pathname));
      fs.readFile(chemin, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      });
      return;
    }
    if (/^\/assets\/cubes-premium\/[a-z0-9-]{1,60}\.png$/i.test(url.pathname)) {
      const chemin = path.join(DOSSIER_CUBES_PREMIUM, path.basename(url.pathname));
      fs.readFile(chemin, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      });
      return;
    }
    if (/^\/assets\/machines\/niveau-(\d{2})\.png$/.test(url.pathname)) {
      // Une variante de carte par palier de cube (1 à 22). Repli automatique sur la
      // carte par défaut si ce palier précis n'a pas encore d'image fournie -- pas
      // besoin de tout avoir d'un coup, on complète au fur et à mesure.
      const cheminNiveau = path.join(__dirname, 'assets', 'machines', path.basename(url.pathname));
      fs.readFile(cheminNiveau, (err, data) => {
        if (!err) {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
          res.end(data);
          return;
        }
        const cheminDefaut = path.join(__dirname, 'assets', 'bitaxe-board.png');
        fs.readFile(cheminDefaut, (err2, data2) => {
          if (err2) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
          res.end(data2);
        });
      });
      return;
    }
    if (/^\/assets\/cubes\/cube-p(\d{2})\.png$/.test(url.pathname)) {
      // Le logo au centre du ventilateur, par palier -- mêmes noms de fichiers que sur
      // le classement en ligne. Repli sur le logo vert fixe si ce palier n'a pas encore
      // son image dédiée.
      const cheminCube = path.join(__dirname, 'assets', 'cubes', path.basename(url.pathname));
      fs.readFile(cheminCube, (err, data) => {
        if (!err) {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
          res.end(data);
          return;
        }
        const cheminDefaut = path.join(__dirname, 'assets', 'logo-ventilo.png');
        fs.readFile(cheminDefaut, (err2, data2) => {
          if (err2) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
          res.end(data2);
        });
      });
      return;
    }
    if (/^\/assets\/premium\/([a-z0-9-]{1,60})\.png$/i.test(url.pathname)) {
      // Image d'un skin Premium possédé -- JAMAIS écrite sur disque : chargée à la demande
      // depuis le service en ligne (telecharger-premium-possede.js, qui revérifie la
      // possession à chaque appel). Ce proxy garantit que seule une AUTORISATION existe
      // localement (state.skinPremiumActif), jamais l'image elle-même -- indispensable
      // pour qu'une revente future coupe l'accès immédiatement, sans avoir à supprimer un
      // quelconque fichier sur l'ordinateur du précédent propriétaire.
      const itemId = path.basename(url.pathname, '.png');
      recupererUnPremiumPossedeAvecCache(itemId, (err, donnees) => {
        if (err) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ erreur: err.message })); return; }
        // Cache court côté navigateur seulement (jamais sur disque) -- évite de re-solliciter
        // le service à chaque rafraîchissement du dashboard (~toutes les 2-5s) tout en
        // restant cohérent avec la revalidation de possession toutes les 10 min.
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' });
        res.end(donnees);
      });
      return;
    }
    if (url.pathname === '/api/premium-disponibles') {
      // Pièces RÉELLEMENT possédées par cette machine (voir listerPossessionsPremium) --
      // proposées à l'activation directe. Ne liste plus "tout ce qui est gratuit en ce
      // moment" : seule une acquisition réelle (téléchargement depuis boutique.html)
      // rend une pièce éligible ici.
      listerPossessionsPremium((_err, possedees) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ items: possedees }));
      });
      return;
    }
    if (url.pathname === '/api/activer-skin-premium') {
      const id = (url.searchParams.get('id') || '').trim();
      if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ erreur: 'id manquant' })); return; }
      activerSkinPremiumDirect(id, (err, resultat) => {
        if (err) {
          res.writeHead(err.message.includes('gratuit') ? 403 : 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ erreur: err.message }));
          return;
        }
        log('info', `🎨 Skin Premium ${resultat.deja ? 'activé' : 'téléchargé et activé'} : ${id}.`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, skinPremiumActif: state.skinPremiumActif }));
      });
      return;
    }
    if (url.pathname === '/api/skin-premium') {
      // Change (ou retire, si id vide) le skin Premium actif sur LA CARTE VISUELLE
      // uniquement. Ne touche jamais bestDiff/paliersAtteints -- voir le commentaire sur
      // state.skinPremiumActif et sur imageCartePlaque dans carteComplete().
      const id = (url.searchParams.get('id') || '').trim();
      if (id) {
        if (!/^[a-z0-9-]{1,60}$/i.test(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ erreur: 'identifiant invalide' }));
          return;
        }
        const cheminImg = path.join(__dirname, 'assets', 'premium', id + '.png');
        if (!fs.existsSync(cheminImg)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ erreur: 'cette pièce n\'est pas (ou plus) présente localement -- télécharge-la depuis la boutique d\'abord' }));
          return;
        }
        state.skinPremiumActif = id;
        log('info', `🎨 Skin Premium activé sur cette machine : ${id} (le palier Genèse réellement atteint, lui, ne change pas).`);
      } else {
        state.skinPremiumActif = null;
        log('info', '🎨 Skin Premium retiré -- retour à l\'affichage automatique du palier Genèse.');
      }
      stateDirty = true;
      saveState();
      // Propage immédiatement au classement public (au lieu d'attendre le prochain ping
      // automatique à 90s) -- soumettreRecordLeaderboard envoie tout l'état courant, y
      // compris skinPremiumActif, sans jamais pouvoir dégrader le vrai bestDiff enregistré.
      soumettreRecordLeaderboard(false);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, skinPremiumActif: state.skinPremiumActif }));
      return;
    }
    if (url.pathname === '/visite') {
      const cheminVisite = path.join(__dirname, 'pages', 'visite.html');
      fs.readFile(cheminVisite, 'utf8', (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Page de visite introuvable.'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }
    if (url.pathname === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        connected: state.connected, pool: state.pool, user: state.user, worker: workerName, machineId, lan: lanInfo, actif: state.actif,
        statsExternesPool,
        hashrate: state.hashrate, threads: state.threads, maxThreads, cpuModel,
        engine: state.engine,
        btcPrice: state.btcPrice, btcSymbol: state.btcSymbol, btcAt: state.btcAt,
        lastBlockAt: state.lastBlockAt, netHashrate: state.netHashrate,
        paiement: state.paiement,
        throttle: state.throttle, calibration: state.calibration, calibEnCours: state.calibEnCours,
        reseau: { cle: reseauCle, symbole: reseau.symbole, recompense: reseau.recompense, label: reseau.label, reseaux: Object.keys(RESEAUX) },
        perThread: [...workers.keys()].sort((a, b) => a - b).map(id => ({ id, rate: workerRate(id) })),
        accepted: state.accepted, rejected: state.rejected, depuis: state.depuis,
        histHash: state.histHash.slice(-50).map(p => p.v),
        bestDiff: state.bestDiff, bestProofHeader: state.bestProofHeader || null,
        bestDiffRecent: state.bestDiffRecent || 0, bestProofHeaderRecent: state.bestProofHeaderRecent || null,
        thermalReel: lireEtatThermiqueReel(),
        controleThermiqueActif: !controleThermiqueDesactive,
        recordExterne: state.recordExterne || 0,
        paliersAtteints: state.paliersAtteints || {},
        bestDiffVerifie: state.bestDiffVerifie || 0,
        poolDiff: state.poolDiff, netDiff: state.netDiff,
        blockHeight: state.blockHeight, jobId: state.jobId,
        uptime: (Date.now() - state.startedAt) / 1000,
        totalHashes: state.totalHashes,
        diffTotalInfini: state.diffTotalInfini || 0,
        blocsTrouves: state.blocsTrouves || 0,
        soloSplit: soloSplit, presetCle: presetCle,
        diffJour: state.diffJour || 0, bestDiffJour: state.bestDiffJour || 0,
        log: state.log.slice(-200),
      }));
    } else if (url.pathname === '/api/threads') {
      const n = parseInt(url.searchParams.get('n'), 10);
      if (Number.isFinite(n) && !state.calibEnCours) setThreads(n);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ threads: state.threads, maxThreads }));
    } else if (url.pathname === '/api/minage') {
      const on = url.searchParams.get('actif');
      if (on === '0' || on === '1') basculerMinage(on === '1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ actif: state.actif }));
    } else if (url.pathname === '/api/journal-jour') {
      const dateVoulue = url.searchParams.get('date') || '';
      let entree = null;
      if (dateVoulue === state.diffJourDate) {
        // Jour en cours, pas encore archivé dans journalJour : on construit une réponse
        // équivalente à la volée à partir du détail brut accumulé aujourd'hui.
        entree = { date: state.diffJourDate, bestDiff: state.bestDiffJour || 0, diffTotal: state.diffJour || 0,
                   detail: [...(state.detailJour || [])].reverse() };
      } else {
        entree = (state.journalJour || []).find(j => j.date === dateVoulue) || null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entree }));
    } else if (url.pathname === '/api/swarm') {
      const maintenant = Date.now();
      const liste = [...swarmPeers.values()]
        .filter(p => maintenant - p.vu <= SWARM_TIMEOUT_MS)
        .sort((a, b) => b.hashrate - a.hashrate);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ moi: { machineId, worker: workerName, cpu: cpuModel, hashrate: state.hashrate }, machines: liste }));
    } else if (url.pathname === '/api/zones-skin' && req.method === 'GET') {
      // Zones déjà enregistrées pour un skin donné (voir bouton "🎯 Zones du skin" sur
      // /machines) -- objet PARTIEL, ne contient que les zones qui dévient du gabarit,
      // au client de compléter avec configInitiale pour les zones absentes.
      const itemId = url.searchParams.get('itemId') || '';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, zones: zonesPremium[itemId] || {} }));
    } else if (url.pathname === '/api/zones-skin' && req.method === 'POST') {
      // Enregistre les zones ajustées pour un skin donné, en local (assets/zones-premium.json).
      // Même validation que /api/config-visuel (uniquement des nombres, sur les clés
      // connues) -- aucune structure/code arbitraire accepté.
      let corps = '';
      req.on('data', chunk => { corps += chunk; if (corps.length > 20000) req.destroy(); });
      req.on('end', () => {
        try {
          const recu = JSON.parse(corps);
          const itemId = /^[a-z0-9-]{1,60}$/i.test(recu.itemId || '') ? recu.itemId : null;
          if (!itemId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, erreur: 'itemId invalide' }));
            return;
          }
          const zonesRecues = recu.zones || {};
          const nouvelle = {};
          for (const cle of Object.keys(CONFIG_VISUEL_DEFAUT)) {
            if (!zonesRecues[cle]) continue; // absent = ne suit pas ce skin, retombe sur cv
            nouvelle[cle] = {};
            for (const champ of Object.keys(CONFIG_VISUEL_DEFAUT[cle])) {
              const v = Number(zonesRecues[cle][champ]);
              if (Number.isFinite(v)) nouvelle[cle][champ] = v;
            }
          }
          // logoVentilo:null explicite = "l'hélice a déjà son cube, masquer l'overlay".
          if (zonesRecues.logoVentilo === null) nouvelle.logoVentilo = null;
          // Couleur d'ambiance propre au skin (liseré, barre LED, logo/marque AXECUBE,
          // nom du palier) -- surcharge --couleur-cube UNIQUEMENT visuellement, ne change
          // jamais le palier réel ni les données affichées (bestDiff, nom du palier...).
          if (/^#[0-9a-f]{6}$/i.test(zonesRecues.couleur || '')) nouvelle.couleur = zonesRecues.couleur;
          // Couleur propre au logo/marque AXECUBE affiché dans l'écran, indépendante de
          // la couleur d'ambiance (liseré/barre LED) -- utile car le texte a besoin de
          // contraste sur fond noir, sans dépendre de l'intensité choisie pour le halo.
          if (/^#[0-9a-f]{6}$/i.test(zonesRecues.couleurLogo || '')) nouvelle.couleurLogo = zonesRecues.couleurLogo;
          // Vitesse de rotation propre au skin, en secondes par tour (plus petit = plus
          // rapide). Bornée pour rester sensée -- ni figée, ni en toupie illisible.
          const vitesse = Number(zonesRecues.vitesse);
          if (Number.isFinite(vitesse) && vitesse >= 0.02 && vitesse <= 3) nouvelle.vitesse = vitesse;
          // Flou de rotation propre au skin, en pixels -- 0 = toujours net (utile pour
          // les artworks très détaillés), valeur haute = effet de mouvement plus marqué.
          const flou = Number(zonesRecues.flou);
          if (Number.isFinite(flou) && flou >= 0 && flou <= 6) nouvelle.flou = flou;

          zonesPremium[itemId] = nouvelle;
          sauvegarderZonesPremium(zonesPremium);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, itemId, zones: nouvelle }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erreur: 'JSON invalide : ' + e.message }));
        }
      });
    } else if (url.pathname === '/api/helice-skin' && req.method === 'POST') {
      // Reçoit l'hélice découpée depuis l'artwork du skin (bouton "✂️ Extraire l'hélice"
      // du panneau "🎯 Zones du skin") et l'écrit dans assets/helices-premium/<itemId>.png.
      // Comme zones-premium.json, ce fichier est prévu pour être commité en Git.
      let corps = '';
      req.on('data', chunk => { corps += chunk; if (corps.length > 8 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const recu = JSON.parse(corps);
          const itemId = /^[a-z0-9-]{1,60}$/i.test(recu.itemId || '') ? recu.itemId : null;
          const m = /^data:image\/png;base64,(.+)$/.exec(recu.helice || '');
          if (!itemId || !m) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, erreur: 'itemId ou image (PNG base64) invalide' }));
            return;
          }
          fs.mkdirSync(DOSSIER_HELICES_PREMIUM, { recursive: true });
          fs.writeFileSync(path.join(DOSSIER_HELICES_PREMIUM, itemId + '.png'), Buffer.from(m[1], 'base64'));
          helicesSkinDisponibles.add(itemId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, itemId }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erreur: 'JSON invalide : ' + e.message }));
        }
      });
    } else if (url.pathname === '/api/cube-skin' && req.method === 'POST') {
      // Reçoit un PNG fourni directement par Chris (upload de fichier, pas de découpe)
      // pour le cube/logo central d'un skin -- assets/cubes-premium/<itemId>.png.
      let corps = '';
      req.on('data', chunk => { corps += chunk; if (corps.length > 8 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const recu = JSON.parse(corps);
          const itemId = /^[a-z0-9-]{1,60}$/i.test(recu.itemId || '') ? recu.itemId : null;
          const m = /^data:image\/png;base64,(.+)$/.exec(recu.cube || '');
          if (!itemId || !m) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, erreur: 'itemId ou image (PNG base64) invalide' }));
            return;
          }
          fs.mkdirSync(DOSSIER_CUBES_PREMIUM, { recursive: true });
          fs.writeFileSync(path.join(DOSSIER_CUBES_PREMIUM, itemId + '.png'), Buffer.from(m[1], 'base64'));
          cubesSkinDisponibles.add(itemId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, itemId }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erreur: 'JSON invalide : ' + e.message }));
        }
      });
    } else if (url.pathname === '/api/config-visuel' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(configVisuel));
    } else if (url.pathname === '/api/config-visuel' && req.method === 'POST') {
      // Reçoit la config éditée depuis le mode édition de /machines, la valide
      // sommairement (structure attendue uniquement, pas de code exécutable possible
      // puisqu'on ne stocke que des nombres), puis l'écrit sur disque pour qu'elle
      // survive aux redémarrages.
      let corps = '';
      req.on('data', chunk => { corps += chunk; if (corps.length > 20000) req.destroy(); });
      req.on('end', () => {
        try {
          const recu = JSON.parse(corps);
          const nouvelle = {};
          for (const cle of Object.keys(CONFIG_VISUEL_DEFAUT)) {
            const section = recu[cle] || {};
            nouvelle[cle] = {};
            for (const champ of Object.keys(CONFIG_VISUEL_DEFAUT[cle])) {
              const v = Number(section[champ]);
              nouvelle[cle][champ] = Number.isFinite(v) ? v : CONFIG_VISUEL_DEFAUT[cle][champ];
            }
          }
          configVisuel = nouvelle;
          sauvegarderConfigVisuel(configVisuel);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erreur: 'JSON invalide' }));
        }
      });
    } else if (url.pathname === '/api/config-ecran') {
      // Position/taille de chaque champ texte de l'écran (page 1/2), éditée en direct via
      // le bouton "🛠 Écran" sur /machines. GET seul renvoie la config actuelle ; avec
      // ?set=<json>, la remplace -- validée champ par champ (uniquement des nombres, sur
      // les clés connues), jamais de structure/code arbitraire accepté.
      const brutSet = url.searchParams.get('set');
      if (brutSet) {
        try {
          const recu = JSON.parse(brutSet);
          const nouvelle = {
            margeH: Number.isFinite(Number(recu.margeH)) ? Number(recu.margeH) : CONFIG_ECRAN_DEFAUT.margeH,
            margeV: Number.isFinite(Number(recu.margeV)) ? Number(recu.margeV) : CONFIG_ECRAN_DEFAUT.margeV,
            page0: {}, page1: {},
          };
          for (const page of ['page0', 'page1']) {
            const section = (recu && recu[page]) || {};
            for (const champ of Object.keys(CONFIG_ECRAN_DEFAUT[page])) {
              const src = section[champ] || {};
              const def = CONFIG_ECRAN_DEFAUT[page][champ];
              nouvelle[page][champ] = {
                left: Number.isFinite(Number(src.left)) ? Number(src.left) : def.left,
                top: Number.isFinite(Number(src.top)) ? Number(src.top) : def.top,
                width: Number.isFinite(Number(src.width)) ? Number(src.width) : def.width,
                size: Number.isFinite(Number(src.size)) ? Number(src.size) : def.size,
                sizeIcone: Number.isFinite(Number(src.sizeIcone)) ? Number(src.sizeIcone) : (def.sizeIcone || 1),
              };
            }
          }
          configEcran = nouvelle;
          sauvegarderConfigEcran(configEcran);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erreur: 'JSON invalide : ' + e.message }));
        }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(configEcran));
    } else if (url.pathname === '/api/details') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '1.0',
        adresse: address, worker: workerName, machineId, scriptPubKey: scriptAttendu,
        pool: { hote: poolHost, port: poolPort, nom: poolLabel },
        stratum: {
          connecte: state.connected, extranonce1, extranonce2Size,
          poolDiff: state.poolDiff, jobId: state.jobId,
        },
        moteur: { nom: state.engine, variante: state.engineVariant || null },
        machine: { cpu: cpuModel, coeursMax: maxThreads, coeursActifs: state.threads, machineId },
        perf: {
          hashrate: state.hashrate, perThread: [...workers.keys()].sort((a,b)=>a-b).map(id=>({id,rate:workerRate(id)})),
          throttle: state.throttle, totalHashes: state.totalHashes, thermalReel: lireEtatThermiqueReel(),
        },
        loterie: {
          bestDiff: state.bestDiff, bestProofHeader: state.bestProofHeader || null,
          bestDiffRecent: state.bestDiffRecent || 0, bestProofHeaderRecent: state.bestProofHeaderRecent || null,
          recordExterne: state.recordExterne || 0,
          accepted: state.accepted, rejected: state.rejected,
          netDiff: state.netDiff, netHashrate: state.netHashrate,
          diffTotalInfini: state.diffTotalInfini || 0,
          blocsTrouves: state.blocsTrouves || 0,
          diffInfiniDepuis: state.diffInfiniDepuis || null,
          codeAccesClassement: state.codeAccesClassement || null,
          journalJour: (state.journalJour || []).slice(-30).map(j => ({ date: j.date, bestDiff: j.bestDiff, diffTotal: j.diffTotal, sansActivite: !!j.sansActivite })),
          diffJour: state.diffJour || 0, bestDiffJour: state.bestDiffJour || 0,
          totalHashes: state.totalHashes || 0,
        },
        bloc: { hauteur: state.blockHeight, depuis: state.lastBlockAt },
        paiement: state.paiement,
        skinPremiumActif: state.skinPremiumActif || null,
        zonesSkinActif: zonesSkinActifPour(state.skinPremiumActif),
        heliceSkinDisponible: !!(state.skinPremiumActif && helicesSkinDisponibles.has(state.skinPremiumActif)),
        heliceSkinVersion: (state.skinPremiumActif && helicesSkinDisponibles.has(state.skinPremiumActif))
          ? empreinteFichier(path.join('assets', 'helices-premium', state.skinPremiumActif + '.png')) : '',
        cubeSkinDisponible: !!(state.skinPremiumActif && cubesSkinDisponibles.has(state.skinPremiumActif)),
        cubeSkinVersion: (state.skinPremiumActif && cubesSkinDisponibles.has(state.skinPremiumActif))
          ? empreinteFichier(path.join('assets', 'cubes-premium', state.skinPremiumActif + '.png')) : '',
        bestDiffVerifie: state.bestDiffVerifie || 0,
        reseau: { cle: reseauCle, symbole: reseau.symbole, recompense: reseau.recompense, label: reseau.label },
        marche: { btcPrice: state.btcPrice, btcSymbol: state.btcSymbol, devise: state.btcDevise },
        calibration: state.calibration,
        histRecord: state.histRecord, histHash: state.histHash,
        uptime: (Date.now() - state.startedReal) / 1000,
        lang,
      }));
    } else if (url.pathname === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
      res.end(JSON.stringify({
        name: 'AXECUBE — Mineur Lottery',
        short_name: 'AXECUBE',
        description: 'Mineur Bitcoin solo CPU, gratuit et sans publicité.',
        start_url: '/' + (jeton ? '?token=' + jeton : ''),
        scope: '/',
        display: 'standalone',
        background_color: '#05070a',
        theme_color: '#05070a',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      }));
    } else if (url.pathname === '/icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect width="100" height="100" rx="18" fill="#05070a"/>
        <g stroke="#96f01f" stroke-width="3" fill="none" stroke-linejoin="round">
          <path d="M50 14 L84 32 L84 68 L50 86 L16 68 L16 32 Z"/>
          <path d="M50 14 L50 50 M50 50 L84 32 M50 50 L16 32 M50 50 L50 86"/>
        </g>
      </svg>`);
    } else if (url.pathname === '/details') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DETAILS_HTML);
    } else if (url.pathname === '/details/jour') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(JOUR_DETAIL_HTML);
    } else if (url.pathname === '/machines') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(genererMachinesHTML());
    } else if (url.pathname === '/decouvrir') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DECOUVRIR_HTML);
    } else if (url.pathname === '/soutenir') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SOUTENIR_HTML);
    } else if (url.pathname === '/api/network') {
      const cle = (url.searchParams.get('net') || '').toLowerCase();
      const ok = changerReseau(cle);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, reseau: reseauCle }));
    } else if (url.pathname === '/api/solo-split') {
      const n = url.searchParams.get('n');
      const ok = changerSoloSplit(n);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    } else if (url.pathname === '/api/pool') {
      const cle = (url.searchParams.get('preset') || '').toLowerCase();
      const ok = changerPool(cle);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, pool: poolLabel, host: poolHost, port: poolPort }));
    } else if (url.pathname === '/api/calibrer') {
      if (!state.calibEnCours) calibrer();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ demarre: true }));
    } else if (url.pathname === '/api/thermique-desactiver') {
      controleThermiqueDesactive = true;
      log('warn', '🌡️  Contrôle thermique automatique désactivé manuellement pour cette session (redevient actif au prochain démarrage).');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ controleThermiqueActif: false }));
    } else if (url.pathname === '/api/thermique-activer') {
      controleThermiqueDesactive = false;
      threadsAvantReductionThermique = null; // repart proprement, sans réduction "en attente" fantôme
      log('ok', '🌡️  Contrôle thermique automatique réactivé.');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ controleThermiqueActif: true }));
    } else if (url.pathname === '/api/recuperer-recompenses') {
      recupererRecompenses((err, resultat) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erreur: err.message }));
          return;
        }
        if (resultat.telecharges.length) {
          log('ok', `🎁 Récompenses récupérées : ${resultat.telecharges.join(', ')}.`);
        }
        if (resultat.echecs.length) {
          log('warn', `⚠️  Certaines récompenses n'ont pas pu être récupérées : ${resultat.echecs.join(', ')}.`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Object.assign({ ok: true }, resultat)));
      });
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
    }
  });
  /** Toutes les adresses IPv4 utilisables, les interfaces physiques en premier. */
  function ipsLocales() {
    const virtuelles = /^(utun|awdl|llw|bridge|vmnet|vnic|docker|tap|tun|veth|anpi)/i;
    const sortie = [];
    try {
      for (const [nom, cartes] of Object.entries(os.networkInterfaces())) {
        for (const c of cartes || []) {
          if (c.family !== 'IPv4' || c.internal) continue;
          if (c.address.startsWith('169.254')) continue;
          sortie.push({ nom, ip: c.address, virtuelle: virtuelles.test(nom) });
        }
      }
    } catch {}
    // en0/en1 (Wi-Fi, Ethernet) d'abord, interfaces virtuelles en dernier
    sortie.sort((a, b) => (a.virtuelle - b.virtuelle) || a.nom.localeCompare(b.nom));
    return sortie;
  }

  if (preset) {
    console.log(`\n⚠️  Préréglage "${presetCle}" : ${preset.note}\n`);
  }
  if (modeCle === 'solo') {
    console.log(`\n🔒 MODE SOLO — récompense entière sur cette adresse (${address.slice(0,10)}…) si un bloc est trouvé.`);
    console.log(`   Cette adresse peut être partagée avec plusieurs machines pour cumuler le hashrate`);
    console.log(`   (famille/amis), mais gardez-la privée : celui qui la connaît peut y faire miner`);
    console.log(`   d'autres personnes, et seul le détenteur de la clé reçoit une éventuelle récompense.\n`);
  } else if (modeCle === 'pool') {
    console.log(`\n🤝 MODE POOL — paiement automatique proportionnel à votre contribution réelle (pas de risque de partage).\n`);
  }
  if (leaderboardUrl && !leaderboardDesactive) {
    console.log(`🌍 Classement communautaire activé (par défaut) : ${leaderboardUrl}`);
    console.log(`   Seuls votre nom de worker, votre CPU et votre meilleure difficulté sont partagés — jamais votre adresse.`);
    console.log(`   Pour désactiver : ajoutez --no-leaderboard\n`);
  }

  let lanInfo = { ouvert: ouvertLan, port: dashPort, ip: null, ipTailscale: null };

  /** Tailscale attribue toujours ses adresses dans la plage CGNAT réservée 100.64.0.0/10
   *  (RFC 6598) -- indépendant du nom de l'interface (utun3, utun4... variable), donc
   *  fiable même si Tailscale change sa numérotation d'une version à l'autre. */
  function estAdresseTailscale(ip) {
    const m = /^100\.(\d{1,3})\./.exec(ip);
    if (!m) return false;
    const deuxieme = Number(m[1]);
    return deuxieme >= 64 && deuxieme <= 127;
  }

  server.listen(dashPort, ouvertLan ? '0.0.0.0' : '127.0.0.1', () => {
    if (!ouvertLan) { log('info', t.dashboardLocal(dashPort)); return; }
    log('info', t.dashboard(dashPort));
    const ips = ipsLocales();
    const q = ':' + dashPort + '/?token=' + jeton;
    if (ips.length) {
      lanInfo.ip = ips[0].ip;
      log('info', t.dashboardLan(ips[0].ip + q));
      for (const autre of ips.slice(1, 4)) log('info', t.dashboardLanAutre(autre.nom, autre.ip + q));
    }
    const tailscale = ips.find((i) => estAdresseTailscale(i.ip));
    if (tailscale) {
      lanInfo.ipTailscale = tailscale.ip;
      log('info', `🌐 Tailscale détecté : ${tailscale.ip}${q} -- accessible aussi en dehors de votre réseau local, depuis un appareil connecté au même compte Tailscale.`);
    }
  });

  /** Vérifie une seule fois au démarrage si une version plus récente est publiée sur GitHub
   *  (fichier VERSION à la racine du repo) -- purement informatif, jamais bloquant : toute
   *  erreur (hors ligne, GitHub inaccessible, timeout) est simplement ignorée en silence. */
  async function verifierMiseAJour() {
    try {
      const ctrl = new AbortController();
      const minuteur = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch('https://raw.githubusercontent.com/kinitof/axecube/main/VERSION', { signal: ctrl.signal });
      clearTimeout(minuteur);
      if (!res.ok) return;
      const distante = (await res.text()).trim();
      const enTableau = (v) => v.split('.').map(n => parseInt(n, 10) || 0);
      const [dA, dB, dC] = enTableau(distante), [lA, lB, lC] = enTableau(AXECUBE_VERSION);
      const plusRecente = dA > lA || (dA === lA && dB > lB) || (dA === lA && dB === lB && dC > lC);
      if (plusRecente && /^\d+\.\d+\.\d+$/.test(distante)) {
        console.log('');
        console.log(`  ⚠️  Nouvelle version d'AXECUBE disponible : v${AXECUBE_VERSION} → v${distante}`);
        console.log('     https://github.com/kinitof/axecube');
        console.log('');
      }
    } catch { /* hors ligne ou GitHub inaccessible -- on n'interrompt jamais le démarrage pour ça */ }
  }
  verifierMiseAJour();

  /* ------------------------------- Démarrage ------------------------------ */
  console.log('');
  console.log('  ⛏️  ' + t.banniere + (reseau.symbole !== 'BTC' ? `  [${reseau.label}]` : ''));
  console.log(`  Version : ${AXECUBE_VERSION}`);
  console.log(`  ${t.adresse} : ${address}`);
  console.log(`  ${t.pool} : ${poolHost}:${poolPort}`);
  if (soloSplit !== null) {
    console.log(`  ⚖️  Solo Split : ${soloSplit}% solo / ${100 - soloSplit}% pool (mot de passe stratum = "${soloSplit}")`);
  }
  console.log(`  ${t.threads} : ${threads}`);
  console.log('');
  connect();
}

main();
