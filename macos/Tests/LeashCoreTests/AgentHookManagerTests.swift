import Testing
import Foundation
@testable import LeashCore

@Suite("AgentHookManager Tests")
struct AgentHookManagerTests {

    private func createTempDirectory() throws -> URL {
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("leash-agent-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempURL, withIntermediateDirectories: true)
        return tempURL
    }

    @Test("Claude Code hook installation, status check, and removal")
    func testClaudeHookLifecycle() throws {
        let home = try createTempDirectory()
        defer { try? FileManager.default.removeItem(at: home) }

        let hookCmd = "leash-hook claude"

        // 1. Initially not installed
        #expect(AgentHookManager.isClaudeHookInstalled(homeDirectory: home) == false)

        // 2. Pre-seed settings.json with user custom options
        let settingsURL = AgentHookManager.claudeSettingsURL(homeDirectory: home)
        try FileManager.default.createDirectory(at: settingsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let initialJSON = """
        {
          "model": "claude-3-5-sonnet",
          "permissions": {
            "allow": ["Bash(ls)"]
          }
        }
        """
        try initialJSON.write(to: settingsURL, atomically: true, encoding: .utf8)

        // 3. Install hook
        try AgentHookManager.installClaudeHook(homeDirectory: home, hookCommand: hookCmd)
        #expect(AgentHookManager.isClaudeHookInstalled(homeDirectory: home) == true)
        #expect(AgentHookManager.isClaudeHookInstalled(homeDirectory: home, hookCommand: hookCmd) == true)

        // Verify other keys preserved
        let updatedData = try Data(contentsOf: settingsURL)
        let updatedJSON = try JSONSerialization.jsonObject(with: updatedData) as? [String: Any]
        #expect(updatedJSON?["model"] as? String == "claude-3-5-sonnet")

        // 4. Remove hook
        try AgentHookManager.removeClaudeHook(homeDirectory: home)
        #expect(AgentHookManager.isClaudeHookInstalled(homeDirectory: home) == false)

        // Verify custom settings still intact
        let finalData = try Data(contentsOf: settingsURL)
        let finalJSON = try JSONSerialization.jsonObject(with: finalData) as? [String: Any]
        #expect(finalJSON?["model"] as? String == "claude-3-5-sonnet")
    }

    @Test("Cursor hook installation across all 4 events and removal")
    func testCursorHookLifecycle() throws {
        let home = try createTempDirectory()
        defer { try? FileManager.default.removeItem(at: home) }

        let hookCmd = "leash-hook cursor"

        #expect(AgentHookManager.isCursorHookInstalled(homeDirectory: home) == false)

        try AgentHookManager.installCursorHook(homeDirectory: home, hookCommand: hookCmd)
        #expect(AgentHookManager.isCursorHookInstalled(homeDirectory: home) == true)

        // Check file content has version 1 and 4 events
        let url = AgentHookManager.cursorHooksURL(homeDirectory: home)
        let data = try Data(contentsOf: url)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(json?["version"] as? Int == 1)
        let hooks = json?["hooks"] as? [String: Any]
        for event in AgentHookManager.cursorEvents {
            let entries = hooks?[event] as? [[String: Any]]
            #expect(entries?.first?["command"] as? String == hookCmd)
            #expect(entries?.first?["failClosed"] as? Bool == true)
        }

        try AgentHookManager.removeCursorHook(homeDirectory: home)
        #expect(AgentHookManager.isCursorHookInstalled(homeDirectory: home) == false)
    }

    @Test("Gemini hook installation and removal")
    func testGeminiHookLifecycle() throws {
        let home = try createTempDirectory()
        defer { try? FileManager.default.removeItem(at: home) }

        let hookCmd = "leash-hook gemini"

        #expect(AgentHookManager.isGeminiHookInstalled(homeDirectory: home) == false)

        try AgentHookManager.installGeminiHook(homeDirectory: home, hookCommand: hookCmd)
        #expect(AgentHookManager.isGeminiHookInstalled(homeDirectory: home) == true)

        try AgentHookManager.removeGeminiHook(homeDirectory: home)
        #expect(AgentHookManager.isGeminiHookInstalled(homeDirectory: home) == false)
    }

    @Test("Antigravity hook installation and removal")
    func testAntigravityHookLifecycle() throws {
        let home = try createTempDirectory()
        defer { try? FileManager.default.removeItem(at: home) }

        let hookCmd = "leash-hook antigravity"

        #expect(AgentHookManager.isAntigravityHookInstalled(homeDirectory: home) == false)

        try AgentHookManager.installAntigravityHook(homeDirectory: home, hookCommand: hookCmd)
        #expect(AgentHookManager.isAntigravityHookInstalled(homeDirectory: home) == true)

        try AgentHookManager.removeAntigravityHook(homeDirectory: home)
        #expect(AgentHookManager.isAntigravityHookInstalled(homeDirectory: home) == false)
    }

    @Test("Codex hook installation and removal")
    func testCodexHookLifecycle() throws {
        let home = try createTempDirectory()
        defer { try? FileManager.default.removeItem(at: home) }

        let hookCmd = "leash-hook codex"

        #expect(AgentHookManager.isCodexHookInstalled(homeDirectory: home) == false)

        try AgentHookManager.installCodexHook(homeDirectory: home, hookCommand: hookCmd)
        #expect(AgentHookManager.isCodexHookInstalled(homeDirectory: home) == true)

        try AgentHookManager.removeCodexHook(homeDirectory: home)
        #expect(AgentHookManager.isCodexHookInstalled(homeDirectory: home) == false)
    }

    @Test("Unified AgentType dispatcher methods")
    func testUnifiedAgentDispatcher() throws {
        let home = try createTempDirectory()
        defer { try? FileManager.default.removeItem(at: home) }

        let manager = AgentHookManager(homeDirectory: home)

        for agent in [AgentType.claudeCode, .cursor, .gemini, .antigravity, .codex] {
            let cmd = "leash-hook \(agent.rawValue)"
            #expect(manager.isHookInstalled(agent: agent) == false)
            try manager.installHook(agent: agent, hookCommand: cmd)
            #expect(manager.isHookInstalled(agent: agent) == true)
            try manager.removeHook(agent: agent)
            #expect(manager.isHookInstalled(agent: agent) == false)
        }
    }
}
