#!/bin/bash
set -euo pipefail

# build-app.sh: Compiles and bundles Agentic Leash into a standalone native macOS .app bundle

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PACKAGE_DIR/.build/release"
OUTPUT_DIR="$PACKAGE_DIR/dist"
APP_NAME="Agentic Leash.app"
APP_BUNDLE="$OUTPUT_DIR/$APP_NAME"

echo "Building Agentic Leash for release (arm64)..."
cd "$PACKAGE_DIR"
swift build -c release --arch arm64

echo "Creating application bundle structure..."
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

echo "Copying executable..."
cp "$BUILD_DIR/AgenticLeash" "$APP_BUNDLE/Contents/MacOS/Agentic Leash"
chmod +x "$APP_BUNDLE/Contents/MacOS/Agentic Leash"

echo "Generating Info.plist..."
cat << 'EOF' > "$APP_BUNDLE/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Agentic Leash</string>
    <key>CFBundleIdentifier</key>
    <string>com.agenticleash.app</string>
    <key>CFBundleName</key>
    <string>Agentic Leash</string>
    <key>CFBundleDisplayName</key>
    <string>Agentic Leash</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
</dict>
</plist>
EOF

# Copy app icon if available
if [ -f "$PACKAGE_DIR/../resources/icon.icns" ]; then
    cp "$PACKAGE_DIR/../resources/icon.icns" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
fi

echo "Application built successfully at:"
echo "  $APP_BUNDLE"
ls -lh "$APP_BUNDLE/Contents/MacOS/Agentic Leash"
