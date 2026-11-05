import SwiftUI
import LeashCore

public struct SettingsView: View {
    @Bindable public var appState: AppState

    public init(appState: AppState) {
        self.appState = appState
    }

    private let supportedAgents: [AgentType] = [
        .claudeCode,
        .cursor,
        .gemini,
        .antigravity,
        .codex
    ]

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // Agent Hook Integrations
                VStack(alignment: .leading, spacing: 12) {
                    Label("Agent Integrations", systemImage: "puzzlepiece.extension")
                        .font(.system(size: 15, weight: .bold))

                    Text("Install hooks into each coding agent's configuration so tool calls and shell operations route through Agentic Leash.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)

                    VStack(spacing: 8) {
                        ForEach(supportedAgents) { agent in
                            agentRow(agent)
                        }
                    }
                }

                Divider()

                // Broker & Daemon Settings
                VStack(alignment: .leading, spacing: 12) {
                    Label("IPC Broker & Storage", systemImage: "server.rack")
                        .font(.system(size: 15, weight: .bold))

                    VStack(alignment: .leading, spacing: 8) {
                        settingPathItem(
                            title: "Unix Domain Socket",
                            subtitle: "Hooks connect to this socket to verify permissions synchronously",
                            value: appState.socketPath ?? AppState.defaultSocketURL.path
                        )

                        settingPathItem(
                            title: "SQLite Database",
                            subtitle: "Persistent store for grants, rules, audit history, and aggregated statistics",
                            value: AppState.defaultDatabaseURL.path
                        )
                    }
                }

                Divider()

                // Default Safe Commands Whitelist
                VStack(alignment: .leading, spacing: 10) {
                    Label("Safe Commands (Auto-Pass)", systemImage: "checkmark.seal")
                        .font(.system(size: 15, weight: .bold))

                    Text("These standard inspection commands automatically pass without prompting user intervention:")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)

                    FlowLayout(spacing: 6) {
                        ForEach(Array(DecisionOptions.defaultSafeCommands).sorted(), id: \.self) { cmd in
                            Text(cmd)
                                .font(.system(size: 11, design: .monospaced))
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(Color.secondary.opacity(0.12))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                    }
                }
            }
            .padding(18)
        }
    }

    private func agentRow(_ agent: AgentType) -> some View {
        let isInstalled = appState.isHookInstalled(for: agent)
        let configPath = AgentHookManager.hookFileURL(agent: agent, homeDirectory: appState.hookManager.homeDirectory).path

        return HStack(spacing: 12) {
            AgentBadge(agentType: agent)
                .frame(width: 120, alignment: .leading)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(isInstalled ? Color.green : Color.secondary.opacity(0.4))
                        .frame(width: 7, height: 7)

                    Text(isInstalled ? "Hook Active" : "Not Configured")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(isInstalled ? Color.green : Color.secondary)
                }

                Text(configPath)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer()

            Button {
                appState.toggleHook(for: agent)
            } label: {
                Text(isInstalled ? "Uninstall Hook" : "Install Hook")
                    .font(.system(size: 11.5, weight: .medium))
            }
            .buttonStyle(.bordered)
            .tint(isInstalled ? .red : .accentColor)
            .controlSize(.regular)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.45))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.secondary.opacity(0.12), lineWidth: 0.8)
        )
    }

    private func settingPathItem(title: String, subtitle: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
            Text(subtitle)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 11, design: .monospaced))
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(nsColor: .textBackgroundColor).opacity(0.6))
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(Color.secondary.opacity(0.15), lineWidth: 0.8)
                )
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.3))
        )
    }
}

/// Simple flow layout view for displaying wrapped tags or commands
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 0
        var height: CGFloat = 0
        var x: CGFloat = 0
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > width && x > 0 {
                x = 0
                height += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        height += rowHeight
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX && x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
