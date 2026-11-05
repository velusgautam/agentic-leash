import Testing
@testable import LeashCore

@Test func coreVersionCheck() async throws {
    #expect(LeashCore.version == "0.7.0")
}
