import Testing
import Foundation
@testable import LeashCore

@Suite("DatabaseStorage Tests")
struct DatabaseStorageTests {

    @Test("In-memory database initializes with empty tables")
    func testInMemoryInitialization() async throws {
        let storage = try DatabaseStorage()
        let grants = try await storage.listGrants()
        let rules = try await storage.listRules()
        let blocks = try await storage.listBlocks()
        let history = try await storage.fetchHistory()

        #expect(grants.isEmpty)
        #expect(rules.isEmpty)
        #expect(blocks.isEmpty)
        #expect(history.isEmpty)
    }

    @Test("History insertion, filtering and pagination")
    func testHistoryOperations() async throws {
        let storage = try DatabaseStorage()

        let id1 = try await storage.insertHistory(
            ts: 1000,
            agent: "claude-code",
            exe: "/usr/local/bin/claude",
            kind: "read",
            path: "/Users/dev/.ssh/id_rsa",
            sensitive: true,
            beforeText: nil,
            afterText: "secret key"
        )
        #expect(id1 > 0)

        let id2 = try await storage.insertHistory(
            ts: 2000,
            agent: "cursor",
            exe: "/Applications/Cursor.app/Contents/MacOS/Cursor",
            kind: "write",
            path: "/Users/dev/project/src/main.ts",
            destPath: "/Users/dev/project/src/main.ts.bak",
            sensitive: false,
            beforeText: "console.log(1)",
            afterText: "console.log(2)"
        )
        #expect(id2 > id1)

        let id3 = try await storage.insertHistory(
            ts: 3000,
            agent: "claude-code",
            exe: "/usr/local/bin/claude",
            kind: "exec",
            path: "/bin/sh",
            sensitive: false,
            beforeText: "npm test",
            afterText: "PASS"
        )
        #expect(id3 > id2)

        // Fetch all (default descending order by ts)
        let all = try await storage.fetchHistory()
        #expect(all.count == 3)
        #expect(all[0].id == id3)
        #expect(all[1].id == id2)
        #expect(all[2].id == id1)
        #expect(all[2].sensitive == true)
        #expect(all[1].destPath == "/Users/dev/project/src/main.ts.bak")

        // Filter by agent
        let claudeRows = try await storage.fetchHistory(agent: "claude-code")
        #expect(claudeRows.count == 2)
        #expect(claudeRows.allSatisfy { $0.agent == "claude-code" })

        // Filter by kind
        let writeRows = try await storage.fetchHistory(kind: "write")
        #expect(writeRows.count == 1)
        #expect(writeRows[0].agent == "cursor")

        // Search in path
        let searchPathRows = try await storage.fetchHistory(search: "ssh")
        #expect(searchPathRows.count == 1)
        #expect(searchPathRows[0].id == id1)

        // Search in before/after text
        let searchTextRows = try await storage.fetchHistory(search: "npm test")
        #expect(searchTextRows.count == 1)
        #expect(searchTextRows[0].id == id3)

        // Pagination
        let paged = try await storage.fetchHistory(limit: 1, offset: 1)
        #expect(paged.count == 1)
        #expect(paged[0].id == id2)
    }

    @Test("History summary computation")
    func testHistorySummary() async throws {
        let storage = try DatabaseStorage()

        // Insert events across various agents and kinds
        try await storage.insertHistory(ts: 100, agent: "claude-code", exe: "claude", kind: "read", path: "/a", sensitive: false)
        try await storage.insertHistory(ts: 200, agent: "claude-code", exe: "claude", kind: "write", path: "/b", sensitive: true)
        try await storage.insertHistory(ts: 300, agent: "claude-code", exe: "claude", kind: "delete", path: "/c", sensitive: false)
        try await storage.insertHistory(ts: 400, agent: "claude-code", exe: "claude", kind: "exec", path: "/bin/echo", sensitive: false)
        try await storage.insertHistory(ts: 500, agent: "cursor", exe: "cursor", kind: "net", path: "api.anthropic.com", sensitive: false)
        try await storage.insertHistory(ts: 600, agent: "cursor", exe: "cursor", kind: "blocked", path: "/etc/shadow", sensitive: true)
        try await storage.insertHistory(ts: 700, agent: "gemini", exe: "gemini", kind: "custom-event", path: "/x", sensitive: false)

        // Query all since timestamp 0
        let fullSummary = try await storage.fetchHistorySummary(since: 0)
        #expect(fullSummary.from == 0)
        #expect(fullSummary.total == 7)
        #expect(fullSummary.sensitive == 2)
        #expect(fullSummary.blocked == 1)
        #expect(fullSummary.agentStats.count == 3)

        let claudeStat = fullSummary.agentStats.first(where: { $0.agent == "claude-code" })
        #expect(claudeStat != nil)
        #expect(claudeStat?.reads == 1)
        #expect(claudeStat?.writes == 2) // write + delete
        #expect(claudeStat?.execs == 1)
        #expect(claudeStat?.net == 0)
        #expect(claudeStat?.other == 0)

        let cursorStat = fullSummary.agentStats.first(where: { $0.agent == "cursor" })
        #expect(cursorStat != nil)
        #expect(cursorStat?.net == 1)
        #expect(cursorStat?.other == 1) // blocked counted as other in agentStats

        let geminiStat = fullSummary.agentStats.first(where: { $0.agent == "gemini" })
        #expect(geminiStat?.other == 1)

        // Query with since filter
        let recentSummary = try await storage.fetchHistorySummary(since: 450)
        #expect(recentSummary.total == 3) // ts: 500, 600, 700
        #expect(recentSummary.sensitive == 1) // ts: 600
        #expect(recentSummary.blocked == 1) // ts: 600
    }

    @Test("Grants management and revocation")
    func testGrantsManagement() async throws {
        let storage = try DatabaseStorage()

        let g1 = try await storage.addGrant(
            agent: "claude-code",
            path: "/Users/dev/repo",
            access: .read,
            source: "leash",
            command: nil,
            expiresAt: 5000,
            sessionId: "session-1"
        )
        #expect(g1 > 0)

        let g2 = try await storage.addGrant(
            agent: "cursor",
            path: "/tmp",
            access: .write,
            source: "config",
            command: "git status",
            expiresAt: nil,
            sessionId: nil
        )
        #expect(g2 > g1)

        var grants = try await storage.listGrants()
        #expect(grants.count == 2)

        let first = grants.first { $0.id == g1 }
        #expect(first?.agent == "claude-code")
        #expect(first?.path == "/Users/dev/repo")
        #expect(first?.access == .read)
        #expect(first?.expiresAt == 5000)
        #expect(first?.sessionId == "session-1")

        let second = grants.first { $0.id == g2 }
        #expect(second?.agent == "cursor")
        #expect(second?.access == .write)
        #expect(second?.command == "git status")
        #expect(second?.expiresAt == nil)

        // Revoke single grant
        try await storage.revokeGrant(id: g1)
        grants = try await storage.listGrants()
        #expect(grants.count == 1)
        #expect(grants[0].id == g2)

        // Revoke all grants
        try await storage.revokeAllGrants()
        grants = try await storage.listGrants()
        #expect(grants.isEmpty)
    }

    @Test("Allow rules operations")
    func testAllowRules() async throws {
        let storage = try DatabaseStorage()

        let r1 = try await storage.addRule(kind: "folder", agent: "claude-code", value: "/Users/dev/allowed")
        #expect(r1 > 0)

        let r2 = try await storage.addRule(kind: "command", agent: "*", value: "git status")
        #expect(r2 > 0)

        var rules = try await storage.listRules()
        #expect(rules.count == 2)
        #expect(rules.contains { $0.kind == "folder" && $0.agent == "claude-code" && $0.value == "/Users/dev/allowed" })
        #expect(rules.contains { $0.kind == "command" && $0.agent == "*" && $0.value == "git status" })

        // Adding duplicate updates created_at and returns ID without throwing
        let r1Duplicate = try await storage.addRule(kind: "folder", agent: "claude-code", value: "/Users/dev/allowed")
        #expect(r1Duplicate == r1)
        rules = try await storage.listRules()
        #expect(rules.count == 2)

        // Remove rule
        try await storage.removeRule(id: r1)
        rules = try await storage.listRules()
        #expect(rules.count == 1)
        #expect(rules[0].id == r2)
    }

    @Test("Block rules operations")
    func testBlockRules() async throws {
        let storage = try DatabaseStorage()

        let b1 = try await storage.addBlock(agent: "cursor", kind: "path", value: "/etc/passwd")
        #expect(b1 > 0)

        let b2 = try await storage.addBlock(agent: "*", kind: "command", value: "rm -rf /")
        #expect(b2 > 0)

        var blocks = try await storage.listBlocks()
        #expect(blocks.count == 2)
        #expect(blocks.contains { $0.agent == "cursor" && $0.value == "/etc/passwd" })

        // Adding duplicate updates created_at and returns ID without error
        let b1Dup = try await storage.addBlock(agent: "cursor", kind: "path", value: "/etc/passwd")
        #expect(b1Dup == b1)
        blocks = try await storage.listBlocks()
        #expect(blocks.count == 2)

        // Remove block
        try await storage.removeBlock(id: b1)
        blocks = try await storage.listBlocks()
        #expect(blocks.count == 1)
        #expect(blocks[0].id == b2)
    }

    @Test("Settings key-value store")
    func testSettings() async throws {
        let storage = try DatabaseStorage()

        let initial = try await storage.getSetting(key: "theme")
        #expect(initial == nil)

        try await storage.setSetting(key: "theme", value: "dark")
        let updated = try await storage.getSetting(key: "theme")
        #expect(updated == "dark")

        try await storage.setSetting(key: "theme", value: "system")
        let overwritten = try await storage.getSetting(key: "theme")
        #expect(overwritten == "system")
    }

    @Test("AgentType properties")
    func testAgentType() {
        #expect(AgentType.allCases.count == 7)
        #expect(AgentType.claudeCode.rawValue == "claude-code")
        #expect(AgentType.claudeCode.id == "claude-code")
        #expect(AgentType.claudeCode.displayName == "Claude Code")
        #expect(!AgentType.claudeCode.iconName.isEmpty)

        #expect(AgentType.cursor.rawValue == "cursor")
        #expect(AgentType.gemini.rawValue == "gemini")
        #expect(AgentType.antigravity.rawValue == "antigravity")
        #expect(AgentType.codex.rawValue == "codex")
        #expect(AgentType.hermes.rawValue == "hermes")
        #expect(AgentType.opencode.rawValue == "opencode")
    }

    @Test("EventTypes JSON Codable with snake_case and camelCase")
    func testEventTypesCodable() throws {
        let hookJson = """
        {
            "agent": "claude-code",
            "event": "preToolUse",
            "tool": "Bash",
            "access": "write",
            "paths": ["/Users/dev/test.txt"],
            "cwd": "/Users/dev",
            "command": "echo hi",
            "session_id": "sess-123",
            "after_secret": true
        }
        """
        let decoder = JSONDecoder()
        let hook = try decoder.decode(HookRequest.self, from: hookJson.data(using: .utf8)!)
        #expect(hook.agent == "claude-code")
        #expect(hook.sessionId == "sess-123")
        #expect(hook.afterSecret == true)
        #expect(hook.access == .write)

        let grantJson = """
        {
            "id": 42,
            "agent": "cursor",
            "path": "/project",
            "access": "read",
            "source": "leash",
            "created_at": 1700000000,
            "expires_at": 1700003600,
            "session_id": "s-456"
        }
        """
        let grant = try decoder.decode(Grant.self, from: grantJson.data(using: .utf8)!)
        #expect(grant.id == 42)
        #expect(grant.createdAt == 1700000000)
        #expect(grant.expiresAt == 1700003600)
        #expect(grant.sessionId == "s-456")

        // Re-encoding preserves data
        let encoder = JSONEncoder()
        let reEncoded = try encoder.encode(grant)
        let reDecoded = try decoder.decode(Grant.self, from: reEncoded)
        #expect(reDecoded == grant)
    }
}
