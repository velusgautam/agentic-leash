import Foundation

/// Manages discovery, installation, and removal of hooks across supported coding agents.
public struct AgentHookManager: Sendable {

    public let homeDirectory: URL

    public static let cursorEvents: [String] = [
        "preToolUse",
        "beforeReadFile",
        "beforeShellExecution",
        "beforeMCPExecution"
    ]

    public static let defaultTimeoutSeconds: Int = 60
    public static let geminiTimeoutMs: Int = 150000

    public init(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.homeDirectory = homeDirectory
    }

    // MARK: - Path Resolvers

    public static func claudeSettingsURL(homeDirectory: URL) -> URL {
        homeDirectory.appendingPathComponent(".claude/settings.json")
    }

    public static func cursorHooksURL(homeDirectory: URL) -> URL {
        homeDirectory.appendingPathComponent(".cursor/hooks.json")
    }

    public static func geminiSettingsURL(homeDirectory: URL) -> URL {
        homeDirectory.appendingPathComponent(".gemini/settings.json")
    }

    public static func antigravityHooksURL(homeDirectory: URL) -> URL {
        homeDirectory.appendingPathComponent(".gemini/config/hooks.json")
    }

    public static func codexHooksURL(homeDirectory: URL) -> URL {
        homeDirectory.appendingPathComponent(".codex/hooks.json")
    }

    public static func hookFileURL(agent: AgentType, homeDirectory: URL) -> URL {
        switch agent {
        case .claudeCode:
            return claudeSettingsURL(homeDirectory: homeDirectory)
        case .cursor:
            return cursorHooksURL(homeDirectory: homeDirectory)
        case .gemini:
            return geminiSettingsURL(homeDirectory: homeDirectory)
        case .antigravity:
            return antigravityHooksURL(homeDirectory: homeDirectory)
        case .codex:
            return codexHooksURL(homeDirectory: homeDirectory)
        case .hermes, .opencode:
            return homeDirectory.appendingPathComponent(".\(agent.rawValue)/hooks.json")
        }
    }

    // MARK: - Helpers

    public static func isOurs(command: String?, name: String? = nil) -> Bool {
        if let name = name, name == "agentic-leash" {
            return true
        }
        guard let command = command else { return false }
        return command.contains("leash-hook") || command.contains("agentic-leash")
    }

    private static func readJSON(at url: URL) -> [String: Any] {
        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any] else {
            return [:]
        }
        return json
    }

    private static func writeJSON(_ dict: [String: Any], to url: URL) throws {
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: [.atomic])
    }

    // MARK: - Claude Code Hooks

    public static func isClaudeHookInstalled(homeDirectory: URL, hookCommand: String? = nil) -> Bool {
        let url = claudeSettingsURL(homeDirectory: homeDirectory)
        let dict = readJSON(at: url)
        guard let hooks = dict["hooks"] as? [String: Any],
              let preToolUse = hooks["PreToolUse"] as? [[String: Any]] else {
            return false
        }

        return preToolUse.contains { group in
            guard let subhooks = group["hooks"] as? [[String: Any]] else { return false }
            return subhooks.contains { hook in
                let cmd = hook["command"] as? String
                if let target = hookCommand {
                    return cmd == target
                }
                return isOurs(command: cmd)
            }
        }
    }

    public static func installClaudeHook(homeDirectory: URL, hookCommand: String) throws {
        let url = claudeSettingsURL(homeDirectory: homeDirectory)
        var root = readJSON(at: url)
        var hooks = root["hooks"] as? [String: Any] ?? [:]
        let rawGroups = hooks["PreToolUse"] as? [[String: Any]] ?? []

        // Clean out existing leash hooks
        let filteredGroups: [[String: Any]] = rawGroups.compactMap { group in
            var updated = group
            guard let subhooks = group["hooks"] as? [[String: Any]] else { return nil }
            let kept = subhooks.filter { hook in
                let cmd = hook["command"] as? String
                return !isOurs(command: cmd) && cmd != hookCommand
            }
            if kept.isEmpty { return nil }
            updated["hooks"] = kept
            return updated
        }

        let ourHook: [String: Any] = [
            "type": "command",
            "command": hookCommand,
            "timeout": defaultTimeoutSeconds
        ]
        let ourGroup: [String: Any] = [
            "matcher": ".*",
            "hooks": [ourHook]
        ]

        hooks["PreToolUse"] = filteredGroups + [ourGroup]
        root["hooks"] = hooks
        try writeJSON(root, to: url)
    }

    public static func removeClaudeHook(homeDirectory: URL) throws {
        let url = claudeSettingsURL(homeDirectory: homeDirectory)
        var root = readJSON(at: url)
        guard var hooks = root["hooks"] as? [String: Any],
              let rawGroups = hooks["PreToolUse"] as? [[String: Any]] else {
            return
        }

        let filteredGroups: [[String: Any]] = rawGroups.compactMap { group in
            var updated = group
            guard let subhooks = group["hooks"] as? [[String: Any]] else { return nil }
            let kept = subhooks.filter { !isOurs(command: $0["command"] as? String) }
            if kept.isEmpty { return nil }
            updated["hooks"] = kept
            return updated
        }

        if filteredGroups.isEmpty {
            hooks.removeValue(forKey: "PreToolUse")
        } else {
            hooks["PreToolUse"] = filteredGroups
        }

        if hooks.isEmpty {
            root.removeValue(forKey: "hooks")
        } else {
            root["hooks"] = hooks
        }

        try writeJSON(root, to: url)
    }

    // MARK: - Cursor Hooks

    public static func isCursorHookInstalled(homeDirectory: URL, hookCommand: String? = nil) -> Bool {
        let url = cursorHooksURL(homeDirectory: homeDirectory)
        let dict = readJSON(at: url)
        guard let hooks = dict["hooks"] as? [String: Any] else { return false }

        return cursorEvents.allSatisfy { event in
            guard let entries = hooks[event] as? [[String: Any]] else { return false }
            return entries.contains { entry in
                let cmd = entry["command"] as? String
                let failClosed = (entry["failClosed"] as? Bool) ?? false
                if let target = hookCommand {
                    return cmd == target && failClosed
                }
                return isOurs(command: cmd) && failClosed
            }
        }
    }

    public static func installCursorHook(homeDirectory: URL, hookCommand: String) throws {
        let url = cursorHooksURL(homeDirectory: homeDirectory)
        var root = readJSON(at: url)
        root["version"] = root["version"] ?? 1

        var hooks = root["hooks"] as? [String: Any] ?? [:]
        for event in cursorEvents {
            let existing = hooks[event] as? [[String: Any]] ?? []
            let kept = existing.filter { entry in
                let cmd = entry["command"] as? String
                return !isOurs(command: cmd) && cmd != hookCommand
            }
            let ourEntry: [String: Any] = [
                "command": hookCommand,
                "timeout": defaultTimeoutSeconds,
                "failClosed": true
            ]
            hooks[event] = kept + [ourEntry]
        }

        root["hooks"] = hooks
        try writeJSON(root, to: url)
    }

    public static func removeCursorHook(homeDirectory: URL) throws {
        let url = cursorHooksURL(homeDirectory: homeDirectory)
        var root = readJSON(at: url)
        guard var hooks = root["hooks"] as? [String: Any] else { return }

        for event in cursorEvents {
            if let existing = hooks[event] as? [[String: Any]] {
                let kept = existing.filter { !isOurs(command: $0["command"] as? String) }
                if kept.isEmpty {
                    hooks.removeValue(forKey: event)
                } else {
                    hooks[event] = kept
                }
            }
        }

        if hooks.isEmpty {
            root.removeValue(forKey: "hooks")
        } else {
            root["hooks"] = hooks
        }

        try writeJSON(root, to: url)
    }

    // MARK: - Gemini Hooks

    public static func isGeminiHookInstalled(homeDirectory: URL, hookCommand: String? = nil) -> Bool {
        let url = geminiSettingsURL(homeDirectory: homeDirectory)
        let dict = readJSON(at: url)
        guard let hooks = dict["hooks"] as? [String: Any],
              let beforeTool = hooks["BeforeTool"] as? [[String: Any]] else {
            return false
        }

        return beforeTool.contains { group in
            guard let subhooks = group["hooks"] as? [[String: Any]] else { return false }
            return subhooks.contains { hook in
                let cmd = hook["command"] as? String
                let name = hook["name"] as? String
                if let target = hookCommand {
                    return cmd == target
                }
                return isOurs(command: cmd, name: name)
            }
        }
    }

    public static func installGeminiHook(homeDirectory: URL, hookCommand: String) throws {
        let url = geminiSettingsURL(homeDirectory: homeDirectory)
        var root = readJSON(at: url)
        var hooks = root["hooks"] as? [String: Any] ?? [:]
        let rawGroups = hooks["BeforeTool"] as? [[String: Any]] ?? []

        let filteredGroups: [[String: Any]] = rawGroups.compactMap { group in
            var updated = group
            guard let subhooks = group["hooks"] as? [[String: Any]] else { return nil }
            let kept = subhooks.filter { hook in
                let cmd = hook["command"] as? String
                let name = hook["name"] as? String
                return !isOurs(command: cmd, name: name) && cmd != hookCommand
            }
            if kept.isEmpty { return nil }
            updated["hooks"] = kept
            return updated
        }

        let ourHook: [String: Any] = [
            "type": "command",
            "name": "agentic-leash",
            "command": hookCommand,
            "timeout": geminiTimeoutMs
        ]
        let ourGroup: [String: Any] = [
            "matcher": ".*",
            "hooks": [ourHook]
        ]

        hooks["BeforeTool"] = filteredGroups + [ourGroup]
        root["hooks"] = hooks
        try writeJSON(root, to: url)
    }

    public static func removeGeminiHook(homeDirectory: URL) throws {
        let url = geminiSettingsURL(homeDirectory: homeDirectory)
        var root = readJSON(at: url)
        guard var hooks = root["hooks"] as? [String: Any],
              let rawGroups = hooks["BeforeTool"] as? [[String: Any]] else {
            return
        }

        let filteredGroups: [[String: Any]] = rawGroups.compactMap { group in
            var updated = group
            guard let subhooks = group["hooks"] as? [[String: Any]] else { return nil }
            let kept = subhooks.filter { hook in
                !isOurs(command: hook["command"] as? String, name: hook["name"] as? String)
            }
            if kept.isEmpty { return nil }
            updated["hooks"] = kept
            return updated
        }

        if filteredGroups.isEmpty {
            hooks.removeValue(forKey: "BeforeTool")
        } else {
            hooks["BeforeTool"] = filteredGroups
        }

        if hooks.isEmpty {
            root.removeValue(forKey: "hooks")
        } else {
            root["hooks"] = hooks
        }

        try writeJSON(root, to: url)
    }

    // MARK: - Antigravity Hooks

    public static func isAntigravityHookInstalled(homeDirectory: URL, hookCommand: String? = nil) -> Bool {
        let url = antigravityHooksURL(homeDirectory: homeDirectory)
        let dict = readJSON(at: url)
        guard let entry = dict["agentic-leash"] as? [String: Any],
              (entry["enabled"] as? Bool) != false,
              let preToolUse = entry["PreToolUse"] as? [[String: Any]] else {
            return false
        }

        return preToolUse.contains { group in
            guard let subhooks = group["hooks"] as? [[String: Any]] else { return false }
            return subhooks.contains { hook in
                let cmd = hook["command"] as? String
                if let target = hookCommand {
                    return cmd == target
                }
                return isOurs(command: cmd)
            }
        }
    }

    public static func installAntigravityHook(homeDirectory: URL, hookCommand: String) throws {
        let url = antigravityHooksURL(homeDirectory: homeDirectory)
        var root = readJSON(at: url)
        var entry = root["agentic-leash"] as? [String: Any] ?? [:]
        entry["enabled"] = true

        let ourHook: [String: Any] = [
            "type": "command",
            "command": hookCommand,
            "timeout": defaultTimeoutSeconds
        ]
        let ourGroup: [String: Any] = [
            "matcher": "*",
            "hooks": [ourHook]
        ]
        entry["PreToolUse"] = [ourGroup]
        root["agentic-leash"] = entry
        try writeJSON(root, to: url)
    }

    public static func removeAntigravityHook(homeDirectory: URL) throws {
        let url = antigravityHooksURL(homeDirectory: homeDirectory)
        var root = readJSON(at: url)
        root.removeValue(forKey: "agentic-leash")
        try writeJSON(root, to: url)
    }

    // MARK: - Codex Hooks

    public static func isCodexHookInstalled(homeDirectory: URL, hookCommand: String? = nil) -> Bool {
        let url = codexHooksURL(homeDirectory: homeDirectory)
        let dict = readJSON(at: url)
        guard let hooks = dict["hooks"] as? [String: Any],
              let preToolUse = hooks["PreToolUse"] as? [[String: Any]] else {
            return false
        }

        return preToolUse.contains { group in
            guard let subhooks = group["hooks"] as? [[String: Any]] else { return false }
            return subhooks.contains { hook in
                let cmd = hook["command"] as? String
                if let target = hookCommand {
                    return cmd == target
                }
                return isOurs(command: cmd)
            }
        }
    }

    public static func installCodexHook(homeDirectory: URL, hookCommand: String) throws {
        let url = codexHooksURL(homeDirectory: homeDirectory)
        var root = readJSON(at: url)
        var hooks = root["hooks"] as? [String: Any] ?? [:]
        let rawGroups = hooks["PreToolUse"] as? [[String: Any]] ?? []

        let filteredGroups: [[String: Any]] = rawGroups.compactMap { group in
            var updated = group
            guard let subhooks = group["hooks"] as? [[String: Any]] else { return nil }
            let kept = subhooks.filter { hook in
                let cmd = hook["command"] as? String
                return !isOurs(command: cmd) && cmd != hookCommand
            }
            if kept.isEmpty { return nil }
            updated["hooks"] = kept
            return updated
        }

        let ourHook: [String: Any] = [
            "type": "command",
            "command": hookCommand,
            "timeout": defaultTimeoutSeconds
        ]
        let ourGroup: [String: Any] = [
            "matcher": ".*",
            "hooks": [ourHook]
        ]

        hooks["PreToolUse"] = filteredGroups + [ourGroup]
        root["hooks"] = hooks
        try writeJSON(root, to: url)
    }

    public static func removeCodexHook(homeDirectory: URL) throws {
        let url = codexHooksURL(homeDirectory: homeDirectory)
        var root = readJSON(at: url)
        guard var hooks = root["hooks"] as? [String: Any],
              let rawGroups = hooks["PreToolUse"] as? [[String: Any]] else {
            return
        }

        let filteredGroups: [[String: Any]] = rawGroups.compactMap { group in
            var updated = group
            guard let subhooks = group["hooks"] as? [[String: Any]] else { return nil }
            let kept = subhooks.filter { !isOurs(command: $0["command"] as? String) }
            if kept.isEmpty { return nil }
            updated["hooks"] = kept
            return updated
        }

        if filteredGroups.isEmpty {
            hooks.removeValue(forKey: "PreToolUse")
        } else {
            hooks["PreToolUse"] = filteredGroups
        }

        if hooks.isEmpty {
            root.removeValue(forKey: "hooks")
        } else {
            root["hooks"] = hooks
        }

        try writeJSON(root, to: url)
    }

    // MARK: - Unified Agent Methods

    public static func isHookInstalled(agent: AgentType, homeDirectory: URL, hookCommand: String? = nil) -> Bool {
        switch agent {
        case .claudeCode:
            return isClaudeHookInstalled(homeDirectory: homeDirectory, hookCommand: hookCommand)
        case .cursor:
            return isCursorHookInstalled(homeDirectory: homeDirectory, hookCommand: hookCommand)
        case .gemini:
            return isGeminiHookInstalled(homeDirectory: homeDirectory, hookCommand: hookCommand)
        case .antigravity:
            return isAntigravityHookInstalled(homeDirectory: homeDirectory, hookCommand: hookCommand)
        case .codex:
            return isCodexHookInstalled(homeDirectory: homeDirectory, hookCommand: hookCommand)
        case .hermes, .opencode:
            return false
        }
    }

    public static func installHook(agent: AgentType, homeDirectory: URL, hookCommand: String) throws {
        switch agent {
        case .claudeCode:
            try installClaudeHook(homeDirectory: homeDirectory, hookCommand: hookCommand)
        case .cursor:
            try installCursorHook(homeDirectory: homeDirectory, hookCommand: hookCommand)
        case .gemini:
            try installGeminiHook(homeDirectory: homeDirectory, hookCommand: hookCommand)
        case .antigravity:
            try installAntigravityHook(homeDirectory: homeDirectory, hookCommand: hookCommand)
        case .codex:
            try installCodexHook(homeDirectory: homeDirectory, hookCommand: hookCommand)
        case .hermes, .opencode:
            break
        }
    }

    public static func removeHook(agent: AgentType, homeDirectory: URL) throws {
        switch agent {
        case .claudeCode:
            try removeClaudeHook(homeDirectory: homeDirectory)
        case .cursor:
            try removeCursorHook(homeDirectory: homeDirectory)
        case .gemini:
            try removeGeminiHook(homeDirectory: homeDirectory)
        case .antigravity:
            try removeAntigravityHook(homeDirectory: homeDirectory)
        case .codex:
            try removeCodexHook(homeDirectory: homeDirectory)
        case .hermes, .opencode:
            break
        }
    }

    // MARK: - Instance Conveniences

    public func isClaudeHookInstalled(hookCommand: String? = nil) -> Bool {
        Self.isClaudeHookInstalled(homeDirectory: homeDirectory, hookCommand: hookCommand)
    }

    public func installClaudeHook(hookCommand: String) throws {
        try Self.installClaudeHook(homeDirectory: homeDirectory, hookCommand: hookCommand)
    }

    public func removeClaudeHook() throws {
        try Self.removeClaudeHook(homeDirectory: homeDirectory)
    }

    public func isCursorHookInstalled(hookCommand: String? = nil) -> Bool {
        Self.isCursorHookInstalled(homeDirectory: homeDirectory, hookCommand: hookCommand)
    }

    public func installCursorHook(hookCommand: String) throws {
        try Self.installCursorHook(homeDirectory: homeDirectory, hookCommand: hookCommand)
    }

    public func removeCursorHook() throws {
        try Self.removeCursorHook(homeDirectory: homeDirectory)
    }

    public func isGeminiHookInstalled(hookCommand: String? = nil) -> Bool {
        Self.isGeminiHookInstalled(homeDirectory: homeDirectory, hookCommand: hookCommand)
    }

    public func installGeminiHook(hookCommand: String) throws {
        try Self.installGeminiHook(homeDirectory: homeDirectory, hookCommand: hookCommand)
    }

    public func removeGeminiHook() throws {
        try Self.removeGeminiHook(homeDirectory: homeDirectory)
    }

    public func isAntigravityHookInstalled(hookCommand: String? = nil) -> Bool {
        Self.isAntigravityHookInstalled(homeDirectory: homeDirectory, hookCommand: hookCommand)
    }

    public func installAntigravityHook(hookCommand: String) throws {
        try Self.installAntigravityHook(homeDirectory: homeDirectory, hookCommand: hookCommand)
    }

    public func removeAntigravityHook() throws {
        try Self.removeAntigravityHook(homeDirectory: homeDirectory)
    }

    public func isCodexHookInstalled(hookCommand: String? = nil) -> Bool {
        Self.isCodexHookInstalled(homeDirectory: homeDirectory, hookCommand: hookCommand)
    }

    public func installCodexHook(hookCommand: String) throws {
        try Self.installCodexHook(homeDirectory: homeDirectory, hookCommand: hookCommand)
    }

    public func removeCodexHook() throws {
        try Self.removeCodexHook(homeDirectory: homeDirectory)
    }

    public func isHookInstalled(agent: AgentType, hookCommand: String? = nil) -> Bool {
        Self.isHookInstalled(agent: agent, homeDirectory: homeDirectory, hookCommand: hookCommand)
    }

    public func installHook(agent: AgentType, hookCommand: String) throws {
        try Self.installHook(agent: agent, homeDirectory: homeDirectory, hookCommand: hookCommand)
    }

    public func removeHook(agent: AgentType) throws {
        try Self.removeHook(agent: agent, homeDirectory: homeDirectory)
    }
}
