import SwiftUI
import LeashCore

public struct HeaderControlsView: View {
    @Bindable public var appState: AppState

    public init(appState: AppState) {
        self.appState = appState
    }

    public var body: some View {
        VStack(spacing: 8) {
            // Mode Buttons Row
            HStack(spacing: 10) {
                // Current section label
                Text(appState.selectedNavigation.title)
                    .font(.system(size: 18, weight: .bold))

                Spacer()

                // Auto Accept Mode Button
                Button {
                    appState.toggleAutoAcceptMode()
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "bolt.fill")
                            .font(.system(size: 11, weight: .semibold))
                        Text(appState.autoAcceptMode ? "Auto Accept (On)" : "Auto Accept Mode")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                }
                .buttonStyle(.bordered)
                .tint(appState.autoAcceptMode ? .yellow : .secondary)

                // Lockdown Button
                Button {
                    appState.toggleLockdown()
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "lock.shield.fill")
                            .font(.system(size: 11, weight: .semibold))
                        Text(appState.lockdown ? "Lockdown (Active)" : "Lockdown")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                }
                .buttonStyle(.bordered)
                .tint(appState.lockdown ? .red : .secondary)

                // Revoke All Button
                Button {
                    Task {
                        await appState.revokeAll()
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "shield.slash.fill")
                            .font(.system(size: 11, weight: .semibold))
                        Text("Revoke (\(appState.activeGrantsCount))")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .disabled(appState.activeGrantsCount == 0)
            }

            // Filter Bar Row (only for Live and History)
            if appState.selectedNavigation == .live || appState.selectedNavigation == .history {
                filterBar
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                // Pause / Resume
                Button {
                    appState.togglePause()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: appState.isPaused ? "play.fill" : "pause.fill")
                            .font(.system(size: 10, weight: .bold))
                        Text(appState.isPaused ? "Resume" : "Pause")
                            .font(.system(size: 11, weight: .medium))
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(appState.isPaused ? .orange : .secondary)

                Divider()
                    .frame(height: 16)

                // Agent filter pills
                agentPill(title: "All agents", agent: nil)
                agentPill(title: "Claude", agent: .claudeCode)
                agentPill(title: "Cursor", agent: .cursor)
                agentPill(title: "Gemini CLI", agent: .gemini)
                agentPill(title: "Antigravity", agent: .antigravity)
                agentPill(title: "Codex", agent: .codex)

                Divider()
                    .frame(height: 16)

                // All kinds menu
                Menu {
                    Button("All kinds") {
                        appState.selectedKindFilter = nil
                        triggerRefresh()
                    }
                    Divider()
                    ForEach(EventKind.allCases, id: \.self) { kind in
                        Button(kind.rawValue.capitalized) {
                            appState.selectedKindFilter = kind
                            triggerRefresh()
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(appState.selectedKindFilter?.rawValue.capitalized ?? "All kinds")
                            .font(.system(size: 11, weight: .medium))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .bold))
                    }
                }
                .menuStyle(.borderlessButton)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.secondary.opacity(0.12))
                )

                // Time window menu
                Menu {
                    ForEach(["Any time", "Today", "Last 1h", "Last 24h", "Last 7d"], id: \.self) { time in
                        Button(time) {
                            appState.selectedTimeFilter = time
                            triggerRefresh()
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(appState.selectedTimeFilter)
                            .font(.system(size: 11, weight: .medium))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .bold))
                    }
                }
                .menuStyle(.borderlessButton)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.secondary.opacity(0.12))
                )

                // Search Bar
                HStack(spacing: 5) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    TextField("Filter by path...", text: $appState.pathSearchQuery)
                        .textFieldStyle(.plain)
                        .font(.system(size: 11))
                        .frame(width: 140)
                        .onSubmit {
                            triggerRefresh()
                        }

                    if !appState.pathSearchQuery.isEmpty {
                        Button {
                            appState.pathSearchQuery = ""
                            triggerRefresh()
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color(nsColor: .controlBackgroundColor))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
                )

                // Sensitive Toggle Pill
                Button {
                    appState.showSensitiveOnly.toggle()
                    triggerRefresh()
                } label: {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(appState.showSensitiveOnly ? Color.orange : Color.secondary.opacity(0.5))
                            .frame(width: 5, height: 5)
                        Text("Sensitive")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                }
                .buttonStyle(.plain)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(appState.showSensitiveOnly ? Color.orange.opacity(0.15) : Color.secondary.opacity(0.1))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(appState.showSensitiveOnly ? Color.orange.opacity(0.4) : Color.clear, lineWidth: 1)
                )

                // Show Temp & Execs Toggle Pill
                Button {
                    appState.showTempAndExecs.toggle()
                    triggerRefresh()
                } label: {
                    Text("Temp & Execs")
                        .font(.system(size: 11, weight: .medium))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                }
                .buttonStyle(.plain)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(appState.showTempAndExecs ? Color.blue.opacity(0.15) : Color.secondary.opacity(0.1))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(appState.showTempAndExecs ? Color.blue.opacity(0.4) : Color.clear, lineWidth: 1)
                )
            }
        }
    }

    private func agentPill(title: String, agent: AgentType?) -> some View {
        let isSelected = appState.selectedAgentFilter == agent
        return Button {
            appState.selectedAgentFilter = agent
            triggerRefresh()
        } label: {
            Text(title)
                .font(.system(size: 11, weight: isSelected ? .semibold : .medium))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .foregroundStyle(isSelected ? Color.white : Color.primary)
                .background(
                    Capsule()
                        .fill(isSelected ? Color.accentColor : Color.secondary.opacity(0.12))
                )
        }
        .buttonStyle(.plain)
    }

    private func triggerRefresh() {
        Task {
            await appState.refreshHistory()
        }
    }
}
