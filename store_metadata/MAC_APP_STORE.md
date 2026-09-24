# Mac App Store Listing & Entitlements: TabSync Studio

### App Information
- **App Name**: TabSync Studio
- **Subtitle**: Tablet Drawing Pad & Annotator
- **Bundle ID**: `com.tabsync.studio.mac`
- **Primary Category**: Productivity
- **Secondary Category**: Graphics & Design
- **Supported macOS**: macOS 11.0 (Big Sur) or higher (Native Apple Silicon ARM64 & Intel Universal)

---

### Keywords (Max 100 chars, comma-separated)
drawing pad,trackpad,tablet,annotator,screen draw,stylus,whiteboard,markup,remote mouse,presentation

---

### App Store Description

TabSync Studio transforms your Android tablet or iPad into a precision drawing pad, desktop screen annotator, and responsive wireless trackpad for your Mac.

Whether you are teaching an online class, delivering a live product presentation, annotating architectural blueprints, sketching in Photoshop/Figma, or simply navigating macOS from across the room, TabSync Studio provides unmatched responsiveness and clarity.

FEATURES HIGHLIGHTS:

🖊️ ANNOTATE & DRAW OVER ANY MAC APPLICATION
• Seamless Fullscreen Canvas: Write, draw, and highlight directly over Safari, Chrome, Keynote, PowerPoint, Slack, PDFs, or your Desktop.
• Zero Desktop Freezing: The transparent canvas runs with pure click-through technology, ensuring your Mac traffic light buttons, window dragging, and underlying applications remain 100% interactive.
• High Refresh Rate Inking: Crisp, anti-aliased Retina vector rendering with pressure dynamics.
• Professional Toolkit: Fine Pen, Translucent Highlighter, Presenter Laser Pointer with decaying comet trail, and Eraser.
• Bidirectional Sync: Change colors, stroke widths, or tools on either your Mac widget or tablet.

🖱️ PRECISION WIRELESS TRACKPAD & DIGITIZER
• Smooth relative cursor motion with zero cursor jumping.
• Full gesture support: Tap to click, two-finger scroll, right-click, and Drag Lock toggle for effortlessly selecting text or moving windows.

🔒 SECURE LOCAL NETWORK PAIRING
• 100% Private: All communications take place over your local Wi-Fi. No cloud relays, no tracking, no external accounts.
• One-Scan Dynamic QR Code & 6-Digit PIN pairing.
• Paired Devices Control: Review, rename, or revoke authorized tablets anytime from your Mac menu bar.
• Stuck Input Safeguard: Automatically releases held mouse buttons or modifier keys if a tablet disconnects.

📸 ONE-CLICK ANNOTATION CAPTURE
• Capture your annotated screen directly to your Mac clipboard and save a timestamped image to your Desktop with one click.

---

### App Privacy Nutrition Labels
- **Data Used to Track You**: None
- **Data Linked to You**: None
- **Data Not Linked to You**: None (Zero telemetry, zero analytics, zero off-device data transfer)

---

### Entitlements & Distribution Profile

#### Mac App Store Sandbox Configuration (`TabSyncStudio.entitlements`)
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <true/>
    <key>com.apple.security.network.server</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.files.user-selected.read-write</key>
    <true/>
</dict>
</plist>
```

#### Developer ID / Direct Distribution (Notarization Ready)
For full global mouse & keyboard synthesis outside the sandboxed canvas window:
- Accessibility API (`AXIsProcessTrusted`)
- Hardened Runtime enabled: `--options runtime`
- Notarization command:
  ```bash
  xcrun notarytool submit TabSyncStudio-macOS-release.zip --keychain-profile "Developer-ID" --wait
  xcrun stapler staple "TabSync Studio.app"
  ```
