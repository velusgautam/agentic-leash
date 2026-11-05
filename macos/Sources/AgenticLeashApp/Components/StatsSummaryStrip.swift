import SwiftUI
import LeashCore

public struct StatsSummaryStrip: View {
    public let summary: HistorySummary?

    public init(summary: HistorySummary?) {
        self.summary = summary
    }

    private var numberFormatter: NumberFormatter {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter
    }

    private func formatNumber(_ num: Int) -> String {
        numberFormatter.string(from: NSNumber(value: num)) ?? "\(num)"
    }

    public var body: some View {
        HStack(spacing: 8) {
            Text("Today")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.primary)

            bullet

            // Total events
            HStack(spacing: 4) {
                Circle()
                    .fill(Color.blue)
                    .frame(width: 6, height: 6)
                Text("\(formatNumber(summary?.total ?? 0)) events")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            bullet

            // Sensitive events
            HStack(spacing: 4) {
                Circle()
                    .fill(Color.orange)
                    .frame(width: 6, height: 6)
                Text("\(formatNumber(summary?.sensitive ?? 0)) sensitive")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            bullet

            // Blocked events
            HStack(spacing: 4) {
                Circle()
                    .fill(Color.red)
                    .frame(width: 6, height: 6)
                Text("\(formatNumber(summary?.blocked ?? 0)) blocked")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            // Agent breakdowns
            if let stats = summary?.agentStats, !stats.isEmpty {
                ForEach(stats, id: \.agent) { stat in
                    bullet
                    agentStatView(stat)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.5))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(Color.secondary.opacity(0.15), lineWidth: 1)
        )
    }

    private var bullet: some View {
        Text("·")
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(.tertiary)
    }

    private func agentStatView(_ stat: AgentStat) -> some View {
        HStack(spacing: 6) {
            AgentBadge(agent: stat.agent)

            if stat.reads > 0 {
                HStack(spacing: 3) {
                    Circle().fill(Color.blue).frame(width: 5, height: 5)
                    Text("\(formatNumber(stat.reads)) reads")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }

            if stat.writes > 0 {
                HStack(spacing: 3) {
                    Circle().fill(Color.orange).frame(width: 5, height: 5)
                    Text("\(formatNumber(stat.writes)) writes")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }

            if stat.execs > 0 {
                HStack(spacing: 3) {
                    Circle().fill(Color.purple).frame(width: 5, height: 5)
                    Text("\(formatNumber(stat.execs)) execs")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }

            if stat.net > 0 {
                HStack(spacing: 3) {
                    Circle().fill(Color.teal).frame(width: 5, height: 5)
                    Text("\(formatNumber(stat.net)) net")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
