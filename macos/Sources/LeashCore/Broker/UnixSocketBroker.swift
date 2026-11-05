import Foundation
import Darwin

/// Incoming message sent by a hook client to the Unix socket broker.
public struct BrokerIncomingMessage: Codable, Sendable {
    public var id: String?
    public var request: HookRequest

    public init(id: String? = nil, request: HookRequest) {
        self.id = id
        self.request = request
    }
}

/// Response sent by the broker back to the hook client.
public struct BrokerResponse: Codable, Sendable, Equatable {
    public var id: String
    public var decision: String
    public var ttlSeconds: Int?

    public init(id: String, decision: String, ttlSeconds: Int? = nil) {
        self.id = id
        self.decision = decision
        self.ttlSeconds = ttlSeconds
    }
}

/// A remembered denial entry for quick rejection without user interruption.
public struct RememberedDenial: Codable, Sendable, Equatable {
    public var key: String
    public var agent: String
    public var sessionId: String?
    public var label: String
    public var until: Int64

    public init(key: String, agent: String, sessionId: String? = nil, label: String, until: Int64) {
        self.key = key
        self.agent = agent
        self.sessionId = sessionId
        self.label = label
        self.until = until
    }
}

/// Manages the Unix domain socket server and prompt queue for hook clients.
public actor UnixSocketBroker {

    struct PendingItem {
        let id: String
        let request: HookRequest
        let askedAt: Int64
        var continuations: [CheckedContinuation<BrokerResponse, Never>]
    }

    struct DeniedCacheEntry {
        let request: HookRequest
        let until: Int64
    }

    public static let defaultDenyMemoryMs: Int64 = 10 * 60 * 1000 // 10 minutes
    public static let defaultOnceMemoryMs: Int64 = 15 * 1000      // 15 seconds

    private var pending: [String: PendingItem] = [:]
    private var denied: [String: DeniedCacheEntry] = [:]
    private var deniedIds: [String: String] = [:]
    private var onceAllowed: [String: Int64] = [:]

    private var serverFd: Int32 = -1
    private var socketPath: String?
    private var isRunning: Bool = false
    private var listenerTask: Task<Void, Never>?

    public var onPendingChange: (@Sendable ([PendingRequest]) -> Void)?

    public func setOnPendingChange(_ handler: (@Sendable ([PendingRequest]) -> Void)?) {
        self.onPendingChange = handler
    }

    public init(onPendingChange: (@Sendable ([PendingRequest]) -> Void)? = nil) {
        self.onPendingChange = onPendingChange
    }

    deinit {
        listenerTask?.cancel()
        if serverFd >= 0 {
            Darwin.close(serverFd)
        }
        if let path = socketPath {
            Darwin.unlink(path)
        }
    }

    /// Computes a unique cache key based on the request's core attributes.
    public static func cacheKey(for request: HookRequest) -> String {
        let sortedPaths = request.paths.sorted().joined(separator: "|")
        return "\(request.agent):\(request.sessionId ?? ""):\(request.access.rawValue):\(request.command ?? ""):\(request.url ?? ""):\(sortedPaths)"
    }

    /// Starts listening on the given Unix domain socket path.
    public func start(socketPath: String) throws {
        if isRunning {
            cleanup()
        }

        // 1. Remove existing socket file if present
        Darwin.unlink(socketPath)

        // 2. Ensure parent directory exists
        let dir = URL(fileURLWithPath: socketPath).deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // 3. Create POSIX stream socket
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }

        // 4. Populate sockaddr_un
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        #if os(macOS)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        #endif

        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        let pathCString = socketPath.utf8CString
        guard pathCString.count <= maxLen else {
            Darwin.close(fd)
            throw NSError(domain: "UnixSocketBroker", code: 1, userInfo: [NSLocalizedDescriptionKey: "Socket path exceeds \(maxLen) bytes"])
        }

        socketPath.withCString { cStr in
            withUnsafeMutablePointer(to: &addr.sun_path) { sunPathPtr in
                sunPathPtr.withMemoryRebound(to: CChar.self, capacity: maxLen) { dest in
                    strncpy(dest, cStr, maxLen - 1)
                    dest[maxLen - 1] = 0
                }
            }
        }

        // 5. Bind
        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { saPtr in
                Darwin.bind(fd, saPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            let err = errno
            Darwin.close(fd)
            throw POSIXError(POSIXErrorCode(rawValue: err) ?? .EIO)
        }

        // 6. Restrict permissions to owner
        Darwin.chmod(socketPath, 0o600)

        // 7. Listen
        guard Darwin.listen(fd, SOMAXCONN) == 0 else {
            let err = errno
            Darwin.close(fd)
            throw POSIXError(POSIXErrorCode(rawValue: err) ?? .EIO)
        }

        self.serverFd = fd
        self.socketPath = socketPath
        self.isRunning = true

        // 8. Launch background listener task
        self.listenerTask = Task.detached { [weak self, fd] in
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            while !Task.isCancelled {
                guard let self else { break }
                let running = await self.checkIsRunning()
                guard running else { break }

                let pollRes = Darwin.poll(&pfd, 1, 100)
                if pollRes > 0 && (pfd.revents & Int16(POLLIN)) != 0 {
                    var clientAddr = sockaddr_un()
                    var clientLen = socklen_t(MemoryLayout<sockaddr_un>.size)
                    let clientFd = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { saPtr in
                            Darwin.accept(fd, saPtr, &clientLen)
                        }
                    }

                    if clientFd >= 0 {
                        Task.detached { [weak self] in
                            guard let self else {
                                Darwin.close(clientFd)
                                return
                            }
                            await self.handleClientConnection(fd: clientFd)
                        }
                    }
                }
            }
        }
    }

    /// Stops the socket broker, cancels waiters, and unlinks the socket file.
    public func stop() {
        cleanup()
    }

    /// Internal synchronous cleanup helper.
    private func cleanup() {
        isRunning = false
        listenerTask?.cancel()
        listenerTask = nil

        if serverFd >= 0 {
            Darwin.close(serverFd)
            serverFd = -1
        }

        if let path = socketPath {
            Darwin.unlink(path)
            socketPath = nil
        }

        let remaining = pending
        pending.removeAll()
        notifyPendingChange()

        for item in remaining.values {
            let res = BrokerResponse(id: item.id, decision: "deny")
            for cont in item.continuations {
                cont.resume(returning: res)
            }
        }
    }

    public func checkIsRunning() -> Bool {
        return isRunning
    }

    /// Handles a connected client socket file descriptor.
    nonisolated func handleClientConnection(fd: Int32) async {
        defer { Darwin.close(fd) }

        var readBuffer = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)

        while true {
            let isRunning = await self.checkIsRunning()
            guard isRunning else { break }

            let count = Darwin.read(fd, &chunk, chunk.count)
            if count <= 0 {
                break
            }
            readBuffer.append(chunk, count: count)

            while let newlineIdx = readBuffer.firstIndex(of: UInt8(ascii: "\n")) {
                let lineData = readBuffer.subdata(in: 0..<newlineIdx)
                readBuffer.removeSubrange(0...newlineIdx)

                guard !lineData.isEmpty else { continue }
                if let response = await self.processIncomingLine(lineData) {
                    if var encoded = try? JSONEncoder().encode(response) {
                        encoded.append(UInt8(ascii: "\n"))
                        _ = encoded.withUnsafeBytes { rawBytes in
                            Darwin.write(fd, rawBytes.baseAddress!, encoded.count)
                        }
                    }
                }
            }
        }

        if !readBuffer.isEmpty {
            if let response = await self.processIncomingLine(readBuffer) {
                if var encoded = try? JSONEncoder().encode(response) {
                    encoded.append(UInt8(ascii: "\n"))
                    _ = encoded.withUnsafeBytes { rawBytes in
                        Darwin.write(fd, rawBytes.baseAddress!, encoded.count)
                    }
                }
            }
        }
    }

    /// Processes raw JSON line data received from a client socket.
    public func processIncomingLine(_ data: Data) async -> BrokerResponse? {
        if let message = try? JSONDecoder().decode(BrokerIncomingMessage.self, from: data) {
            let id = message.id ?? UUID().uuidString
            return await processIncoming(id: id, request: message.request)
        }
        if let request = try? JSONDecoder().decode(HookRequest.self, from: data) {
            let id = UUID().uuidString
            return await processIncoming(id: id, request: request)
        }
        return nil
    }

    /// Internal logic for checking caches or suspending on pending approval.
    private func processIncoming(id: String, request: HookRequest) async -> BrokerResponse {
        let key = Self.cacheKey(for: request)
        let now = Int64(Date().timeIntervalSince1970 * 1000)

        pruneExpiredCaches(now: now)

        // 1. Cached denial check
        if let denial = denied[key], denial.until > now {
            return BrokerResponse(id: id, decision: "deny")
        }

        // 2. Cached once-allow check
        if let onceUntil = onceAllowed[key], onceUntil > now {
            return BrokerResponse(id: id, decision: "allow")
        }

        // 3. Suspend waiting for decide(...) call
        return await withCheckedContinuation { continuation in
            if var existing = pending[id] {
                existing.continuations.append(continuation)
                pending[id] = existing
            } else if let matchKey = pending.first(where: { Self.cacheKey(for: $0.value.request) == key })?.key {
                var item = pending[matchKey]!
                item.continuations.append(continuation)
                pending[matchKey] = item
            } else {
                pending[id] = PendingItem(id: id, request: request, askedAt: now, continuations: [continuation])
                notifyPendingChange()
            }
        }
    }

    /// Resolves a pending request with a given verdict.
    public func decide(id: String, decision: VerdictKind, ttlSeconds: Int? = nil, once: Bool = false) {
        let str: String
        switch decision {
        case .pass:
            str = "allow"
        case .deny:
            str = "deny"
        case .prompt:
            str = "prompt"
        }
        decide(id: id, decisionString: str, ttlSeconds: ttlSeconds, once: once)
    }

    /// Resolves a pending request with a raw string decision ("allow" / "deny").
    public func decide(id: String, decisionString: String, ttlSeconds: Int? = nil, once: Bool = false) {
        guard let item = pending.removeValue(forKey: id) else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let key = Self.cacheKey(for: item.request)

        if decisionString == "allow" {
            if once || (ttlSeconds != nil && ttlSeconds! <= 15) {
                let ttl = ttlSeconds ?? 15
                onceAllowed[key] = now + Int64(ttl) * 1000
            }
        } else if decisionString == "deny" {
            let ttl = ttlSeconds ?? 600 // 10 minutes
            denied[key] = DeniedCacheEntry(request: item.request, until: now + Int64(ttl) * 1000)
            deniedIds[id] = key
        }

        notifyPendingChange()

        let response = BrokerResponse(id: id, decision: decisionString, ttlSeconds: ttlSeconds)
        for cont in item.continuations {
            cont.resume(returning: response)
        }
    }

    /// Returns the current list of pending requests awaiting human or system action.
    public func getPending() -> [PendingRequest] {
        return pending.values
            .map { PendingRequest(id: $0.id, request: $0.request, askedAt: $0.askedAt) }
            .sorted { $0.askedAt < $1.askedAt }
    }

    /// Clears cached denials and once-allows from memory.
    public func clearMemory() {
        denied.removeAll()
        deniedIds.removeAll()
        onceAllowed.removeAll()
    }

    /// Undoes a remembered denial associated with the pending request id.
    public func undoDenial(id: String) -> Bool {
        guard let key = deniedIds.removeValue(forKey: id) else { return false }
        return denied.removeValue(forKey: key) != nil
    }

    /// Lists all currently active remembered denials.
    public func listDenials() -> [RememberedDenial] {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return denied.compactMap { key, entry in
            guard entry.until > now else { return nil }
            let label = entry.request.command?.trimmingCharacters(in: .whitespacesAndNewlines)
                ?? entry.request.url
                ?? entry.request.paths.joined(separator: ", ")
            return RememberedDenial(
                key: key,
                agent: entry.request.agent,
                sessionId: entry.request.sessionId,
                label: label,
                until: entry.until
            )
        }.sorted { $0.until > $1.until }
    }

    private func pruneExpiredCaches(now: Int64) {
        for (key, entry) in denied where entry.until <= now {
            denied.removeValue(forKey: key)
        }
        for (key, until) in onceAllowed where until <= now {
            onceAllowed.removeValue(forKey: key)
        }
    }

    private func notifyPendingChange() {
        let list = getPending()
        onPendingChange?(list)
    }

    /// Sends a hook request as a client over a Unix domain socket and waits for the broker response.
    public static func sendClientRequest(socketPath: String, message: BrokerIncomingMessage) throws -> BrokerResponse {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { Darwin.close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        #if os(macOS)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        #endif

        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        let pathCString = socketPath.utf8CString
        guard pathCString.count <= maxLen else {
            throw NSError(domain: "UnixSocketBroker", code: 1, userInfo: [NSLocalizedDescriptionKey: "Path exceeds \(maxLen) bytes"])
        }

        socketPath.withCString { cStr in
            withUnsafeMutablePointer(to: &addr.sun_path) { sunPathPtr in
                sunPathPtr.withMemoryRebound(to: CChar.self, capacity: maxLen) { dest in
                    strncpy(dest, cStr, maxLen - 1)
                    dest[maxLen - 1] = 0
                }
            }
        }

        let connRes = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { saPtr in
                Darwin.connect(fd, saPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connRes == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ECONNREFUSED)
        }

        var data = try JSONEncoder().encode(message)
        data.append(UInt8(ascii: "\n"))
        let writeRes = data.withUnsafeBytes { rawBytes in
            Darwin.write(fd, rawBytes.baseAddress!, data.count)
        }
        guard writeRes > 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }

        var responseBuffer = Data()
        var chunk = [UInt8](repeating: 0, count: 1024)
        while true {
            let n = Darwin.read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            responseBuffer.append(chunk, count: n)
            if responseBuffer.contains(UInt8(ascii: "\n")) {
                break
            }
        }

        if let newlineIdx = responseBuffer.firstIndex(of: UInt8(ascii: "\n")) {
            responseBuffer = responseBuffer.subdata(in: 0..<newlineIdx)
        }

        return try JSONDecoder().decode(BrokerResponse.self, from: responseBuffer)
    }
}
