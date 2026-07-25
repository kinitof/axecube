// AXECUBE — fonction Netlify : classements (jour / semaine / mois / historique complet)
'use strict';
const { getStore } = require('@netlify/blobs');

const FENETRES = {
  jour: 24 * 3600e3,
  semaine: 7 * 24 * 3600e3,
  mois: 30 * 24 * 3600e3,
};
const INACTIF_MS = 7 * 24 * 3600e3; // un mineur silencieux depuis 7j sort du classement all-time affiché

function meilleurDansFenetre(historique, depuis) {
  let max = 0;
  for (const e of historique || []) if (e.t >= depuis && e.d > max) max = e.d;
  return max;
}

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
  const { blobs } = await store.list();
  const toutes = (await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })))).filter(Boolean);

  const maintenant = Date.now();
  const construireClassement = (depuis) =>
    toutes
      .map(e => ({
        worker: e.worker, cpu: e.cpu, hashrate: e.hashrate,
        bestDiff: depuis ? meilleurDansFenetre(e.historique, maintenant - depuis) : e.bestDiff,
      }))
      .filter(e => e.bestDiff > 0)
      .sort((a, b) => b.bestDiff - a.bestDiff)
      .slice(0, 100);

  const actifs = toutes.filter(e => (maintenant - e.vu) <= INACTIF_MS);

  const reponse = {
    top: construireClassement(null).filter(e => actifs.some(a => a.worker === e.worker)), // compat. rétro (all-time, actifs)
    allTime: construireClassement(null),
    jour: construireClassement(FENETRES.jour),
    semaine: construireClassement(FENETRES.semaine),
    mois: construireClassement(FENETRES.mois),
    total: toutes.length,
  };

  return { statusCode: 200, headers: cors, body: JSON.stringify(reponse) };
};
