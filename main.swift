// AXECUBE Desktop — appli macOS native qui affiche le dashboard AXECUBE dans une
// vraie fenêtre système (sans barre d'adresse ni onglet de navigateur), ET qui
// lance elle-même le mineur (axecube.js) si besoin -- le client n'a plus jamais
// à ouvrir un Terminal.
//
// IMPORTANT : cette appli doit être placée dans LE MÊME DOSSIER que axecube.js
// (exactement comme AXECUBE.command/.bat). Elle lit et écrit le même fichier
// .axecube-config que ces lanceurs, donc les réglages restent cohérents des deux
// côtés.
//
// Cmd+K (ou menu AXECUBE > Mode compact) : minimise vraiment la grande fenêtre et
// affiche un petit panneau flottant séparé à la place. Cmd+R recharge, Cmd+Q quitte
// proprement (et arrête le mineur qu'on a lancé nous-mêmes).

import Cocoa
import WebKit

// Port de départ : comme le lanceur bash, on décale si occupé (jusqu'à 1350).
let PORT_DEPART = 1337
let PORT_MAX = 1350

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var boutonRetour: NSButton!
    var tentativeDemarrageFaite = false
    var mineurProcess: Process?
    var port = PORT_DEPART

    var panneau: NSPanel!
    var panneauWebView: WKWebView!
    var modeCompactActif = false

    var dossierAxecube: URL {
        Bundle.main.bundleURL.deletingLastPathComponent()
    }
    var urlDashboard: String { "http://127.0.0.1:\(port)/" }

    // ---------------------------------------------------------------- Démarrage

    func applicationDidFinishLaunching(_ notification: Notification) {
        construireFenetrePrincipale()
        construirePanneauCompact()
        afficherAttente()
        attendreEtCharger()

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        construireMenu()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // On arrête le mineur seulement si c'est NOUS qui l'avons démarré -- s'il
        // tournait déjà avant (lancé à la main), on le laisse tranquille.
        mineurProcess?.terminate()
    }

    func construireFenetrePrincipale() {
        let largeur: CGFloat = 420
        let hauteur: CGFloat = 800
        let ecran = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 900)
        let x = ecran.maxX - largeur - 40
        let y = ecran.maxY - hauteur - 40
        let cadre = NSRect(x: x, y: y, width: largeur, height: hauteur)

        window = NSWindow(contentRect: cadre,
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered,
                           defer: false)
        window.title = "AXECUBE"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isReleasedWhenClosed = false
        window.level = .normal
        window.minSize = NSSize(width: 280, height: 420)
        window.delegate = self

        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.frame = NSRect(origin: .zero, size: cadre.size)
        window.contentView = webView

        // Bouton retour flottant, visible seulement quand il y a un endroit où revenir
        // (visite guidée, découvrir, soutenir...) -- posé par-dessus la page web.
        boutonRetour = NSButton(frame: NSRect(x: 12, y: cadre.height - 44, width: 32, height: 32))
        boutonRetour.bezelStyle = .circular
        boutonRetour.title = ""
        boutonRetour.image = NSImage(systemSymbolName: "chevron.left", accessibilityDescription: "Retour")
        boutonRetour.imagePosition = .imageOnly
        boutonRetour.isBordered = true
        boutonRetour.target = self
        boutonRetour.action = #selector(retourDashboard)
        boutonRetour.isHidden = true
        boutonRetour.translatesAutoresizingMaskIntoConstraints = false
        webView.addSubview(boutonRetour)
        NSLayoutConstraint.activate([
            boutonRetour.leadingAnchor.constraint(equalTo: webView.leadingAnchor, constant: 12),
            boutonRetour.topAnchor.constraint(equalTo: webView.topAnchor, constant: 12),
            boutonRetour.widthAnchor.constraint(equalToConstant: 32),
            boutonRetour.heightAnchor.constraint(equalToConstant: 32),
        ])
    }

    func construirePanneauCompact() {
        let largeur: CGFloat = 280
        let hauteur: CGFloat = 420
        let ecran = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 900)
        let x = ecran.maxX - largeur - 24
        let y = ecran.maxY - hauteur - 24
        let cadre = NSRect(x: x, y: y, width: largeur, height: hauteur)

        panneau = NSPanel(contentRect: cadre,
                           styleMask: [.titled, .closable, .resizable, .nonactivatingPanel, .utilityWindow],
                           backing: .buffered,
                           defer: false)
        panneau.title = "AXECUBE"
        panneau.titlebarAppearsTransparent = true
        panneau.titleVisibility = .hidden
        panneau.isReleasedWhenClosed = false
        panneau.level = .floating
        panneau.hidesOnDeactivate = false
        panneau.isFloatingPanel = true
        panneau.minSize = NSSize(width: 220, height: 300)
        panneau.delegate = self

        let config = WKWebViewConfiguration()
        panneauWebView = WKWebView(frame: NSRect(origin: .zero, size: cadre.size), configuration: config)
        panneauWebView.autoresizingMask = [.width, .height]
        panneauWebView.uiDelegate = self
        panneauWebView.setValue(false, forKey: "drawsBackground")
        panneau.contentView = panneauWebView
    }

    func chargerDashboard() {
        guard let url = URL(string: urlDashboard) else { return }
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5))
    }

    // ------------------------------------------------------- Mode compact / restauration

    @objc func basculerModeCompact() {
        if modeCompactActif { restaurerFenetrePrincipale() } else { activerModeCompact() }
    }
    func activerModeCompact() {
        modeCompactActif = true
        if panneauWebView.url == nil, let url = URL(string: urlDashboard) {
            panneauWebView.load(URLRequest(url: url))
        }
        panneau.orderFront(nil)
        window.miniaturize(nil)
    }
    func restaurerFenetrePrincipale() {
        modeCompactActif = false
        panneau.orderOut(nil)
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func windowWillClose(_ notification: Notification) {
        if let w = notification.object as? NSWindow, w === panneau { restaurerFenetrePrincipale() }
    }

    // -------------------------------------------------- Attente : vérification réseau directe
    //
    // On ne compte plus du tout sur les callbacks de WebKit pour savoir si le serveur
    // est prêt (elles se sont montrées peu fiables pour ce cas précis). À la place,
    // on teste nous-mêmes une vraie connexion TCP au port du dashboard, et on ne
    // charge la page qu'une fois cette connexion confirmée.

    func attendreEtCharger() {
        verifierJoignable(port: port) { [weak self] joignable in
            guard let self = self else { return }
            if joignable {
                self.chargerDashboard()
                return
            }
            if !self.tentativeDemarrageFaite {
                self.tentativeDemarrageFaite = true
                self.demarrerMineurSiNecessaire()
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.attendreEtCharger()
            }
        }
    }

    func verifierJoignable(port: Int, completion: @escaping (Bool) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let sock = Darwin.socket(AF_INET, SOCK_STREAM, 0)
            guard sock >= 0 else { DispatchQueue.main.async { completion(false) }; return }
            defer { Darwin.close(sock) }
            var minuteur = timeval(tv_sec: 1, tv_usec: 0)
            setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &minuteur, socklen_t(MemoryLayout<timeval>.size))
            var addr = sockaddr_in()
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = in_port_t(port).bigEndian
            addr.sin_addr.s_addr = inet_addr("127.0.0.1")
            let resultat = withUnsafePointer(to: &addr) { ptr -> Int32 in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            DispatchQueue.main.async { completion(resultat == 0) }
        }
    }

    func afficherAttente(erreur: String? = nil) {
        let detail = erreur.map { "<br><span style=\"color:#e8b64a;font-size:9px\">\($0)</span>" } ?? ""
        let html = """
        <html><body style="margin:0;height:100vh;display:flex;align-items:center;
        justify-content:center;background:#07090c;color:#96f01f;
        font-family:ui-monospace,Menlo,monospace;font-size:13px;text-align:center;padding:20px">
        <div>⛏️ Démarrage d'AXECUBE…<br><span style="color:#6b7686;font-size:11px">
        Ça ne prend que quelques secondes.
        </span>\(detail)</div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // Selon la page affichée : le bouton retour n'apparaît que hors du dashboard
    // principal, et la fenêtre s'agrandit automatiquement pour les pages plus riches
    // en contenu (visite guidée, découvrir, soutenir...), puis revient à la taille
    // compacte en revenant sur le dashboard.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        let surDashboard = (webView.url?.path ?? "/") == "/"
        boutonRetour.isHidden = surDashboard
        ajusterTailleFenetre(agrandir: !surDashboard)
    }

    func ajusterTailleFenetre(agrandir: Bool) {
        let ecran = window.screen ?? NSScreen.main
        let visible = ecran?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 900)
        let cadreActuel = window.frame
        if agrandir {
            guard abs(cadreActuel.width - visible.width) > 1 else { return } // déjà plein écran
            window.setFrame(visible, display: true, animate: true)
        } else {
            let largeurCible: CGFloat = 420, hauteurCible: CGFloat = 800
            guard abs(cadreActuel.width - largeurCible) > 1 else { return }
            let nouveauCadre = NSRect(x: cadreActuel.midX - largeurCible / 2, y: cadreActuel.maxY - hauteurCible,
                                       width: largeurCible, height: hauteurCible)
            window.setFrame(nouveauCadre, display: true, animate: true)
        }
    }

    // -------------------------------------------------- alert()/confirm() JavaScript
    //
    // Par défaut, WKWebView ignore silencieusement alert()/confirm() -- ce qui rend
    // certains boutons du dashboard (comme le repli du mode panneau flottant, non
    // disponible dans ce moteur) invisibles/muets sans ce qui suit.

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alerte = NSAlert()
        alerte.messageText = "AXECUBE"
        alerte.informativeText = message
        alerte.addButton(withTitle: "OK")
        alerte.runModal()
        completionHandler()
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alerte = NSAlert()
        alerte.messageText = "AXECUBE"
        alerte.informativeText = message
        alerte.addButton(withTitle: "OK")
        alerte.addButton(withTitle: "Annuler")
        completionHandler(alerte.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alerte = NSAlert()
        alerte.messageText = "AXECUBE"
        alerte.informativeText = prompt
        alerte.addButton(withTitle: "OK")
        alerte.addButton(withTitle: "Annuler")
        let champ = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        champ.stringValue = defaultText ?? ""
        alerte.accessoryView = champ
        completionHandler(alerte.runModal() == .alertFirstButtonReturn ? champ.stringValue : nil)
    }

    // -------------------------------------------------- Téléchargements (export logs, carte de record)
    //
    // "Exporter les logs" et "Partager mon record" utilisent un lien <a download> --
    // sans ce qui suit, WKWebView ne sait pas où enregistrer le fichier et ne fait
    // rien de visible. On l'enregistre directement dans le dossier Téléchargements.

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                   suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dossierTelechargements = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        var destination = dossierTelechargements.appendingPathComponent(suggestedFilename)
        if FileManager.default.fileExists(atPath: destination.path) {
            let base = (suggestedFilename as NSString).deletingPathExtension
            let ext = (suggestedFilename as NSString).pathExtension
            var compteur = 2
            repeat {
                let nom = ext.isEmpty ? "\(base) (\(compteur))" : "\(base) (\(compteur)).\(ext)"
                destination = dossierTelechargements.appendingPathComponent(nom)
                compteur += 1
            } while FileManager.default.fileExists(atPath: destination.path)
        }
        completionHandler(destination)
    }
    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Glass")?.play()
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        afficherErreur("Échec de l'export :\n\(error.localizedDescription)")
    }

    // ---------------------------------------------------------------- Lancement du mineur

    func demarrerMineurSiNecessaire() {
        let dossier = dossierAxecube
        let cheminJs = dossier.appendingPathComponent("axecube.js")
        guard FileManager.default.fileExists(atPath: cheminJs.path) else {
            afficherErreur("« axecube.js » introuvable à côté de l'application.\n\n" +
                            "Place « AXECUBE Desktop.app » dans le même dossier que axecube.js.")
            return
        }
        guard let node = trouverNode() else {
            afficherErreurNode()
            return
        }

        var config = lireConfig(dossier: dossier)
        if config["ADRESSE"] == nil || config["ADRESSE"]!.isEmpty {
            guard let adresse = demanderAdresseBTC() else {
                afficherErreur("Une adresse Bitcoin est nécessaire pour miner.\nRelance l'application quand tu en as une.")
                return
            }
            config["ADRESSE"] = adresse
        }
        if config["WORKER"] == nil || config["WORKER"]!.isEmpty {
            let suggestion = Host.current().localizedName?
                .components(separatedBy: CharacterSet.alphanumerics.inverted).joined() ?? "mac"
            config["WORKER"] = demanderNomMineur(suggestion: suggestion) ?? suggestion
        }
        if config["POOLPRESET"] == nil {
            config["POOLPRESET"] = demanderPool()
        }
        if config["COEURS"] == nil { config["COEURS"] = String(max(1, ProcessInfo.processInfo.activeProcessorCount / 2)) }
        if config["RESEAU"] == nil { config["RESEAU"] = "btc" }
        if config["LAN"] == nil { config["LAN"] = "0" }
        ecrireConfig(dossier: dossier, config: config)

        port = trouverPortLibre()

        var args = [cheminJs.path, config["ADRESSE"]!,
                    "--threads", config["COEURS"]!,
                    "--port", String(port),
                    "--network", config["RESEAU"]!,
                    "--worker", config["WORKER"]!]
        if config["LAN"] == "1" { args.append("--lan") }
        if let preset = config["POOLPRESET"], !preset.isEmpty, preset != "defaut" {
            args.append(contentsOf: ["--pool-preset", preset])
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = args
        process.currentDirectoryURL = dossier
        let cheminLog = dossier.appendingPathComponent("axecube.log")
        if !FileManager.default.fileExists(atPath: cheminLog.path) {
            FileManager.default.createFile(atPath: cheminLog.path, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: cheminLog) {
            handle.seekToEndOfFile()
            process.standardOutput = handle
            process.standardError = handle
        }
        do {
            try process.run()
            mineurProcess = process
        } catch {
            afficherErreur("Impossible de démarrer AXECUBE :\n\(error.localizedDescription)")
        }
    }

    // Node.js n'est pas toujours dans le PATH d'une appli lancée en double-clic --
    // mêmes emplacements que ceux vérifiés par AXECUBE.command.
    func trouverNode() -> String? {
        for chemin in ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: chemin) { return chemin }
        }
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        which.arguments = ["node"]
        let pipe = Pipe()
        which.standardOutput = pipe
        which.standardError = Pipe()
        do {
            try which.run()
            which.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let chemin = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !chemin.isEmpty, FileManager.default.isExecutableFile(atPath: chemin) {
                return chemin
            }
        } catch { }
        return nil
    }

    func trouverPortLibre() -> Int {
        var p = PORT_DEPART
        while p <= PORT_MAX {
            if portEstLibre(p) { return p }
            p += 1
        }
        return PORT_DEPART
    }
    func portEstLibre(_ p: Int) -> Bool {
        let sock = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return true }
        defer { Darwin.close(sock) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(p).bigEndian
        addr.sin_addr.s_addr = INADDR_ANY
        let resultat = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return resultat == 0
    }

    // ------------------------------------------------------- .axecube-config (lecture/écriture)

    func lireConfig(dossier: URL) -> [String: String] {
        var resultat: [String: String] = [:]
        let chemin = dossier.appendingPathComponent(".axecube-config")
        guard let contenu = try? String(contentsOf: chemin, encoding: .utf8) else { return resultat }
        for ligne in contenu.split(separator: "\n") {
            let parties = ligne.split(separator: "=", maxSplits: 1)
            guard parties.count == 2 else { continue }
            resultat[String(parties[0])] = String(parties[1]).trimmingCharacters(in: .whitespaces)
        }
        return resultat
    }
    func ecrireConfig(dossier: URL, config: [String: String]) {
        let chemin = dossier.appendingPathComponent(".axecube-config")
        let cles = ["ADRESSE", "COEURS", "LAN", "RESEAU", "WORKER", "POOLPRESET"]
        let lignes = cles.compactMap { cle -> String? in
            guard let v = config[cle] else { return nil }
            return "\(cle)=\(v)"
        }
        try? lignes.joined(separator: "\n").write(to: chemin, atomically: true, encoding: .utf8)
    }

    // ------------------------------------------------------------------- Dialogues natifs

    func demanderAdresseBTC() -> String? {
        let alerte = NSAlert()
        alerte.messageText = "Où envoyer la récompense ?"
        alerte.informativeText = "Colle ton adresse Bitcoin (commence par bc1, 1 ou 3).\nUtilise une adresse dont tu détiens les clés."
        alerte.addButton(withTitle: "Continuer")
        alerte.addButton(withTitle: "Annuler")
        let champ = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        champ.placeholderString = "bc1..."
        alerte.accessoryView = champ
        alerte.window.initialFirstResponder = champ
        let reponse = alerte.runModal()
        guard reponse == .alertFirstButtonReturn else { return nil }
        let adresse = champ.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return adresse.isEmpty ? nil : adresse
    }

    func demanderNomMineur(suggestion: String) -> String? {
        let alerte = NSAlert()
        alerte.messageText = "Quel nom donner à cette machine ?"
        alerte.informativeText = "Sert à la distinguer sur le pool et le classement communautaire."
        alerte.addButton(withTitle: "Continuer")
        alerte.addButton(withTitle: "Utiliser la suggestion")
        let champ = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        champ.stringValue = suggestion
        alerte.accessoryView = champ
        alerte.window.initialFirstResponder = champ
        alerte.runModal()
        let nom = champ.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-")).inverted).joined()
        return nom.isEmpty ? suggestion : nom
    }

    func demanderPool() -> String {
        let alerte = NSAlert()
        alerte.messageText = "Quel pool utiliser ?"
        alerte.informativeText = "Tu pourras en changer à tout moment depuis le tableau de bord."
        alerte.addButton(withTitle: "Continuer")
        let options = [
            ("Par défaut — public-pool.io, 0% de frais", ""),
            ("Braiins Solo — aucun compte requis, 0,5% de frais", "braiins-solo"),
            ("CKPool — actif depuis 2014, 2% de frais", "ckpool"),
            ("Mineshop.eu — aucun compte requis, 0% de frais", "mineshop-solo"),
        ]
        let menu = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 340, height: 26))
        for (libelle, _) in options { menu.addItem(withTitle: libelle) }
        alerte.accessoryView = menu
        alerte.runModal()
        let indice = menu.indexOfSelectedItem
        return (indice >= 0 && indice < options.count) ? options[indice].1 : ""
    }

    func afficherErreurNode() {
        let alerte = NSAlert()
        alerte.messageText = "Node.js est introuvable"
        alerte.informativeText = "AXECUBE a besoin de Node.js pour fonctionner (gratuit, 2 minutes à installer).\nTélécharge la version LTS sur nodejs.org, installe-la, puis relance AXECUBE."
        alerte.addButton(withTitle: "Ouvrir nodejs.org")
        alerte.addButton(withTitle: "Fermer")
        if alerte.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.open(URL(string: "https://nodejs.org")!)
        }
    }
    func afficherErreur(_ message: String) {
        let alerte = NSAlert()
        alerte.messageText = "AXECUBE"
        alerte.informativeText = message
        alerte.addButton(withTitle: "OK")
        alerte.runModal()
    }

    // ---------------------------------------------------------------- Menu

    func construireMenu() {
        let menubar = NSMenu()
        let appMenuItem = NSMenuItem()
        menubar.addItem(appMenuItem)
        NSApp.mainMenu = menubar
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Recharger", action: #selector(recharger), keyEquivalent: "r")
        let retour = NSMenuItem(title: "Retour au tableau de bord", action: #selector(retourDashboard), keyEquivalent: "\u{2190}")
        retour.keyEquivalentModifierMask = [.command]
        appMenu.addItem(retour)
        appMenu.addItem(withTitle: "Mode compact", action: #selector(basculerModeCompact), keyEquivalent: "k")
        appMenu.addItem(withTitle: "Agrandir / réduire la fenêtre", action: #selector(basculerTailleFenetre), keyEquivalent: "=")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quitter AXECUBE", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
    }
    @objc func recharger() { attendreEtCharger() }
    // Retour arrière si possible (visite guidée, découvrir, soutenir...), sinon on
    // revient directement au dashboard principal -- jamais besoin de fermer l'appli.
    @objc func retourDashboard() {
        if webView.canGoBack {
            webView.goBack()
        } else {
            chargerDashboard()
        }
    }
    // Bascule entre la taille compacte habituelle et une taille plus large, pratique
    // pour lire les pages plus riches en contenu (visite guidée, découvrir...).
    @objc func basculerTailleFenetre() {
        ajusterTailleFenetre(agrandir: window.frame.width < 700)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
