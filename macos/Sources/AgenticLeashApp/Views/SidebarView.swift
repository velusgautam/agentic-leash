import SwiftUI
import LeashCore

public struct SidebarView: View {
    @Bindable public var appState: AppState

    public init(appState: AppState) {
        self.appState = appState
    }

    public var body: some View {
        VStack(spacing: 0) {
            // App Branding Header
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [Color.blue, Color.cyan],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 32, height: 32)

                    Image(systemName: "shield.lefthalf.filled")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text("Agentic Leash")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.primary)

                    HStack(spacing: 5) {
                        Circle()
                            .fill(appState.lockdown ? Color.red : (appState.autoAcceptMode ? Color.yellow : Color.green))
                            .frame(width: 6, height: 6)
                        Text(statusText)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 12)

            Divider()
                .padding(.horizontal, 10)

            // Navigation Items List
            List(selection: $appState.selectedNavigation) {
                Section {
                    ForEach(NavigationItem.allCases) { item in
                        NavigationLink(value: item) {
                            HStack(spacing: 8) {
                                Image(systemName: item.iconName)
                                    .font(.system(size: 13, weight: .medium))
                                    .frame(width: 18)

                                Text(item.title)
                                    .font(.system(size: 13, weight: .medium))

                                Spacer()

                                if item == .live && !appState.pendingRequests.isEmpty {
                                    Text("\(appState.pendingRequests.count)")
                                        .font(.system(size: 10, weight: .bold))
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Capsule().fill(Color.orange))
                                } else if item == .rules && appState.activeGrantsCount > 0 {
                                    Text("\(appState.activeGrantsCount)")
                                        .font(.system(size: 10, weight: .semibold))
                                        .foregroundStyle(.secondary)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Capsule().fill(Color.secondary.opacity(0.18)))
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }
            }
            .listStyle(.sidebar)

            Spacer(minLength: 0)

            Divider()
                .padding(.horizontal, 10)

            // Bottom Daemon / Socket Status
            HStack(spacing: 6) {
                Image(systemName: "circle.fill")
                    .font(.system(size: 6))
                    .foregroundStyle(appState.isBootstrapped ? Color.green : Color.orange)

                Text(appState.isBootstrapped ? "Socket Broker Active" : "Initializing...")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)

                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .frame(minWidth: 200, idealWidth: 220, maxWidth: 260)
    }

    private var statusText: String {
        if appState.lockdown {
            return "Lockdown Active"
        }
        if appState.autoAcceptMode {
            return "Auto Accept On"
        }
        return "Protected"
    }
}
