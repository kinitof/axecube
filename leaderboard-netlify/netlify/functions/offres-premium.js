// AXECUBE — fonction Netlify : lecture PUBLIQUE de l'état commercial actuel de chaque
// pièce de la collection Premium (gratuit / à venir / achat + prix + remise). Alimentée
// exclusivement par admin-offres.js (protégé par mot de passe) -- personne d'autre ne
// peut modifier ces valeurs. Utilisée par boutique.html (affichage) et par AXECUBE
// lui-même (savoir quoi proposer au téléchargement gratuit).
'use strict';
const { getStore } = require('@netlify/blobs');

function storeOffres() {
  return (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: 'axecube-offres-premium', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('axecube-offres-premium');
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const store = storeOffres();
  const { blobs } = await store.list();
  const offres = {};
  for (const b of blobs) {
    try {
      offres[b.key] = await store.get(b.key, { type: 'json' });
    } catch { /* entrée corrompue -- ignorée plutôt que de tout faire échouer */ }
  }
  return { statusCode: 200, headers: cors, body: JSON.stringify({ offres }) };
};
