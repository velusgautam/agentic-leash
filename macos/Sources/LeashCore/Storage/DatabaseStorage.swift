import Foundation
import SQLite3

// Destructor constant for SQLite text binding
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Errors thrown by SQLite operations.
public enum DatabaseError: Error, LocalizedError, Sendable {
    case openFailed(String)
    case prepareFailed(String)
    case bindFailed(String)
    case stepFailed(String)
    case executionFailed(String)
    case databaseClosed

    public var errorDescription: String? {
        switch self {
        case .openFailed(let message):
            return "Failed to open database: \(message)"
        case .prepareFailed(let message):
            return "Failed to prepare statement: \(message)"
        case .bindFailed(let message):
            return "Failed to bind parameter: \(message)"
        case .stepFailed(let message):
            return "Failed to step statement: \(message)"
        case .executionFailed(let message):
            return "Failed to execute SQL: \(message)"
        case .databaseClosed:
            return "Database is already closed."
        }
    }
}

/// Wrapper around SQLite database pointer for Sendable safety and automatic closure on deallocation.
private final class SQLiteHandle: @unchecked Sendable {
    let pointer: OpaquePointer

    init(pointer: OpaquePointer) {
        self.pointer = pointer
    }

    deinit {
        sqlite3_close_v2(pointer)
    }
}

/// Thread-safe storage layer managing configuration, rules, grants, and history.
public actor DatabaseStorage: Sendable {
    private let handle: SQLiteHandle
    private var db: OpaquePointer { handle.pointer }

    /// Initializes a SQLite database. Pass nil or empty string for an in-memory database.
    public init(path: String? = nil) throws {
        let resolvedPath: String
        if let path, !path.isEmpty {
            resolvedPath = path
            let dir = URL(fileURLWithPath: path).deletingLastPathComponent()
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } else {
            resolvedPath = ":memory:"
        }

        var rawPointer: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let status = sqlite3_open_v2(resolvedPath, &rawPointer, flags, nil)
        guard status == SQLITE_OK, let rawPointer else {
            let msg = rawPointer != nil ? String(cString: sqlite3_errmsg(rawPointer)) : "Unknown error"
            if let rawPointer { sqlite3_close_v2(rawPointer) }
            throw DatabaseError.openFailed(msg)
        }

        try Self.executePragmas(db: rawPointer, isInMemory: resolvedPath == ":memory:")
        try Self.createSchema(db: rawPointer)

        self.handle = SQLiteHandle(pointer: rawPointer)
    }

    private static func executePragmas(db: OpaquePointer, isInMemory: Bool) throws {
        try execute(db: db, sql: "PRAGMA foreign_keys = ON;")
        try execute(db: db, sql: "PRAGMA busy_timeout = 5000;")
        if !isInMemory {
            try execute(db: db, sql: "PRAGMA journal_mode = WAL;")
            try execute(db: db, sql: "PRAGMA synchronous = NORMAL;")
        }
    }

    private static func createSchema(db: OpaquePointer) throws {
        let sql = """
        CREATE TABLE IF NOT EXISTS grants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent TEXT NOT NULL,
            path TEXT NOT NULL,
            access TEXT NOT NULL,
            source TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            command TEXT,
            session_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_grants_agent_expires ON grants(agent, expires_at);

        CREATE TABLE IF NOT EXISTS rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            agent TEXT NOT NULL,
            value TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(kind, agent, value)
        );

        CREATE TABLE IF NOT EXISTS blocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent TEXT NOT NULL,
            kind TEXT NOT NULL,
            value TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(agent, kind, value)
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            agent TEXT NOT NULL,
            exe TEXT NOT NULL,
            kind TEXT NOT NULL,
            path TEXT NOT NULL,
            dest_path TEXT,
            sensitive INTEGER NOT NULL DEFAULT 0,
            before_text TEXT,
            after_text TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts);
        CREATE INDEX IF NOT EXISTS idx_history_agent_ts ON history(agent, ts);
        CREATE INDEX IF NOT EXISTS idx_history_kind ON history(kind);
        """
        try execute(db: db, sql: sql)
    }

    // MARK: - History

    /// Inserts a history record and returns the created row ID.
    @discardableResult
    public func insertHistory(
        ts: Int64,
        agent: String,
        exe: String,
        kind: String,
        path: String,
        destPath: String? = nil,
        sensitive: Bool = false,
        beforeText: String? = nil,
        afterText: String? = nil
    ) throws -> Int64 {
        let sql = """
        INSERT INTO history (ts, agent, exe, kind, path, dest_path, sensitive, before_text, after_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.prepareFailed(lastErrorMessage())
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_int64(stmt, 1, ts)
        sqlite3_bind_text(stmt, 2, agent, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, exe, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 4, kind, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 5, path, -1, SQLITE_TRANSIENT)

        if let destPath {
            sqlite3_bind_text(stmt, 6, destPath, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 6)
        }

        sqlite3_bind_int(stmt, 7, sensitive ? 1 : 0)

        if let beforeText {
            sqlite3_bind_text(stmt, 8, beforeText, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 8)
        }

        if let afterText {
            sqlite3_bind_text(stmt, 9, afterText, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 9)
        }

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(lastErrorMessage())
        }

        return sqlite3_last_insert_rowid(db)
    }

    /// Fetches history rows matching optional filtering criteria.
    public func fetchHistory(
        limit: Int = 100,
        offset: Int = 0,
        agent: String? = nil,
        kind: String? = nil,
        search: String? = nil
    ) throws -> [HistoryRow] {

        var sql = "SELECT id, ts, agent, exe, kind, path, dest_path, sensitive, before_text, after_text FROM history WHERE 1=1"
        var params: [Any] = []

        if let agent, !agent.isEmpty {
            sql += " AND agent = ?"
            params.append(agent)
        }
        if let kind, !kind.isEmpty {
            sql += " AND kind = ?"
            params.append(kind)
        }
        if let search, !search.isEmpty {
            sql += " AND (path LIKE ? OR exe LIKE ? OR before_text LIKE ? OR after_text LIKE ?)"
            let pattern = "%\(search)%"
            params.append(pattern)
            params.append(pattern)
            params.append(pattern)
            params.append(pattern)
        }

        sql += " ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?;"
        params.append(limit)
        params.append(offset)

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.prepareFailed(lastErrorMessage())
        }
        defer { sqlite3_finalize(stmt) }

        for (index, param) in params.enumerated() {
            let col = Int32(index + 1)
            if let stringVal = param as? String {
                sqlite3_bind_text(stmt, col, stringVal, -1, SQLITE_TRANSIENT)
            } else if let intVal = param as? Int {
                sqlite3_bind_int(stmt, col, Int32(intVal))
            } else if let int64Val = param as? Int64 {
                sqlite3_bind_int64(stmt, col, int64Val)
            }
        }

        var results: [HistoryRow] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = sqlite3_column_int64(stmt, 0)
            let ts = sqlite3_column_int64(stmt, 1)
            let agentName = String(cString: sqlite3_column_text(stmt, 2))
            let exe = String(cString: sqlite3_column_text(stmt, 3))
            let kindName = String(cString: sqlite3_column_text(stmt, 4))
            let path = String(cString: sqlite3_column_text(stmt, 5))

            let destPath: String?
            if sqlite3_column_type(stmt, 6) != SQLITE_NULL, let cStr = sqlite3_column_text(stmt, 6) {
                destPath = String(cString: cStr)
            } else {
                destPath = nil
            }

            let sensitive = sqlite3_column_int(stmt, 7) == 1

            let beforeText: String?
            if sqlite3_column_type(stmt, 8) != SQLITE_NULL, let cStr = sqlite3_column_text(stmt, 8) {
                beforeText = String(cString: cStr)
            } else {
                beforeText = nil
            }

            let afterText: String?
            if sqlite3_column_type(stmt, 9) != SQLITE_NULL, let cStr = sqlite3_column_text(stmt, 9) {
                afterText = String(cString: cStr)
            } else {
                afterText = nil
            }

            results.append(HistoryRow(
                id: id,
                ts: ts,
                agent: agentName,
                exe: exe,
                kind: kindName,
                path: path,
                destPath: destPath,
                sensitive: sensitive,
                beforeText: beforeText,
                afterText: afterText
            ))
        }

        return results
    }

    /// Computes summary statistics for history recorded since the given timestamp.
    public func fetchHistorySummary(since: Int64) throws -> HistorySummary {

        // Total events
        var total = 0
        do {
            let sql = "SELECT COUNT(*) FROM history WHERE ts >= ?;"
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt {
                defer { sqlite3_finalize(stmt) }
                sqlite3_bind_int64(stmt, 1, since)
                if sqlite3_step(stmt) == SQLITE_ROW {
                    total = Int(sqlite3_column_int(stmt, 0))
                }
            }
        }

        // Sensitive events
        var sensitive = 0
        do {
            let sql = "SELECT COUNT(*) FROM history WHERE ts >= ? AND sensitive = 1;"
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt {
                defer { sqlite3_finalize(stmt) }
                sqlite3_bind_int64(stmt, 1, since)
                if sqlite3_step(stmt) == SQLITE_ROW {
                    sensitive = Int(sqlite3_column_int(stmt, 0))
                }
            }
        }

        // Blocked events (kind in 'blocked', 'deny')
        var blocked = 0
        do {
            let sql = "SELECT COUNT(*) FROM history WHERE ts >= ? AND kind IN ('blocked', 'deny');"
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt {
                defer { sqlite3_finalize(stmt) }
                sqlite3_bind_int64(stmt, 1, since)
                if sqlite3_step(stmt) == SQLITE_ROW {
                    blocked = Int(sqlite3_column_int(stmt, 0))
                }
            }
        }

        // Agent stats
        var agentMap: [String: AgentStat] = [:]
        do {
            let sql = "SELECT agent, kind, COUNT(*) FROM history WHERE ts >= ? GROUP BY agent, kind;"
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt {
                defer { sqlite3_finalize(stmt) }
                sqlite3_bind_int64(stmt, 1, since)
                while sqlite3_step(stmt) == SQLITE_ROW {
                    let agentName = String(cString: sqlite3_column_text(stmt, 0))
                    let kind = String(cString: sqlite3_column_text(stmt, 1)).lowercased()
                    let count = Int(sqlite3_column_int(stmt, 2))

                    var stat = agentMap[agentName] ?? AgentStat(agent: agentName)
                    switch kind {
                    case "read":
                        stat.reads += count
                    case "write", "create", "delete", "rename":
                        stat.writes += count
                    case "exec":
                        stat.execs += count
                    case "net":
                        stat.net += count
                    default:
                        stat.other += count
                    }
                    agentMap[agentName] = stat
                }
            }
        }

        let sortedStats = agentMap.values.sorted { $0.agent < $1.agent }
        return HistorySummary(
            from: since,
            total: total,
            sensitive: sensitive,
            blocked: blocked,
            agentStats: sortedStats
        )
    }

    // MARK: - Grants

    /// Adds a grant to the grants table and returns the row ID.
    @discardableResult
    public func addGrant(
        agent: String,
        path: String,
        access: Access,
        source: String = "leash",
        command: String? = nil,
        createdAt: Int64? = nil,
        expiresAt: Int64? = nil,
        sessionId: String? = nil
    ) throws -> Int64 {
        let now = createdAt ?? Int64(Date().timeIntervalSince1970 * 1000)
        let sql = """
        INSERT INTO grants (agent, path, access, source, created_at, expires_at, command, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.prepareFailed(lastErrorMessage())
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, agent, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, path, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, access.rawValue, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 4, source, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int64(stmt, 5, now)

        if let expiresAt {
            sqlite3_bind_int64(stmt, 6, expiresAt)
        } else {
            sqlite3_bind_null(stmt, 6)
        }

        if let command {
            sqlite3_bind_text(stmt, 7, command, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 7)
        }

        if let sessionId {
            sqlite3_bind_text(stmt, 8, sessionId, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 8)
        }

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(lastErrorMessage())
        }

        return sqlite3_last_insert_rowid(db)
    }

    /// Lists all grants ordered by ID.
    public func listGrants() throws -> [Grant] {
        let sql = "SELECT id, agent, path, access, source, command, created_at, expires_at, session_id FROM grants ORDER BY id ASC;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.prepareFailed(lastErrorMessage())
        }
        defer { sqlite3_finalize(stmt) }

        var grants: [Grant] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = sqlite3_column_int64(stmt, 0)
            let agent = String(cString: sqlite3_column_text(stmt, 1))
            let path = String(cString: sqlite3_column_text(stmt, 2))
            let accessRaw = String(cString: sqlite3_column_text(stmt, 3))
            let access = Access(rawValue: accessRaw) ?? .read
            let source = String(cString: sqlite3_column_text(stmt, 4))

            let command: String?
            if sqlite3_column_type(stmt, 5) != SQLITE_NULL, let cStr = sqlite3_column_text(stmt, 5) {
                command = String(cString: cStr)
            } else {
                command = nil
            }

            let createdAt = sqlite3_column_int64(stmt, 6)

            let expiresAt: Int64?
            if sqlite3_column_type(stmt, 7) != SQLITE_NULL {
                expiresAt = sqlite3_column_int64(stmt, 7)
            } else {
                expiresAt = nil
            }

            let sessionId: String?
            if sqlite3_column_type(stmt, 8) != SQLITE_NULL, let cStr = sqlite3_column_text(stmt, 8) {
                sessionId = String(cString: cStr)
            } else {
                sessionId = nil
            }

            grants.append(Grant(
                id: id,
                agent: agent,
                path: path,
                access: access,
                source: source,
                command: command,
                createdAt: createdAt,
                expiresAt: expiresAt,
                sessionId: sessionId
            ))
        }

        return grants
    }

    /// Revokes a grant by its ID.
    public func revokeGrant(id: Int64) throws {
        let sql = "DELETE FROM grants WHERE id = ?;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.prepareFailed(lastErrorMessage())
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_int64(stmt, 1, id)
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(lastErrorMessage())
        }
    }

    /// Revokes all active grants.
    public func revokeAllGrants() throws {
        try execute("DELETE FROM grants;")
    }

    // MARK: - Rules

    /// Adds or replaces an allow rule, returning the row ID.
    @discardableResult
    public func addRule(kind: String, agent: String, value: String, createdAt: Int64? = nil) throws -> Int64 {
        let now = createdAt ?? Int64(Date().timeIntervalSince1970 * 1000)
        let sql = """
        INSERT INTO rules (kind, agent, value, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(kind, agent, value) DO UPDATE SET created_at = excluded.created_at;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.prepareFailed(lastErrorMessage())
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, kind, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, agent, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, value, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int64(stmt, 4, now)

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(lastErrorMessage())
        }

        // Query the row ID (in case of conflict update where last_insert_rowid might not change)
        let selectSql = "SELECT id FROM rules WHERE kind = ? AND agent = ? AND value = ?;"
        var selectStmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, selectSql, -1, &selectStmt, nil) == SQLITE_OK, let selectStmt else {
            return sqlite3_last_insert_rowid(db)
        }
        defer { sqlite3_finalize(selectStmt) }

        sqlite3_bind_text(selectStmt, 1, kind, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(selectStmt, 2, agent, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(selectStmt, 3, value, -1, SQLITE_TRANSIENT)

        if sqlite3_step(selectStmt) == SQLITE_ROW {
            return sqlite3_column_int64(selectStmt, 0)
        }
        return sqlite3_last_insert_rowid(db)
    }

    /// Lists all allow rules ordered by ID.
    public func listRules() throws -> [AllowRule] {
        let sql = "SELECT id, kind, agent, value, created_at FROM rules ORDER BY id ASC;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.prepareFailed(lastErrorMessage())
        }
        defer { sqlite3_finalize(stmt) }

        var rules: [AllowRule] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = sqlite3_column_int64(stmt, 0)
            let kind = String(cString: sqlite3_column_text(stmt, 1))
            let agent = String(cString: sqlite3_column_text(stmt, 2))
            let value = String(cString: sqlite3_column_text(stmt, 3))
            let createdAt = sqlite3_column_int64(stmt, 4)

            rules.append(AllowRule(
                id: id,
                kind: kind,
                agent: agent,
                value: value,
                createdAt: createdAt
            ))
        }

        return rules
    }

    /// Removes an allow rule by ID.
    public func removeRule(id: Int64) throws {
        let sql = "DELETE FROM rules WHERE id = ?;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.prepareFailed(lastErrorMessage())
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_int64(stmt, 1, id)
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(lastErrorMessage())
        }
    }

    // MARK: - Blocks

    /// Adds or replaces a block rule, returning the row ID.
    @discardableResult
    public func addBlock(agent: String, kind: String, value: String, createdAt: Int64? = nil) throws -> Int64 {
        let now = createdAt ?? Int64(Date().timeIntervalSince1970 * 1000)
        let sql = """
        INSERT INTO blocks (agent, kind, value, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(agent, kind, value) DO UPDATE SET created_at = excluded.created_at;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.prepareFailed(lastErrorMessage())
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, agent, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, kind, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, value, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int64(stmt, 4, now)

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(lastErrorMessage())
        }

        // Query the row ID
        let selectSql = "SELECT id FROM blocks WHERE agent = ? AND kind = ? AND value = ?;"
        var selectStmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, selectSql, -1, &selectStmt, nil) == SQLITE_OK, let selectStmt else {
            return sqlite3_last_insert_rowid(db)
        }
        defer { sqlite3_finalize(selectStmt) }

        sqlite3_bind_text(selectStmt, 1, agent, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(selectStmt, 2, kind, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(selectStmt, 3, value, -1, SQLITE_TRANSIENT)

        if sqlite3_step(selectStmt) == SQLITE_ROW {
            return sqlite3_column_int64(selectStmt, 0)
        }
        return sqlite3_last_insert_rowid(db)
    }

    /// Lists all block rules ordered by ID.
    public func listBlocks() throws -> [BlockRule] {
        let sql = "SELECT id, agent, kind, value, created_at FROM blocks ORDER BY id ASC;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.prepareFailed(lastErrorMessage())
        }
        defer { sqlite3_finalize(stmt) }

        var blocks: [BlockRule] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = sqlite3_column_int64(stmt, 0)
            let agent = String(cString: sqlite3_column_text(stmt, 1))
            let kind = String(cString: sqlite3_column_text(stmt, 2))
            let value = String(cString: sqlite3_column_text(stmt, 3))
            let createdAt = sqlite3_column_int64(stmt, 4)

            blocks.append(BlockRule(
                id: id,
                agent: agent,
                kind: kind,
                value: value,
                createdAt: createdAt
            ))
        }

        return blocks
    }

    /// Removes a block rule by ID.
    public func removeBlock(id: Int64) throws {
        let sql = "DELETE FROM blocks WHERE id = ?;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.prepareFailed(lastErrorMessage())
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_int64(stmt, 1, id)
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(lastErrorMessage())
        }
    }

    // MARK: - Settings

    /// Retrieves the stored value for a given setting key.
    public func getSetting(key: String) throws -> String? {
        let sql = "SELECT value FROM settings WHERE key = ?;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.prepareFailed(lastErrorMessage())
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, key, -1, SQLITE_TRANSIENT)
        if sqlite3_step(stmt) == SQLITE_ROW, let cStr = sqlite3_column_text(stmt, 0) {
            return String(cString: cStr)
        }
        return nil
    }

    /// Sets or updates a key-value setting.
    public func setSetting(key: String, value: String) throws {
        let sql = """
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw DatabaseError.prepareFailed(lastErrorMessage())
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, key, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, value, -1, SQLITE_TRANSIENT)

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(lastErrorMessage())
        }
    }

    // MARK: - Helpers

    private func execute(_ sql: String) throws {
        try Self.execute(db: db, sql: sql)
    }

    private static func execute(db: OpaquePointer, sql: String) throws {
        var errorMsg: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &errorMsg) != SQLITE_OK {
            let msg = errorMsg != nil ? String(cString: errorMsg!) : "Unknown SQL error"
            sqlite3_free(errorMsg)
            throw DatabaseError.executionFailed(msg)
        }
    }

    private func lastErrorMessage() -> String {
        return String(cString: sqlite3_errmsg(db))
    }
}
