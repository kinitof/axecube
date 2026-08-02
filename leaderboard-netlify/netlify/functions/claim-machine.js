// AXECUBE — fonction Netlify : rattache une machine (via son machineId + code d'accès
// secret) à un compte, identifié par un wallet Solana. La preuve d'identité du wallet se
// fait par SIGNATURE d'un message (jamais de mot de passe, jamais de clé privée transmise).
'use strict';
const nacl = require('tweetnacl');
const { PublicKey } = require('@solana/web3.js');
const { getStore } = require('@netlify/blobs');

function verifierSignature(wallet, message, signatureBase64) {
  try {
    const pubkey = new PublicKey(wallet).toBytes();
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = Buffer.from(signatureBase64, 'base64');
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubkey);
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ ok: false, erreur: 'Méthode non autorisée' }) };

  let j;
  try { j = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, erreur: 'JSON invalide' }) }; }

  const { wallet, message, signature, machineId, code } = j;
  if (!wallet || !message || !signature || !machineId || !code) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, erreur: 'Paramètres manquants' }) };
  }

  // Le message signé doit contenir CE wallet -- empêche de rejouer la signature d'un
  // wallet pour en réclamer un autre.
  if (!message.includes(wallet)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, erreur: 'Message de signature invalide' }) };
  }
  if (!verifierSignature(wallet, message, signature)) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ ok: false, erreur: 'Signature invalide -- ce wallet n\u2019a pas signé ce message' }) };
  }

  const store = (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: 'axecube-leaderboard', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('axecube-leaderboard');

  const cleMachine = `id:${machineId}`;
  let entree;
  try { entree = await store.get(cleMachine, { type: 'json' }); } catch { entree = null; }
  if (!entree) {
    return { statusCode: 404, headers: cors, body: JSON.stringify({ ok: false, erreur: 'Machine introuvable' }) };
  }
  if (entree.codeAcces !== String(code).trim().toUpperCase()) {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ ok: false, erreur: 'Code d\u2019accès incorrect' }) };
  }
  if (entree.walletProprietaire && entree.walletProprietaire !== wallet) {
    return { statusCode: 409, headers: cors, body: JSON.stringify({ ok: false, erreur: 'Cette machine est déjà rattachée à un autre wallet' }) };
  }

  // Rattache la machine au wallet (des deux côtés : sur l'entrée machine elle-même, et
  // dans la liste des machines de ce compte, pour retrouver facilement l'une à partir de
  // l'autre sans avoir à parcourir tout le store).
  entree.walletProprietaire = wallet;
  await store.setJSON(cleMachine, entree);

  const cleCompte = `compte:${wallet}`;
  let compte;
  try { compte = await store.get(cleCompte, { type: 'json' }); } catch { compte = null; }
  const machineIds = new Set((compte && compte.machineIds) || []);
  machineIds.add(machineId);
  await store.setJSON(cleCompte, { machineIds: [...machineIds], derniereMaj: new Date().toISOString() });

  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, worker: entree.worker }) };
};
