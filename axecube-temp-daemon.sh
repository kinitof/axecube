#!/bin/bash
# AXECUBE — démon de surveillance thermique (à lancer UNE SEULE FOIS avec sudo, reste ouvert).
#
# Écrit toutes les 5 secondes la dernière lecture disponible dans /tmp/axecube-temp.log,
# écrasé à chaque tour -- l'app menu bar (AxecubeMenuBar.swift) se contente de lire ce
# fichier, donc elle n'a jamais besoin d'être lancée en sudo elle-même.
#
# Compatibilité : le matériel disponible via `powermetrics` diffère selon les Mac --
#   - Mac Intel (avec ventilateur)      : température brute en °C via le sampler "smc"
#   - Mac Apple Silicon (M1 à M4)       : pas de °C brut disponible ainsi, seulement un
#                                          niveau de pression thermique qualitatif
#                                          (Nominal / Fair / Heavy / etc.) via "thermal"
# Ce script détecte automatiquement, une seule fois au démarrage, lequel des deux
# fonctionne sur CETTE machine, et utilise le bon pour toute la suite -- aucune action
# manuelle requise, ça s'adapte tout seul que ce soit ton Mac ou celui d'un autre mineur.
#
# (Sur Windows/Linux, ce script ne sert à rien -- l'app menu bar est de toute façon
# une app macOS native, elle ne se lance jamais sur ces plateformes.)
#
# Utilisation :
#   sudo bash axecube-temp-daemon.sh
# (laisse la fenêtre de Terminal ouverte, ou lance en tâche de fond avec un &)
#
# Pour l'arrêter : Ctrl+C dans ce terminal, ou `pkill -f axecube-temp-daemon`.

LOG="/tmp/axecube-temp.log"

if [ "$(id -u)" -ne 0 ]; then
  echo "⚠️  Ce script doit être lancé avec sudo (accès aux capteurs matériels) :"
  echo "    sudo bash \"$0\""
  exit 1
fi

# Détection unique du sampler qui fonctionne sur cette machine précise.
SAMPLER="thermal"
if powermetrics --samplers smc -i1 -n1 > /dev/null 2>&1; then
  SAMPLER="smc"
  echo "🌡️  Capteur SMC détecté (température en °C disponible)."
else
  echo "🌡️  Capteur SMC indisponible sur cette puce -- utilisation du niveau de pression thermique."
fi

echo "🌡️  Démon de surveillance AXECUBE démarré -- écrit dans $LOG toutes les 5s."
echo "    (Ctrl+C pour arrêter)"

while true; do
  powermetrics --samplers "$SAMPLER" -i1 -n1 > "$LOG.tmp" 2>/dev/null
  mv "$LOG.tmp" "$LOG"
  sleep 5
done
