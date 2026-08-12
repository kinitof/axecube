// AXECUBE — fonction Netlify : renvoie le bestDiff RÉELLEMENT vérifié pour un machineId
// donné, tel qu'enregistré côté serveur (store 'axecube-leaderboard', même source que
// telecharger-media.js et top.js). Sert à ce que les badges bronze/argent/or/... affichés
// sur le dashboard local ne fassent JAMAIS confiance à la seule valeur locale (facilement
// modifiable en éditant miner-state.json à la main) -- ils revérifient ici, exactement
// comme le fait déjà telecharger-media.js pour les 22 cubes Genèse. Aucune donnée
// sensible renvoyée : juste un nombre.
'use strict';
const { getStore } = require('@netlify/blobs');

function storeLeaderboard() {
  return (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: 'axecube-leaderboard', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('axecube-leaderboard');
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: cors, body: '{}' };

  const params = event.queryStringParameters || {};
  // Même règle de validation que submit.js / telecharger-media.js pour machineId.
  const machineId = /^[0-9a-f]{8,32}$/i.test(params.machineId || '') ? params.machineId : null;
  if (!machineId) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ erreur: 'machineId invalide' }) };
  }

  const leaderboard = storeLeaderboard();
  let record = null;
  try { record = await leaderboard.get(`id:${machineId}`, { type: 'json' }); } catch { /* machine inconnue */ }
  const bestDiff = (record && typeof record.bestDiff === 'number') ? record.bestDiff : 0;

  return { statusCode: 200, headers: cors, body: JSON.stringify({ bestDiff }) };
};
