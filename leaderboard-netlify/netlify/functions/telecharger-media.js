// AXECUBE — fonction Netlify : sert une image de palier Genèse (carte machine ou cube)
// UNIQUEMENT si le bestDiff RÉELLEMENT enregistré côté serveur pour cette machineId
// atteint le seuil du niveau demandé. Ne fait jamais confiance à une valeur envoyée par
// le client -- toujours revérifié contre le classement (comme le veut le commentaire dans
// axecube.js : "vérifié côté serveur via le vrai bestDiff enregistré, jamais celui annoncé
// localement").
//
// Store et format de clé vérifiés contre submit.js : store 'axecube-leaderboard',
// clé 'id:' + machineId (le préfixe id: est important -- submit.js retombe sur
// worker+'|'+cpu seulement si machineId est absent, ce qui n'arrive jamais ici puisque
// axecube.js fournit toujours machineId dans ses appels à telecharger-media).
'use strict';
const { getStore } = require('@netlify/blobs');

const NOM_STORE_LEADERBOARD = 'axecube-leaderboard';
const NOM_STORE_IMAGES = 'axecube-images-privees';

// Doit rester STRICTEMENT identique à SEUILS_CPU dans axecube.js / recompenses.html /
// mes-recompenses.html -- sinon un palier pourrait être débloqué côté client mais refusé
// ici (ou l'inverse).
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

function storeLeaderboard() {
  return (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: NOM_STORE_LEADERBOARD, siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore(NOM_STORE_LEADERBOARD);
}
function storeImages() {
  return (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: NOM_STORE_IMAGES, siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore(NOM_STORE_IMAGES);
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: cors, body: '{}' };

  const params = event.queryStringParameters || {};
  // Même règle de validation que submit.js pour machineId (hexadécimal, 8 à 32 caractères).
  const machineId = /^[0-9a-f]{8,32}$/i.test(params.machineId || '') ? params.machineId : null;
  const type = params.type === 'machine' || params.type === 'cube' ? params.type : null;
  const niveau = Number.isInteger(Number(params.niveau)) ? Number(params.niveau) : null;

  if (!machineId || !type || !niveau || niveau < 1 || niveau > 22) {
    return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ erreur: 'paramètres invalides' }) };
  }

  // Vérification server-side du vrai palier atteint -- jamais confiance au client.
  const leaderboard = storeLeaderboard();
  let record = null;
  try { record = await leaderboard.get(`id:${machineId}`, { type: 'json' }); } catch { /* machine inconnue */ }
  const bestDiff = (record && typeof record.bestDiff === 'number') ? record.bestDiff : 0;
  const niveauGagne = niveauDeCube(bestDiff);

  if (niveau > niveauGagne) {
    return {
      statusCode: 403,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ erreur: `palier ${niveau} non atteint (palier actuel vérifié : ${niveauGagne})` }),
    };
  }

  const numero = String(niveau).padStart(2, '0');
  const cle = type === 'machine' ? `niveau-${numero}` : `cube-p${numero}`;

  const images = storeImages();
  let donnees = null;
  try { donnees = await images.get(cle, { type: 'arrayBuffer' }); } catch { /* image absente */ }
  if (!donnees) {
    return { statusCode: 404, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ erreur: 'image introuvable' }) };
  }

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' },
    isBase64Encoded: true,
    body: Buffer.from(donnees).toString('base64'),
  };
};
