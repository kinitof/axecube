#!/bin/bash
# Compile main.swift en une vraie application macOS : AXECUBE.app
# Prérequis : les outils en ligne de commande Xcode (déjà présents sur la plupart des
# Mac ; sinon `xcode-select --install` te les proposera).
set -e

DOSSIER="$(cd "$(dirname "$0")" && pwd)"
NOM_APP="AXECUBE Desktop"
BUNDLE="$DOSSIER/$NOM_APP.app"

echo "🔨 Compilation…"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS"

swiftc "$DOSSIER/main.swift" -O -o "$BUNDLE/Contents/MacOS/AXECUBE"

cat > "$BUNDLE/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>AXECUBE</string>
    <key>CFBundleDisplayName</key><string>AXECUBE</string>
    <key>CFBundleIdentifier</key><string>eu.axecube.desktop</string>
    <key>CFBundleVersion</key><string>1.0</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundleExecutable</key><string>AXECUBE</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSMinimumSystemVersion</key><string>11.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key><true/>
        <key>NSExceptionDomains</key>
        <dict>
            <key>127.0.0.1</key>
            <dict>
                <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
                <key>NSIncludesSubdomains</key><false/>
            </dict>
            <key>localhost</key>
            <dict>
                <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
                <key>NSIncludesSubdomains</key><false/>
            </dict>
        </dict>
    </dict>
</dict>
</plist>
EOF

echo "✅ \"$NOM_APP.app\" créée dans : $DOSSIER"
echo "   Glisse-la dans /Applications, ou double-clique dessus directement."
echo "   (Lance AXECUBE normalement d'abord -- cette appli affiche juste le dashboard.)"
