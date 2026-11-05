import SwiftUI
import LeashCore

public struct AppLayout: View {
    @Bindable public var appState: AppState

    public init(appState: AppState) {
        self.appState = appState
    }

    public var body: some View {
        NavigationSplitView {
            SidebarView(appState: appState)
        } detail: {
            VStack(spacing: 0) {
                HeaderControlsView(appState: appState)

                Divider()

                detailContent
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    @ViewBuilder
    private var detailContent: some View {
        switch appState.selectedNavigation {
        case .live:
            LiveActivityView(appState: appState)
        case .history:
            HistoryView(appState: appState)
        case .rules:
            RulesView(appState: appState)
        case .settings:
            SettingsView(appState: appState)
        }
    }
}
