#!/usr/bin/env node
'use strict';

/**
 * AXECUBE TEST POOL
 * Pool Stratum V1 locale de validation pour AXECUBE.
 *
 * But:
 *  - accepter mining.subscribe / mining.authorize
 *  - envoyer un vrai job Stratum
 *  - recevoir mining.submit
 *  - reconstruire indépendamment coinbase -> merkle -> header 80 octets
 *  - recalculer SHA256d et vérifier la difficulté du share
 *
 * IMPORTANT:
 *  Ceci est une pool de TEST LOCALE. Elle ne soumet rien au réseau Bitcoin.
 */

const net = require('net');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3333);

// Difficulté basse : environ 1 share toutes les ~4 295 hashes en moyenne.
const SHARE_DIFF = Number(process.env.DIFF || 0.000001);

// nBits regtest, cible réseau extrêmement basse.
// AXECUBE l'identifiera comme simulation puisqu'on est sur 127.0.0.1.
const NBITS = '207fffff';
const VERSION = '20000000';
const PREVHASH = '00'.repeat(32);

// Extranonce Stratum
const EXTRANONCE1 = 'a1b2c3d4';
const EXTRANONCE2_SIZE = 4;

const DIFF1 = 0x00000000ffff0000000000000000000000000000000000000000000000000000n;

function sha256d(buf) {
  return crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(buf).digest())
    .digest();
}

function swap32(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i += 4) {
    out[i] = buf[i + 3];
    out[i + 1] = buf[i + 2];
    out[i + 2] = buf[i + 1];
    out[i + 3] = buf[i];
  }
  return out;
}

function hashDifficulty(hashBuf) {
  const beHex = Buffer.from(hashBuf).reverse().toString('hex');
  const value = BigInt('0x' + beHex);
  if (value === 0n) return Infinity;
  return Number((DIFF1 * 1000000n) / value) / 1000000;
}

function difficultyToTarget(diff) {
  const scaled = BigInt(Math.max(1, Math.round(diff * 1000000)));
  return (DIFF1 * 1000000n) / scaled;
}

function nbitsToTarget(nbitsHex) {
  const nbits = parseInt(nbitsHex, 16);
  const exp = nbits >>> 24;
  const mant = BigInt(nbits & 0x007fffff);
  return mant << (8n * (BigInt(exp) - 3n));
}

function buildMerkleRoot(cbHash, branches) {
  let root = cbHash;
  for (const b of branches) {
    root = sha256d(Buffer.concat([root, Buffer.from(b, 'hex')]));
  }
  return root;
}

function buildHeader(job, merkleRoot, nonceHex, ntimeHex) {
  const header = Buffer.alloc(80);

  Buffer.from(job.version, 'hex').reverse().copy(header, 0);
  swap32(Buffer.from(job.prevhash, 'hex')).copy(header, 4);
  merkleRoot.copy(header, 36);
  Buffer.from(ntimeHex, 'hex').reverse().copy(header, 68);
  Buffer.from(job.nbits, 'hex').reverse().copy(header, 72);
  Buffer.from(nonceHex, 'hex').reverse().copy(header, 76);

  return header;
}

function nowHex() {
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
}

// Coinbase volontairement simple mais sérialisée proprement.
// L'extranonce est placé dans le scriptSig entre coinb1 et coinb2.
function makeCoinbaseParts() {
  const version = '01000000';
  const vinCount = '01';
  const prevout = '00'.repeat(32) + 'ffffffff';

  // scriptSig = [hauteur factice 3 octets] + extranonce1 + extranonce2
  const prefix = '03' + '010000'; // push 3 bytes, hauteur factice = 1
  const scriptLen = (3 + 1 + 4 + EXTRANONCE2_SIZE); // push opcode + 3 + en1 + en2
  const scriptLenHex = scriptLen.toString(16).padStart(2, '0');

  const sequence = 'ffffffff';

  // Une sortie OP_TRUE de 50 BTC (test uniquement)
  const voutCount = '01';
  const value = '00f2052a01000000'; // 50 BTC little-endian
  const pkScriptLen = '01';
  const pkScript = '51'; // OP_TRUE
  const locktime = '00000000';

  const coinb1 =
    version +
    vinCount +
    prevout +
    scriptLenHex +
    prefix;

  const coinb2 =
    sequence +
    voutCount +
    value +
    pkScriptLen +
    pkScript +
    locktime;

  return { coinb1, coinb2 };
}

let jobCounter = 0;

function createJob() {
  const { coinb1, coinb2 } = makeCoinbaseParts();
  return {
    jobId: 'axetest-' + (++jobCounter),
    prevhash: PREVHASH,
    coinb1,
    coinb2,
    merkleBranch: [],
    version: VERSION,
    nbits: NBITS,
    ntime: nowHex(),
    cleanJobs: true,
  };
}

function log(...args) {
  console.log(new Date().toLocaleTimeString('fr-FR'), ...args);
}

const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`🔌 AXECUBE connecté : ${peer}`);

  socket.setNoDelay(true);
  let buf = '';
  let authorizedUser = '';
  let currentJob = null;
  let submitted = 0;
  let accepted = 0;

  function send(obj) {
    socket.write(JSON.stringify(obj) + '\n');
  }

  function sendJob() {
    currentJob = createJob();

    send({
      id: null,
      method: 'mining.set_difficulty',
      params: [SHARE_DIFF]
    });

    send({
      id: null,
      method: 'mining.notify',
      params: [
        currentJob.jobId,
        currentJob.prevhash,
        currentJob.coinb1,
        currentJob.coinb2,
        currentJob.merkleBranch,
        currentJob.version,
        currentJob.nbits,
        currentJob.ntime,
        currentJob.cleanJobs
      ]
    });

    log(`📦 Job envoyé : ${currentJob.jobId}`);
    log(`🎯 Difficulté share : ${SHARE_DIFF}`);
    log(`🧪 nBits simulation : ${NBITS}`);
  }

  function verifySubmit(params) {
    if (!currentJob) return { ok: false, reason: 'aucun job actif' };
    if (!Array.isArray(params) || params.length < 5) {
      return { ok: false, reason: 'paramètres mining.submit incomplets' };
    }

    const [user, jobId, extranonce2, ntime, nonce] = params;

    if (jobId !== currentJob.jobId) {
      return { ok: false, reason: `job inconnu (${jobId})` };
    }
    if (!/^[0-9a-fA-F]{8}$/.test(extranonce2)) {
      return { ok: false, reason: `extranonce2 invalide (${extranonce2})` };
    }
    if (!/^[0-9a-fA-F]{8}$/.test(ntime)) {
      return { ok: false, reason: `ntime invalide (${ntime})` };
    }
    if (!/^[0-9a-fA-F]{8}$/.test(nonce)) {
      return { ok: false, reason: `nonce invalide (${nonce})` };
    }

    const coinbaseHex =
      currentJob.coinb1 +
      EXTRANONCE1 +
      extranonce2.toLowerCase() +
      currentJob.coinb2;

    let coinbase;
    try {
      coinbase = Buffer.from(coinbaseHex, 'hex');
    } catch {
      return { ok: false, reason: 'coinbase hex invalide' };
    }

    const coinbaseHash = sha256d(coinbase);
    const merkleRoot = buildMerkleRoot(coinbaseHash, currentJob.merkleBranch);
    const header = buildHeader(
      currentJob,
      merkleRoot,
      nonce.toLowerCase(),
      ntime.toLowerCase()
    );
    const hash = sha256d(header);

    const hashBE = Buffer.from(hash).reverse();
    const hashHex = hashBE.toString('hex');
    const hashValue = BigInt('0x' + hashHex);
    const diff = hashDifficulty(hash);

    const shareTarget = difficultyToTarget(SHARE_DIFF);
    const networkTarget = nbitsToTarget(currentJob.nbits);

    const shareValid = hashValue <= shareTarget;
    const blockValid = hashValue <= networkTarget;

    return {
      ok: shareValid,
      user,
      hashHex,
      diff,
      headerHex: header.toString('hex'),
      shareValid,
      blockValid,
      shareTargetHex: shareTarget.toString(16).padStart(64, '0'),
      networkTargetHex: networkTarget.toString(16).padStart(64, '0'),
      reason: shareValid ? null : 'hash au-dessus de la cible du share'
    };
  }

  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');

    while (buf.includes('\n')) {
      const idx = buf.indexOf('\n');
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);

      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log('❌ JSON invalide reçu');
        continue;
      }

      const method = msg.method;

      if (method === 'mining.subscribe') {
        log('✓ mining.subscribe reçu');
        send({
          id: msg.id,
          result: [
            [
              ['mining.set_difficulty', 'axecube-test-diff'],
              ['mining.notify', 'axecube-test-job']
            ],
            EXTRANONCE1,
            EXTRANONCE2_SIZE
          ],
          error: null
        });
        log(`✓ Souscription OK — extranonce1=${EXTRANONCE1}, en2size=${EXTRANONCE2_SIZE}`);
      }

      else if (method === 'mining.suggest_difficulty') {
        log(`ℹ️ AXECUBE suggère difficulté ${msg.params?.[0]} — test maintenu à ${SHARE_DIFF}`);
        if (msg.id !== undefined && msg.id !== null) {
          send({ id: msg.id, result: true, error: null });
        }
      }

      else if (method === 'mining.authorize') {
        authorizedUser = String(msg.params?.[0] || 'axecube');
        log(`✓ mining.authorize reçu : ${authorizedUser}`);
        send({ id: msg.id, result: true, error: null });
        log('✓ Autorisation OK');
        sendJob();
      }

      else if (method === 'mining.submit') {
        submitted++;
        const result = verifySubmit(msg.params);

        log('');
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log(`🔎 mining.submit #${submitted} reçu`);

        if (result.ok) {
          accepted++;
          log(`✓ Coinbase reconstruite`);
          log(`✓ Merkle root recalculée`);
          log(`✓ Header 80 octets reconstruit`);
          log(`✓ SHA-256d recalculé indépendamment`);
          log(`✓ Nonce valide : ${msg.params[4]}`);
          log(`✓ Hash : ${result.hashHex}`);
          log(`✓ Difficulté réelle du hash : ${result.diff}`);
          log(`✓ Cible share atteinte : OUI`);

          if (result.blockValid) {
            log(`✓ Cible "réseau" de simulation atteinte : OUI`);
            log('');
            log('✅ TEST RÉUSSI — AXECUBE A TROUVÉ ET SOUMIS UNE SOLUTION VALIDE');
            log('🧪 Il s’agit uniquement d’un bloc de SIMULATION locale.');
          } else {
            log(`ℹ️ Cible "réseau" de simulation atteinte : NON`);
            log('');
            log('✅ SHARE VALIDE — chaîne Stratum + SHA256d confirmée');
          }

          send({ id: msg.id, result: true, error: null });
        } else {
          log(`❌ SHARE REFUSÉ : ${result.reason}`);
          if (result.hashHex) log(`Hash recalculé : ${result.hashHex}`);
          if (result.diff !== undefined) log(`Difficulté réelle : ${result.diff}`);
          send({
            id: msg.id,
            result: false,
            error: [23, result.reason || 'Low difficulty share', null]
          });
        }

        log(`📊 Acceptés : ${accepted}/${submitted}`);
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('');
      }

      else {
        log(`ℹ️ Méthode ignorée : ${method || '(réponse sans method)'}`);
        if (msg.id !== undefined && msg.id !== null) {
          send({ id: msg.id, result: true, error: null });
        }
      }
    }
  });

  socket.on('error', (err) => {
    log(`⚠️ Socket : ${err.message}`);
  });

  socket.on('close', () => {
    log(`🔌 AXECUBE déconnecté — ${accepted}/${submitted} shares valides`);
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║              AXECUBE TEST POOL                      ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Pool locale : stratum+tcp://${HOST}:${PORT}`);
  console.log(`Difficulté  : ${SHARE_DIFF}`);
  console.log(`nBits test  : ${NBITS}`);
  console.log('');
  console.log('1) Laisse cette fenêtre ouverte.');
  console.log('2) Lance AXECUBE sur 127.0.0.1:' + PORT);
  console.log('3) Attends un mining.submit.');
  console.log('');
  console.log('⚠️ TEST LOCAL UNIQUEMENT — aucun bloc n’est envoyé à Bitcoin.');
  console.log('');
});

server.on('error', (err) => {
  console.error('Erreur serveur:', err);
  process.exit(1);
});
