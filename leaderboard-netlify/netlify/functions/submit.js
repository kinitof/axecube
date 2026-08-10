// AXECUBE — fonction Netlify : réception d'un record de difficulté, avec vérification
// cryptographique de la preuve de travail (empêche de déclarer une difficulté sans
// avoir réellement produit le calcul correspondant).
'use strict';
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

/** Code d'accès lisible (pas de 0/O/1/I ambigus) -- sert à rattacher cette machine à un
 *  compte (wallet Solana) sur "Mes récompenses gagnées". Généré UNE SEULE FOIS, à la toute
 *  première soumission de ce machineId, puis jamais régénéré (sinon le propriétaire perdrait
 *  l'accès à ses propres récompenses déjà acquises). */
function genererCodeAcces() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code.slice(0, 4) + '-' + code.slice(4);
}

const MAX_TEXTE = 40;
const DIFF1 = 0x00000000FFFF0000000000000000000000000000000000000000000000000000n;
const TOLERANCE = 0.98; // marge d'arrondi flottant entre client et serveur
const HISTOIRE_MAX = 5000; // entrées conservées par mineur (~35 jours à raison de records fréquents)
const FENETRE_HISTOIRE_MS = 35 * 24 * 3600e3;
// Un CPU, même très musclé (SIMD, gros Threadripper), ne dépasse pas quelques centaines de
// MH/s. Un Bitaxe (ASIC) démarre à plusieurs centaines de GH/s. La marge est large exprès
// pour ne jamais classer un CPU costaud comme ASIC par erreur.
const SEUIL_ASIC_HS = 1e9; // 1 GH/s

function nettoieTexte(v, max) {
  return String(v == null ? '' : v).replace(/[<>]/g, '').slice(0, max);
}

/** Recalcule indépendamment la difficulté d'un en-tête de bloc de 80 octets (sha256d). */
function difficulteDepuisHeader(headerHex) {
  if (typeof headerHex !== 'string' || !/^[0-9a-fA-F]{160}$/.test(headerHex)) return null;
  const header = Buffer.from(headerHex, 'hex');
  const h1 = crypto.createHash('sha256').update(header).digest();
  const h2 = crypto.createHash('sha256').update(h1).digest();
  const hashBE = BigInt('0x' + Buffer.from(h2).reverse().toString('hex'));
  if (hashBE === 0n) return Infinity;
  return Number((DIFF1 * 1000000n) / hashBE) / 1000000;
}

// Étiquettes calendaires (toujours en UTC, pour que tous les mineurs dans le monde partagent
// exactement les mêmes frontières de jour/semaine/mois -- sans ça, un mineur au Japon et un
// mineur en France ne changeraient pas de "jour" au même instant, ce qui fausserait le classement).
function etiquetteJour(ts) {
  const d = new Date(ts);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function etiquetteMois(ts) {
  const d = new Date(ts);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
function etiquetteSemaineISO(ts) {
  // Semaine ISO 8601 (commence le lundi) -- même convention que "SEMAINE" affiché côté UI.
  const d = new Date(Date.UTC(new Date(ts).getUTCFullYear(), new Date(ts).getUTCMonth(), new Date(ts).getUTCDate()));
  const jourSemaine = (d.getUTCDay() + 6) % 7; // lundi=0 ... dimanche=6
  d.setUTCDate(d.getUTCDate() - jourSemaine + 3); // jeudi de la semaine courante
  const premierJeudi = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const numero = 1 + Math.round(((d - premierJeudi) / 86400000 - 3 + ((premierJeudi.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() + '-W' + String(numero).padStart(2, '0');
}

/** Fait avancer (ou garde) un compteur de période : nouvelle étiquette = on repart de cette
 *  valeur (même si elle est plus basse que l'ancienne -- la période précédente est terminée) ;
 *  même étiquette = on ne garde que le maximum. */
function avancerPeriode(actuel, etiquette, valeur) {
  if (!actuel || actuel.etiquette !== etiquette) return { etiquette, valeur };
  return { etiquette, valeur: Math.max(actuel.valeur, valeur) };
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: '{}' };

  let j;
  try { j = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: '{}' }; }

  const worker = nettoieTexte(j.worker, MAX_TEXTE) || 'anon';
  const bestDiffAnnonce = Number(j.bestDiff) || 0;
  const hashrate = Number(j.hashrate) || 0;
  const cpu = nettoieTexte(j.cpu, MAX_TEXTE);
  const pool = nettoieTexte(j.pool, 30) || null;
  const machineId = /^[0-9a-f]{8,32}$/i.test(j.machineId || '') ? j.machineId : null;
  const headerHex = typeof j.headerHex === 'string' ? j.headerHex : null;
  const diffPeriodeAnnonce = Number(j.diffPeriode) || 0;
  const headerHexPeriode = typeof j.headerHexPeriode === 'string' ? j.headerHexPeriode : null;
  const acceptedAnnonce = Math.max(0, Math.floor(Number(j.accepted) || 0));
  const totalHashesAnnonce = Math.max(0, Number(j.totalHashes) || 0);
  // Skin Premium actif choisi localement par l'utilisateur -- purement cosmétique, affiché
  // publiquement (classement) pour donner envie à la communauté d'acheter la même pièce.
  // Ne participe JAMAIS au calcul du record, du classement, ni d'aucune valeur compétitive
  // -- même règle strictement respectée que côté axecube.js (voir carteComplete()).
  const skinPremiumAnnonce = /^[a-z0-9-]{1,60}$/i.test(j.skinPremiumActif || '') ? j.skinPremiumActif : null;
  if (bestDiffAnnonce <= 0) return { statusCode: 400, headers: cors, body: '{}' };

  // Vérification cryptographique : sans preuve valide correspondant à la difficulté
  // annoncée (ou dépassant la tolérance d'arrondi), on ne retient PAS cette valeur comme
  // nouveau record -- mais on n'ignore plus toute la soumission pour autant : le pool
  // actuellement utilisé, le hashrate et le "vu à" doivent quand même pouvoir se mettre à
  // jour à chaque ping (ex. reprise d'un ancien record sans preuve locale, ou simple
  // battement de coeur périodique), sans que ça ouvre la porte à truquer le record lui-même.
  let bestDiffVerifie = 0;
  let verifie = false;
  if (headerHex) {
    const recalcul = difficulteDepuisHeader(headerHex);
    if (recalcul !== null && recalcul >= bestDiffAnnonce * TOLERANCE) {
      bestDiffVerifie = Math.min(recalcul, bestDiffAnnonce * 1.02); // ne retient pas plus que ce qui a été annoncé (+marge)
      verifie = true;
    }
  }

  // Le candidat "période" (JOUR/SEMAINE/MOIS) a sa propre preuve, potentiellement différente
  // de celle du record all-time -- vérifié indépendamment, avec la même exigence cryptographique.
  let diffPeriodeVerifie = 0;
  if (headerHexPeriode && diffPeriodeAnnonce > 0) {
    const recalcul = difficulteDepuisHeader(headerHexPeriode);
    if (recalcul !== null && recalcul >= diffPeriodeAnnonce * TOLERANCE) {
      diffPeriodeVerifie = Math.min(recalcul, diffPeriodeAnnonce * 1.02);
    }
  }

  const store = (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: 'axecube-leaderboard', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('axecube-leaderboard');
  // Clé de stockage : l'identité machine si le client la fournit (stable même si le nom
  // affiché ou le libellé CPU changent plus tard) — sinon repli sur l'ancien schéma
  // worker+cpu pour compatibilité avec d'anciennes versions du client.
  const cle = machineId ? `id:${machineId}` : worker + '|' + cpu;
  let precedent = null;
  try { precedent = await store.get(cle, { type: 'json' }); } catch { /* pas d'entrée existante */ }

  const maintenant = Date.now();
  const bestDiffPrecedent = precedent ? (precedent.bestDiff || 0) : 0;
  const nouveauMeilleur = verifie && bestDiffVerifie > bestDiffPrecedent;

  // Le mineur revérifie/republie sa meilleure preuve toutes les ~90s (voire ~5s si un
  // dashboard est ouvert) juste pour garder le pool/hashrate/statut à jour -- ce heartbeat
  // renvoie systématiquement le MÊME headerHex, qui se revérifie donc systématiquement à la
  // MÊME valeur (l'ancien record). Sans la condition nouveauMeilleur ci-dessous, chaque
  // heartbeat "confirmerait" à tort le jour/la semaine/le mois à ce vieux record dès la
  // première réception après un changement de période, exactement le même bug que celui
  // déjà corrigé plus haut pour l'historique -- juste déplacé ici si on ne fait pas attention.
  const meilleurCandidatSoumission = Math.max(nouveauMeilleur ? bestDiffVerifie : 0, diffPeriodeVerifie);

  // L'historique de progression n'accueille que les VRAIS nouveaux records (nouveauMeilleur),
  // pas chaque simple confirmation périodique de l'ancien (le mineur revérifie/republie sa
  // meilleure preuve toutes les ~90s, voire ~5s si un dashboard est ouvert, juste pour garder
  // le pool/hashrate/statut à jour) -- sinon chaque battement de coeur rajoute une entrée
  // fraîchement datée avec la valeur du record all-time, et les classements par période
  // (jour/semaine/mois) finissent par toujours afficher le record de toujours au lieu du
  // vrai progrès réalisé pendant cette période précise.
  const historique = (precedent && Array.isArray(precedent.historique)) ? precedent.historique : [];
  if (nouveauMeilleur) {
    historique.push({ t: maintenant, d: bestDiffVerifie });
  }
  const seuil = maintenant - FENETRE_HISTOIRE_MS;
  const historiqueElague = historique.filter(e => e.t >= seuil).slice(-HISTOIRE_MAX);

  const categorie = hashrate >= SEUIL_ASIC_HS ? 'asic' : 'cpu';

  // Code d'accès de cette machine -- généré une seule fois (première soumission jamais vue
  // pour ce machineId), conservé identique à toutes les soumissions suivantes. C'est ce code,
  // couplé à la signature du wallet Solana, qui permet de rattacher cette machine à un compte
  // sur "Mes récompenses gagnées" sans jamais transmettre la clé privée de personne.
  const codeAcces = (precedent && precedent.codeAcces) ? precedent.codeAcces : genererCodeAcces();

  // Compteurs calendaires JOUR/SEMAINE/MOIS : chacun repart à zéro dès que son étiquette
  // (jour civil / semaine ISO / mois) change par rapport à la dernière soumission enregistrée
  // -- exactement le comportement décrit : un record du jour glisse en acquis de la semaine
  // et du mois tant qu'il n'est pas dépassé, puis s'efface au changement de période suivant.
  const periodesPrecedentes = (precedent && precedent.periodes) || {};
  const periodes = meilleurCandidatSoumission > 0 ? {
    jour: avancerPeriode(periodesPrecedentes.jour, etiquetteJour(maintenant), meilleurCandidatSoumission),
    semaine: avancerPeriode(periodesPrecedentes.semaine, etiquetteSemaineISO(maintenant), meilleurCandidatSoumission),
    mois: avancerPeriode(periodesPrecedentes.mois, etiquetteMois(maintenant), meilleurCandidatSoumission),
  } : periodesPrecedentes;

  const entree = {
    worker, cpu, hashrate, categorie,
    bestDiff: Math.max(bestDiffVerifie, bestDiffPrecedent), // record all-time (jamais abaissé par un ping non prouvé)
    // Nombre de shares acceptées cumulées -- simple compteur d'assiduité affiché (page
    // RÉCOMPENSES, cubes de progression CPU), jamais utilisé pour un classement compétitif,
    // donc pas besoin de preuve cryptographique. Gardé monotone par précaution (comme
    // bestDiff) pour qu'un redémarrage ou un aléa d'envoi ne fasse jamais redescendre le total.
    accepted: Math.max(acceptedAnnonce, precedent ? (precedent.accepted || 0) : 0),
    // Travail réel cumulé (hachages calculés), indépendant du pool utilisé -- contrairement
    // à "accepted" (nombre de shares), ce chiffre n'avantage jamais un mineur qui choisirait
    // un pool à difficulté minimale plus basse. C'est la base du système "Pioches & Titres".
    totalHashes: Math.max(totalHashesAnnonce, precedent ? (precedent.totalHashes || 0) : 0),
    // Le pool "record" n'est attaché que quand le record s'améliore vraiment (donc prouvé) --
    // sinon une resynchro depuis un autre pool écraserait à tort le pool où le vrai record a
    // été trouvé. Le pool "actuel", lui, reflète l'état live et se met à jour à chaque ping,
    // prouvé ou non -- ce n'est qu'une info d'affichage, pas une donnée de classement.
    poolRecord: nouveauMeilleur ? pool : (precedent ? precedent.poolRecord || pool : pool),
    poolActuel: pool,
    historique: historiqueElague,
    periodes,
    vu: maintenant,
    // Horodatage du dernier VRAI record battu (prouvé), distinct de "vu" qui se
    // rafraîchit à chaque simple ping de statut -- sert au badge "nouveau record" côté
    // frontend, pour ne pas l'afficher juste parce que le mineur est actif et en tête.
    dernierRecordAt: nouveauMeilleur ? maintenant : (precedent ? precedent.dernierRecordAt || null : null),
    codeAcces,
    walletProprietaire: (precedent && precedent.walletProprietaire) || null,
    // Cosmétique uniquement -- voir commentaire plus haut sur skinPremiumAnnonce.
    skinPremiumActif: skinPremiumAnnonce,
  };
  await store.setJSON(cle, entree);

  return { statusCode: 200, headers: cors, body: JSON.stringify({
    ok: true, verifie, bestDiff: entree.bestDiff, categorie, codeAcces,
    raison: verifie ? undefined : 'preuve manquante ou invalide — pool/statut mis à jour, record inchangé',
  }) };
};
