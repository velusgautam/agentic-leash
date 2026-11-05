import SwiftUI
import LeashCore

public struct LiveActivityView: View {
    @Bindable public var appState: AppState

    public init(appState: AppState) {
        self.appState = appState
    }

    private var timeFormatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Decision Banner at top if there are pending requests
            if !appState.pendingRequests.isEmpty {
                DecisionBanner(requests: appState.pendingRequests) { id, verdict, once in
                    Task {
                        await appState.resolvePending(id: id, verdict: verdict, once: once)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }

            // Events Stream
            if appState.liveEvents.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(appState.liveEvents) { event in
                            eventRow(event)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "waveform.path.ecg")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)

            Text("Waiting for Agent Activity")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.secondary)

            Text("Hooks are active. When agents read, write, or execute commands, events will stream here live.")
                .font(.system(size: 12))
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func eventRow(_ event: HistoryRow) -> some View {
        let date = Date(timeIntervalSince1970: TimeInterval(event.ts) / 1000)
        let timeString = timeFormatter.string(from: date)

        return HStack(spacing: 10) {
            // Timestamp
            Text(timeString)
                .font(.system(size: 11, weight: .regular, design: .monospaced))
                .foregroundStyle(.tertiary)
                .frame(width: 58, alignment: .leading)

            // Agent Badge
            AgentBadge(agent: event.agent)
                .frame(width: 105, alignment: .leading)

            // Kind Badge
            KindBadge(kind: event.kind)
                .frame(width: 70, alignment: .leading)

            // Target Path / Command
            Text(event.path)
                .font(.system(size: 11.5, weight: .regular, design: .monospaced))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)

            Spacer(minLength: 8)

            // Sensitive indicator
            if event.sensitive {
                HStack(spacing: 3) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 9))
                    Text("SENSITIVE")
                        .font(.system(size: 9, weight: .bold))
                }
                .foregroundStyle(Color.orange)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(Color.orange.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 3))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.4))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(Color.secondary.opacity(0.1), lineWidth: 0.8)
        )
    }
}
