#!/bin/bash
#
#  ▦ AXECUBE — lanceur macOS
#  Double-cliquez ce fichier pour démarrer le minage.
#  (Au premier lancement, votre adresse Bitcoin vous sera demandée, puis mémorisée.)
#

cd "$(dirname "$0")" || exit 1

if [ ! -f axecube.js ]; then
  echo "Fichier axecube.js introuvable à côté du lanceur."
  echo "Gardez AXECUBE.command et axecube.js dans le même dossier."
  read -r -p "Appuyez sur Entrée pour fermer…" _
  exit 1
fi

VERT=$'\033[38;5;154m'; BLANC=$'\033[97m'; GRIS=$'\033[90m'
ROUGE=$'\033[91m'; JAUNE=$'\033[93m'; GRAS=$'\033[1m'; RAZ=$'\033[0m'

CONF=".axecube-config"
PORT=1337

clear
cat <<BANNIERE
${VERT}${GRAS}
        ╱▔▔▔╲        A X E C U B E
       ╱     ╲       ${BLANC}mineur lottery${VERT}
       ╲     ╱
        ╲▁▁▁╱       ${GRIS}minage solo Bitcoin · chaque bloc est une chance${VERT}
${RAZ}
BANNIERE

# ─────────────────────────────  Node.js  ─────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  # Emplacements courants absents du PATH d'une fenêtre lancée par double-clic
  for CHEMIN in /usr/local/bin /opt/homebrew/bin; do
    [ -x "$CHEMIN/node" ] && export PATH="$CHEMIN:$PATH"
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "${ROUGE}${GRAS}Node.js est introuvable sur cet ordinateur.${RAZ}"
  echo
  echo "AXECUBE en a besoin pour fonctionner. C'est gratuit et l'installation"
  echo "prend deux minutes :"
  echo
  echo "  1. ${BLANC}Ouvrez ${GRAS}https://nodejs.org${RAZ}"
  echo "  2. Téléchargez la version ${GRAS}LTS${RAZ} et lancez l'installateur"
  echo "  3. ${BLANC}Fermez cette fenêtre et double-cliquez à nouveau sur AXECUBE${RAZ}"
  echo
  read -r -p "Appuyez sur Entrée pour ouvrir nodejs.org…" _
  open "https://nodejs.org"
  exit 1
fi

VERSION_NODE=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null)
if [ -z "$VERSION_NODE" ] || [ "$VERSION_NODE" -lt 18 ]; then
  echo "${JAUNE}Votre version de Node.js est trop ancienne (v$VERSION_NODE).${RAZ}"
  echo "Installez la version LTS depuis https://nodejs.org, puis relancez AXECUBE."
  echo
  read -r -p "Appuyez sur Entrée pour quitter…" _
  exit 1
fi

# ────────────────────────────  Adresse BTC  ───────────────────────────
# L'adresse est validée par le décodeur d'AXECUBE (bech32/bech32m + Base58Check),
# pas par une approximation : une somme de contrôle fausse est rejetée.
valider_adresse() {
  node axecube.js --verifier-adresse "$1" >/dev/null 2>&1
}

# Lecture de la configuration SANS l'exécuter (pas de « source ») :
# seules les clés connues sont retenues, les valeurs ne sont jamais interprétées.
lire_config() {
  [ -f "$CONF" ] || return 0
  while IFS='=' read -r cle valeur; do
    valeur=${valeur%\"}; valeur=${valeur#\"}
    case "$cle" in
      ADRESSE) ADRESSE=$(printf '%s' "$valeur" | tr -cd 'A-Za-z0-9') ;;
      COEURS)  COEURS=$(printf '%s' "$valeur" | tr -cd '0-9') ;;
      LAN)     LAN=$(printf '%s' "$valeur" | tr -cd '01') ;;
      RESEAU)  RESEAU=$(printf '%s' "$valeur" | tr -cd 'a-z') ;;
      WORKER)  WORKER=$(printf '%s' "$valeur" | tr -cd 'A-Za-z0-9_-') ;;
    esac
  done < "$CONF"
}

lire_config

while [ -z "$ADRESSE" ] || ! valider_adresse "$ADRESSE"; do
  if [ -n "$ADRESSE" ]; then
    echo "${JAUNE}Cette adresse ne ressemble pas à une adresse Bitcoin valide.${RAZ}"
    echo
  fi
  echo "${BLANC}${GRAS}Où faut-il envoyer la récompense si vous trouvez un bloc ?${RAZ}"
  echo "${GRIS}Collez votre adresse Bitcoin (commence par bc1, 1 ou 3)."
  echo "Utilisez une adresse dont vous détenez les clés — pas celle d'une plateforme.${RAZ}"
  echo
  printf "  Adresse : "
  read -r ADRESSE
  ADRESSE=$(echo "$ADRESSE" | tr -d '[:space:]')
  echo
done

# ──────────────────────────────  Réseau à miner  ───────────────────────
if [ -z "$RESEAU" ]; then
  echo "${BLANC}${GRAS}Quel réseau voulez-vous miner ?${RAZ}"
  echo "${GRIS}1) Bitcoin${RAZ}         — le grand jackpot (~3,125 BTC), quasi impossible à gagner"
  echo "${GRIS}2) Fractal Bitcoin${RAZ} — même moteur, ~20 000× plus de chances, récompense bien plus modeste (~25 FB)"
  echo
  printf "  Réseau [1] : "
  read -r REP_RESEAU
  case "$REP_RESEAU" in
    2) RESEAU=fractal ;;
    *) RESEAU=btc ;;
  esac
  echo
fi
COEURS_MAX=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)
if [ -z "$COEURS" ]; then
  DEFAUT=$(( COEURS_MAX / 2 ))
  [ "$DEFAUT" -lt 1 ] && DEFAUT=1
  echo "${BLANC}${GRAS}Combien de cœurs AXECUBE peut-il utiliser ?${RAZ}"
  echo "${GRIS}Votre Mac en a $COEURS_MAX. Plus de cœurs = plus de puissance, mais plus"
  echo "de chaleur. Vous pourrez ajuster à tout moment depuis le tableau de bord.${RAZ}"
  echo
  printf "  Cœurs [%s] : " "$DEFAUT"
  read -r SAISIE
  COEURS=${SAISIE:-$DEFAUT}
  case "$COEURS" in
    ''|*[!0-9]*) COEURS=$DEFAUT ;;
  esac
  [ "$COEURS" -lt 1 ] && COEURS=1
  [ "$COEURS" -gt "$COEURS_MAX" ] && COEURS=$COEURS_MAX
  echo
fi

# ──────────────────────────────  Nom du mineur  ────────────────────────
if [ -z "$WORKER" ]; then
  echo "${BLANC}${GRAS}Quel nom donner à cette machine ?${RAZ}"
  echo "${GRIS}Sert à la distinguer sur le pool et le classement communautaire"
  echo "(utile si vous minez depuis plusieurs machines avec la même adresse).${RAZ}"
  echo
  printf "  Nom [macbook] : "
  read -r SAISIE_WORKER
  WORKER=$(printf '%s' "${SAISIE_WORKER:-macbook}" | tr -cd 'A-Za-z0-9_-')
  [ -z "$WORKER" ] && WORKER=macbook
  echo
fi

# ─────────────────────────  Accès depuis le téléphone  ────────────────────
if [ -z "$LAN" ]; then
  echo "${BLANC}${GRAS}Autoriser la consultation depuis votre téléphone ?${RAZ}"
  echo "${GRIS}Le tableau de bord devient accessible aux appareils de votre réseau,"
  echo "protégé par un lien secret. Sinon, il reste limité à cet ordinateur.${RAZ}"
  echo
  printf "  Autoriser ? [o/N] : "
  read -r REP
  case "$REP" in [oOyY]*) LAN=1 ;; *) LAN=0 ;; esac
  echo
fi

# Mémorisation des réglages (fichier de données, jamais exécuté)
cat > "$CONF" <<CONFIG
ADRESSE=$ADRESSE
COEURS=$COEURS
LAN=$LAN
RESEAU=$RESEAU
WORKER=$WORKER
CONFIG

# ────────────────────────────  Port libre  ────────────────────────────
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
  [ "$PORT" -gt 1350 ] && break
done

# ──────────────────────────────  Départ  ──────────────────────────────
echo "${GRIS}Adresse  ${RAZ}${ADRESSE}"
echo "${GRIS}Nom      ${RAZ}${WORKER}"
echo "${GRIS}Réseau   ${RAZ}$([ "$RESEAU" = "fractal" ] && echo "Fractal Bitcoin" || echo "Bitcoin")"
echo "${GRIS}Cœurs    ${RAZ}${COEURS} sur ${COEURS_MAX}"
echo "${GRIS}Écran    ${RAZ}http://localhost:${PORT}"
echo
echo "${VERT}Démarrage du minage…${RAZ}  ${GRIS}(Ctrl+C pour arrêter — votre record est sauvegardé)${RAZ}"
echo

( sleep 3; open "http://localhost:$PORT" ) &

OPTS="--network $RESEAU --worker $WORKER"
[ "$LAN" = "1" ] && OPTS="$OPTS --lan"

node axecube.js "$ADRESSE" --threads "$COEURS" --port "$PORT" $OPTS

echo
echo "${GRIS}Minage arrêté. Votre record et vos statistiques sont conservés.${RAZ}"
echo "${GRIS}Double-cliquez AXECUBE pour reprendre.${RAZ}"
echo
read -r -p "Appuyez sur Entrée pour fermer cette fenêtre…" _
