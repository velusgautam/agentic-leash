import Foundation

/// File access level: read or write.
public enum Access: String, CaseIterable, Codable, Sendable {
    case read
    case write
}

/// Nature of an event monitored by hooks or endpoint security.
public enum EventKind: String, CaseIterable, Codable, Sendable {
    case read
    case write
    case create
    case delete
    case rename
    case exec
    case net
}

/// Verdict decision for an incoming hook request.
public enum VerdictKind: String, CaseIterable, Codable, Sendable {
    case pass
    case deny
    case prompt
}

/// Duration preset for temporary or permanent grants.
public enum PresetId: String, CaseIterable, Codable, Sendable {
    case once
    case fifteenMinutes = "15m"
    case session
    case oneHour = "1h"
    case today
    case eightHours = "8h"
    case repo
    case always
}

/// Incoming hook request payload from an agent integration.
public struct HookRequest: Codable, Sendable, Equatable {
    public var agent: String
    public var event: String
    public var tool: String
    public var access: Access
    public var paths: [String]
    public var cwd: String
    public var url: String?
    public var command: String?
    public var sessionId: String?
    public var afterSecret: Bool?

    public init(
        agent: String,
        event: String,
        tool: String,
        access: Access,
        paths: [String],
        cwd: String,
        url: String? = nil,
        command: String? = nil,
        sessionId: String? = nil,
        afterSecret: Bool? = nil
    ) {
        self.agent = agent
        self.event = event
        self.tool = tool
        self.access = access
        self.paths = paths
        self.cwd = cwd
        self.url = url
        self.command = command
        self.sessionId = sessionId
        self.afterSecret = afterSecret
    }

    enum CodingKeys: String, CodingKey {
        case agent, event, tool, access, paths, cwd, url, command
        case sessionId = "sessionId"
        case sessionIdSnake = "session_id"
        case afterSecret = "afterSecret"
        case afterSecretSnake = "after_secret"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.agent = try container.decode(String.self, forKey: .agent)
        self.event = try container.decode(String.self, forKey: .event)
        self.tool = try container.decode(String.self, forKey: .tool)
        self.access = try container.decode(Access.self, forKey: .access)
        self.paths = try container.decode([String].self, forKey: .paths)
        self.cwd = try container.decode(String.self, forKey: .cwd)
        self.url = try container.decodeIfPresent(String.self, forKey: .url)
        self.command = try container.decodeIfPresent(String.self, forKey: .command)
        self.sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            ?? container.decodeIfPresent(String.self, forKey: .sessionIdSnake)
        self.afterSecret = try container.decodeIfPresent(Bool.self, forKey: .afterSecret)
            ?? container.decodeIfPresent(Bool.self, forKey: .afterSecretSnake)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(agent, forKey: .agent)
        try container.encode(event, forKey: .event)
        try container.encode(tool, forKey: .tool)
        try container.encode(access, forKey: .access)
        try container.encode(paths, forKey: .paths)
        try container.encode(cwd, forKey: .cwd)
        try container.encodeIfPresent(url, forKey: .url)
        try container.encodeIfPresent(command, forKey: .command)
        try container.encodeIfPresent(sessionId, forKey: .sessionId)
        try container.encodeIfPresent(afterSecret, forKey: .afterSecret)
    }
}

/// Represents an active or expired permission grant.
public struct Grant: Identifiable, Codable, Sendable, Equatable {
    public var id: Int64
    public var agent: String
    public var path: String
    public var access: Access
    public var source: String
    public var command: String?
    public var createdAt: Int64
    public var expiresAt: Int64?
    public var sessionId: String?

    public init(
        id: Int64,
        agent: String,
        path: String,
        access: Access,
        source: String = "leash",
        command: String? = nil,
        createdAt: Int64,
        expiresAt: Int64? = nil,
        sessionId: String? = nil
    ) {
        self.id = id
        self.agent = agent
        self.path = path
        self.access = access
        self.source = source
        self.command = command
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.sessionId = sessionId
    }

    enum CodingKeys: String, CodingKey {
        case id, agent, path, access, source, command
        case createdAt = "createdAt"
        case createdAtSnake = "created_at"
        case expiresAt = "expiresAt"
        case expiresAtSnake = "expires_at"
        case sessionId = "sessionId"
        case sessionIdSnake = "session_id"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(Int64.self, forKey: .id)
        self.agent = try container.decode(String.self, forKey: .agent)
        self.path = try container.decode(String.self, forKey: .path)
        self.access = try container.decode(Access.self, forKey: .access)
        self.source = try container.decode(String.self, forKey: .source)
        self.command = try container.decodeIfPresent(String.self, forKey: .command)
        self.createdAt = try container.decodeIfPresent(Int64.self, forKey: .createdAt)
            ?? container.decode(Int64.self, forKey: .createdAtSnake)
        self.expiresAt = try container.decodeIfPresent(Int64.self, forKey: .expiresAt)
            ?? container.decodeIfPresent(Int64.self, forKey: .expiresAtSnake)
        self.sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            ?? container.decodeIfPresent(String.self, forKey: .sessionIdSnake)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(agent, forKey: .agent)
        try container.encode(path, forKey: .path)
        try container.encode(access, forKey: .access)
        try container.encode(source, forKey: .source)
        try container.encodeIfPresent(command, forKey: .command)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encodeIfPresent(expiresAt, forKey: .expiresAt)
        try container.encodeIfPresent(sessionId, forKey: .sessionId)
    }
}

/// Whitelist rule allowing paths or commands for specific agents.
public struct AllowRule: Identifiable, Codable, Sendable, Equatable {
    public var id: Int64
    public var kind: String // "folder" or "command"
    public var agent: String
    public var value: String
    public var createdAt: Int64

    public init(id: Int64, kind: String, agent: String, value: String, createdAt: Int64) {
        self.id = id
        self.kind = kind
        self.agent = agent
        self.value = value
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, agent, value
        case createdAt = "createdAt"
        case createdAtSnake = "created_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(Int64.self, forKey: .id)
        self.kind = try container.decode(String.self, forKey: .kind)
        self.agent = try container.decode(String.self, forKey: .agent)
        self.value = try container.decode(String.self, forKey: .value)
        self.createdAt = try container.decodeIfPresent(Int64.self, forKey: .createdAt)
            ?? container.decode(Int64.self, forKey: .createdAtSnake)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(kind, forKey: .kind)
        try container.encode(agent, forKey: .agent)
        try container.encode(value, forKey: .value)
        try container.encode(createdAt, forKey: .createdAt)
    }
}

/// Block rule explicitly denying paths or commands for specific agents.
public struct BlockRule: Identifiable, Codable, Sendable, Equatable {
    public var id: Int64
    public var agent: String
    public var kind: String // "path" or "command"
    public var value: String
    public var createdAt: Int64

    public init(id: Int64, agent: String, kind: String, value: String, createdAt: Int64) {
        self.id = id
        self.agent = agent
        self.kind = kind
        self.value = value
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case id, agent, kind, value
        case createdAt = "createdAt"
        case createdAtSnake = "created_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(Int64.self, forKey: .id)
        self.agent = try container.decode(String.self, forKey: .agent)
        self.kind = try container.decode(String.self, forKey: .kind)
        self.value = try container.decode(String.self, forKey: .value)
        self.createdAt = try container.decodeIfPresent(Int64.self, forKey: .createdAt)
            ?? container.decode(Int64.self, forKey: .createdAtSnake)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(agent, forKey: .agent)
        try container.encode(kind, forKey: .kind)
        try container.encode(value, forKey: .value)
        try container.encode(createdAt, forKey: .createdAt)
    }
}

/// An entry in the history log representing an observed agent action.
public struct HistoryRow: Identifiable, Codable, Sendable, Equatable {
    public var id: Int64
    public var ts: Int64
    public var agent: String
    public var exe: String
    public var kind: String
    public var path: String
    public var destPath: String?
    public var sensitive: Bool
    public var beforeText: String?
    public var afterText: String?

    public init(
        id: Int64,
        ts: Int64,
        agent: String,
        exe: String,
        kind: String,
        path: String,
        destPath: String? = nil,
        sensitive: Bool = false,
        beforeText: String? = nil,
        afterText: String? = nil
    ) {
        self.id = id
        self.ts = ts
        self.agent = agent
        self.exe = exe
        self.kind = kind
        self.path = path
        self.destPath = destPath
        self.sensitive = sensitive
        self.beforeText = beforeText
        self.afterText = afterText
    }

    enum CodingKeys: String, CodingKey {
        case id, ts, agent, exe, kind, path, sensitive
        case destPath = "destPath"
        case destPathSnake = "dest_path"
        case beforeText = "beforeText"
        case beforeTextSnake = "before_text"
        case afterText = "afterText"
        case afterTextSnake = "after_text"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(Int64.self, forKey: .id)
        self.ts = try container.decode(Int64.self, forKey: .ts)
        self.agent = try container.decode(String.self, forKey: .agent)
        self.exe = try container.decode(String.self, forKey: .exe)
        self.kind = try container.decode(String.self, forKey: .kind)
        self.path = try container.decode(String.self, forKey: .path)
        self.destPath = try container.decodeIfPresent(String.self, forKey: .destPath)
            ?? container.decodeIfPresent(String.self, forKey: .destPathSnake)
        self.sensitive = try container.decode(Bool.self, forKey: .sensitive)
        self.beforeText = try container.decodeIfPresent(String.self, forKey: .beforeText)
            ?? container.decodeIfPresent(String.self, forKey: .beforeTextSnake)
        self.afterText = try container.decodeIfPresent(String.self, forKey: .afterText)
            ?? container.decodeIfPresent(String.self, forKey: .afterTextSnake)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(ts, forKey: .ts)
        try container.encode(agent, forKey: .agent)
        try container.encode(exe, forKey: .exe)
        try container.encode(kind, forKey: .kind)
        try container.encode(path, forKey: .path)
        try container.encodeIfPresent(destPath, forKey: .destPath)
        try container.encode(sensitive, forKey: .sensitive)
        try container.encodeIfPresent(beforeText, forKey: .beforeText)
        try container.encodeIfPresent(afterText, forKey: .afterText)
    }
}

/// Statistics per agent over a time window.
public struct AgentStat: Codable, Sendable, Equatable {
    public var agent: String
    public var reads: Int
    public var writes: Int
    public var execs: Int
    public var net: Int
    public var other: Int

    public init(agent: String, reads: Int = 0, writes: Int = 0, execs: Int = 0, net: Int = 0, other: Int = 0) {
        self.agent = agent
        self.reads = reads
        self.writes = writes
        self.execs = execs
        self.net = net
        self.other = other
    }
}

/// Aggregated history statistics over a given timeframe.
public struct HistorySummary: Codable, Sendable, Equatable {
    public var from: Int64
    public var total: Int
    public var sensitive: Int
    public var blocked: Int
    public var agentStats: [AgentStat]

    public init(from: Int64, total: Int, sensitive: Int, blocked: Int, agentStats: [AgentStat]) {
        self.from = from
        self.total = total
        self.sensitive = sensitive
        self.blocked = blocked
        self.agentStats = agentStats
    }
}

/// An in-flight request waiting for user or automated decision.
public struct PendingRequest: Identifiable, Codable, Sendable, Equatable {
    public var id: String
    public var request: HookRequest
    public var askedAt: Int64

    public init(id: String, request: HookRequest, askedAt: Int64) {
        self.id = id
        self.request = request
        self.askedAt = askedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, request
        case askedAt = "askedAt"
        case askedAtSnake = "asked_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(String.self, forKey: .id)
        self.request = try container.decode(HookRequest.self, forKey: .request)
        self.askedAt = try container.decodeIfPresent(Int64.self, forKey: .askedAt)
            ?? container.decode(Int64.self, forKey: .askedAtSnake)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(request, forKey: .request)
        try container.encode(askedAt, forKey: .askedAt)
    }
}

