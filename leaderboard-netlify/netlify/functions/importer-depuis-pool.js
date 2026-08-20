// AXECUBE — fonction Netlify : point de départ pour une machine SANS AUCUN historique
// local (machineId jamais vu par submit.js) qui a déjà miné auparavant via un pool
// externe (AxeMiner, SoloPool.eu...) avec la même adresse BTC/coin. Interroge l'API
// publique du pool concerné, récupère le meilleur diff qu'il a déjà enregistré pour cette
// adresse, et l'utilise comme record de DÉPART -- jamais pour dépasser un record déjà
// prouvé cryptographiquement (voir submit.js).
//
// GARDE-FOU DE CONCEPTION (volontairement strict) : ne fonctionne QUE si ce machineId n'a
// STRICTEMENT AUCUNE entrée dans le classement (précédent === null). Dès qu'une machine a
// soumis quoi que ce soit -- même un simple ping sans preuve -- cette route se referme
// définitivement pour elle. Objectif : offrir un vrai "welcome pack" à une machine externe
// qui rejoint l'écosystème AXECUBE pour la première fois, sans jamais pouvoir servir à
// gonfler artificiellement un record déjà établi et prouvé.
//
// Confiance déléguée : contrairement à submit.js (preuve cryptographique autoportée, zéro
// confiance), cette route fait confiance à l'API publique du pool lui-même -- raisonnable
// en pratique (un pool a déjà vérifié chaque share avant de la créditer), mais marqué
// "verifie: false" dans le store, exactement comme le prévoit déjà le commentaire de
// submit.js ("reprise depuis le pool sans preuve locale").
'use strict';
const https = require('https');
const { getStore } = require('@netlify/blobs');

function storeLeaderboard() {
  return (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN)
    ? getStore({ name: 'axecube-leaderboard', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('axecube-leaderboard');
}

function requeteJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 6000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Réponse illisible du pool')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Pool injoignable (timeout)')); });
  });
}

// Un "adaptateur" par pool connu : sait construire l'URL de requête et extraire le
// meilleur diff depuis la réponse propre à ce pool. Focus BTC/AxeMiner pour l'instant --
// ajouter un autre pool = ajouter une entrée ici, sans toucher au reste de la fonction.
const ADAPTATEURS_POOL = {
  'axeminer': {
    url: (adresse) => `https://axeminer.com/api/client/${encodeURIComponent(adresse)}`,
    extraireBestDiff: (data) => {
      // AxeMiner garde un historique PAR SESSION -- on prend le max sur toutes les
      // sessions connues, pas juste la dernière (voir commentaire équivalent côté client).
      const sessions = data.sessions || (data.session ? [data.session] : []);
      const maxSessions = sessions.reduce((max, s) => Math.max(max, Number(s.bestDifficulty) || 0), 0);
      return Math.max(maxSessions, Number(data.bestDifficulty) || 0);
    },
  },
};

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
  const adresse = typeof params.adresse === 'string' && params.adresse.length >= 10 && params.adresse.length <= 100
    ? params.adresse : null;
  const poolCle = ADAPTATEURS_POOL[params.pool] ? params.pool : null;

  if (!machineId || !adresse || !poolCle) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({
      ok: false, erreur: 'Paramètres requis : machineId, adresse, pool (' + Object.keys(ADAPTATEURS_POOL).join('|') + ')',
    }) };
  }

  const store = storeLeaderboard();
  const cle = `id:${machineId}`;

  // --- Garde-fou principal : cette machine ne doit STRICTEMENT AUCUNE entrée existante ---
  let precedent = null;
  try { precedent = await store.get(cle, { type: 'json' }); } catch { /* pas d'entrée -- c'est le cas attendu */ }
  if (precedent) {
    return { statusCode: 409, headers: cors, body: JSON.stringify({
      ok: false, erreur: 'Cette machine a déjà un historique local -- la reprise depuis un pool externe '
        + 'ne sert que de point de départ pour une toute nouvelle machine.',
    }) };
  }

  // --- Interrogation du pool ---
  let bestDiffPool = 0;
  try {
    const data = await requeteJSON(ADAPTATEURS_POOL[poolCle].url(adresse));
    bestDiffPool = ADAPTATEURS_POOL[poolCle].extraireBestDiff(data);
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({
      ok: false, erreur: 'Impossible d\'interroger ' + poolCle + ' : ' + e.message,
    }) };
  }

  if (!(bestDiffPool > 0)) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({
      ok: false, erreur: 'Aucun historique trouvé sur ce pool pour cette adresse -- la machine part de 0, normalement.',
      bestDiff: 0,
    }) };
  }

  const maintenant = Date.now();
  const entree = {
    worker: 'anon', cpu: '', hashrate: 0, categorie: 'cpu',
    bestDiff: bestDiffPool,
    accepted: 0, totalHashes: 0,
    poolRecord: poolCle, poolActuel: poolCle,
    historique: [{ t: maintenant, d: bestDiffPool }],
    periodes: {},
    vu: maintenant,
    dernierRecordAt: maintenant,
    codeAcces: null, // généré normalement à la première VRAIE soumission via submit.js
    walletProprietaire: null,
    skinPremiumActif: null,
    sautsSuspects: [],
    // Marqueur explicite : ce record n'a jamais été prouvé cryptographiquement par AXECUBE
    // lui-même -- juste importé depuis les stats publiques du pool. Un futur système de
    // Mint/NFT devra l'exiger absent, comme pour les sauts suspects.
    origineRecuperation: { pool: poolCle, importeLe: maintenant },
  };
  await store.setJSON(cle, entree);

  return { statusCode: 200, headers: cors, body: JSON.stringify({
    ok: true, bestDiff: bestDiffPool, pool: poolCle, verifie: false,
    message: `Point de départ récupéré depuis ${poolCle} : ${bestDiffPool}`,
  }) };
};
