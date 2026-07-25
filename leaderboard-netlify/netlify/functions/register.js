// AXECUBE — fonction Netlify : attribution d'un nom de mineur unique (axecubeNNN)
// et comptage anonyme du nombre total de mineurs créés. Aucune donnée personnelle
// n'est demandée ni stockée — juste un compteur qui s'incrémente.
'use strict';
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const store = (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: 'axecube-leaderboard', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('axecube-leaderboard');
  const CLE = 'compteur-mineurs';

  let compteur = 0;
  try {
    const existant = await store.get(CLE, { type: 'json' });
    if (existant && typeof existant.total === 'number') compteur = existant.total;
  } catch { /* premier appel, compteur reste à 0 */ }

  compteur += 1;
  await store.setJSON(CLE, { total: compteur, derniere: new Date().toISOString() });

  const nom = 'axecube' + String(compteur).padStart(3, '0');
  return { statusCode: 200, headers: cors, body: JSON.stringify({ nom, total: compteur }) };
};
