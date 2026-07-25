// AXECUBE — fonction Netlify : réception d'un record de difficulté, avec vérification
// cryptographique de la preuve de travail (empêche de déclarer une difficulté sans
// avoir réellement produit le calcul correspondant).
'use strict';
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const MAX_TEXTE = 40;
const DIFF1 = 0x00000000FFFF0000000000000000000000000000000000000000000000000000n;
const TOLERANCE = 0.98; // marge d'arrondi flottant entre client et serveur
const HISTOIRE_MAX = 5000; // entrées conservées par mineur (~35 jours à raison de records fréquents)
const FENETRE_HISTOIRE_MS = 35 * 24 * 3600e3;

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
  const headerHex = typeof j.headerHex === 'string' ? j.headerHex : null;
  if (bestDiffAnnonce <= 0) return { statusCode: 400, headers: cors, body: '{}' };

  // Vérification cryptographique : sans preuve valide correspondant à la difficulté
  // annoncée (ou dépassant la tolérance d'arrondi), on ignore silencieusement la
  // soumission plutôt que de faire confiance à un chiffre envoyé tel quel.
  let bestDiffVerifie = 0;
  let verifie = false;
  if (headerHex) {
    const recalcul = difficulteDepuisHeader(headerHex);
    if (recalcul !== null && recalcul >= bestDiffAnnonce * TOLERANCE) {
      bestDiffVerifie = Math.min(recalcul, bestDiffAnnonce * 1.02); // ne retient pas plus que ce qui a été annoncé (+marge)
      verifie = true;
    }
  }
  if (!verifie) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: false, raison: 'preuve manquante ou invalide' }) };
  }

  const store = (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: 'axecube-leaderboard', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('axecube-leaderboard');
  const cle = worker + '|' + cpu;
  let precedent = null;
  try { precedent = await store.get(cle, { type: 'json' }); } catch { /* pas d'entrée existante */ }

  const maintenant = Date.now();
  const historique = (precedent && Array.isArray(precedent.historique)) ? precedent.historique : [];
  historique.push({ t: maintenant, d: bestDiffVerifie });
  const seuil = maintenant - FENETRE_HISTOIRE_MS;
  const historiqueElague = historique.filter(e => e.t >= seuil).slice(-HISTOIRE_MAX);

  const entree = {
    worker, cpu, hashrate,
    bestDiff: Math.max(bestDiffVerifie, precedent ? precedent.bestDiff : 0), // record all-time
    historique: historiqueElague,
    vu: maintenant,
  };
  await store.setJSON(cle, entree);

  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, verifie: true, bestDiff: entree.bestDiff }) };
};
