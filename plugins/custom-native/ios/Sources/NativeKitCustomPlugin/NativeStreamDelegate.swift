import Foundation

final class NativeStreamDelegate: NSObject, URLSessionDataDelegate {
    let streamId: String
    let format: String
    var onData: (([String: Any]) -> Void)?
    var onEnd: ((Int?) -> Void)?
    var onError: ((String, Int?) -> Void)?
    private var status: Int?
    private var pending = ""
    private var ended = false
    private let allowRedirects: Bool

    init(streamId: String, format: String, allowRedirects: Bool = true) {
        self.streamId = streamId
        self.format = format
        self.allowRedirects = allowRedirects
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(allowRedirects ? request : nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        status = (response as? HTTPURLResponse)?.statusCode
        if let code = status, !(200...299).contains(code) {
            ended = true
            onError?("HTTP \(code)", code)
            completionHandler(.cancel)
        } else {
            completionHandler(.allow)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !ended else { return }
        pending += String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n")
        if format == "text" {
            onData?(["data": pending, "format": format]); pending = ""; return
        }
        let separator = format == "sse" ? "\n\n" : "\n"
        while let range = pending.range(of: separator) {
            let block = String(pending[..<range.lowerBound])
            pending = String(pending[range.upperBound...])
            if format == "ndjson" {
                if !block.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { onData?(["data": block, "format": format]) }
            } else if let event = parseSSE(block) { onData?(event) }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !ended else { return }
        ended = true
        if let error = error as NSError?, error.code != NSURLErrorCancelled { onError?(error.localizedDescription, status) }
        else if error == nil {
            if !pending.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if format == "sse", let event = parseSSE(pending) { onData?(event) }
                else { onData?(["data": pending, "format": format]) }
            }
            onEnd?(status)
        }
    }

    private func parseSSE(_ block: String) -> [String: Any]? {
        var values: [String] = []
        var name: String?
        var id: String?
        for line in block.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if line.isEmpty || line.hasPrefix(":") { continue }
            let pieces = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
            let field = pieces[0]
            let value = pieces.count > 1 ? pieces[1].replacingOccurrences(of: "^ ", with: "", options: .regularExpression) : ""
            if field == "data" { values.append(value) }
            else if field == "event" { name = value }
            else if field == "id" { id = value }
        }
        if values.isEmpty && name == nil && id == nil { return nil }
        var result: [String: Any] = ["data": values.joined(separator: "\n"), "format": format]
        if let name { result["event"] = name }
        if let id { result["id"] = id }
        return result
    }
}
