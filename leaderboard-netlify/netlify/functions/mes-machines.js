// AXECUBE — fonction Netlify : retourne toutes les machines rattachées à un compte
// (wallet Solana), après vérification de la signature -- c'est cette liste qui alimente
// la page "Mes récompenses gagnées" (cubes combinés de toutes les machines du compte).
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

  const { wallet, message, signature } = j;
  if (!wallet || !message || !signature) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, erreur: 'Paramètres manquants' }) };
  }
  if (!message.includes(wallet)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, erreur: 'Message de signature invalide' }) };
  }
  if (!verifierSignature(wallet, message, signature)) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ ok: false, erreur: 'Signature invalide' }) };
  }

  const store = (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: 'axecube-leaderboard', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('axecube-leaderboard');

  let compte;
  try { compte = await store.get(`compte:${wallet}`, { type: 'json' }); } catch { compte = null; }
  const machineIds = (compte && compte.machineIds) || [];

  const machines = [];
  for (const machineId of machineIds) {
    let entree;
    try { entree = await store.get(`id:${machineId}`, { type: 'json' }); } catch { entree = null; }
    if (!entree) continue;
    machines.push({
      machineId, worker: entree.worker, cpu: entree.cpu,
      bestDiff: entree.bestDiff || 0, accepted: entree.accepted || 0, totalHashes: entree.totalHashes || 0,
    });
  }

  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, machines }) };
};
