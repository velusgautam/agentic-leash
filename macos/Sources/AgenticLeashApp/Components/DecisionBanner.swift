import SwiftUI
import LeashCore

public struct DecisionBanner: View {
    public let requests: [PendingRequest]
    public let onResolve: (String, VerdictKind, Bool) -> Void

    public init(
        requests: [PendingRequest],
        onResolve: @escaping (String, VerdictKind, Bool) -> Void
    ) {
        self.requests = requests
        self.onResolve = onResolve
    }

    public var body: some View {
        if requests.isEmpty {
            EmptyView()
        } else {
            VStack(spacing: 10) {
                ForEach(requests) { req in
                    card(for: req)
                }
            }
            .padding(.bottom, 4)
        }
    }

    private func card(for req: PendingRequest) -> some View {
        let pathOrCommand = req.request.command
            ?? req.request.paths.first
            ?? req.request.url
            ?? "(no target specified)"

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.shield.fill")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Color.amber)
                    Text("Permission Requested")
                        .font(.system(size: 13, weight: .semibold))
                }

                Spacer()

                AgentBadge(agent: req.request.agent)

                KindBadge(kind: req.request.access.rawValue)

                Text(req.request.tool)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.secondary.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            }

            // Target path or command box
            HStack {
                Text(pathOrCommand)
                    .font(.system(size: 12, weight: .regular, design: .monospaced))
                    .lineLimit(3)
                    .textSelection(.enabled)
                Spacer()
            }
            .padding(8)
            .background(Color(nsColor: .textBackgroundColor).opacity(0.6))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
            )

            // Action Buttons
            HStack(spacing: 8) {
                Spacer()

                Button {
                    onResolve(req.id, .pass, true)
                } label: {
                    Label("Allow Once", systemImage: "clock.arrow.circlepath")
                        .font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.regular)

                Button {
                    onResolve(req.id, .pass, false)
                } label: {
                    Label("Allow Session", systemImage: "checkmark.shield")
                        .font(.system(size: 12, weight: .semibold))
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
                .controlSize(.regular)

                Button(role: .destructive) {
                    onResolve(req.id, .deny, false)
                } label: {
                    Label("Deny", systemImage: "xmark.shield")
                        .font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .controlSize(.regular)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(color: Color.black.opacity(0.08), radius: 4, x: 0, y: 2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.amber.opacity(0.4), lineWidth: 1.2)
        )
    }
}

private extension Color {
    static let amber = Color(red: 0.95, green: 0.65, blue: 0.15)
}
