import Foundation

/// Verdict outcome for evaluating a hook request.
public enum DecisionVerdict: Equatable, Sendable {
    case pass(grantIds: [Int64] = [], autoAccept: Bool = false)
    case deny(reason: String)
    case prompt
}

/// Configuration options and environmental context for the DecisionEngine.
public struct DecisionOptions: Sendable {
    public var now: Int64
    public var lockdown: Bool
    public var autoAcceptUntil: Int64?
    public var autoAcceptAgent: String?
    public var grants: [Grant]
    public var allowRules: [AllowRule]
    public var blockRules: [BlockRule]
    public var safeCommands: Set<String>

    /// Default set of standard read-only commands that are safe to auto-pass.
    public static let defaultSafeCommands: Set<String> = [
        "pwd", "whoami", "id", "uname", "hostname", "date", "which",
        "git --version", "node --version", "python --version", "python3 --version",
        "npm --version", "pnpm --version", "yarn --version", "cargo --version",
        "rustc --version", "go version", "sw_vers", "echo", "true"
    ]

    public init(
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        lockdown: Bool = false,
        autoAcceptUntil: Int64? = nil,
        autoAcceptAgent: String? = nil,
        grants: [Grant] = [],
        allowRules: [AllowRule] = [],
        blockRules: [BlockRule] = [],
        safeCommands: Set<String> = DecisionOptions.defaultSafeCommands
    ) {
        self.now = now
        self.lockdown = lockdown
        self.autoAcceptUntil = autoAcceptUntil
        self.autoAcceptAgent = autoAcceptAgent
        self.grants = grants
        self.allowRules = allowRules
        self.blockRules = blockRules
        self.safeCommands = safeCommands
    }
}

/// Evaluates hook requests against active policies, grants, rules, and security modes.
public struct DecisionEngine: Sendable {

    /// Checks if a child filesystem path is equal to or inside a parent directory path.
    public static func isPathUnder(child: String, parent: String) -> Bool {
        let childStd = URL(fileURLWithPath: (child as NSString).expandingTildeInPath).standardized.path
        let parentStd = URL(fileURLWithPath: (parent as NSString).expandingTildeInPath).standardized.path
        if childStd == parentStd {
            return true
        }
        let prefix = parentStd.hasSuffix("/") ? parentStd : parentStd + "/"
        return childStd.hasPrefix(prefix)
    }

    /// Evaluates a hook request against current decision options.
    public static func evaluate(request: HookRequest, options: DecisionOptions) -> DecisionVerdict {
        // 1. Lockdown mode active
        if options.lockdown {
            return .deny(reason: "Lockdown mode active")
        }

        // 2. Block rules check
        for rule in options.blockRules {
            guard rule.agent == "*" || rule.agent == request.agent else { continue }
            let ruleKind = rule.kind.lowercased()
            if ruleKind == "command" {
                if let cmd = request.command?.trimmingCharacters(in: .whitespacesAndNewlines), !cmd.isEmpty {
                    if cmd == rule.value.trimmingCharacters(in: .whitespacesAndNewlines) {
                        return .deny(reason: "Blocked by block rule")
                    }
                }
            } else if ruleKind == "path" || ruleKind == "folder" {
                if request.paths.contains(where: { isPathUnder(child: $0, parent: rule.value) }) {
                    return .deny(reason: "Blocked by block rule")
                }
            }
        }

        // 3. Auto-accept mode check
        if let autoUntil = options.autoAcceptUntil, options.now < autoUntil {
            let agentOk = options.autoAcceptAgent == nil || options.autoAcceptAgent == "*" || options.autoAcceptAgent == request.agent
            if agentOk {
                return .pass(grantIds: [], autoAccept: true)
            }
        }

        // 4. Safe commands check
        if let cmd = request.command?.trimmingCharacters(in: .whitespacesAndNewlines), !cmd.isEmpty {
            if options.safeCommands.contains(cmd) {
                return .pass(grantIds: [], autoAccept: false)
            }
        }

        // 5. Allow rules check
        let activeAllowRules = options.allowRules.filter { $0.agent == "*" || $0.agent == request.agent }
        if let cmd = request.command?.trimmingCharacters(in: .whitespacesAndNewlines), !cmd.isEmpty {
            if activeAllowRules.contains(where: {
                $0.kind.lowercased() == "command" && $0.value.trimmingCharacters(in: .whitespacesAndNewlines) == cmd
            }) {
                return .pass(grantIds: [], autoAccept: false)
            }
        }
        if !request.paths.isEmpty {
            let folderRules = activeAllowRules.filter { $0.kind.lowercased() == "folder" || $0.kind.lowercased() == "path" }
            let allCovered = request.paths.allSatisfy { path in
                folderRules.contains(where: { isPathUnder(child: path, parent: $0.value) })
            }
            if allCovered && !folderRules.isEmpty {
                return .pass(grantIds: [], autoAccept: false)
            }
        }

        // 6. Active grants check
        let activeGrants = options.grants.filter { grant in
            guard grant.agent == "*" || grant.agent == request.agent else { return false }
            if let expiresAt = grant.expiresAt, expiresAt <= options.now {
                return false
            }
            if let grantSession = grant.sessionId, !grantSession.isEmpty {
                if grantSession != request.sessionId {
                    return false
                }
            }
            return true
        }

        // 6a. Command grant
        if let cmd = request.command?.trimmingCharacters(in: .whitespacesAndNewlines), !cmd.isEmpty {
            if let matchingGrant = activeGrants.first(where: {
                $0.command?.trimmingCharacters(in: .whitespacesAndNewlines) == cmd
            }) {
                return .pass(grantIds: [matchingGrant.id], autoAccept: false)
            }
        }

        // 6b. Path grants
        if !request.paths.isEmpty {
            let pathGrants = activeGrants.filter { $0.command == nil || $0.command?.isEmpty == true }
            var matchedGrantIds: Set<Int64> = []
            let allPathsCovered = request.paths.allSatisfy { reqPath in
                if let matchingGrant = pathGrants.first(where: { grant in
                    let accessOk = (request.access == .read) || (grant.access == .write)
                    return accessOk && isPathUnder(child: reqPath, parent: grant.path)
                }) {
                    matchedGrantIds.insert(matchingGrant.id)
                    return true
                }
                return false
            }
            if allPathsCovered && !matchedGrantIds.isEmpty {
                return .pass(grantIds: Array(matchedGrantIds).sorted(), autoAccept: false)
            }
        }

        // 7. Default prompt
        return .prompt
    }
}
