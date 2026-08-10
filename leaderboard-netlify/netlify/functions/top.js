// AXECUBE — fonction Netlify : classements (jour / semaine / mois / historique complet),
// séparés entre petits mineurs CPU et grosses machines (ASIC type Bitaxe) pour rester
// comparable — un CPU et un ASIC n'ont rien à faire dans le même tableau.
'use strict';
const { getStore } = require('@netlify/blobs');

const INACTIF_MS = 7 * 24 * 3600e3; // un mineur silencieux depuis 7j sort du classement all-time affiché
const SEUIL_ASIC_HS = 1e9; // même seuil que submit.js — cohérence si une vieille entrée n'a pas le champ

// Mêmes étiquettes calendaires (UTC) que submit.js -- nécessaires pour savoir si le compteur
// jour/semaine/mois stocké sur une entrée correspond encore à la période EN COURS, ou s'il
// date d'une période déjà terminée (mineur resté silencieux depuis) et doit donc afficher 0.
function etiquetteJour(ts) {
  const d = new Date(ts);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function etiquetteMois(ts) {
  const d = new Date(ts);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
function etiquetteSemaineISO(ts) {
  const d = new Date(Date.UTC(new Date(ts).getUTCFullYear(), new Date(ts).getUTCMonth(), new Date(ts).getUTCDate()));
  const jourSemaine = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - jourSemaine + 3);
  const premierJeudi = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const numero = 1 + Math.round(((d - premierJeudi) / 86400000 - 3 + ((premierJeudi.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() + '-W' + String(numero).padStart(2, '0');
}
/** Valeur d'un compteur de période pour CE moment précis : 0 si son étiquette stockée ne
 *  correspond plus à la période en cours (personne n'a rien soumis depuis le changement). */
function valeurPeriode(compteur, etiquetteActuelle) {
  return (compteur && compteur.etiquette === etiquetteActuelle) ? compteur.valeur : 0;
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

  // Étiquettes de la période EN COURS, calculées une seule fois pour cette requête.
  const labelJour = etiquetteJour(maintenant), labelSemaine = etiquetteSemaineISO(maintenant), labelMois = etiquetteMois(maintenant);

  function construireClassement(entrees, cle) {
    return entrees
      .map(e => ({
        worker: e.worker, cpu: e.cpu, hashrate: e.hashrate, poolRecord: e.poolRecord || null,
        poolActuel: e.poolActuel || null, accepted: e.accepted || 0, totalHashes: e.totalHashes || 0,
        bestDiff: cle === 'jour' ? valeurPeriode(e.periodes && e.periodes.jour, labelJour)
                : cle === 'semaine' ? valeurPeriode(e.periodes && e.periodes.semaine, labelSemaine)
                : cle === 'mois' ? valeurPeriode(e.periodes && e.periodes.mois, labelMois)
                : e.bestDiff,
        vu: e.vu || null, dernierRecordAt: e.dernierRecordAt || null, spark: decimer(e.historique, 12),
        // Skin Premium actif de ce mineur (id + lien direct vers son aperçu public basse
        // résolution, déjà généré à l'upload pour TOUTE la collection -- jamais l'image
        // complète). null si aucun skin actif -- purement cosmétique, voir submit.js.
        skinPremiumActif: e.skinPremiumActif || null,
        skinApercuUrl: e.skinPremiumActif ? ('/.netlify/functions/apercu-premium?itemId=' + encodeURIComponent(e.skinPremiumActif)) : null,
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
      jour: construireClassement(entrees, 'jour'),
      semaine: construireClassement(entrees, 'semaine'),
      mois: construireClassement(entrees, 'mois'),
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
