// AXECUBE — fonction Netlify ADMIN : seule façon d'écrire dans le store des offres
// premium. Protégée par un mot de passe (variable d'environnement ADMIN_PASSWORD,
// à définir dans les paramètres Netlify -- jamais dans le code). Toi seul le connais.
'use strict';
const { getStore } = require('@netlify/blobs');

const STATUTS_VALIDES = ['gratuit', 'a_venir', 'achat'];

function storeOffres() {
  return (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: 'axecube-offres-premium', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('axecube-offres-premium');
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: '{}' };

  let j;
  try { j = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ erreur: 'JSON invalide' }) }; }

  // Mot de passe obligatoire -- sans ADMIN_PASSWORD configuré côté Netlify, cette
  // fonction refuse TOUT (fail-safe : pas de mot de passe = pas d'écriture possible,
  // jamais l'inverse).
  if (!process.env.ADMIN_PASSWORD || j.motDePasse !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ erreur: 'mot de passe incorrect' }) };
  }

  const itemId = /^[a-z0-9-]{1,60}$/i.test(j.itemId || '') ? j.itemId : null;
  const statut = STATUTS_VALIDES.includes(j.statut) ? j.statut : null;
  if (!itemId || !statut) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ erreur: 'itemId ou statut invalide' }) };
  }

  const prix = statut === 'achat' ? Math.max(0, Number(j.prix) || 0) : null;
  const remise = statut === 'achat' ? Math.max(0, Math.min(90, Number(j.remise) || 0)) : 0;

  const store = storeOffres();
  const entree = { statut, prix, remise, majLe: Date.now() };
  await store.setJSON(itemId, entree);

  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, itemId, entree }) };
};
