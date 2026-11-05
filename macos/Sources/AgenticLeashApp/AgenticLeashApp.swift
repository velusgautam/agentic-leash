import SwiftUI
import LeashCore

@main
struct AgenticLeashApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            AppLayout(appState: appState)
                .frame(minWidth: 1000, minHeight: 650)
                .task {
                    await appState.bootstrap()
                }
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)

        MenuBarExtra {
            VStack(alignment: .leading, spacing: 6) {
                if !appState.pendingRequests.isEmpty {
                    Text("⚠️ \(appState.pendingRequests.count) Permission(s) Pending")
                        .font(.headline)
                    Divider()
                }

                Button(appState.autoAcceptMode ? "Disable Auto Accept" : "Enable Auto Accept (15m)") {
                    appState.toggleAutoAcceptMode()
                }

                Button(appState.lockdown ? "Disable Lockdown" : "Enable Lockdown") {
                    appState.toggleLockdown()
                }

                Divider()

                Button("Revoke All Grants (\(appState.activeGrantsCount))") {
                    Task {
                        await appState.revokeAll()
                    }
                }
                .disabled(appState.activeGrantsCount == 0)

                Divider()

                Button("Quit Agentic Leash") {
                    NSApplication.shared.terminate(nil)
                }
                .keyboardShortcut("q")
            }
        } label: {
            let iconName = appState.lockdown ? "lock.shield.fill" : (appState.autoAcceptMode ? "bolt.fill" : "shield.lefthalf.filled")
            Image(systemName: iconName)
        }
    }
}
