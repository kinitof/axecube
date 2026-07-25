@echo off
setlocal enabledelayedexpansion
title AXECUBE - mineur lottery
color 0A
cd /d "%~dp0"

if not exist axecube.js (
  echo Fichier axecube.js introuvable a cote du lanceur.
  echo Gardez AXECUBE.bat et axecube.js dans le meme dossier.
  pause
  exit /b 1
)

cls
echo.
echo         /----\        A X E C U B E
echo        /      \       mineur lottery
echo        \      /
echo         \----/       minage solo Bitcoin - chaque bloc est une chance
echo.

rem ------------------------------  Node.js  ------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js est introuvable sur cet ordinateur.
  echo.
  echo AXECUBE en a besoin pour fonctionner. C'est gratuit et l'installation
  echo prend deux minutes :
  echo.
  echo   1. Ouvrez https://nodejs.org
  echo   2. Telechargez la version LTS et lancez l'installateur
  echo   3. Fermez cette fenetre et relancez AXECUBE.bat
  echo.
  pause
  start "" "https://nodejs.org"
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set VERSION_NODE=%%v
if not defined VERSION_NODE (
  echo Impossible de determiner la version de Node.js installee.
  pause
  exit /b 1
)
if %VERSION_NODE% LSS 18 (
  echo Votre version de Node.js est trop ancienne ^(v%VERSION_NODE%^).
  echo Installez la version LTS depuis https://nodejs.org, puis relancez AXECUBE.
  echo.
  pause
  exit /b 1
)

set CONF=.axecube-config
set PORT=1337

rem ------------------------  Lecture config existante  ------------------------
set ADRESSE=
set COEURS=
set LAN=
set RESEAU=
set WORKER=
if exist "%CONF%" (
  for /f "usebackq tokens=1,2 delims==" %%a in ("%CONF%") do (
    if "%%a"=="ADRESSE" set ADRESSE=%%b
    if "%%a"=="COEURS"  set COEURS=%%b
    if "%%a"=="LAN"     set LAN=%%b
    if "%%a"=="RESEAU"  set RESEAU=%%b
    if "%%a"=="WORKER"  set WORKER=%%b
  )
)

rem ------------------------------  Adresse BTC  ------------------------------
:demande_adresse
if defined ADRESSE (
  node axecube.js --verifier-adresse "%ADRESSE%" >nul 2>nul
  if not errorlevel 1 goto adresse_ok
  echo Cette adresse ne ressemble pas a une adresse Bitcoin valide.
  echo.
  set ADRESSE=
)
echo Ou faut-il envoyer la recompense si vous trouvez un bloc ?
echo Collez votre adresse Bitcoin ^(commence par bc1, 1 ou 3^).
echo Utilisez une adresse dont vous detenez les cles - pas celle d'une plateforme.
echo.
set /p ADRESSE="  Adresse : "
echo.
goto demande_adresse
:adresse_ok

rem ------------------------------  Reseau a miner  ------------------------------
if not defined RESEAU (
  echo Quel reseau voulez-vous miner ?
  echo 1^) Bitcoin         - le grand jackpot ^(~3,125 BTC^), quasi impossible a gagner
  echo 2^) Fractal Bitcoin - meme moteur, ~20 000x plus de chances, recompense plus modeste ^(~25 FB^)
  echo.
  set /p REP_RESEAU="  Reseau [1] : "
  if "!REP_RESEAU!"=="2" (set RESEAU=fractal) else (set RESEAU=btc)
  echo.
)

set COEURS_MAX=%NUMBER_OF_PROCESSORS%
if not defined COEURS (
  set /a DEFAUT=COEURS_MAX/2
  if !DEFAUT! LSS 1 set DEFAUT=1
  echo Combien de coeurs AXECUBE peut-il utiliser ?
  echo Ce PC en a %COEURS_MAX%. Plus de coeurs = plus de puissance, mais plus
  echo de chaleur. Vous pourrez ajuster a tout moment depuis le tableau de bord.
  echo.
  set /p SAISIE="  Coeurs [!DEFAUT!] : "
  if not defined SAISIE (set COEURS=!DEFAUT!) else (set COEURS=!SAISIE!)
  echo !COEURS!| findstr /r "^[0-9][0-9]*$" >nul
  if errorlevel 1 set COEURS=!DEFAUT!
  if !COEURS! LSS 1 set COEURS=1
  if !COEURS! GTR !COEURS_MAX! set COEURS=!COEURS_MAX!
  echo.
)

rem ------------------------------  Nom du mineur  ------------------------------
if not defined WORKER (
  echo Quel nom donner a cette machine ?
  echo Sert a la distinguer sur le pool et le classement communautaire
  echo ^(utile si vous minez depuis plusieurs machines avec la meme adresse^).
  echo.
  set /p SAISIE_WORKER="  Nom [pc] : "
  if not defined SAISIE_WORKER (set WORKER=pc) else (set WORKER=!SAISIE_WORKER!)
  echo.
)

rem ------------------------  Acces depuis le telephone  ------------------------
if not defined LAN (
  echo Autoriser la consultation depuis votre telephone ?
  echo Le tableau de bord devient accessible aux appareils de votre reseau,
  echo protege par un lien secret. Sinon, il reste limite a cet ordinateur.
  echo.
  set /p REP="  Autoriser ? [o/N] : "
  if /i "!REP:~0,1!"=="o" (set LAN=1) else (set LAN=0)
  echo.
)

rem Memorisation des reglages (fichier de donnees, jamais execute)
(
  echo ADRESSE=%ADRESSE%
  echo COEURS=%COEURS%
  echo LAN=%LAN%
  echo RESEAU=%RESEAU%
  echo WORKER=%WORKER%
) > "%CONF%"

rem ------------------------------  Port libre  ------------------------------
:verif_port
netstat -an | findstr /r /c:"[:.]%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  set /a PORT=PORT+1
  if !PORT! LEQ 1350 goto verif_port
)

rem ------------------------------  Depart  ------------------------------
echo Adresse  %ADRESSE%
echo Nom      %WORKER%
if "%RESEAU%"=="fractal" (echo Reseau   Fractal Bitcoin) else (echo Reseau   Bitcoin)
echo Coeurs   %COEURS% sur %COEURS_MAX%
echo Ecran    http://localhost:%PORT%
echo.
echo Demarrage du minage...  ^(Ctrl+C pour arreter - votre record est sauvegarde^)
echo.

set OPTS=--network %RESEAU% --worker %WORKER%
if "%LAN%"=="1" set OPTS=%OPTS% --lan

start "" cmd /c "timeout /t 3 >nul & start http://localhost:%PORT%"

node axecube.js "%ADRESSE%" --threads %COEURS% --port %PORT% %OPTS%

echo.
echo Minage arrete. Votre record et vos statistiques sont conserves.
echo Relancez AXECUBE.bat pour reprendre.
echo.
pause
