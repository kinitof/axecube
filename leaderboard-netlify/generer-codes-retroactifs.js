#!/usr/bin/env node
// AXECUBE — génère un code d'accès rétroactif pour tous les mineurs déjà
// enregistrés AVANT l'ajout du système de code (donc qui n'en ont jamais reçu).
// Les mineurs enregistrés APRÈS ce changement reçoivent déjà leur code
// automatiquement via register.js -- ce script ne les touche pas (il saute
// tout mineur qui a déjà une entrée acces:<nom>).
//
// Utilisation :
//   BLOBS_SITE_ID=xxx BLOBS_TOKEN=xxx node generer-codes-retroactifs.js --dry-run
//   BLOBS_SITE_ID=xxx BLOBS_TOKEN=xxx node generer-codes-retroactifs.js

'use strict';
const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const DRY_RUN = process.argv.includes('--dry-run');

function genererCodeAcces() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code.slice(0, 4) + '-' + code.slice(4);
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

  // Repère les entrées de mineurs (on exclut les clés techniques comme
  // "compteur-mineurs" et les entrées "acces:*" déjà existantes).
  const nomsVus = new Set();
  for (const b of blobs) {
    if (b.key.startsWith('acces:') || b.key === 'compteur-mineurs') continue;
    const entree = await store.get(b.key, { type: 'json' });
    if (entree && entree.worker) nomsVus.add(entree.worker.trim().toLowerCase());
  }

  console.log(`👤 ${nomsVus.size} mineur(s) unique(s) repéré(s) : ${[...nomsVus].join(', ')}\n`);

  let generes = 0, deja = 0;
  for (const nom of nomsVus) {
    const cle = 'acces:' + nom;
    const existant = await store.get(cle, { type: 'json' }).catch(() => null);
    if (existant && existant.code) {
      console.log(`⏭️  ${nom} a déjà un code (${existant.code}), on ne touche pas.`);
      deja++;
      continue;
    }
    const code = genererCodeAcces();
    console.log(`🔑 ${nom} -> ${code}${DRY_RUN ? '  (dry-run, rien écrit)' : ''}`);
    if (!DRY_RUN) {
      await store.setJSON(cle, { code, cree: new Date().toISOString(), retroactif: true });
    }
    generes++;
  }

  console.log('\n— Résumé —');
  console.log(`Codes ${DRY_RUN ? 'à générer' : 'générés'} : ${generes}`);
  console.log(`Déjà existants (ignorés) : ${deja}`);
  if (DRY_RUN) console.log('\n(mode --dry-run : rien n\'a été écrit, relancez sans ce flag pour appliquer)');
}

main().catch(e => { console.error('Erreur :', e); process.exit(1); });
