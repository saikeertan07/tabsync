import Cocoa
import WebKit

class ScriptHandler: NSObject, WKScriptMessageHandler {
    weak var appDelegate: AppDelegate?
    
    init(appDelegate: AppDelegate) {
        self.appDelegate = appDelegate
    }
    
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let dict = message.body as? [String: Any],
              let action = dict["action"] as? String else { return }
        
        DispatchQueue.main.async { [weak self] in
            guard let delegate = self?.appDelegate else { return }
            switch action {
            case "quit":
                NSApp.terminate(nil)
                
            case "resizeWidget":
                if let height = dict["height"] as? CGFloat {
                    delegate.setWidgetHeight(height)
                }
                
            case "screenshot":
                delegate.takeScreenshot()
                
            case "toggleOverlay":
                delegate.toggleOverlayVisibility()
                
            case "openAccessibility":
                delegate.openAccessibilitySettings()
                
            case "hostApi":
                if let reqId = dict["reqId"] as? String,
                   let endpoint = dict["endpoint"] as? String {
                    let method = (dict["method"] as? String) ?? "GET"
                    let body = dict["body"] as? [String: Any]
                    delegate.executeHostApi(reqId: reqId, endpoint: endpoint, method: method, body: body)
                }
                
            default:
                break
            }
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, URLSessionDelegate {
    var canvasWindow: NSWindow!
    var widgetWindow: NSWindow!
    var canvasWebView: WKWebView!
    var widgetWebView: WKWebView!
    var serverProcess: Process?
    var statusItem: NSStatusItem?
    var isOverlayVisible: Bool = true
    let defaultWidgetHeight: CGFloat = 68
    var currentWidgetHeight: CGFloat = 68
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        
        cleanupOrphans()
        startServer()
        setupWindows()
        setupStatusItem()
        setupMainMenu()
        loadWebViews()
    }
    
    func cleanupOrphans() {
        // Clean up any stale instances holding port 4444 or old mac-input
        let p = Process()
        p.launchPath = "/bin/sh"
        p.arguments = ["-c", "lsof -ti:4444 | xargs kill -9 2>/dev/null; pkill -9 -f 'mac-input' 2>/dev/null"]
        try? p.run()
        p.waitUntilExit()
    }
    
    func setupWindows() {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let screenRect = screen.frame
        
        // 1. Transparent Full-Screen Canvas Overlay (Always click-through: ZERO freeze, all Mac apps work 100%!)
        canvasWindow = NSWindow(
            contentRect: screenRect,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        canvasWindow.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.floatingWindow)) - 1)
        canvasWindow.backgroundColor = .clear
        canvasWindow.isOpaque = false
        canvasWindow.hasShadow = false
        canvasWindow.ignoresMouseEvents = true // Clicks pass through completely to Chrome, Safari, Desktop!
        canvasWindow.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        
        let canvasConfig = WKWebViewConfiguration()
        canvasConfig.preferences.setValue(true, forKey: "developerExtrasEnabled")
        canvasWebView = WKWebView(frame: NSRect(origin: .zero, size: screenRect.size), configuration: canvasConfig)
        canvasWebView.navigationDelegate = self
        canvasWebView.autoresizingMask = [.width, .height]
        canvasWebView.setValue(false, forKey: "drawsBackground")
        
        canvasWindow.contentView?.addSubview(canvasWebView)
        canvasWindow.orderFront(nil)
        
        // 2. Compact Draggable Floating Widget Toolbar
        let widgetW: CGFloat = 590
        let widgetH: CGFloat = defaultWidgetHeight
        let widgetX = (screenRect.width - widgetW) / 2 + screenRect.origin.x
        let widgetY = screenRect.origin.y + screenRect.height - widgetH - 45
        let widgetRect = NSRect(x: widgetX, y: widgetY, width: widgetW, height: widgetH)
        
        widgetWindow = NSWindow(
            contentRect: widgetRect,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        widgetWindow.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.floatingWindow)) + 1)
        widgetWindow.backgroundColor = .clear
        widgetWindow.isOpaque = false
        widgetWindow.hasShadow = true
        widgetWindow.isMovableByWindowBackground = true // Click and drag widget anywhere on screen!
        widgetWindow.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        widgetWindow.delegate = self
        
        let widgetConfig = WKWebViewConfiguration()
        widgetConfig.userContentController.add(ScriptHandler(appDelegate: self), name: "tabSync")
        // No host secret injection into DOM: administrative calls are mediated securely via native ScriptHandler IPC
        widgetWebView = WKWebView(frame: NSRect(origin: .zero, size: widgetRect.size), configuration: widgetConfig)
        widgetWebView.navigationDelegate = self
        widgetWebView.autoresizingMask = [.width, .height]
        widgetWebView.setValue(false, forKey: "drawsBackground")
        
        widgetWindow.contentView?.addSubview(widgetWebView)
        widgetWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    
    func setWidgetHeight(_ height: CGFloat) {
        currentWidgetHeight = height
        guard let window = widgetWindow else { return }
        var frame = window.frame
        let diff = height - frame.size.height
        frame.size.height = height
        frame.origin.y -= diff // grow downward
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.2
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            window.animator().setFrame(frame, display: true)
        }
    }
    
    func takeScreenshot() {
        let task = Process()
        task.launchPath = "/usr/sbin/screencapture"
        let timestamp = Int(Date().timeIntervalSince1970)
        let desktopPath = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop").path
        let filePath = "\(desktopPath)/TabSync_Annotation_\(timestamp).png"
        task.arguments = ["-c", filePath] // copies to clipboard AND saves to Desktop
        try? task.run()
        
        NSSound(named: "Glass")?.play()
    }
    
    func toggleOverlayVisibility() {
        isOverlayVisible.toggle()
        if isOverlayVisible {
            canvasWindow.orderFront(nil)
        } else {
            canvasWindow.orderOut(nil)
        }
    }
    
    func openAccessibilitySettings() {
        // Trigger system permission prompt if not yet requested
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let _ = AXIsProcessTrustedWithOptions(options)
        
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }
    
    func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem?.button {
            button.title = "⚡ TabSync"
        }
        
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "TabSync Studio v1.0.0", action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        
        let showItem = NSMenuItem(title: "Show Floating Toolbar", action: #selector(showWidgetAction), keyEquivalent: "w")
        showItem.target = self
        menu.addItem(showItem)
        
        let snapItem = NSMenuItem(title: "Capture Screen Annotation", action: #selector(screenshotAction), keyEquivalent: "4")
        snapItem.keyEquivalentModifierMask = [.command, .shift]
        snapItem.target = self
        menu.addItem(snapItem)
        
        let clearItem = NSMenuItem(title: "Clear Screen Drawings", action: #selector(clearDrawingsAction), keyEquivalent: "k")
        clearItem.keyEquivalentModifierMask = [.command]
        clearItem.target = self
        menu.addItem(clearItem)
        
        menu.addItem(NSMenuItem.separator())
        
        let eStopItem = NSMenuItem(title: "⚠️ Emergency Stop (Halt Remote Input)", action: #selector(emergencyStopAction), keyEquivalent: ".")
        eStopItem.keyEquivalentModifierMask = [.command]
        eStopItem.target = self
        menu.addItem(eStopItem)
        
        let resumeItem = NSMenuItem(title: "▶️ Resume Remote Input", action: #selector(emergencyResumeAction), keyEquivalent: "")
        resumeItem.target = self
        menu.addItem(resumeItem)
        
        menu.addItem(NSMenuItem.separator())
        
        let permItem = NSMenuItem(title: "Check Accessibility Permissions...", action: #selector(openPermsAction), keyEquivalent: "")
        permItem.target = self
        menu.addItem(permItem)
        
        menu.addItem(NSMenuItem.separator())
        
        let quitItem = NSMenuItem(title: "Quit TabSync Studio", action: #selector(quitAppAction), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        
        statusItem?.menu = menu
    }
    
    @objc func showWidgetAction() {
        widgetWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    
    @objc func screenshotAction() {
        takeScreenshot()
    }
    
    func getHostSession() -> (port: Int, secret: String) {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let sessionFile = home.appendingPathComponent(".tabsync/host_session.json")
        if let data = try? Data(contentsOf: sessionFile),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let port = (json["port"] as? Int) ?? 4444
            let secret = (json["hostSecret"] as? String) ?? ""
            return (port, secret)
        }
        return (4444, "")
    }
    
    func getServerPort() -> Int {
        return getHostSession().port
    }
    
    func getSecureUrlSession() -> URLSession {
        return URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    }

    func executeHostApi(reqId: String, endpoint: String, method: String, body: [String: Any]?) {
        let session = getHostSession()
        guard let url = URL(string: "https://localhost:\(session.port)\(endpoint)") else {
            notifyHostApiResult(reqId: reqId, success: false, json: "{}", error: "Invalid URL")
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !session.secret.isEmpty {
            req.setValue(session.secret, forHTTPHeaderField: "X-TabSync-Host-Secret")
        }
        if let body = body, let bodyData = try? JSONSerialization.data(withJSONObject: body) {
            req.httpBody = bodyData
        }
        
        let urlSession = getSecureUrlSession()
        urlSession.dataTask(with: req) { [weak self] data, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    self?.notifyHostApiResult(reqId: reqId, success: false, json: "{}", error: error.localizedDescription)
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if status >= 200 && status < 300, let data = data, let str = String(data: data, encoding: .utf8) {
                    self?.notifyHostApiResult(reqId: reqId, success: true, json: str, error: "")
                } else {
                    let errMsg = "HTTP status \(status)"
                    self?.notifyHostApiResult(reqId: reqId, success: false, json: "{}", error: errMsg)
                }
            }
        }.resume()
    }

    func notifyHostApiResult(reqId: String, success: Bool, json: String, error: String) {
        let cleanJson = json.isEmpty ? "{}" : json
        let cleanErr = error.replacingOccurrences(of: "'", with: "\\'")
        let js = "if (window.__handleHostIpcResponse) { window.__handleHostIpcResponse('\(reqId)', \(success), \(cleanJson), '\(cleanErr)'); }"
        widgetWebView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // WKNavigationDelegate: Strict destination lockdown
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let isLoopback = (url.host == "localhost" || url.host == "127.0.0.1")
        let isServerPort = (url.port == getServerPort())
        let isAllowedScheme = (url.scheme == "https" || url.scheme == "http")
        if isLoopback && isServerPort && isAllowedScheme {
            decisionHandler(.allow)
        } else {
            print("[Security] Blocked unauthorized macOS WebView navigation to: \(url)")
            decisionHandler(.cancel)
        }
    }

    // Handle local self-signed TLS challenge for localhost in WKWebView
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let serverTrust = challenge.protectionSpace.serverTrust,
           let host = challenge.protectionSpace.host as String?,
           (host == "localhost" || host == "127.0.0.1") {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
            return
        }
        completionHandler(.performDefaultHandling, nil)
    }

    // Handle local self-signed TLS challenge for localhost in URLSession
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let serverTrust = challenge.protectionSpace.serverTrust,
           let host = challenge.protectionSpace.host as String?,
           (host == "localhost" || host == "127.0.0.1") {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
            return
        }
        completionHandler(.performDefaultHandling, nil)
    }

    @objc func clearDrawingsAction() {
        canvasWebView.evaluateJavaScript("window.postMessage({ type: 'clear' }, '*');", completionHandler: nil)
        let session = getHostSession()
        guard let url = URL(string: "https://localhost:\(session.port)/api/canvas/clear") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        if !session.secret.isEmpty {
            req.setValue(session.secret, forHTTPHeaderField: "X-TabSync-Host-Secret")
        }
        getSecureUrlSession().dataTask(with: req).resume()
    }
    
    @objc func emergencyStopAction() {
        let session = getHostSession()
        guard let url = URL(string: "https://localhost:\(session.port)/api/emergency_stop") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        if !session.secret.isEmpty {
            req.setValue(session.secret, forHTTPHeaderField: "X-TabSync-Host-Secret")
        }
        getSecureUrlSession().dataTask(with: req).resume()
    }
    
    @objc func emergencyResumeAction() {
        let session = getHostSession()
        guard let url = URL(string: "https://localhost:\(session.port)/api/emergency_resume") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        if !session.secret.isEmpty {
            req.setValue(session.secret, forHTTPHeaderField: "X-TabSync-Host-Secret")
        }
        getSecureUrlSession().dataTask(with: req).resume()
    }
    
    @objc func openPermsAction() {
        openAccessibilitySettings()
    }
    
    @objc func quitAppAction() {
        NSApp.terminate(nil)
    }
    
    func setupMainMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        
        appMenu.addItem(withTitle: "About TabSync Studio", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide TabSync Studio", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit TabSync Studio", action: #selector(quitAppAction), keyEquivalent: "q")
        
        NSApp.mainMenu = mainMenu
    }
    
    func findNodeExecutable() -> String? {
        // 1. Check bundled runtime inside App Bundle Contents/MacOS/node or Contents/Resources/node
        if let macosDir = Bundle.main.executableURL?.deletingLastPathComponent().path {
            let bundledNode = macosDir + "/node"
            if FileManager.default.isExecutableFile(atPath: bundledNode) {
                return bundledNode
            }
        }
        if let resDir = Bundle.main.resourceURL?.path {
            let bundledNode = resDir + "/node"
            if FileManager.default.isExecutableFile(atPath: bundledNode) {
                return bundledNode
            }
        }
        
        // 2. Check standard system locations
        let candidates = [
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/bin/node"
        ]
        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }
        return nil
    }
    
    func startServer() {
        guard let nodePath = findNodeExecutable() else {
            print("Node.js runtime not found.")
            return
        }
        
        var serverDir = Bundle.main.resourceURL?.appendingPathComponent("app").path ?? ""
        if !FileManager.default.fileExists(atPath: serverDir + "/server.js") {
            serverDir = "/Users/tedlasaikeertan/.gemini/antigravity/scratch/tabsync-app"
        }
        
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = ["server.js"]
        process.currentDirectoryURL = URL(fileURLWithPath: serverDir)
        
        do {
            try process.run()
            self.serverProcess = process
            print("TabSync server started PID: \(process.processIdentifier)")
        } catch {
            print("Could not start server process: \(error)")
        }
    }
    
    func loadWebViews() {
        var attempts = 0
        func tryLoad() {
            attempts += 1
            let port = getServerPort()
            guard let url = URL(string: "https://localhost:\(port)/overlay") else { return }
            var request = URLRequest(url: url)
            request.timeoutInterval = 0.8
            
            let task = getSecureUrlSession().dataTask(with: request) { [weak self] (_, response, error) in
                if error == nil && (response as? HTTPURLResponse)?.statusCode == 200 {
                    DispatchQueue.main.async {
                        guard let self = self else { return }
                        let currentSession = self.getHostSession()
                        self.canvasWebView.load(URLRequest(url: URL(string: "https://localhost:\(currentSession.port)/overlay")!))
                        self.widgetWebView.load(URLRequest(url: URL(string: "https://localhost:\(currentSession.port)/widget")!))
                    }
                } else if attempts < 20 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        tryLoad()
                    }
                } else {
                    DispatchQueue.main.async {
                        guard let self = self else { return }
                        let currentSession = self.getHostSession()
                        self.canvasWebView.load(URLRequest(url: URL(string: "https://localhost:\(currentSession.port)/overlay")!))
                        self.widgetWebView.load(URLRequest(url: URL(string: "https://localhost:\(currentSession.port)/widget")!))
                    }
                }
            }
            task.resume()
        }
        tryLoad()
    }
    
    func windowWillClose(_ notification: Notification) {
        if let window = notification.object as? NSWindow, window == widgetWindow {
            NSApp.terminate(nil)
        }
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
        serverProcess?.waitUntilExit()
        cleanupOrphans()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
