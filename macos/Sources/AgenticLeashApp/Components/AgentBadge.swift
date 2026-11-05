import SwiftUI
import LeashCore

public struct AgentBadge: View {
    public let agentName: String

    public init(agent: String) {
        self.agentName = agent
    }

    public init(agentType: AgentType) {
        self.agentName = agentType.displayName
    }

    private var normalized: String {
        agentName.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var displayName: String {
        if let agent = AgentType(rawValue: normalized) {
            return agent.displayName
        }
        if normalized == "claude" || normalized.contains("claude") {
            return "Claude Code"
        }
        if normalized == "cursor" {
            return "Cursor"
        }
        if normalized.contains("gemini") {
            return "Gemini"
        }
        if normalized.contains("antigravity") {
            return "Antigravity"
        }
        if normalized.contains("codex") {
            return "Codex"
        }
        return agentName
    }

    private var iconName: String {
        if let agent = AgentType(rawValue: normalized) {
            return agent.iconName
        }
        if normalized.contains("claude") {
            return "sparkles"
        }
        if normalized.contains("cursor") {
            return "cursorarrow"
        }
        if normalized.contains("gemini") {
            return "sparkle"
        }
        if normalized.contains("antigravity") {
            return "shield.lefthalf.filled"
        }
        if normalized.contains("codex") {
            return "terminal"
        }
        return "cpu"
    }

    private var themeColor: Color {
        if normalized.contains("claude") {
            return Color(red: 0.88, green: 0.44, blue: 0.22)
        }
        if normalized.contains("cursor") {
            return Color(red: 0.15, green: 0.65, blue: 0.95)
        }
        if normalized.contains("gemini") {
            return Color(red: 0.42, green: 0.52, blue: 0.96)
        }
        if normalized.contains("antigravity") {
            return Color(red: 0.18, green: 0.76, blue: 0.56)
        }
        if normalized.contains("codex") {
            return Color(red: 0.28, green: 0.72, blue: 0.42)
        }
        return Color.secondary
    }

    public var body: some View {
        HStack(spacing: 5) {
            Image(systemName: iconName)
                .font(.system(size: 10, weight: .semibold))
            Text(displayName)
                .font(.system(size: 11, weight: .medium))
        }
        .foregroundStyle(themeColor)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(themeColor.opacity(0.12))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(themeColor.opacity(0.25), lineWidth: 1)
        )
    }
}
