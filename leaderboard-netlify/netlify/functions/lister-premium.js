// AXECUBE — fonction Netlify : liste dynamiquement l'identifiant de chaque pièce de la
// collection Premium réellement présente dans le store privé (uploadée via
// admin-upload-images.js) -- exclut automatiquement les 44 clés du système Genèse
// (niveau-01..22, cube-p01..22), qui ne font jamais partie de la boutique.
//
// Usage : alimente admin-boutique.html (pour retrouver facilement l'identifiant
// technique d'une pièce) et boutique.html (pour savoir quoi afficher, en plus de
// l'état gratuit/achat déjà exposé par offres-premium.js).
'use strict';
const { getStore } = require('@netlify/blobs');

const REGEX_GENESE = /^(niveau|cube-p)-?\d{2}$/i;

function storeImages() {
  return (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: 'axecube-images-privees', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('axecube-images-privees');
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const store = storeImages();
  const { blobs } = await store.list();
  const items = blobs
    .map((b) => b.key)
    .filter((cle) => !REGEX_GENESE.test(cle))
    .sort();

  return { statusCode: 200, headers: cors, body: JSON.stringify({ items }) };
};
