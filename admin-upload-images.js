#!/usr/bin/env node
// AXECUBE — script ADMIN (à lancer depuis ton Mac, jamais côté serveur/client) : envoie
// TOUTES tes images vers les stores Netlify Blobs privés :
//   - Les 22 paliers Genèse (assets/machines/, assets/cubes/) -- store 'axecube-images-privees'
//   - TOUTE la collection Premium (assets/premium/, un seul dossier, autant de fichiers
//     que tu veux) -- même store, clé = nom du fichier sans l'extension
//
// Génère aussi automatiquement un aperçu basse résolution PUBLIC de chaque pièce Premium
// (store 'axecube-previews-publiques'), utilisé par boutique.html pour l'affichage --
// jamais l'image complète, jamais suffisant pour être réutilisé comme "le vrai" visuel.
//
// Utilisation :
//   BLOBS_SITE_ID=xxx BLOBS_TOKEN=xxx node admin-upload-images.js
//
// Génération d'aperçus : nécessite le paquet "sharp" (traitement d'image). S'il n'est
// pas installé, les aperçus sont simplement ignorés (avec un avertissement) -- le reste
// du script fonctionne quand même normalement.
//   npm install sharp
'use strict';
const fs = require('fs');
const path = require('path');
const { getStore } = require('@netlify/blobs');

const DOSSIER_MACHINES = path.join(__dirname, 'assets', 'machines'); // niveau-01.png .. niveau-22.png
const DOSSIER_CUBES = path.join(__dirname, 'assets', 'cubes');       // cube-p01.png .. cube-p22.png
const DOSSIER_PREMIUM = path.join(__dirname, 'assets', 'premium');   // n'importe quel nombre de .png

let sharp = null;
try { sharp = require('sharp'); } catch { /* optionnel -- voir message plus bas */ }

function storeImages() {
  if (!process.env.BLOBS_SITE_ID || !process.env.BLOBS_TOKEN) {
    console.error('❌ Variables BLOBS_SITE_ID / BLOBS_TOKEN manquantes. Voir le commentaire en haut du script.');
    process.exit(1);
  }
  return getStore({ name: 'axecube-images-privees', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN });
}
function storePreviews() {
  return getStore({ name: 'axecube-previews-publiques', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN });
}

async function uploaderPaliers(dossier, prefixeFichier, prefixeCle) {
  if (!fs.existsSync(dossier)) { console.log(`⏭️  Dossier absent, ignoré : ${dossier}`); return { envoyes: 0, ignores: 0 }; }
  const s = storeImages();
  let envoyes = 0, ignores = 0;
  for (let n = 1; n <= 22; n++) {
    const numero = String(n).padStart(2, '0');
    const fichier = path.join(dossier, `${prefixeFichier}${numero}.png`);
    if (!fs.existsSync(fichier)) { ignores++; continue; }
    const donnees = fs.readFileSync(fichier);
    const cle = `${prefixeCle}${numero}`;
    await s.set(cle, donnees);
    console.log(`✅ ${cle} envoyé (${(donnees.length / 1024).toFixed(0)} Ko)`);
    envoyes++;
  }
  return { envoyes, ignores };
}

/** Contrairement aux paliers Genèse (numérotés 1 à 22, quantité fixe), la collection
 *  Premium est un dossier ouvert : on envoie TOUT fichier .png trouvé dedans, quel que
 *  soit son nom (le nom de fichier SANS extension devient l'identifiant technique --
 *  celui à utiliser ensuite dans ⚙ Paramètres ou admin-boutique.html). */
async function uploaderPremium() {
  if (!fs.existsSync(DOSSIER_PREMIUM)) {
    console.log(`⏭️  Dossier premium absent, ignoré : ${DOSSIER_PREMIUM}`);
    return { envoyes: 0 };
  }
  const images = storeImages();
  const previews = sharp ? storePreviews() : null;
  const fichiers = fs.readdirSync(DOSSIER_PREMIUM).filter((f) => /\.png$/i.test(f));

  if (fichiers.length === 0) {
    console.log('⏭️  Aucun fichier .png trouvé dans assets/premium/.');
    return { envoyes: 0 };
  }
  if (!sharp) {
    console.log('⚠️  Paquet "sharp" non installé -- les aperçus publics basse résolution ne');
    console.log('    seront PAS générés cette fois (les images complètes seront quand même');
    console.log('    envoyées normalement). Lance "npm install sharp" puis relance ce script');
    console.log('    pour générer les aperçus manquants.');
  }

  let envoyes = 0;
  for (const fichier of fichiers) {
    const itemId = path.basename(fichier, '.png');
    if (!/^[a-z0-9-]+$/i.test(itemId)) {
      console.log(`⚠️  Ignoré "${fichier}" -- le nom de fichier doit être en minuscules/chiffres/tirets uniquement (pas d'espace ni d'accent), renomme-le puis relance.`);
      continue;
    }
    const cheminComplet = path.join(DOSSIER_PREMIUM, fichier);
    const donnees = fs.readFileSync(cheminComplet);
    await images.set(itemId, donnees);
    console.log(`✅ ${itemId} envoyé (${(donnees.length / 1024).toFixed(0)} Ko)`);
    envoyes++;

    if (sharp) {
      try {
        const apercu = await sharp(cheminComplet).resize({ width: 300 }).jpeg({ quality: 80 }).toBuffer();
        await previews.set(itemId, apercu);
        console.log(`   ↳ aperçu public généré (${(apercu.length / 1024).toFixed(0)} Ko)`);
      } catch (e) {
        console.log(`   ↳ ⚠️  échec génération aperçu pour ${itemId} : ${e.message}`);
      }
    }
  }
  return { envoyes };
}

(async () => {
  console.log('📤 Envoi des 22 cartes machines (Genèse)...');
  const resMachines = await uploaderPaliers(DOSSIER_MACHINES, 'niveau-', 'niveau-');
  console.log('📤 Envoi des 22 cubes (Genèse)...');
  const resCubes = await uploaderPaliers(DOSSIER_CUBES, 'cube-p', 'cube-p');
  console.log('📤 Envoi de la collection Premium (assets/premium/, tous les fichiers)...');
  const resPremium = await uploaderPremium();

  console.log('\n--- Résumé ---');
  console.log(`Cartes machines Genèse : ${resMachines.envoyes} envoyées, ${resMachines.ignores} absentes localement`);
  console.log(`Cubes Genèse           : ${resCubes.envoyes} envoyées, ${resCubes.ignores} absents localement`);
  console.log(`Collection Premium     : ${resPremium.envoyes} pièce(s) envoyée(s)`);
  console.log('\nRelance ce script à chaque fois que tu ajoutes/remplaces une image --');
  console.log('il écrase simplement l\'ancienne version, sans rien casser.');
})();
