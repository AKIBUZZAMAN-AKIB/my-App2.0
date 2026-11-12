import UIKit
import WebKit

/// Browser-only HTTPS surface. No NativeKit bootstrap, WKScriptMessageHandler, or injected user script is installed.
final class RemoteBrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    let sessionId: String
    private let startURL: URL
    private let allowedHosts: Set<String>
    private var webView: WKWebView?
    var onStatus: ((String, String) -> Void)?
    var onClose: (() -> Void)?
    private var closed = false

    init(sessionId: String, title: String, url: URL, allowedHosts: [String]) throws {
        self.sessionId = sessionId
        self.startURL = url
        var rules = Set(try allowedHosts.map(Self.validateRule))
        if rules.isEmpty { rules.insert(Self.hostAndPort(url)) }
        self.allowedHosts = rules
        super.init(nibName: nil, bundle: nil)
        self.title = title.isEmpty ? url.host : title
        guard isAllowed(url) else { throw Self.error("Initial URL host is not allowed") }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Back", style: .plain, target: self, action: #selector(goBack))
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Close", style: .done, target: self, action: #selector(closeTapped))
        let configuration = WKWebViewConfiguration()
        if #available(iOS 17.0, *) {
            // Persist normal browser cookies/storage without sharing the trusted host's default store.
            configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: IsolatedAppStore.remoteProfileIdentifier)
        } else {
            // iOS 15–16 has no public arbitrary named persistent store. Keep browser storage usable.
            configuration.websiteDataStore = .default()
        }
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = true
        // Intentionally keep this browser-only configuration free of injected code and native message receivers.
        let browser = WKWebView(frame: .zero, configuration: configuration)
        browser.translatesAutoresizingMaskIntoConstraints = false
        browser.navigationDelegate = self
        browser.uiDelegate = self
        browser.allowsBackForwardNavigationGestures = true
        if #available(iOS 16.4, *) { browser.isInspectable = false }
        view.addSubview(browser)
        NSLayoutConstraint.activate([
            browser.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            browser.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            browser.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            browser.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        webView = browser
        browser.load(URLRequest(url: startURL, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 60))
        onStatus?("opened", "")
    }

    @objc private func goBack() { webView?.goBack() }
    @objc private func closeTapped() { close() }

    func close(completion: (() -> Void)? = nil) {
        guard !closed else { completion?(); return }
        closed = true
        webView?.stopLoading()
        let finish = { [weak self] in
            guard let self else { completion?(); return }
            self.webView?.navigationDelegate = nil
            self.webView?.uiDelegate = nil
            self.webView?.removeFromSuperview()
            self.webView = nil
            self.onStatus?("closed", "browser-only URL session closed")
            self.onClose?()
            completion?()
        }
        if let navigation = navigationController, navigation.presentingViewController != nil {
            navigation.dismiss(animated: true, completion: finish)
        } else { dismiss(animated: true, completion: finish) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.targetFrame?.isMainFrame != false, let url = navigationAction.request.url, isAllowed(url) else {
            onStatus?("blocked", "navigation outside the HTTPS allowlist was blocked")
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        onStatus?("navigationError", error.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        onStatus?("processGone", "remote browser WebKit process terminated")
        webView.reload()
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, isAllowed(url) { webView.load(URLRequest(url: url)) }
        return nil
    }

    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    @available(iOS 18.4, *)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        completionHandler(nil)
    }

    private func isAllowed(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil, let host = url.host?.lowercased() else { return false }
        let port = url.port ?? 443
        for rule in allowedHosts {
            let parts = rule.split(separator: ":", omittingEmptySubsequences: false)
            let pattern = String(parts[0])
            let expectedPort = parts.count == 2 ? Int(parts[1]) ?? -1 : 443
            let matches = pattern.hasPrefix("*.")
                ? host.hasSuffix(String(pattern.dropFirst())) && host != String(pattern.dropFirst(2))
                : host == pattern
            if matches && port == expectedPort { return true }
        }
        return false
    }

    private static func validateRule(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !value.isEmpty, value.count <= 260 else { throw error("Invalid remote URL host rule") }
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 1 || parts.count == 2 else { throw error("Invalid remote URL host rule") }
        if parts.count == 2 { guard let port = Int(parts[1]), port >= 1, port <= 65_535 else { throw error("Invalid remote URL host port") } }
        var hostname = String(parts[0])
        if hostname.hasPrefix("*.") { hostname.removeFirst(2) }
        let labels = hostname.split(separator: ".", omittingEmptySubsequences: false)
        guard !labels.isEmpty, hostname.count <= 253 else { throw error("Invalid remote URL host rule") }
        for label in labels {
            let chars = Array(label.utf8)
            let alphanumeric: (UInt8) -> Bool = { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 122) }
            guard !chars.isEmpty, chars.count <= 63, alphanumeric(chars[0]), alphanumeric(chars[chars.count - 1]), chars.allSatisfy({ alphanumeric($0) || $0 == 45 }) else {
                throw error("Invalid remote URL host rule")
            }
        }
        return value
    }

    private static func hostAndPort(_ url: URL) -> String {
        let host = url.host?.lowercased() ?? ""
        return url.port == nil || url.port == 443 ? host : "\(host):\(url.port!)"
    }

    private static func error(_ message: String) -> NSError {
        NSError(domain: "NativeKitRemoteBrowser", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
