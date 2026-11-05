// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgenticLeash",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "LeashCore", targets: ["LeashCore"]),
        .executable(name: "AgenticLeash", targets: ["AgenticLeashApp"])
    ],
    dependencies: [],
    targets: [
        .target(
            name: "LeashCore",
            dependencies: [],
            path: "Sources/LeashCore"
        ),
        .executableTarget(
            name: "AgenticLeashApp",
            dependencies: ["LeashCore"],
            path: "Sources/AgenticLeashApp"
        ),
        .testTarget(
            name: "LeashCoreTests",
            dependencies: ["LeashCore"],
            path: "Tests/LeashCoreTests"
        )
    ]
)
