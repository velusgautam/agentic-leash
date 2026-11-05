import SwiftUI
import LeashCore

public struct HistoryView: View {
    @Bindable public var appState: AppState
    @State private var selectedRow: HistoryRow? = nil

    public init(appState: AppState) {
        self.appState = appState
    }

    private var timeFormatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Stats summary strip at top
            StatsSummaryStrip(summary: appState.historySummary)
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 8)

            // Content split: History List + Detail Inspector
            HSplitView {
                historyList
                    .frame(minWidth: 400)

                if let selected = selectedRow {
                    detailInspector(selected)
                        .frame(minWidth: 280, maxWidth: 420)
                }
            }
        }
        .task {
            await appState.refreshHistory()
        }
    }

    private var historyList: some View {
        Group {
            if appState.historyEvents.isEmpty {
                VStack(spacing: 10) {
                    Spacer()
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 36))
                        .foregroundStyle(.tertiary)
                    Text("No History Records")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text("Historical events matching your filter will appear here.")
                        .font(.system(size: 12))
                        .foregroundStyle(.tertiary)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 3) {
                        ForEach(appState.historyEvents) { row in
                            historyRow(row)
                                .onTapGesture {
                                    if selectedRow?.id == row.id {
                                        selectedRow = nil
                                    } else {
                                        selectedRow = row
                                    }
                                }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                }
            }
        }
    }

    private func historyRow(_ row: HistoryRow) -> some View {
        let isSelected = selectedRow?.id == row.id
        let date = Date(timeIntervalSince1970: TimeInterval(row.ts) / 1000)
        let timeString = timeFormatter.string(from: date)

        return HStack(spacing: 10) {
            Text(timeString)
                .font(.system(size: 10.5, weight: .regular, design: .monospaced))
                .foregroundStyle(.tertiary)
                .frame(width: 120, alignment: .leading)

            AgentBadge(agent: row.agent)
                .frame(width: 105, alignment: .leading)

            KindBadge(kind: row.kind)
                .frame(width: 70, alignment: .leading)

            Text(row.path)
                .font(.system(size: 11.5, weight: .regular, design: .monospaced))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.middle)

            if let dest = row.destPath {
                Image(systemName: "arrow.right")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                Text(dest)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 8)

            if row.beforeText != nil || row.afterText != nil {
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            if row.sensitive {
                Text("SENSITIVE")
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(Color.orange)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1.5)
                    .background(Color.orange.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 3))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.14) : Color(nsColor: .controlBackgroundColor).opacity(0.35))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(isSelected ? Color.accentColor.opacity(0.4) : Color.secondary.opacity(0.08), lineWidth: 1)
        )
    }

    private func detailInspector(_ row: HistoryRow) -> some View {
        let date = Date(timeIntervalSince1970: TimeInterval(row.ts) / 1000)

        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Event Details")
                    .font(.system(size: 13, weight: .bold))
                Spacer()
                Button {
                    selectedRow = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    detailItem(title: "Time", value: timeFormatter.string(from: date))
                    detailItem(title: "Agent", value: row.agent)
                    detailItem(title: "Tool / Executable", value: row.exe)
                    detailItem(title: "Operation Kind", value: row.kind.uppercased())
                    detailItem(title: "Source Path", value: row.path)

                    if let dest = row.destPath {
                        detailItem(title: "Destination Path", value: dest)
                    }

                    if row.sensitive {
                        HStack(spacing: 4) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(Color.orange)
                            Text("Classified as Sensitive Path")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(Color.orange)
                        }
                        .padding(.top, 4)
                    }

                    // Diff view if beforeText or afterText exists
                    if row.beforeText != nil || row.afterText != nil {
                        Divider().padding(.vertical, 4)
                        Text("Modifications")
                            .font(.system(size: 12, weight: .bold))

                        if let before = row.beforeText {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Before:")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(.red)
                                Text(before)
                                    .font(.system(size: 11, design: .monospaced))
                                    .padding(8)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color.red.opacity(0.08))
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                        }

                        if let after = row.afterText {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("After:")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(.green)
                                Text(after)
                                    .font(.system(size: 11, design: .monospaced))
                                    .padding(8)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color.green.opacity(0.08))
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                        }
                    }
                }
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.7))
    }

    private func detailItem(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 11.5, weight: .regular, design: .monospaced))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        }
    }
}
