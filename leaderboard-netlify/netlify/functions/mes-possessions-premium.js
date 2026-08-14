// AXECUBE — fonction Netlify : liste les identifiants des pièces Premium RÉELLEMENT
// possédées par un machineId donné (registre alimenté par acquerir-premium-gratuit.js,
// et plus tard par un éventuel flux d'achat). Lecture publique -- c'est ce endpoint que
// consultent boutique.html (pour afficher "Obtenue" au lieu de "Obtenir") et axecube.js
// (pour peupler la liste "Activer ce skin" dans ⚙ Paramètres, et pour la revérification
// périodique côté machine).
//
// IMPORTANT : le store 'axecube-possessions-premium' garde, pour chaque machineId, un
// enregistrement de la forme { items: { "<itemId>": { acquisLe, viaOffre } } } -- un OBJET
// indexé par itemId (voir acquerir-premium-gratuit.js). Les deux consommateurs actuels
// (boutique.html, axecube.js) attendent en revanche un simple TABLEAU d'identifiants
// (ex: new Set(j.items), Array.isArray(j.items)). Ce endpoint fait donc explicitement la
// conversion Object.keys(...) avant de répondre -- ne jamais renvoyer enregistrement.items
// tel quel, ça casse silencieusement l'affichage des deux côtés (Set(objet) lève une
// erreur avalée par le try/catch de boutique.html, et Array.isArray(objet) est false côté
// axecube.js, qui retombe alors sur [] -- "Tu ne possèdes aucune pièce Premium").
'use strict';
const { getStore } = require('@netlify/blobs');

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
  const machineId = /^[0-9a-f]{8,32}$/i.test(params.machineId || '') ? params.machineId : null;
  if (!machineId) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ erreur: 'machineId requis' }) };
  }

  const possessions = storePossessions();
  let enregistrement = null;
  try { enregistrement = await possessions.get(machineId, { type: 'json' }); } catch { /* aucune possession encore */ }

  // enregistrement.items est un OBJET { itemId: {...} } -- on le convertit en tableau de
  // clés, c'est le format attendu par tous les appelants (boutique.html, axecube.js).
  const items = (enregistrement && enregistrement.items && typeof enregistrement.items === 'object')
    ? Object.keys(enregistrement.items)
    : [];

  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, items }) };
};
