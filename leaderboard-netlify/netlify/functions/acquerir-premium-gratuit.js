// AXECUBE — fonction Netlify : enregistre la POSSESSION d'une pièce Premium actuellement
// gratuite pour un machineId donné. Remplace l'ancien telecharger-premium-gratuit.js --
// ne renvoie JAMAIS l'image elle-même : seule une AUTORISATION D'ACCÈS est créée côté
// serveur (store 'axecube-possessions-premium'). L'image reste hébergée en ligne pour
// toujours ; elle n'est jamais copiée sur l'ordinateur de l'utilisateur, ce qui permet à
// une revente future de couper l'accès instantanément (voir telecharger-premium-possede.js
// et mes-possessions-premium.js) sans avoir à supprimer un quelconque fichier local.
//
// La possession, une fois enregistrée, reste acquise même si l'offre repasse ensuite en
// "achat" ou "à venir" -- on ne retire jamais rétroactivement ce qu'un mineur a déjà
// obtenu pendant que c'était gratuit.
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
function storePossessions() {
  return (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: 'axecube-possessions-premium', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('axecube-possessions-premium');
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
  const itemId = /^[a-z0-9-]{1,60}$/i.test(params.itemId || '') ? params.itemId : null;
  const machineId = /^[0-9a-f]{8,32}$/i.test(params.machineId || '') ? params.machineId : null;
  if (!itemId || !machineId) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ erreur: 'itemId et machineId requis -- ouvre la boutique depuis le bouton 🛒 de ton dashboard AXECUBE' }) };
  }

  const offres = storeOffres();
  let offre = null;
  try { offre = await offres.get(itemId, { type: 'json' }); } catch { /* pas d'offre définie */ }
  if (!offre || offre.statut !== 'gratuit') {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ erreur: 'cette pièce n\'est pas (ou plus) en accès gratuit' }) };
  }

  // Vérifie que l'image existe bien avant d'enregistrer une possession qui pointerait
  // dans le vide.
  const images = storeImages();
  let existe = false;
  try { existe = (await images.get(itemId, { type: 'arrayBuffer' })) != null; } catch { /* considéré absent */ }
  if (!existe) {
    return { statusCode: 404, headers: cors, body: JSON.stringify({ erreur: 'image introuvable' }) };
  }

  const possessions = storePossessions();
  let enregistrement = null;
  try { enregistrement = await possessions.get(machineId, { type: 'json' }); } catch { /* aucune possession encore */ }
  enregistrement = enregistrement || { items: {} };
  const dejaPossedee = !!enregistrement.items[itemId];
  if (!dejaPossedee) {
    enregistrement.items[itemId] = { acquisLe: new Date().toISOString(), viaOffre: 'gratuit' };
    try { await possessions.setJSON(machineId, enregistrement); }
    catch (e) { return { statusCode: 502, headers: cors, body: JSON.stringify({ erreur: 'échec d\'enregistrement : ' + e.message }) }; }
  }

  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, itemId, dejaPossedee }) };
};
