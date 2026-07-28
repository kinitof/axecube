// AXECUBE — fonction Netlify : classements (jour / semaine / mois / historique complet),
// séparés entre petits mineurs CPU et grosses machines (ASIC type Bitaxe) pour rester
// comparable — un CPU et un ASIC n'ont rien à faire dans le même tableau.
'use strict';
const { getStore } = require('@netlify/blobs');

const FENETRES = {
  jour: 24 * 3600e3,
  semaine: 7 * 24 * 3600e3,
  mois: 30 * 24 * 3600e3,
};
const INACTIF_MS = 7 * 24 * 3600e3; // un mineur silencieux depuis 7j sort du classement all-time affiché
const SEUIL_ASIC_HS = 1e9; // même seuil que submit.js — cohérence si une vieille entrée n'a pas le champ

function meilleurDansFenetre(historique, depuis) {
  let max = 0;
  for (const e of historique || []) if (e.t >= depuis && e.d > max) max = e.d;
  return max;
}

function categorieDe(e) {
  return e.categorie || (Number(e.hashrate) >= SEUIL_ASIC_HS ? 'asic' : 'cpu');
}

function decimer(historique, n) {
  if (!historique || !historique.length) return [];
  if (historique.length <= n) return historique.map(p => p.d);
  const pas = (historique.length - 1) / (n - 1);
  const vals = [];
  for (let i = 0; i < n; i++) vals.push(historique[Math.round(i * pas)].d);
  return vals;
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

  function construireClassement(entrees, depuis) {
    return entrees
      .map(e => ({
        worker: e.worker, cpu: e.cpu, hashrate: e.hashrate, poolRecord: e.poolRecord || null,
        bestDiff: depuis ? meilleurDansFenetre(e.historique, maintenant - depuis) : e.bestDiff,
        vu: e.vu || null, spark: decimer(e.historique, 12),
      }))
      .filter(e => e.bestDiff > 0)
      .sort((a, b) => b.bestDiff - a.bestDiff)
      .slice(0, 100);
  }

  function classementsPourCategorie(categorie) {
    const entrees = toutes.filter(e => categorieDe(e) === categorie);
    const actifs = entrees.filter(e => (maintenant - e.vu) <= INACTIF_MS).length;
    return {
      allTime: construireClassement(entrees, null),
      jour: construireClassement(entrees, FENETRES.jour),
      semaine: construireClassement(entrees, FENETRES.semaine),
      mois: construireClassement(entrees, FENETRES.mois),
      total: entrees.length,
      actifs,
    };
  }

  const cpu = classementsPourCategorie('cpu');
  const asic = classementsPourCategorie('asic');

  const reponse = {
    cpu, asic, misAJour: maintenant,
    // Compat. rétro pour d'anciennes versions de l'app : les champs de premier niveau
    // reprennent le classement CPU (c'est la catégorie par défaut du produit).
    top: cpu.allTime, allTime: cpu.allTime,
    jour: cpu.jour, semaine: cpu.semaine, mois: cpu.mois,
    total: toutes.length,
  };

  return { statusCode: 200, headers: cors, body: JSON.stringify(reponse) };
};
