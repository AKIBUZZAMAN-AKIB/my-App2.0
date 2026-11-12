import UIKit
import WebKit
import UniformTypeIdentifiers

final class IsolatedSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL
    private let entry: String
    private let host: String
    private let csp: String

    init(root: URL, entry: String, host: String, allowedHosts: [String], allowDirectNetwork: Bool, networkMode: String) {
        self.root = root
        self.entry = entry
        self.host = host
        if networkMode == "full" {
            // Owner-approved full internet: open HTTPS/WSS + form posts; everything else stays locked.
            self.csp = [
                "default-src 'self' data: blob:",
                "script-src 'self' 'unsafe-inline' data: blob:",
                "style-src 'self' 'unsafe-inline' data: blob:",
                "img-src 'self' data: blob: https:",
                "font-src 'self' data: blob: https:",
                "media-src 'self' data: blob: https:",
                "connect-src 'self' https: wss: data: blob:",
                "worker-src 'self' blob: data:",
                "frame-src 'self' data: blob: https:",
                "object-src 'none'",
                "base-uri 'none'",
                "form-action 'self' https:"
            ].joined(separator: "; ")
        } else {
            let httpsSources = (allowDirectNetwork && networkMode == "hosts") ? allowedHosts.map { "https://\($0)" }.joined(separator: " ") : ""
            let wssSources = (allowDirectNetwork && networkMode == "hosts") ? allowedHosts.map { "wss://\($0)" }.joined(separator: " ") : ""
            self.csp = [
                "default-src 'self' data: blob:",
                "script-src 'self' 'unsafe-inline' data: blob:",
                "style-src 'self' 'unsafe-inline' data: blob:",
                "img-src 'self' data: blob: \(httpsSources)",
                "font-src 'self' data: blob:",
                "media-src 'self' data: blob: \(httpsSources)",
                "connect-src 'self' \(httpsSources) \(wssSources)",
                "worker-src 'self' blob:",
                "frame-src 'self' data: blob:",
                "object-src 'none'",
                "base-uri 'none'",
                "form-action 'none'"
            ].joined(separator: "; ")
        }
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url,
              requestURL.scheme?.lowercased() == "nativekit-app",
              requestURL.host?.lowercased() == host.lowercased() else {
            fail(urlSchemeTask, "Invalid package origin", code: 403)
            return
        }
        do {
            let decoded = requestURL.path.removingPercentEncoding ?? requestURL.path
            let path = decoded.trimmingCharacters(in: CharacterSet(charactersIn: "/")).isEmpty ? entry : decoded.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let file = try IsolatedAppStore.resolve(root, path)
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else { throw NSError(domain: "NativeKitScheme", code: 404, userInfo: nil) }
            var data = try Data(contentsOf: file, options: [.mappedIfSafe])
            let type = UTType(filenameExtension: file.pathExtension)
            let mime = type?.preferredMIMEType ?? fallbackMime(file.pathExtension)
            if mime == "text/html" {
                guard var html = String(data: data, encoding: .utf8) else {
                    throw NSError(domain: "NativeKitScheme", code: 415, userInfo: [NSLocalizedDescriptionKey: "Package HTML must be UTF-8"])
                }
                let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(escapeAttribute(csp))\">"
                // The policy must precede every package script; prepending lets the HTML parser create an implicit head even for malformed documents.
                html = meta + html
                data = Data(html.utf8)
            }
            let response = URLResponse(url: requestURL, mimeType: mime, expectedContentLength: data.count, textEncodingName: mime.hasPrefix("text/") || mime.contains("javascript") || mime.contains("json") ? "utf-8" : nil)
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch {
            let nativeError = error as NSError
            fail(urlSchemeTask, nativeError.localizedDescription.isEmpty ? "Package resource not found" : nativeError.localizedDescription, code: nativeError.domain == "NativeKitScheme" ? nativeError.code : 404)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func fail(_ task: WKURLSchemeTask, _ message: String, code: Int) {
        task.didFailWithError(NSError(domain: "NativeKitScheme", code: code, userInfo: [NSLocalizedDescriptionKey: message]))
    }

    private func fallbackMime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "js", "mjs": return "text/javascript"
        case "json": return "application/json"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        default: return "application/octet-stream"
        }
    }

    private func escapeAttribute(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;")
    }
}

private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var owner: IsolatedBrowserViewController?
    init(_ owner: IsolatedBrowserViewController) { self.owner = owner }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.receive(message)
    }
}

final class IsolatedBrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private static let rpcChannel = "nativekit-app-browser-v1"

    let sessionId: String
    let appId: String
    let token: String
    let originHost: String
    var onRequest: ((String, String) -> Void)?
    var onStatus: ((String, String) -> Void)?
    var onClose: (() -> Void)?

    private let packageRoot: URL
    private let entry: String
    private let bootstrap: String
    private let allowedHosts: [String]
    private let allowDirectNetwork: Bool
    private let networkMode: String
    private let mediaAutoplay: Bool
    private let hangTerminationDelay: TimeInterval
    private var webView: WKWebView!
    private var schemeHandler: IsolatedSchemeHandler!
    private var scriptHandler: WeakScriptHandler!
    private var processReloads = 0
    private var watchdogTimer: Timer?
    private var heartbeatStartedAt: TimeInterval?
    private var heartbeatGeneration = 0
    private var recoveryView: UIView?

    init(sessionId: String, appId: String, token: String, title: String, packageRoot: URL, entry: String, bootstrap: String, allowedHosts: [String], allowDirectNetwork: Bool, networkMode: String, mediaAutoplay: Bool, hangTerminationDelayMs: Int) {
        self.sessionId = sessionId
        self.appId = appId
        self.token = token
        self.packageRoot = packageRoot
        self.entry = entry
        self.bootstrap = bootstrap
        self.allowedHosts = allowedHosts
        self.allowDirectNetwork = allowDirectNetwork
        self.networkMode = ["sandboxed", "hosts", "full"].contains(networkMode) ? networkMode : (allowDirectNetwork ? "hosts" : "sandboxed")
        self.mediaAutoplay = mediaAutoplay
        self.hangTerminationDelay = TimeInterval(max(1_000, min(30_000, hangTerminationDelayMs))) / 1_000
        self.originHost = IsolatedAppStore.originHost(appId)
        super.init(nibName: nil, bundle: nil)
        self.title = title
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .close, target: self, action: #selector(closeTapped))
        NotificationCenter.default.addObserver(self, selector: #selector(applicationDidEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(applicationWillEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
        createWebView()
    }

    private func createWebView() {
        stopWatchdog()
        recoveryView?.removeFromSuperview()
        recoveryView = nil
        if let previous = webView {
            previous.navigationDelegate = nil
            previous.uiDelegate = nil
            previous.configuration.userContentController.removeScriptMessageHandler(forName: "NativeKitIsolatedTransport")
            previous.stopLoading()
            previous.removeFromSuperview()
        }

        let configuration = WKWebViewConfiguration()
        configuration.processPool = WKProcessPool()
        if #available(iOS 17.0, *) {
            configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: IsolatedAppStore.profileIdentifier(appId))
        } else {
            // iOS 15–16 has no public persistent per-app store. Ephemeral storage preserves isolation rather than silently sharing host/app data.
            configuration.websiteDataStore = .nonPersistent()
        }
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = false
        configuration.mediaTypesRequiringUserActionForPlayback = mediaAutoplay ? [] : .all
        schemeHandler = IsolatedSchemeHandler(root: packageRoot, entry: entry, host: originHost, allowedHosts: allowedHosts, allowDirectNetwork: allowDirectNetwork, networkMode: networkMode)
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: "nativekit-app")

        let content = WKUserContentController()
        scriptHandler = WeakScriptHandler(self)
        content.add(scriptHandler, name: "NativeKitIsolatedTransport")
        let adapter = """
        (()=>{const h=window.webkit?.messageHandlers?.NativeKitIsolatedTransport;if(!h)return;const t={onmessage:null,postMessage:v=>h.postMessage(v)};Object.defineProperty(window,'NativeKitIsolatedTransport',{value:t,writable:false,configurable:false});})();
        """
        let cookieShim = """
        (()=>{if(location.protocol!=='nativekit-app:')return;const key='__nativekit_cookie_jar_v1';const read=()=>{try{return JSON.parse(localStorage.getItem(key)||'{}')}catch{return {}}};try{Object.defineProperty(Document.prototype,'cookie',{configurable:true,get(){const now=Date.now(),jar=read(),out=[];for(const [name,item] of Object.entries(jar)){if(item.expires&&item.expires<=now){delete jar[name];continue}out.push(name+'='+item.value)}localStorage.setItem(key,JSON.stringify(jar));return out.join('; ')},set(input){const parts=String(input).split(';').map(v=>v.trim()),pair=parts.shift()||'',at=pair.indexOf('=');if(at<1)return;const name=pair.slice(0,at),value=pair.slice(at+1),jar=read(),item={value};for(const part of parts){const [k,...rest]=part.split('='),v=rest.join('=');if(k.toLowerCase()==='max-age')item.expires=Date.now()+Number(v)*1000;if(k.toLowerCase()==='expires')item.expires=Date.parse(v)}if(item.expires&&item.expires<=Date.now())delete jar[name];else jar[name]=item;localStorage.setItem(key,JSON.stringify(jar))}})}catch{}})();
        """
        content.addUserScript(WKUserScript(source: adapter + cookieShim + bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController = content

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        guard let url = URL(string: "nativekit-app://\(originHost)/\(entry)") else { return }
        onStatus?("loading", url.absoluteString)
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        startWatchdog()
    }

    private func startWatchdog() {
        stopWatchdog()
        let interval = max(0.25, min(1.0, hangTerminationDelay / 4.0))
        watchdogTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.watchdogTick()
        }
    }

    private func stopWatchdog() {
        watchdogTimer?.invalidate()
        watchdogTimer = nil
        heartbeatStartedAt = nil
        heartbeatGeneration += 1
    }

    @objc private func applicationDidEnterBackground() { stopWatchdog() }

    @objc private func applicationWillEnterForeground() {
        if webView != nil && recoveryView == nil { startWatchdog() }
    }

    private func watchdogTick() {
        guard UIApplication.shared.applicationState == .active else {
            heartbeatStartedAt = nil
            heartbeatGeneration += 1
            return
        }
        guard let current = webView else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let started = heartbeatStartedAt {
            guard now - started >= hangTerminationDelay else { return }
            stopWatchdog()
            onStatus?("rendererUnresponsive", "WebKit content process missed the NativeKit heartbeat")
            onStatus?("rendererGone", "unresponsive WebKit content process was detached and replaced")
            if processReloads < 1 {
                processReloads += 1
                createWebView()
            } else {
                showRecovery()
            }
            return
        }
        heartbeatStartedAt = now
        heartbeatGeneration += 1
        let generation = heartbeatGeneration
        current.evaluateJavaScript("void 0") { [weak self, weak current] _, _ in
            guard let self, let current, self.webView === current, self.heartbeatGeneration == generation else { return }
            self.heartbeatStartedAt = nil
        }
    }

    func receive(_ message: WKScriptMessage) {
        guard message.name == "NativeKitIsolatedTransport",
              message.frameInfo.isMainFrame,
              message.webView === webView,
              message.frameInfo.securityOrigin.protocol.lowercased() == "nativekit-app",
              message.frameInfo.securityOrigin.host.lowercased() == originHost.lowercased(),
              let body = message.body as? String,
              body.utf8.count <= 2_800_000,
              let data = body.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["channel"] as? String == Self.rpcChannel,
              constantTimeEquals(token, object["token"] as? String ?? "") else {
            onStatus?("protocolError", "Rejected unauthenticated WebKit message")
            return
        }
        onRequest?(body, "nativekit-app://\(originHost)")
    }

    func postMessage(_ message: String, completion: @escaping (Error?) -> Void) {
        guard message.utf8.count <= 2_800_000,
              let data = message.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              JSONSerialization.isValidJSONObject(object),
              let normalized = try? JSONSerialization.data(withJSONObject: object),
              normalized.count <= 2_800_000,
              let json = String(data: normalized, encoding: .utf8) else {
            completion(NSError(domain: "NativeKitIsolatedBrowser", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid response envelope"]))
            return
        }
        webView.evaluateJavaScript("window.__NativeKitIsolatedReceive?.(\(json));") { _, error in completion(error) }
    }

    func close(completion: (() -> Void)? = nil) {
        stopWatchdog()
        dismiss(animated: true) { [weak self] in
            self?.disposeWebView()
            completion?()
        }
    }

    @objc private func closeTapped() { close() }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || navigationController?.isBeingDismissed == true {
            disposeWebView()
            onStatus?("closed", "isolated view closed")
            onClose?()
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.targetFrame?.isMainFrame != false, let url = navigationAction.request.url else { decisionHandler(.allow); return }
        let local = url.scheme?.lowercased() == "nativekit-app" && url.host?.lowercased() == originHost.lowercased()
        let remoteAllowed = networkMode == "full" && url.scheme?.lowercased() == "https"
        if local || remoteAllowed { decisionHandler(.allow) }
        else {
            onStatus?("navigationBlocked", url.absoluteString)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        processReloads = 0
        onStatus?("ready", "nativekit-app://\(originHost)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        stopWatchdog()
        onStatus?("rendererGone", "WebKit web content process terminated")
        if processReloads < 1 {
            processReloads += 1
            createWebView()
        } else {
            showRecovery()
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        onStatus?("navigationBlocked", navigationAction.request.url?.absoluteString ?? "popup")
        return nil
    }

    private func showRecovery() {
        stopWatchdog()
        webView?.removeFromSuperview()
        let panel = UIStackView()
        panel.axis = .vertical
        panel.alignment = .center
        panel.spacing = 18
        panel.translatesAutoresizingMaskIntoConstraints = false
        let label = UILabel()
        label.text = "The isolated web renderer stopped. You can retry without restarting the host app."
        label.numberOfLines = 0
        label.textAlignment = .center
        let retry = UIButton(type: .system)
        retry.setTitle("Reload isolated app", for: .normal)
        retry.addTarget(self, action: #selector(retryRenderer), for: .touchUpInside)
        panel.addArrangedSubview(label)
        panel.addArrangedSubview(retry)
        view.addSubview(panel)
        recoveryView = panel
        NSLayoutConstraint.activate([
            panel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28),
            panel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28),
            panel.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }

    @objc private func retryRenderer() {
        processReloads = 0
        createWebView()
    }

    private func disposeWebView() {
        stopWatchdog()
        recoveryView?.removeFromSuperview()
        recoveryView = nil
        guard let current = webView else { return }
        current.navigationDelegate = nil
        current.uiDelegate = nil
        current.configuration.userContentController.removeScriptMessageHandler(forName: "NativeKitIsolatedTransport")
        current.stopLoading()
        current.removeFromSuperview()
        webView = nil
        schemeHandler = nil
        scriptHandler = nil
    }

    deinit {
        watchdogTimer?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    private func constantTimeEquals(_ left: String, _ right: String) -> Bool {
        let a = Array(left.utf8), b = Array(right.utf8)
        var difference = a.count ^ b.count
        for index in 0..<max(a.count, b.count) { difference |= Int(index < a.count ? a[index] : 0) ^ Int(index < b.count ? b[index] : 0) }
        return difference == 0
    }
}
