// netlify/functions/mint-cube.js
//
// Mint un cube AXECUBE en NFT sur Solana (devnet pour l'instant) et l'envoie
// directement dans le wallet de l'utilisateur.
//
// Variables d'environnement requises (à définir dans Netlify -- Site settings
// > Environment variables, JAMAIS commitées dans le repo) :
//   SOLANA_TREASURY_SECRET_KEY = la clé secrète du wallet trésorerie devnet,
//     au format JSON (le contenu de treasury-devnet.json généré par
//     `solana-keygen new`), ex: "[12,34,56,...]"
//   SOLANA_RPC_URL = l'endpoint RPC à utiliser. Pour du devnet, le public
//     gratuit suffit largement pour tester : https://api.devnet.solana.com
//   SITE_URL = l'URL publique du site (ex: https://axecube-leaderboard.netlify.app)
//     -- sert à construire l'URL de l'image du cube dans les métadonnées NFT.
//
// Pour passer en mainnet plus tard : générer un NOUVEAU wallet trésorerie
// mainnet (financé en vrai SOL), un RPC dédié (Helius/QuickNode conseillé --
// le RPC public mainnet est trop limité en débit), et changer SOLANA_RPC_URL.

const { Connection, Keypair, clusterApiUrl } = require('@solana/web3.js');
const { Metaplex, keypairIdentity, bundlrStorage, toMetaplexFile } = require('@metaplex-foundation/js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ erreur: 'Méthode non autorisée' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ erreur: 'JSON invalide' }) };
  }

  const { wallet, cubeId, nom, type, icone } = payload;
  if (!wallet || !cubeId || !nom) {
    return { statusCode: 400, body: JSON.stringify({ erreur: 'Paramètres manquants (wallet, cubeId, nom requis)' }) };
  }

  if (!process.env.SOLANA_TREASURY_SECRET_KEY) {
    return { statusCode: 500, body: JSON.stringify({ erreur: 'SOLANA_TREASURY_SECRET_KEY non configurée côté serveur' }) };
  }

  try {
    // --- Connexion RPC + wallet trésorerie (paie les frais de mint) ---
    const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl('devnet');
    const connection = new Connection(rpcUrl, 'confirmed');

    const rawKey = process.env.SOLANA_TREASURY_SECRET_KEY || '';
    console.log('DEBUG longueur brute:', rawKey.length);
    console.log('DEBUG 15 derniers caractères (codes):', JSON.stringify(rawKey.slice(-15)));

    let secretKeyArray;
    try {
      secretKeyArray = JSON.parse(rawKey);
    } catch (parseErr) {
      console.log('DEBUG échec JSON.parse, tentative de nettoyage...');
      const nettoye = rawKey.trim().replace(/[^\d,\[\]]/g, '');
      console.log('DEBUG version nettoyée, longueur:', nettoye.length);
      secretKeyArray = JSON.parse(nettoye);
    }
    const tresorerie = Keypair.fromSecretKey(new Uint8Array(secretKeyArray));

    const metaplex = Metaplex.make(connection)
      .use(keypairIdentity(tresorerie))
      .use(bundlrStorage({
        address: 'https://devnet.bundlr.network',
        providerUrl: rpcUrl,
        timeout: 60000,
      }));

    // --- Métadonnées du NFT ---
    const siteUrl = process.env.SITE_URL || 'https://axecube-leaderboard.netlify.app';
    const imageUrl = siteUrl + '/icones/' + icone + '.png';

    const { uri } = await metaplex.nfts().uploadMetadata({
      name: 'AXECUBE — ' + nom,
      description: type + ' débloqué sur AXECUBE. Rareté vérifiable on-chain via le minage réel.',
      image: imageUrl,
      attributes: [
        { trait_type: 'Type', value: type },
        { trait_type: 'Cube', value: nom },
        { trait_type: 'ID interne', value: cubeId },
      ],
      properties: {
        files: [{ uri: imageUrl, type: 'image/png' }],
        category: 'image',
      },
    });

    // --- Mint réel, envoyé directement dans le wallet de l'utilisateur ---
    const { nft } = await metaplex.nfts().create({
      uri,
      name: 'AXECUBE — ' + nom,
      sellerFeeBasisPoints: 500, // 5% de royalties sur les reventes (ajustable)
      tokenOwner: new (require('@solana/web3.js').PublicKey)(wallet),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        mintAddress: nft.address.toString(),
        explorerUrl: 'https://explorer.solana.com/address/' + nft.address.toString() + '?cluster=devnet',
      }),
    };
  } catch (e) {
    console.error('Erreur mint:', e);
    return { statusCode: 500, body: JSON.stringify({ erreur: e.message || 'Erreur inconnue lors du mint' }) };
  }
};
