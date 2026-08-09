// AXECUBE — fonction Netlify : sert l'APERÇU basse résolution (généré automatiquement
// par admin-upload-images.js via sharp) d'une pièce Premium. Contrairement à
// telecharger-media.js / telecharger-premium-gratuit.js, cette fonction est PUBLIQUE
// et sans vérification -- c'est le but : donner un aperçu à tout le monde sur
// boutique.html, sans jamais exposer le vrai fichier haute résolution.
'use strict';
const { getStore } = require('@netlify/blobs');

function storePreviews() {
  return (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: 'axecube-previews-publiques', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('axecube-previews-publiques');
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const params = event.queryStringParameters || {};
  const itemId = /^[a-z0-9-]{1,60}$/i.test(params.itemId || '') ? params.itemId : null;
  if (!itemId) {
    return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ erreur: 'itemId invalide' }) };
  }

  const store = storePreviews();
  let donnees = null;
  try { donnees = await store.get(itemId, { type: 'arrayBuffer' }); } catch { /* aperçu absent */ }
  if (!donnees) {
    return { statusCode: 404, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ erreur: 'aperçu introuvable' }) };
  }

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
    isBase64Encoded: true,
    body: Buffer.from(donnees).toString('base64'),
  };
};
