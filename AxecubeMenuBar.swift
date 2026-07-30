// AxecubeMenuBar.swift
// AXECUBE — petite app menu bar macOS : affiche hashrate + température CPU en direct,
// et envoie une notification si la température dépasse le seuil défini.
//
// Ne nécessite AUCUN privilège root -- elle se contente de :
//   1. Lire le fichier /tmp/axecube-temp.log, écrit par axecube-temp-daemon.sh (lancé à
//      part, une seule fois, avec sudo -- voir ce script pour les détails).
//   2. Interroger l'API locale du dashboard AXECUBE (http://127.0.0.1:<port>/api/stats),
//      qui répond sans jeton pour les requêtes venant de la machine elle-même.
//
// COMPILATION (Terminal, depuis le dossier contenant ce fichier) :
//   swiftc AxecubeMenuBar.swift -o AxecubeMenuBar -framework Cocoa
//   ./AxecubeMenuBar
//
// Pour la lancer sans passer par Terminal à chaque fois, tu peux la glisser dans un
// dossier comme /Applications ou créer un simple raccourci -- dis-moi si tu veux qu'on
// pousse jusqu'à un vrai .app avec icône, ce fichier suffit pour une première version
// fonctionnelle en ligne de commande.

import Cocoa

// ─────────────────────────────────────────────────────────────────────────────
// Réglages -- à adapter si besoin
// ─────────────────────────────────────────────────────────────────────────────
let DASHBOARD_URL = "http://127.0.0.1:1337/api/stats"   // adapte le port si tu utilises --port
let TEMP_LOG_PATH = "/tmp/axecube-temp.log"
let SEUIL_ALERTE_C: Double = 90.0                        // utilisé seulement sur les Mac où une vraie température est disponible
let INTERVALLE_RAFRAICHISSEMENT: TimeInterval = 5.0      // secondes entre deux mises à jour
let COOLDOWN_ALERTE: TimeInterval = 300.0                // ne pas re-notifier avant 5 min

/// Selon le Mac (Intel avec ventilateur vs Apple Silicon), axecube-temp-daemon.sh écrit soit
/// une vraie température en °C, soit un niveau de pression thermique qualitatif -- l'app
/// détecte automatiquement lequel des deux est présent dans le fichier et s'adapte.
enum EtatThermique {
    case temperature(Double)
    case pression(String)
}

final class AxecubeMenuBarApp: NSObject, NSApplicationDelegate {
    let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var timer: Timer?
    var derniereAlerte: Date = .distantPast

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)  // pas d'icône dans le Dock, juste la barre de menus

        statusItem.button?.title = "⛏ AXECUBE …"
        construireMenu()

        rafraichir()
        timer = Timer.scheduledTimer(withTimeInterval: INTERVALLE_RAFRAICHISSEMENT, repeats: true) { [weak self] _ in
            self?.rafraichir()
        }
    }

    func construireMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Ouvrir le dashboard", action: #selector(ouvrirDashboard), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "Quitter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        for item in menu.items { item.target = self }
        statusItem.menu = menu
    }

    @objc func ouvrirDashboard() {
        if let url = URL(string: "http://127.0.0.1:1337/") {
            NSWorkspace.shared.open(url)
        }
    }

    func rafraichir() {
        let etat = lireEtatThermique()
        recupererHashrate { [weak self] hashrateMHs in
            guard let self = self else { return }
            DispatchQueue.main.async {
                self.majAffichage(hashrateMHs: hashrateMHs, etat: etat)
                if let e = etat, self.estElevee(e) {
                    self.verifierAlerte(etat: e)
                }
            }
        }
    }

    /// Sur les Mac avec vraie température : élevé si ≥ SEUIL_ALERTE_C. Sur Apple Silicon
    /// (niveau qualitatif) : élevé dès que ce n'est pas "Nominal" -- le vocabulaire exact
    /// varie selon la version de macOS (Fair/Moderate/Heavy/Serious/Critical/Trapping...),
    /// donc on ne liste pas chaque cas, seul "Nominal" est considéré normal.
    func estElevee(_ etat: EtatThermique) -> Bool {
        switch etat {
        case .temperature(let t): return t >= SEUIL_ALERTE_C
        case .pression(let p): return p.lowercased() != "nominal"
        }
    }

    func emojiPour(_ pression: String) -> String {
        switch pression.lowercased() {
        case "nominal": return "🟢"
        case "fair", "moderate": return "🟡"
        default: return "🔴"
        }
    }

    func majAffichage(hashrateMHs: Double?, etat: EtatThermique?) {
        var morceaux: [String] = []
        if let h = hashrateMHs {
            morceaux.append(String(format: "⛏ %.1f MH/s", h))
        } else {
            morceaux.append("⛏ —")
        }
        switch etat {
        case .temperature(let t):
            let emoji = t >= SEUIL_ALERTE_C ? "🔴" : (t >= SEUIL_ALERTE_C - 15 ? "🟡" : "🟢")
            morceaux.append(String(format: "%@ %.0f°C", emoji, t))
        case .pression(let p):
            morceaux.append("\(emojiPour(p)) \(p)")
        case .none:
            morceaux.append("🌡 —")
        }
        statusItem.button?.title = morceaux.joined(separator: "  ·  ")
    }

    /// Lit /tmp/axecube-temp.log et détecte automatiquement lequel des deux formats
    /// possibles s'y trouve (voir EtatThermique ci-dessus) : une vraie température en °C
    /// (ligne contenant "temperature"), ou à défaut un niveau de pression thermique
    /// qualitatif (ligne "Current pressure level: <Niveau>", format Apple Silicon).
    func lireEtatThermique() -> EtatThermique? {
        guard let contenu = try? String(contentsOfFile: TEMP_LOG_PATH, encoding: .utf8) else { return nil }
        for ligne in contenu.split(separator: "\n") {
            let l = ligne.lowercased()
            if l.contains("temperature"),
               let regex = try? NSRegularExpression(pattern: "([0-9]+\\.?[0-9]*)\\s*C\\b"),
               let m = regex.firstMatch(in: String(ligne), range: NSRange(ligne.startIndex..., in: ligne)),
               let range = Range(m.range(at: 1), in: ligne),
               let valeur = Double(ligne[range]) {
                return .temperature(valeur)
            }
            if l.contains("current pressure level") {
                let parties = ligne.split(separator: ":")
                if parties.count >= 2 {
                    return .pression(parties[1].trimmingCharacters(in: .whitespaces))
                }
            }
        }
        return nil
    }

    /// Interroge l'API locale du dashboard AXECUBE pour le hashrate courant (en H/s côté
    /// serveur -- on convertit ici en MH/s pour l'affichage).
    func recupererHashrate(completion: @escaping (Double?) -> Void) {
        guard let url = URL(string: DASHBOARD_URL) else { completion(nil); return }
        var requete = URLRequest(url: url)
        requete.timeoutInterval = 3
        URLSession.shared.dataTask(with: requete) { data, _, _ in
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let hashrateNombre = json["hashrate"] as? NSNumber else {
                completion(nil); return
            }
            completion(hashrateNombre.doubleValue / 1_000_000.0)
        }.resume()
    }

    func verifierAlerte(etat: EtatThermique) {
        let maintenant = Date()
        guard maintenant.timeIntervalSince(derniereAlerte) >= COOLDOWN_ALERTE else { return }
        derniereAlerte = maintenant

        let notif = NSUserNotification()
        switch etat {
        case .temperature(let t):
            notif.title = "⚠️ AXECUBE — Surchauffe détectée"
            notif.informativeText = String(format: "Température CPU : %.0f°C (seuil : %.0f°C). Pense à vérifier la ventilation.", t, SEUIL_ALERTE_C)
        case .pression(let p):
            notif.title = "⚠️ AXECUBE — Pression thermique élevée"
            notif.informativeText = "Niveau actuel : \(p). Pense à vérifier la ventilation ou réduire les threads."
        }
        notif.soundName = NSUserNotificationDefaultSoundName
        NSUserNotificationCenter.default.deliver(notif)
    }
}

let app = NSApplication.shared
let delegate = AxecubeMenuBarApp()
app.delegate = delegate
app.run()
