import SwiftUI
import LeashCore

public struct RulesView: View {
    @Bindable public var appState: AppState

    @State private var newAllowKind = "folder"
    @State private var newAllowAgent = "*"
    @State private var newAllowValue = ""

    @State private var newBlockAgent = "*"
    @State private var newBlockKind = "path"
    @State private var newBlockValue = ""

    public init(appState: AppState) {
        self.appState = appState
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Section 1: Active Grants
                grantsSection

                Divider()

                // Section 2: Allow Rules (Whitelist)
                allowRulesSection

                Divider()

                // Section 3: Block Rules (Blacklist)
                blockRulesSection
            }
            .padding(16)
        }
        .task {
            await appState.refreshGrantsAndRules()
        }
    }

    // MARK: - Active Grants Section

    private var grantsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Active Grants (\(appState.grants.count))", systemImage: "key.fill")
                    .font(.system(size: 14, weight: .bold))

                Spacer()

                if !appState.grants.isEmpty {
                    Button(role: .destructive) {
                        Task { await appState.revokeAll() }
                    } label: {
                        Text("Revoke All")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }

            if appState.grants.isEmpty {
                emptyPlaceholder(message: "No active grants. Approved sessions or paths will appear here.")
            } else {
                VStack(spacing: 6) {
                    ForEach(appState.grants) { grant in
                        grantRow(grant)
                    }
                }
            }
        }
    }

    private func grantRow(_ grant: Grant) -> some View {
        HStack(spacing: 8) {
            AgentBadge(agent: grant.agent)

            KindBadge(kind: grant.access.rawValue)

            Text(grant.path)
                .font(.system(size: 11.5, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)

            if let cmd = grant.command {
                Text("[\(cmd)]")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if let sid = grant.sessionId {
                Text("Session: \(sid.prefix(8))")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }

            Button {
                Task { await appState.revokeGrant(id: grant.id) }
            } label: {
                Text("Revoke")
                    .font(.system(size: 10.5, weight: .medium))
            }
            .buttonStyle(.bordered)
            .tint(.red)
            .controlSize(.mini)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.4))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.secondary.opacity(0.12), lineWidth: 0.8)
        )
    }

    // MARK: - Allow Rules Section

    private var allowRulesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Allow Rules (Whitelist)", systemImage: "checkmark.shield.fill")
                .font(.system(size: 14, weight: .bold))

            // Add new allow rule row
            HStack(spacing: 8) {
                Picker("Kind", selection: $newAllowKind) {
                    Text("Folder").tag("folder")
                    Text("Command").tag("command")
                }
                .frame(width: 100)

                Picker("Agent", selection: $newAllowAgent) {
                    Text("All (*)").tag("*")
                    ForEach(AgentType.allCases) { agent in
                        Text(agent.displayName).tag(agent.rawValue)
                    }
                }
                .frame(width: 130)

                TextField("Path or Command pattern...", text: $newAllowValue)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 11, design: .monospaced))

                Button("Add Rule") {
                    guard !newAllowValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                    let kind = newAllowKind
                    let agent = newAllowAgent
                    let val = newAllowValue
                    newAllowValue = ""
                    Task {
                        await appState.addAllowRule(kind: kind, agent: agent, value: val)
                    }
                }
                .controlSize(.regular)
                .disabled(newAllowValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if appState.allowRules.isEmpty {
                emptyPlaceholder(message: "No custom allow rules configured.")
            } else {
                VStack(spacing: 6) {
                    ForEach(appState.allowRules) { rule in
                        ruleRow(id: rule.id, kind: rule.kind, agent: rule.agent, value: rule.value, isBlock: false)
                    }
                }
            }
        }
    }

    // MARK: - Block Rules Section

    private var blockRulesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Block Rules (Deny List)", systemImage: "nosign")
                .font(.system(size: 14, weight: .bold))

            // Add new block rule row
            HStack(spacing: 8) {
                Picker("Kind", selection: $newBlockKind) {
                    Text("Path").tag("path")
                    Text("Command").tag("command")
                }
                .frame(width: 100)

                Picker("Agent", selection: $newBlockAgent) {
                    Text("All (*)").tag("*")
                    ForEach(AgentType.allCases) { agent in
                        Text(agent.displayName).tag(agent.rawValue)
                    }
                }
                .frame(width: 130)

                TextField("Path or Command to block...", text: $newBlockValue)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 11, design: .monospaced))

                Button("Add Block") {
                    guard !newBlockValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                    let kind = newBlockKind
                    let agent = newBlockAgent
                    let val = newBlockValue
                    newBlockValue = ""
                    Task {
                        await appState.addBlockRule(agent: agent, kind: kind, value: val)
                    }
                }
                .controlSize(.regular)
                .disabled(newBlockValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if appState.blockRules.isEmpty {
                emptyPlaceholder(message: "No block rules configured.")
            } else {
                VStack(spacing: 6) {
                    ForEach(appState.blockRules) { rule in
                        ruleRow(id: rule.id, kind: rule.kind, agent: rule.agent, value: rule.value, isBlock: true)
                    }
                }
            }
        }
    }

    private func ruleRow(id: Int64, kind: String, agent: String, value: String, isBlock: Bool) -> some View {
        HStack(spacing: 8) {
            Text(kind.uppercased())
                .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(isBlock ? Color.red.opacity(0.12) : Color.green.opacity(0.12))
                .foregroundStyle(isBlock ? Color.red : Color.green)
                .clipShape(RoundedRectangle(cornerRadius: 4))

            AgentBadge(agent: agent)

            Text(value)
                .font(.system(size: 11.5, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)

            Spacer()

            Button {
                Task {
                    if isBlock {
                        await appState.deleteBlockRule(id: id)
                    } else {
                        await appState.deleteAllowRule(id: id)
                    }
                }
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 11))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.4))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.secondary.opacity(0.12), lineWidth: 0.8)
        )
    }

    private func emptyPlaceholder(message: String) -> some View {
        HStack {
            Spacer()
            Text(message)
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color.secondary.opacity(0.05))
        )
    }
}
