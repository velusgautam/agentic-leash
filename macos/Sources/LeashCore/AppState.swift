import Foundation
import Observation

/// The primary navigation sections in Agentic Leash.
public enum NavigationItem: String, CaseIterable, Identifiable, Sendable {
    case live
    case history
    case rules
    case settings

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .live: return "Live Activity"
        case .history: return "History"
        case .rules: return "Rules & Grants"
        case .settings: return "Settings"
        }
    }

    public var iconName: String {
        switch self {
        case .live: return "waveform.path.ecg"
        case .history: return "clock.arrow.circlepath"
        case .rules: return "shield.checkered"
        case .settings: return "gearshape"
        }
    }
}

/// Central state orchestrator for Agentic Leash on macOS.
@MainActor
@Observable
public final class AppState: Sendable {

    // MARK: - Navigation & Modes
    public var selectedNavigation: NavigationItem = .live
    public var autoAcceptMode: Bool = false
    public var autoAcceptUntil: Date? = nil
    public var lockdown: Bool = false

    // MARK: - Data State
    public var pendingRequests: [PendingRequest] = []
    public var liveEvents: [HistoryRow] = []
    public var historyEvents: [HistoryRow] = []
    public var historySummary: HistorySummary? = nil
    public var activeGrantsCount: Int = 0
    public var grants: [Grant] = []
    public var allowRules: [AllowRule] = []
    public var blockRules: [BlockRule] = []

    // MARK: - Filter State
    public var selectedAgentFilter: AgentType? = nil
    public var selectedKindFilter: EventKind? = nil
    public var selectedTimeFilter: String = "Any time"
    public var pathSearchQuery: String = ""
    public var isPaused: Bool = false
    public var showSensitiveOnly: Bool = false
    public var showTempAndExecs: Bool = true

    // MARK: - Subsystems
    public var storage: DatabaseStorage
    public var broker: UnixSocketBroker
    public var hookManager: AgentHookManager

    public var isBootstrapped: Bool = false
    public var socketPath: String?

    // MARK: - Default Paths
    public static var defaultDatabaseURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return appSupport.appendingPathComponent("AgenticLeash/leash.sqlite3")
    }

    public static var defaultSocketURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".agentic-leash/leash.sock")
    }

    // MARK: - Initializer
    public init(
        storage: DatabaseStorage? = nil,
        broker: UnixSocketBroker? = nil,
        hookManager: AgentHookManager = AgentHookManager()
    ) {
        if let storage {
            self.storage = storage
        } else {
            // Default to in-memory until bootstrap is called
            self.storage = (try? DatabaseStorage(path: nil))!
        }

        let newBroker = broker ?? UnixSocketBroker()
        self.broker = newBroker
        self.hookManager = hookManager
    }

    // MARK: - Lifecycle

    /// Initializes storage, socket broker, loads initial rules, grants, and history.
    public func bootstrap(databasePath: String? = nil, socketPath: String? = nil) async {
        let resolvedDbPath = databasePath ?? Self.defaultDatabaseURL.path
        if let realStorage = try? DatabaseStorage(path: resolvedDbPath) {
            self.storage = realStorage
        }

        let resolvedSocket = socketPath ?? Self.defaultSocketURL.path
        self.socketPath = resolvedSocket

        await broker.stop()
        broker = UnixSocketBroker()

        await broker.setOnPendingChange { [weak self] list in
            Task { @MainActor [weak self] in
                self?.pendingRequests = list
            }
        }

        try? await broker.start(socketPath: resolvedSocket)

        await refreshGrantsAndRules()
        await refreshHistory()
        self.isBootstrapped = true
    }

    // MARK: - Modes

    public func toggleAutoAcceptMode(duration: TimeInterval = 15 * 60) {
        if autoAcceptMode {
            autoAcceptMode = false
            autoAcceptUntil = nil
        } else {
            autoAcceptMode = true
            autoAcceptUntil = Date().addingTimeInterval(duration)
            if lockdown {
                lockdown = false
            }
        }
    }

    public func toggleLockdown() {
        lockdown.toggle()
        if lockdown {
            autoAcceptMode = false
            autoAcceptUntil = nil
        }
    }

    public func togglePause() {
        isPaused.toggle()
    }

    // MARK: - Grants & Revocation

    public func revokeAll() async {
        try? await storage.revokeAllGrants()
        await broker.clearMemory()
        await refreshGrantsAndRules()
    }

    public func revokeGrant(id: Int64) async {
        try? await storage.revokeGrant(id: id)
        await refreshGrantsAndRules()
    }

    // MARK: - Decision Resolution

    public func resolvePending(id: String, verdict: VerdictKind, once: Bool = false) async {
        let matchedReq = pendingRequests.first(where: { $0.id == id })
        await broker.decide(id: id, decision: verdict, ttlSeconds: once ? 15 : nil, once: once)

        if let req = matchedReq {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let primaryPath = req.request.paths.first ?? req.request.command ?? req.request.url ?? "unknown"
            let kindStr = verdict == .deny ? "deny" : req.request.access.rawValue

            if verdict == .pass && !once {
                _ = try? await storage.addGrant(
                    agent: req.request.agent,
                    path: primaryPath,
                    access: req.request.access,
                    source: "user_approval",
                    command: req.request.command,
                    sessionId: req.request.sessionId
                )
                await refreshGrantsAndRules()
            }

            let insertedId = (try? await storage.insertHistory(
                ts: now,
                agent: req.request.agent,
                exe: req.request.tool,
                kind: kindStr,
                path: primaryPath,
                destPath: nil,
                sensitive: false
            )) ?? 0

            let row = HistoryRow(
                id: insertedId,
                ts: now,
                agent: req.request.agent,
                exe: req.request.tool,
                kind: kindStr,
                path: primaryPath
            )
            addLiveEvent(row)
        }

        pendingRequests.removeAll(where: { $0.id == id })
    }

    // MARK: - History & Stats

    public func refreshHistory() async {
        let agentFilter = selectedAgentFilter?.rawValue
        let kindFilter = selectedKindFilter?.rawValue
        let search = pathSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : pathSearchQuery

        let fetched = (try? await storage.fetchHistory(
            limit: 500,
            offset: 0,
            agent: agentFilter,
            kind: kindFilter,
            search: search
        )) ?? []

        var filtered = fetched
        if showSensitiveOnly {
            filtered = filtered.filter { $0.sensitive }
        }
        if !showTempAndExecs {
            filtered = filtered.filter { row in
                let p = row.path.lowercased()
                let isTemp = p.contains("/tmp") || p.contains("/var/folders") || p.contains(".tmp")
                let isExec = row.kind.lowercased() == "exec"
                return !isTemp && !isExec
            }
        }

        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let calendar = Calendar.current
        let startOfTodayMs = Int64(calendar.startOfDay(for: Date()).timeIntervalSince1970 * 1000)

        switch selectedTimeFilter {
        case "Today":
            filtered = filtered.filter { $0.ts >= startOfTodayMs }
        case "Last 1h":
            filtered = filtered.filter { $0.ts >= (nowMs - 3600 * 1000) }
        case "Last 24h":
            filtered = filtered.filter { $0.ts >= (nowMs - 24 * 3600 * 1000) }
        case "Last 7d":
            filtered = filtered.filter { $0.ts >= (nowMs - 7 * 24 * 3600 * 1000) }
        default:
            break
        }

        self.historyEvents = filtered

        let summary = try? await storage.fetchHistorySummary(since: startOfTodayMs)
        self.historySummary = summary
    }

    public func refreshGrantsAndRules() async {
        self.grants = (try? await storage.listGrants()) ?? []
        self.allowRules = (try? await storage.listRules()) ?? []
        self.blockRules = (try? await storage.listBlocks()) ?? []
        self.activeGrantsCount = self.grants.count
    }

    public func addLiveEvent(_ event: HistoryRow) {
        guard !isPaused else { return }
        liveEvents.insert(event, at: 0)
        if liveEvents.count > 250 {
            liveEvents.removeLast()
        }
    }

    // MARK: - Rules Management

    public func addAllowRule(kind: String, agent: String, value: String) async {
        _ = try? await storage.addRule(kind: kind, agent: agent, value: value)
        await refreshGrantsAndRules()
    }

    public func deleteAllowRule(id: Int64) async {
        try? await storage.removeRule(id: id)
        await refreshGrantsAndRules()
    }

    public func addBlockRule(agent: String, kind: String, value: String) async {
        _ = try? await storage.addBlock(agent: agent, kind: kind, value: value)
        await refreshGrantsAndRules()
    }

    public func deleteBlockRule(id: Int64) async {
        try? await storage.removeBlock(id: id)
        await refreshGrantsAndRules()
    }

    // MARK: - Hooks Management

    public func isHookInstalled(for agent: AgentType) -> Bool {
        hookManager.isHookInstalled(agent: agent)
    }

    public func toggleHook(for agent: AgentType, hookCommand: String = "leash-hook") {
        let installed = isHookInstalled(for: agent)
        if installed {
            try? hookManager.removeHook(agent: agent)
        } else {
            try? hookManager.installHook(agent: agent, hookCommand: hookCommand)
        }
    }
}
