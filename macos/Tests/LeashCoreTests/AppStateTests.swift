import Foundation
import Testing
@testable import LeashCore

@Suite("AppState Tests")
struct AppStateTests {

    @Test("AppState initializes with default values and navigation")
    @MainActor
    func testInitialization() async {
        let state = AppState()
        #expect(state.selectedNavigation == .live)
        #expect(state.autoAcceptMode == false)
        #expect(state.autoAcceptUntil == nil)
        #expect(state.lockdown == false)
        #expect(state.pendingRequests.isEmpty)
        #expect(state.liveEvents.isEmpty)
        #expect(state.historyEvents.isEmpty)
        #expect(state.historySummary == nil)
        #expect(state.activeGrantsCount == 0)
        #expect(state.selectedAgentFilter == nil)
        #expect(state.selectedKindFilter == nil)
        #expect(state.selectedTimeFilter == "Any time")
        #expect(state.pathSearchQuery == "")
        #expect(state.isPaused == false)
        #expect(state.showSensitiveOnly == false)
        #expect(state.showTempAndExecs == true)
    }

    @Test("Auto-accept and lockdown toggles")
    @MainActor
    func testModeToggles() async {
        let state = AppState()

        state.toggleAutoAcceptMode()
        #expect(state.autoAcceptMode == true)
        #expect(state.autoAcceptUntil != nil)

        state.toggleLockdown()
        #expect(state.lockdown == true)
        #expect(state.autoAcceptMode == false)
        #expect(state.autoAcceptUntil == nil)

        state.toggleLockdown()
        #expect(state.lockdown == false)

        state.togglePause()
        #expect(state.isPaused == true)
        state.togglePause()
        #expect(state.isPaused == false)
    }

    @Test("Rules and Grants management via AppState")
    @MainActor
    func testRulesAndGrants() async throws {
        let state = AppState()

        await state.addAllowRule(kind: "folder", agent: "claude-code", value: "/Users/alice/project")
        #expect(state.allowRules.count == 1)
        #expect(state.allowRules.first?.value == "/Users/alice/project")

        if let ruleId = state.allowRules.first?.id {
            await state.deleteAllowRule(id: ruleId)
            #expect(state.allowRules.isEmpty)
        }

        await state.addBlockRule(agent: "*", kind: "command", value: "rm -rf /")
        #expect(state.blockRules.count == 1)
        #expect(state.blockRules.first?.value == "rm -rf /")

        if let blockId = state.blockRules.first?.id {
            await state.deleteBlockRule(id: blockId)
            #expect(state.blockRules.isEmpty)
        }
    }

    @Test("Live events buffering and pause control")
    @MainActor
    func testLiveEvents() async {
        let state = AppState()

        let row1 = HistoryRow(id: 1, ts: 1000, agent: "cursor", exe: "shell", kind: "exec", path: "git status")
        let row2 = HistoryRow(id: 2, ts: 2000, agent: "gemini", exe: "read", kind: "read", path: "/path/to/file")

        state.addLiveEvent(row1)
        #expect(state.liveEvents.count == 1)
        #expect(state.liveEvents.first?.id == 1)

        state.addLiveEvent(row2)
        #expect(state.liveEvents.count == 2)
        #expect(state.liveEvents.first?.id == 2) // newest first

        state.togglePause()
        let row3 = HistoryRow(id: 3, ts: 3000, agent: "antigravity", exe: "write", kind: "write", path: "/test")
        state.addLiveEvent(row3)
        #expect(state.liveEvents.count == 2) // ignored while paused
    }

    @Test("Pending requests resolution and history recording")
    @MainActor
    func testPendingResolution() async throws {
        let state = AppState()

        let hookReq = HookRequest(
            agent: "claude-code",
            event: "preToolUse",
            tool: "write_file",
            access: .write,
            paths: ["/Users/alice/repo/src/index.ts"],
            cwd: "/Users/alice/repo"
        )
        let pending = PendingRequest(id: "req-1", request: hookReq, askedAt: 123456789)
        state.pendingRequests = [pending]

        await state.resolvePending(id: "req-1", verdict: .pass, once: false)
        #expect(state.pendingRequests.isEmpty)
        #expect(state.activeGrantsCount == 1)
        #expect(state.liveEvents.count == 1)
        #expect(state.liveEvents.first?.kind == "write")

        // Revoke all
        await state.revokeAll()
        #expect(state.activeGrantsCount == 0)
    }

    @Test("History filtering by agent, kind, and sensitive")
    @MainActor
    func testHistoryFiltering() async throws {
        let state = AppState()

        _ = try await state.storage.insertHistory(
            ts: 100000,
            agent: "claude-code",
            exe: "read",
            kind: "read",
            path: "/Users/alice/.aws/credentials",
            sensitive: true
        )

        _ = try await state.storage.insertHistory(
            ts: 200000,
            agent: "cursor",
            exe: "write",
            kind: "write",
            path: "/Users/alice/repo/app.ts",
            sensitive: false
        )

        await state.refreshHistory()
        #expect(state.historyEvents.count == 2)

        state.selectedAgentFilter = .claudeCode
        await state.refreshHistory()
        #expect(state.historyEvents.count == 1)
        #expect(state.historyEvents.first?.agent == "claude-code")

        state.selectedAgentFilter = nil
        state.showSensitiveOnly = true
        await state.refreshHistory()
        #expect(state.historyEvents.count == 1)
        #expect(state.historyEvents.first?.sensitive == true)
    }
}
