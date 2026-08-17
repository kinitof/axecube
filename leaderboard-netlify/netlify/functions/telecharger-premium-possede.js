// AXECUBE — fonction Netlify : sert les octets de l'image d'une pièce Premium, mais
// UNIQUEMENT si le machineId fourni la possède réellement (registre 'axecube-possessions-premium',
// alimenté par acquerir-premium-gratuit.js). Revérifiée à CHAQUE appel -- jamais de cache
// de l'autorisation côté serveur -- pour qu'une revente/transfert futur coupe l'accès
// immédiatement, sans qu'aucun fichier n'ait jamais été copié sur l'ordinateur de
// l'ancien propriétaire (voir le proxy local /assets/premium/<id>.png dans axecube.js,
// qui appelle cette fonction à chaque affichage de la carte).
//
// EXCEPTION ADMIN : les machineId listés dans ADMIN_MACHINE_IDS (variable d'environnement
// Netlify, séparés par des virgules) sautent la vérification de possession -- pratique
// pour Chris quand il teste/règle un nouveau skin sans avoir à d'abord se l'acquérir
// manuellement via la boutique. Si ADMIN_MACHINE_IDS n'est pas configurée, ce bypass est
// simplement inactif (comportement normal pour tout le monde).
'use strict';
const { getStore } = require('@netlify/blobs');

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
function estAdmin(machineId) {
  const liste = (process.env.ADMIN_MACHINE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return liste.includes(machineId);
}

exports.handler = async (event) => {
  const corsJson = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsJson, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: corsJson, body: '{}' };

  const params = event.queryStringParameters || {};
  const itemId = /^[a-z0-9-]{1,60}$/i.test(params.itemId || '') ? params.itemId : null;
  const machineId = /^[0-9a-f]{8,32}$/i.test(params.machineId || '') ? params.machineId : null;
  if (!itemId || !machineId) {
    return { statusCode: 400, headers: corsJson, body: JSON.stringify({ erreur: 'itemId et machineId requis' }) };
  }

  const admin = estAdmin(machineId);

  // 1) Vérifie la possession -- sauf si machineId admin (voir estAdmin ci-dessus).
  if (!admin) {
    const possessions = storePossessions();
    let enregistrement = null;
    try { enregistrement = await possessions.get(machineId, { type: 'json' }); } catch { /* aucune possession */ }
    const possede = !!(enregistrement && enregistrement.items && enregistrement.items[itemId]);
    if (!possede) {
      return { statusCode: 403, headers: corsJson, body: JSON.stringify({ erreur: 'cette pièce n\'est pas possédée par cette machine' }) };
    }
  }

  // 2) Sert l'image complète -- jamais écrite sur disque côté client, uniquement
  // transmise à la demande à chaque affichage de la carte.
  const images = storeImages();
  let donnees = null;
  try { donnees = await images.get(itemId, { type: 'arrayBuffer' }); } catch { /* considérée absente */ }
  if (!donnees) {
    return { statusCode: 404, headers: corsJson, body: JSON.stringify({ erreur: 'image introuvable' }) };
  }

  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'image/png',
      'Cache-Control': 'private, max-age=300',
    },
    body: Buffer.from(donnees).toString('base64'),
    isBase64Encoded: true,
  };
};
