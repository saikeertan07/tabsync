# ⚡ TabSync Studio

**TabSync Studio** is a real-time cross-platform companion app that connects your **Android tablet** (or iPad) directly to your **MacBook**, turning your tablet into a **high-precision pressure-sensitive drawing tablet, interactive live whiteboard, graphics digitizer (Wacom-style) for Mac apps, and remote trackpad/controller**.

---

## 🚀 Quick Start

1. Open your terminal and navigate to the project directory:
   ```bash
   cd /Users/tedlasaikeertan/.gemini/antigravity/scratch/tabsync-app
   ```
2. Start the application:
   ```bash
   ./start.sh
   ```
   *(or run `npm start`)*

3. The **Mac Dashboard** will automatically open at `https://localhost:4444` (plain `http://localhost:4444` is also automatically redirected).
4. On your **Android Tablet**, open your camera or browser and scan the **QR Code** shown on your Mac screen (or navigate to `https://<your-mac-ip>:4444/tablet`).

> 💡 **Tip:** On Android Chrome or Samsung Internet, tap the browser menu (⋮) and select **"Add to Home screen"** or **"Install app"**. It will launch full-screen with no browser address bar!

---

## 🎨 4 Versatile Modes

### 1. ✏️ Studio Drawing Board (Live Mirror Whiteboard)
* **Real-time Synchronized Drawing:** Everything drawn on your tablet instantly appears on your MacBook screen with zero perceived latency.
* **Hardware Stylus & S-Pen Pressure:** Dynamic line thickness matching how hard you press your stylus (`e.pressure`).
* **Ultra-smooth 120Hz Curves:** Employs quadratic Bézier spline interpolation and coalesced pointer events for buttery, natural strokes.
* **Palm Rejection:** Built-in **"Stylus Only"** toggle ignores palm and finger touches while drawing.
* **Artist Toolkit:**
  * **Pens:** Ballpoint Pen, Fountain Brush, Highlighter (semi-transparent), Neon Glow Pen, Precision Eraser.
  * **Vector Shapes:** Straight Lines, Directed Arrows, Rectangles, Circles/Ellipses.
  * **Color Palette:** Curated modern color swatches + Full HEX color wheel picker.
  * **Backgrounds:** Dark Dot Grid, Dark Blueprint Grid, Pure Black OLED, Light Dots, Lined Paper, Pure White.
* **Mac Export & Clipboard Integration:**
  * Click **"Copy to Clipboard"** on Mac to copy the drawing directly into macOS clipboard for instant pasting into Slack, Figma, Notes, Docs, or Discord.
  * Click **"Save Image"** to export high-resolution PNGs.

---

### 2. 🎨 Mac Digitizer (Graphics Tablet Mode for Mac Apps)
* Turns your Android tablet into an external **Wacom / Apple Pencil style digitizer tablet** for your Mac!
* Works directly with desktop creative applications: **Photoshop, Krita, Figma, Sketch, Illustrator, Blender, Mac Preview, Apple Notes**, etc.
* **Two Mapping Modes:**
  * **Absolute (1:1 Screen Mapping):** The tablet surface corresponds 1:1 to your Mac display. Touching the top-left places the Mac cursor at the top-left.
  * **Relative (Trackpad Digitizer):** Move your stylus across the pad to glide the cursor with acceleration.
* **Artist Shortcut Bar:**
  * Dedicated on-screen keys for Mac artists: `⌘Z (Undo)`, `⌘⇧Z (Redo)`, `[ (Brush Size -)`, `] (Brush Size +)`, `Space (Hand / Pan)`, `⌥ (Eyedropper)`, `⌘S (Save)`, and `Right Click`.

---

### 3. 🖱️ Precision Trackpad & Shortcuts
* Turn your tablet into a giant Mac glass trackpad.
* **1-Finger Drag:** Smooth cursor movement.
* **1-Finger Tap:** Left Click.
* **2-Finger Tap:** Right Click.
* **2-Finger Scroll:** Vertical and horizontal page scrolling.
* On-screen quick keys: `⌘C (Copy)`, `⌘V (Paste)`, `⌘+ (Zoom In)`, `⌘- (Zoom Out)`, `Esc`.

---

### 4. 🔴 Laser Pointer & Presentation Remote
* Ideal for lectures, slideshows, and video calls:
  * Touch or drag on the tablet to cast a high-visibility glowing red laser pointer with fading trail directly across the Mac screen.
  * Built-in **Previous Slide** and **Next Slide** presentation buttons.

---

## 🛠️ Architecture & Under the Hood

* **Native macOS Input Bridge (`mac-input`):** A compiled Swift binary leveraging Apple's `CoreGraphics` (`CGEvent`) and `ApplicationServices` to deliver sub-millisecond mouse and stylus injection into macOS.
* **High-Speed WebSocket Server:** Node.js server with bidirectional broadcast and in-memory canvas state synchronization.
* **W3C Pointer Events & Coalesced Sampling:** Uses `getCoalescedEvents()` to capture every intermediate point from high-refresh rate tablet digitizers (e.g. 90Hz/120Hz S-Pen).
* **Screen Wake Lock API:** Keeps the tablet display awake during drawing sessions.
* **Cross-Resolution Vector Parity:** Canvas strokes are stored and transmitted as normalized coordinates `(0.0 to 1.0)`, ensuring drawings scale with high-DPI crispness regardless of differing tablet and Mac display ratios.

---

## 📁 File Structure

```
tabsync-app/
├── server.js                # Express & WebSocket server with IP & QR generation
├── mac-input.swift          # Native Swift CoreGraphics bridge for macOS automation
├── mac-input                # Compiled native macOS ARM64 binary
├── start.sh                 # One-click startup script
├── package.json             # Node dependencies (express, ws, qrcode)
└── public/
    ├── shared/
    │   └── canvas-engine.js # Vector drawing engine, pressure curves, spline smoothing
    ├── tablet/              # Android Tablet Web / PWA client
    │   ├── index.html
    │   ├── style.css
    │   ├── tablet.js
    │   ├── manifest.json
    │   └── sw.js
    └── mac/                 # MacBook Host Dashboard
        ├── index.html
        ├── style.css
        └── mac.js
```
