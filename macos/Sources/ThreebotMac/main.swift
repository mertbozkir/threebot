import AppKit
import UserNotifications
import WebKit

/// An IPv6 host without URL brackets, so `[::1]` and `::1` compare equal.
func unbracketed(_ host: String) -> String {
    host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
}

/// The gateway address from THREEBOT_HOME/.env (default ~/.threebot), the file `threebot up` writes.
func gatewayURL() -> URL {
    let environment = ProcessInfo.processInfo.environment
    let home = environment["THREEBOT_HOME"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".threebot")
    var settings: [String: String] = [:]
    let text = (try? String(contentsOf: home.appendingPathComponent(".env"), encoding: .utf8)) ?? ""
    for line in text.split(whereSeparator: \.isNewline) {
        let parts = line.split(separator: "=", maxSplits: 1)
        guard parts.count == 2 else { continue }
        let key = parts[0].trimmingCharacters(in: .whitespaces)
        var value = parts[1].trimmingCharacters(in: .whitespaces)
        if value.count >= 2, let first = value.first, first == "\"" || first == "'", value.last == first {
            value = String(value.dropFirst().dropLast())
        }
        settings[key] = value
    }
    let port = settings["PORT"].flatMap { Int($0) }.flatMap { (1...65535).contains($0) ? $0 : nil } ?? 3780
    // A wildcard or loopback listener is reached on 127.0.0.1; a specific address is used as is.
    var host = unbracketed(settings["HOST"] ?? "")
    if ["", "0.0.0.0", "::", "localhost", "127.0.0.1"].contains(host) { host = "127.0.0.1" }
    var components = URLComponents()
    components.scheme = "http"
    components.host = host.contains(":") ? "[\(host)]" : host
    components.port = port
    components.path = "/"
    return components.url ?? URL(string: "http://127.0.0.1:3780/")!
}

/// WebKit in an app view refuses notification permission and has no Push API, so the page's
/// notifications go to macOS through this script. Only Notification and the service worker's
/// showNotification are replaced; nothing else reaches native code.
private let notificationScript = """
(() => {
  const bridge = window.webkit.messageHandlers.threebotNotifications;
  let permission = "__PERMISSION__";
  const shown = new Map();
  const page = Date.now().toString(36);
  let next = 0;
  class NativeNotification extends EventTarget {
    constructor(title, options = {}) {
      super();
      this.title = String(title);
      this.body = String(options.body ?? "");
      this.tag = String(options.tag ?? "");
      this.data = options.data ?? null;
      this.onclick = this.onclose = this.onerror = this.onshow = null;
      this.id = page + "-" + (++next);
      if (permission !== "granted") { setTimeout(() => this.dispatchEvent(new Event("error"))); return; }
      shown.set(this.id, this);
      const url = typeof this.data?.url === "string" ? this.data.url : "";
      bridge.postMessage({ action: "show", id: this.id, title: this.title, body: this.body, tag: this.tag, url });
    }
    static get permission() { return permission; }
    static async requestPermission(callback) {
      permission = await bridge.postMessage({ action: "permission" });
      callback?.(permission);
      return permission;
    }
    close() {
      shown.delete(this.id);
      bridge.postMessage({ action: "close", id: this.id });
    }
    dispatchEvent(event) {
      const handler = this["on" + event.type];
      if (typeof handler === "function") handler.call(this, event);
      return super.dispatchEvent(event);
    }
  }
  Object.defineProperty(window, "Notification", { value: NativeNotification, configurable: true, writable: true });
  if (window.ServiceWorkerRegistration) {
    ServiceWorkerRegistration.prototype.showNotification = async function (title, options) {
      new NativeNotification(title, options).fromWorker = true;
    };
  }
  window.__threebotNotifications = {
    // false: the app opens the notification's URL itself, as the service worker would.
    clicked(id) {
      const notification = shown.get(id);
      if (!notification || notification.fromWorker) return false;
      shown.delete(id);
      notification.dispatchEvent(new Event("click"));
      return true;
    },
    setPermission(value) { permission = value; },
  };
})();
"""

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate,
    WKScriptMessageHandlerWithReply, UNUserNotificationCenterDelegate, NSWindowDelegate {
    private let gateway = gatewayURL()
    private var notificationPermission = "default"
    // Page notification id -> macOS request identifier. A reused tag replaces the earlier entry.
    private var notificationRequests: [String: String] = [:]
    private var window: NSWindow!
    private var webView: WKWebView!
    private var popupViews: [ObjectIdentifier: WKWebView] = [:]
    private var documentWindows: [NSWindow] = []
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var downloadDestinations: [ObjectIdentifier: (temporary: URL, chosen: URL)] = [:]
    private var userNavigation = false
    private var showingLoadError = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        createMenus()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // The Connect Apps popup must start from a user gesture.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Threebot"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.contentMinSize = NSSize(width: 360, height: 480)
        window.collectionBehavior = [.fullScreenPrimary]
        window.isReleasedWhenClosed = false
        window.contentView = webView
        if !window.setFrameUsingName("ThreebotMainWindow") {
            window.center()
        }
        window.setFrameAutosaveName("ThreebotMainWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // UserNotifications needs an app bundle; a bare `swift run` binary loads without it.
        guard Bundle.main.bundleIdentifier != nil else {
            webView.load(URLRequest(url: gateway))
            return
        }
        UNUserNotificationCenter.current().delegate = self
        webView.configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "threebotNotifications")
        Task {
            await refreshNotificationPermission()
            webView.load(URLRequest(url: gateway))
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        // The user may have changed Threebot's notifications in System Settings.
        guard Bundle.main.bundleIdentifier != nil, webView.url != nil else { return }
        Task { await refreshNotificationPermission() }
    }

    private func refreshNotificationPermission() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional: applyNotificationPermission("granted")
        case .denied: applyNotificationPermission("denied")
        default: applyNotificationPermission("default")
        }
    }

    private func applyNotificationPermission(_ permission: String) {
        let controller = webView.configuration.userContentController
        if permission != notificationPermission || controller.userScripts.isEmpty {
            notificationPermission = permission
            controller.removeAllUserScripts()
            let source = notificationScript.replacingOccurrences(of: "__PERMISSION__", with: permission)
            controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        webView.evaluateJavaScript("window.__threebotNotifications?.setPermission(\"\(permission)\")")
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, message.webView === webView,
              origin.protocol == gateway.scheme, unbracketed(origin.host) == unbracketed(gateway.host ?? ""),
              // WebKit reports the scheme's default port as 0.
              (origin.port == 0 ? 80 : origin.port) == (gateway.port ?? 80),
              let body = message.body as? [String: Any], let action = body["action"] as? String else {
            replyHandler(nil, "Not allowed")
            return
        }
        let center = UNUserNotificationCenter.current()
        switch action {
        case "permission":
            Task {
                let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
                applyNotificationPermission(granted ? "granted" : "denied")
                replyHandler(notificationPermission, nil)
            }
        case "show":
            guard let id = body["id"] as? String, let title = body["title"] as? String else {
                replyHandler(nil, "Missing notification")
                return
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body["body"] as? String ?? ""
            content.sound = .default
            content.userInfo = ["id": id, "url": body["url"] as? String ?? ""]
            let tag = body["tag"] as? String ?? ""
            let identifier = tag.isEmpty ? "threebot-\(id)" : "threebot-tag-\(tag)"
            notificationRequests = notificationRequests.filter { $0.value != identifier }
            notificationRequests[id] = identifier
            center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
            replyHandler(nil, nil)
        case "close":
            if let id = body["id"] as? String, let identifier = notificationRequests.removeValue(forKey: id) {
                center.removeDeliveredNotifications(withIdentifiers: [identifier])
            }
            replyHandler(nil, nil)
        default:
            replyHandler(nil, "Unknown action")
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        // The page already skips notifications for the Bot on screen.
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let id = info["id"] as? String ?? ""
        let path = info["url"] as? String ?? ""
        await MainActor.run { openNotification(id: id, path: path) }
    }

    private func openNotification(id: String, path: String) {
        notificationRequests.removeValue(forKey: id)
        NSApp.activate(ignoringOtherApps: true)
        window.deminiaturize(nil)
        window.makeKeyAndOrderFront(nil)
        webView.callAsyncJavaScript("return window.__threebotNotifications?.clicked(id) ?? false", arguments: ["id": id], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            if case .success(let handled) = result, handled as? Bool == true { return }
            guard !path.isEmpty, let target = URL(string: path, relativeTo: self.gateway)?.absoluteURL,
                  self.isSameOrigin(target) else { return }
            self.webView.load(URLRequest(url: target))
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.deminiaturize(nil)
        window.makeKeyAndOrderFront(nil)
        return true
    }

    private func createMenus() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Threebot", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Threebot", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Threebot", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)

        let edit = NSMenu(title: "Edit")
        for (title, selector, key) in [
            ("Undo", "undo:", "z"), ("Redo", "redo:", "Z"),
            ("Cut", "cut:", "x"), ("Copy", "copy:", "c"),
            ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")
        ] {
            edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editItem.submenu = edit
        menu.addItem(editItem)

        let view = NSMenu(title: "View")
        for (title, action, key) in [
            ("Reload", #selector(reloadPage), "r"),
            ("Zoom In", #selector(zoomIn), "+"),
            ("Zoom Out", #selector(zoomOut), "-"),
            ("Actual Size", #selector(actualSize), "0")
        ] {
            let item = view.addItem(withTitle: title, action: action, keyEquivalent: key)
            item.target = self
        }
        let viewItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        viewItem.submenu = view
        menu.addItem(viewItem)

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        let fullscreen = windowMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullscreen.keyEquivalentModifierMask = [.command, .control]
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        let windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windowMenu
    }

    @objc private func reloadPage() {
        if webView.url == nil { webView.load(URLRequest(url: gateway)) }
        else { webView.reload() }
    }

    @objc private func zoomIn() { webView.pageZoom = min(2, webView.pageZoom + 0.1) }
    @objc private func zoomOut() { webView.pageZoom = max(0.5, webView.pageZoom - 0.1) }
    @objc private func actualSize() { webView.pageZoom = 1 }

    private func isSameOrigin(_ url: URL) -> Bool {
        url.scheme == gateway.scheme && url.host == gateway.host && url.port == gateway.port
    }

    private func isLocalBlob(_ url: URL) -> Bool {
        guard url.scheme == "blob", let inner = URL(string: String(url.absoluteString.dropFirst(5))) else { return false }
        return isSameOrigin(inner)
    }

    private func disposePopup(_ view: WKWebView) {
        guard popupViews.removeValue(forKey: ObjectIdentifier(view)) != nil else { return }
        view.stopLoading()
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }

    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let popup = popupViews[ObjectIdentifier(view)] != nil
        let topLevel = action.targetFrame?.isMainFrame ?? true
        let clicked = action.navigationType == .linkActivated || action.navigationType == .formSubmitted
        if !popup && topLevel && clicked { userNavigation = true }

        let blankPopup = url.absoluteString == "about:blank" && (popup || action.targetFrame == nil)
        let inlineDocument = !topLevel && ["about:blank", "about:srcdoc"].contains(url.absoluteString)
        if blankPopup || inlineDocument {
            decisionHandler(.allow)
        } else if isSameOrigin(url) || isLocalBlob(url) {
            // Same-site popup destinations reuse the visible app window.
            if (popup || action.targetFrame == nil) && !action.shouldPerformDownload {
                decisionHandler(.cancel)
                if url.path.hasPrefix("/t3/") {
                    // Files (PDFs, images) get their own closable window; the app page stays put.
                    openDocumentWindow(action.request)
                } else {
                    userNavigation = true
                    webView.load(action.request)
                }
                if popup { disposePopup(view) }
            } else {
                decisionHandler(action.shouldPerformDownload ? .download : .allow)
            }
        } else if topLevel && (popup || clicked || userNavigation) && ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            decisionHandler(.cancel)
            NSWorkspace.shared.open(url)
            if popup { disposePopup(view) }
            else { userNavigation = false }
        } else {
            decisionHandler(.cancel)
            if popup { disposePopup(view) }
        }
    }

    func webView(_ view: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard action.targetFrame == nil, let url = action.request.url,
              url.absoluteString == "about:blank" else { return nil }
        let child = WKWebView(frame: .zero, configuration: configuration)
        child.navigationDelegate = self
        child.uiDelegate = self
        popupViews[ObjectIdentifier(child)] = child
        return child
    }

    func webViewDidClose(_ view: WKWebView) { disposePopup(view) }

    private func openDocumentWindow(_ request: URLRequest) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = webView.configuration.websiteDataStore
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        let document = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 1000),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        document.title = request.url?.lastPathComponent ?? "Threebot"
        document.isReleasedWhenClosed = false
        document.contentView = view
        document.delegate = self
        document.cascadeTopLeft(from: NSPoint(x: window.frame.minX + 40, y: window.frame.maxY - 40))
        documentWindows.append(document)
        view.load(request)
        document.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow else { return }
        (closing.contentView as? WKWebView)?.stopLoading()
        documentWindows.removeAll { $0 === closing }
    }

    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        if view === webView { userNavigation = false }
    }

    func webView(_ view: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let url = response.response.url,
           !isSameOrigin(url), !isLocalBlob(url), url.absoluteString != "about:blank" {
            decisionHandler(.cancel)
            if userNavigation && ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
            userNavigation = false
            if view !== webView { disposePopup(view) }
            return
        }
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let attachment = disposition.lowercased().hasPrefix("attachment")
        decisionHandler(response.isForMainFrame && (!response.canShowMIMEType || attachment) ? .download : .allow)
    }

    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { handleLoadError(view, error) }
    func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { handleLoadError(view, error) }

    private func handleLoadError(_ view: WKWebView, _ error: Error) {
        if view !== webView { disposePopup(view); return }
        userNavigation = false
        let failure = error as NSError
        guard !(failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled),
              !(failure.domain == "WebKitErrorDomain" && failure.code == 102), !showingLoadError else { return }
        showingLoadError = true
        let alert = NSAlert()
        alert.messageText = "Threebot could not load"
        alert.informativeText = "The local Threebot service must be running at \(gateway.absoluteString)."
        alert.addButton(withTitle: "Retry")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] result in
            guard let self else { return }
            self.showingLoadError = false
            if result == .alertFirstButtonReturn { self.webView.load(URLRequest(url: self.gateway)) }
        }
    }

    func webView(_ view: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    // Memory's Forget asks with confirm(); WebKit answers false when the app doesn't.
    func webView(_ view: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard view === webView, frame.isMainFrame else { completionHandler(false); return }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { result in
            completionHandler(result == .alertFirstButtonReturn)
        }
    }

    // The existing sidebar uses prompt() when creating a section.
    func webView(_ view: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard view === webView, frame.isMainFrame else { completionHandler(nil); return }
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { result in
            completionHandler(result == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    func webView(_ view: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { trackDownload(download) }
    func webView(_ view: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { trackDownload(download) }

    private func trackDownload(_ download: WKDownload) {
        downloads[ObjectIdentifier(download)] = download
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self, result == .OK, let chosen = panel.url else {
                completionHandler(nil)
                self?.downloads.removeValue(forKey: ObjectIdentifier(download))
                return
            }
            // WebKit needs a new file. Keep an existing destination intact until
            // the complete download can replace it after the user's Save choice.
            // The file is staged in a private (0700) folder on the same volume, so
            // nobody else can read it while it downloads or if saving fails.
            let staging = chosen.deletingLastPathComponent().appendingPathComponent(".threebot-download-\(UUID().uuidString)")
            do {
                try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            } catch {
                completionHandler(nil)
                self.downloads.removeValue(forKey: ObjectIdentifier(download))
                let alert = NSAlert()
                alert.messageText = "Could not save download"
                alert.informativeText = error.localizedDescription
                alert.beginSheetModal(for: self.window)
                return
            }
            let temporary = staging.appendingPathComponent(chosen.lastPathComponent)
            self.downloadDestinations[ObjectIdentifier(download)] = (temporary, chosen)
            completionHandler(temporary)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        let id = ObjectIdentifier(download)
        downloads.removeValue(forKey: id)
        guard let destination = downloadDestinations.removeValue(forKey: id) else { return }
        do {
            if FileManager.default.fileExists(atPath: destination.chosen.path) {
                _ = try FileManager.default.replaceItemAt(destination.chosen, withItemAt: destination.temporary)
            } else {
                try FileManager.default.moveItem(at: destination.temporary, to: destination.chosen)
            }
            try? FileManager.default.removeItem(at: destination.temporary.deletingLastPathComponent())
        } catch {
            let alert = NSAlert()
            alert.messageText = "Could not save download"
            alert.informativeText = "The complete download is at \(destination.temporary.path). \(error.localizedDescription)"
            alert.beginSheetModal(for: window)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let id = ObjectIdentifier(download)
        downloads.removeValue(forKey: id)
        if let destination = downloadDestinations.removeValue(forKey: id) {
            try? FileManager.default.removeItem(at: destination.temporary.deletingLastPathComponent())
        }
        let failure = error as NSError
        guard !(failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled) else { return }
        let alert = NSAlert()
        alert.messageText = "Download failed"
        alert.informativeText = error.localizedDescription
        alert.beginSheetModal(for: window)
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.setActivationPolicy(.regular)
    application.delegate = delegate
    withExtendedLifetime(delegate) { application.run() }
}
