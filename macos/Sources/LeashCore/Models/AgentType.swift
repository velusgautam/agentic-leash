import Foundation

/// Represents the supported AI coding agents monitored or regulated by Agentic Leash.
public enum AgentType: String, CaseIterable, Identifiable, Codable, Sendable {
    case claudeCode = "claude-code"
    case cursor = "cursor"
    case gemini = "gemini"
    case antigravity = "antigravity"
    case codex = "codex"
    case hermes = "hermes"
    case opencode = "opencode"

    /// Unique identifier matching raw string value.
    public var id: String {
        rawValue
    }

    /// User-facing display name.
    public var displayName: String {
        switch self {
        case .claudeCode:
            return "Claude Code"
        case .cursor:
            return "Cursor"
        case .gemini:
            return "Gemini"
        case .antigravity:
            return "Antigravity"
        case .codex:
            return "Codex"
        case .hermes:
            return "Hermes"
        case .opencode:
            return "OpenCode"
        }
    }

    /// System SF Symbol icon name or custom asset identifier.
    public var iconName: String {
        switch self {
        case .claudeCode:
            return "sparkles"
        case .cursor:
            return "cursorarrow"
        case .gemini:
            return "sparkle"
        case .antigravity:
            return "shield.lefthalf.filled"
        case .codex:
            return "terminal"
        case .hermes:
            return "bolt"
        case .opencode:
            return "chevron.left.forwardslash.chevron.right"
        }
    }
}
