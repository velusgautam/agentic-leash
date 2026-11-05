import SwiftUI
import LeashCore

public struct KindBadge: View {
    public let kind: String

    public init(kind: String) {
        self.kind = kind
    }

    public init(eventKind: EventKind) {
        self.kind = eventKind.rawValue
    }

    private var normalized: String {
        kind.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var iconName: String {
        switch normalized {
        case "read":
            return "eye.fill"
        case "write":
            return "pencil"
        case "exec":
            return "terminal.fill"
        case "net":
            return "globe"
        case "create":
            return "plus.circle.fill"
        case "delete":
            return "trash.fill"
        case "rename":
            return "arrow.triangle.2.circlepath"
        case "deny", "blocked":
            return "xmark.octagon.fill"
        default:
            return "gearshape.fill"
        }
    }

    private var color: Color {
        switch normalized {
        case "read":
            return Color.blue
        case "write":
            return Color.orange
        case "exec":
            return Color.purple
        case "net":
            return Color.teal
        case "create":
            return Color.green
        case "delete", "deny", "blocked":
            return Color.red
        case "rename":
            return Color.indigo
        default:
            return Color.secondary
        }
    }

    public var body: some View {
        HStack(spacing: 4) {
            Image(systemName: iconName)
                .font(.system(size: 9, weight: .bold))
            Text(normalized.uppercased())
                .font(.system(size: 9.5, weight: .bold, design: .monospaced))
        }
        .foregroundStyle(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 2.5)
        .background(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(color.opacity(0.12))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .stroke(color.opacity(0.25), lineWidth: 0.8)
        )
    }
}
