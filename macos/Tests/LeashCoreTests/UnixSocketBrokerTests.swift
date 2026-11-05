import Testing
import Foundation
@testable import LeashCore

@Suite("UnixSocketBroker Tests")
struct UnixSocketBrokerTests {

    private func createUniqueSocketPath() -> String {
        let unique = UUID().uuidString.prefix(8)
        return "/tmp/leash-test-\(unique).sock"
    }

    @Test("Broker starts, accepts request, pauses on pending, and responds on decide")
    func testBrokerRequestLifecycle() async throws {
        let socketPath = createUniqueSocketPath()
        let broker = UnixSocketBroker()

        try await broker.start(socketPath: socketPath)
        let isRunning = await broker.checkIsRunning()
        #expect(isRunning == true)

        let testRequest = HookRequest(
            agent: "claude-code",
            event: "preToolUse",
            tool: "Bash",
            access: .write,
            paths: ["/tmp/app.js"],
            cwd: "/tmp",
            command: "node /tmp/app.js"
        )
        let message = BrokerIncomingMessage(id: "msg-1", request: testRequest)

        // Run client send in a detached task because it blocks waiting for response
        let clientTask = Task.detached {
            try UnixSocketBroker.sendClientRequest(socketPath: socketPath, message: message)
        }

        // Wait briefly for broker to receive message and put it into pending
        for _ in 0..<30 {
            let pending = await broker.getPending()
            if !pending.isEmpty { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        let pendingList = await broker.getPending()
        #expect(pendingList.count == 1)
        #expect(pendingList.first?.id == "msg-1")

        // User decides to allow
        await broker.decide(id: "msg-1", decision: .pass)

        let response = try await clientTask.value
        #expect(response.id == "msg-1")
        #expect(response.decision == "allow")

        let afterPending = await broker.getPending()
        #expect(afterPending.isEmpty)

        await broker.stop()
    }

    @Test("Once-allow cache remembers decision for identical requests")
    func testOnceAllowCache() async throws {
        let socketPath = createUniqueSocketPath()
        let broker = UnixSocketBroker()
        try await broker.start(socketPath: socketPath)

        let testRequest = HookRequest(
            agent: "cursor",
            event: "preToolUse",
            tool: "Read",
            access: .read,
            paths: ["/Users/dev/file.txt"],
            cwd: "/Users/dev"
        )
        let message1 = BrokerIncomingMessage(id: "req-once-1", request: testRequest)

        let clientTask1 = Task.detached {
            try UnixSocketBroker.sendClientRequest(socketPath: socketPath, message: message1)
        }

        for _ in 0..<30 {
            let pending = await broker.getPending()
            if !pending.isEmpty { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        // Decide with once = true
        await broker.decide(id: "req-once-1", decision: .pass, ttlSeconds: 15, once: true)
        let res1 = try await clientTask1.value
        #expect(res1.decision == "allow")

        // Second request with same attributes but different message id
        let message2 = BrokerIncomingMessage(id: "req-once-2", request: testRequest)
        let res2 = try UnixSocketBroker.sendClientRequest(socketPath: socketPath, message: message2)
        #expect(res2.decision == "allow")

        let pending = await broker.getPending()
        #expect(pending.isEmpty)

        await broker.stop()
    }

    @Test("Denial cache rejects identical requests without prompting")
    func testDenialCacheAndUndo() async throws {
        let socketPath = createUniqueSocketPath()
        let broker = UnixSocketBroker()
        try await broker.start(socketPath: socketPath)

        let testRequest = HookRequest(
            agent: "claude-code",
            event: "preToolUse",
            tool: "Bash",
            access: .write,
            paths: [],
            cwd: "/tmp",
            command: "rm -rf ~/.config"
        )
        let message1 = BrokerIncomingMessage(id: "deny-1", request: testRequest)

        let clientTask1 = Task.detached {
            try UnixSocketBroker.sendClientRequest(socketPath: socketPath, message: message1)
        }

        for _ in 0..<30 {
            let pending = await broker.getPending()
            if !pending.isEmpty { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        // Decide to deny
        await broker.decide(id: "deny-1", decision: .deny, ttlSeconds: 600)
        let res1 = try await clientTask1.value
        #expect(res1.decision == "deny")

        let denials = await broker.listDenials()
        #expect(denials.count == 1)
        #expect(denials.first?.agent == "claude-code")

        // Subsequent identical request is auto-denied
        let message2 = BrokerIncomingMessage(id: "deny-2", request: testRequest)
        let res2 = try UnixSocketBroker.sendClientRequest(socketPath: socketPath, message: message2)
        #expect(res2.decision == "deny")

        // Undo denial
        let undone = await broker.undoDenial(id: "deny-1")
        #expect(undone == true)
        let denialsAfterUndo = await broker.listDenials()
        #expect(denialsAfterUndo.isEmpty)

        // Clear memory
        await broker.clearMemory()

        await broker.stop()
    }
}
