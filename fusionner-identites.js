#!/usr/bin/env node
// AXECUBE — fusion des identités dédoublées suite à l'ajout du machineId stable.
//
// Avant l'ajout de l'identifiant machine (hardware UUID), chaque mineur était identifié
// par la clé "worker|cpu". Depuis, la clé devient "id:<machineId>" dès qu'un identifiant
// stable est disponible -- ce qui a créé, pour les mineurs déjà actifs à l'époque, une
// DEUXIÈME entrée qui repart de zéro (accepted, totalHashes, periodes) pendant que
// l'ancienne reste figée avec l'historique/record d'avant. Ce script recolle les deux :
//
//   - Garde le record all-time le plus élevé des deux (bestDiff, poolRecord associé)
//   - Fusionne les historiques (progression du record dans le temps)
//   - Conserve les données vivantes de l'entrée récente (accepted, totalHashes, periodes,
//     poolActuel, vu) -- ce sont les seules à jour, l'ancienne entrée ne les a jamais eues
//   - Supprime l'ancienne entrée une fois la fusion faite
//
// Utilisation :
//   BLOBS_SITE_ID=xxx BLOBS_TOKEN=xxx node fusionner-identites.js --dry-run
//   BLOBS_SITE_ID=xxx BLOBS_TOKEN=xxx node fusionner-identites.js

'use strict';
const { getStore } = require('@netlify/blobs');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const DRY_RUN = !!args['dry-run'];

function fusionnerHistoriques(a, b) {
  const tous = [...(a || []), ...(b || [])];
  const vus = new Set();
  return tous
    .filter(pt => {
      const clef = pt.t + ':' + pt.d;
      if (vus.has(clef)) return false;
      vus.add(clef);
      return true;
    })
    .sort((x, y) => x.t - y.t);
}

async function main() {
  if (!process.env.BLOBS_SITE_ID || !process.env.BLOBS_TOKEN) {
    console.error('\n⚠️  Variables manquantes : BLOBS_SITE_ID et BLOBS_TOKEN doivent être définies.\n');
    process.exit(1);
  }

  const store = getStore({
    name: 'axecube-leaderboard',
    siteID: process.env.BLOBS_SITE_ID,
    token: process.env.BLOBS_TOKEN,
  });

  const { blobs } = await store.list();
  console.log(`📦 ${blobs.length} entrée(s) trouvée(s) dans le store.\n`);

  const entrees = [];
  for (const b of blobs) {
    const e = await store.get(b.key, { type: 'json' });
    if (e) entrees.push({ cle: b.key, ...e });
  }

  // Regroupe par signature "worker (en minuscules) + cpu" pour repérer les paires
  // ancienne-clé / nouvelle-clé qui décrivent en réalité la même machine physique.
  const groupes = new Map();
  for (const e of entrees) {
    const sig = (e.worker || '').toLowerCase() + '|' + (e.cpu || '');
    if (!groupes.has(sig)) groupes.set(sig, []);
    groupes.get(sig).push(e);
  }

  let fusions = 0;
  for (const [sig, groupe] of groupes) {
    if (groupe.length < 2) continue;
    const ancienne = groupe.find(e => !e.cle.startsWith('id:'));
    const recente = groupe.find(e => e.cle.startsWith('id:'));
    if (!ancienne || !recente) continue; // pas le cas de figure ciblé par ce script

    const bestDiffFusionne = Math.max(ancienne.bestDiff || 0, recente.bestDiff || 0);
    const poolRecordFusionne = (ancienne.bestDiff || 0) > (recente.bestDiff || 0)
      ? (ancienne.poolRecord || recente.poolRecord)
      : (recente.poolRecord || ancienne.poolRecord);

    console.log(`🔗 ${sig}`);
    console.log(`   Ancienne clé "${ancienne.cle}" (bestDiff ${ancienne.bestDiff || 0}) + `
      + `nouvelle clé "${recente.cle}" (bestDiff ${recente.bestDiff || 0}, `
      + `accepted ${recente.accepted || 0}, totalHashes ${recente.totalHashes || 0})`);
    console.log(`   → fusionné : bestDiff ${bestDiffFusionne}, reste sous "${recente.cle}"`);

    if (!DRY_RUN) {
      const fusion = {
        ...recente,
        bestDiff: bestDiffFusionne,
        poolRecord: poolRecordFusionne,
        historique: fusionnerHistoriques(ancienne.historique, recente.historique),
      };
      delete fusion.cle;
      await store.setJSON(recente.cle, fusion);
      await store.delete(ancienne.cle);
    }
    fusions++;
  }

  console.log('\n— Résumé —');
  console.log(`Entrées analysées : ${entrees.length}`);
  console.log(`Fusions ${DRY_RUN ? 'identifiées' : 'appliquées'} : ${fusions}`);
  if (DRY_RUN) console.log('\n(mode --dry-run : rien n\'a été écrit, relancez sans ce flag pour appliquer)');
  else console.log('\n✅ Fusions appliquées au store.');
}

main().catch(e => { console.error('Erreur :', e); process.exit(1); });
