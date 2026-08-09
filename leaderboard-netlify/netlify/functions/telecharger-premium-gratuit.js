// AXECUBE — fonction Netlify : sert une image premium haute résolution UNIQUEMENT si
// son statut actuel (défini via admin-offres.js) est bien 'gratuit'. Aucune vérification
// de palier/machineId ici -- un cadeau explicitement offert par le créateur ne dépend pas
// de la performance de minage (contrairement aux 22 cartes Genèse, qui restent toujours
// liées à telecharger-media.js et sa vérification de bestDiff).
'use strict';
const { getStore } = require('@netlify/blobs');

function storeOffres() {
  return (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: 'axecube-offres-premium', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('axecube-offres-premium');
}
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
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: cors, body: '{}' };

  const params = event.queryStringParameters || {};
  const itemId = /^[a-z0-9-]{1,60}$/i.test(params.itemId || '') ? params.itemId : null;
  if (!itemId) {
    return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ erreur: 'itemId invalide' }) };
  }

  const offres = storeOffres();
  let offre = null;
  try { offre = await offres.get(itemId, { type: 'json' }); } catch { /* pas d'offre définie */ }

  if (!offre || offre.statut !== 'gratuit') {
    return {
      statusCode: 403,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ erreur: 'cette pièce n\'est pas (ou plus) en accès gratuit' }),
    };
  }

  const images = storeImages();
  let donnees = null;
  try { donnees = await images.get(itemId, { type: 'arrayBuffer' }); } catch { /* image absente */ }
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
