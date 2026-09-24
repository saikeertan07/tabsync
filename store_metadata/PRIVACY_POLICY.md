# Privacy Policy for TabSync Studio

**Last Updated: October 5, 2026**

TabSync Studio ("we", "our", or "the App") is committed to protecting your privacy. This Privacy Policy explains our practices regarding data collection, processing, and storage when using the TabSync Studio macOS application and Android tablet application.

---

### 1. Data Minimization & Local-Only Architecture
TabSync Studio is engineered with a strict **Local-First Privacy Architecture**:
- All communications between your Android tablet and your Mac occur **exclusively over your local private Wi-Fi network**.
- **No cloud servers, external relays, or intermediaries** receive, store, or forward your drawing strokes, mouse movements, typed text, or annotations.
- The App requires **no user accounts, no email addresses, and no registration**.

---

### 2. Information Handled by the App

| Data Category | Purpose | Storage & Retention |
| :--- | :--- | :--- |
| **Drawing & Stroke Data** | Transmitted in real-time between your tablet and Mac display overlay. | Processed in volatile memory during the active session. Not stored externally or transmitted off-device. |
| **Mouse & Cursor Coordinates** | Translates touch gestures on your tablet into cursor movement on your Mac. | Processed instantly in real-time memory. Never logged or saved. |
| **Pairing & Authentication Tokens** | Cryptographic random tokens exchanged during QR/PIN pairing to ensure only authorized tablets can connect to your Mac. | Stored locally in encrypted app preferences (`~/.tabsync/` on Mac, Android `SharedPreferences`). Never sent to any external server. |
| **Network IP & Port** | Used solely to establish the local peer-to-peer WebSocket connection on your LAN. | Kept in local memory during session. |
| **Typed Text** | Sent when using remote keyboard input to paste text into your active Mac application. | Dispatched directly to the system pasteboard/input event stream. Never logged, cached, or monitored. |

---

### 3. Data Not Collected
TabSync Studio **DOES NOT**:
- Collect or transmit personal identification information (names, emails, phone numbers).
- Collect analytics, telemetry, or user behavior tracking data.
- Integrate third-party advertising SDKs or tracking pixels.
- Access your contacts, location, camera (except for optional local QR scanning on tablet), or microphone.
- Retain clipboard history or monitor keystrokes outside explicit input actions.

---

### 4. Permissions & Justification

#### macOS Application
- **Accessibility (`AXIsProcessTrusted`)**: Required solely to synthesize cursor movement, clicks, and keystrokes from your authenticated tablet into macOS applications.
- **Local Network**: Required to host the local WebSocket server for peer-to-peer tablet pairing.

#### Android Application
- **Internet / Local Network (`android.permission.INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`)**: Required to connect to your Mac host on your local Wi-Fi.
- **Wake Lock (`android.permission.WAKE_LOCK`)**: Keeps your tablet screen active while actively drawing or presenting.
- **Camera (Optional)**: Used locally on-device solely to scan the pairing QR code from your Mac screen. Image frames are processed in real-time and never saved or transmitted.

---

### 5. Security & Device Control
- Every connection requires **cryptographic pairing verification** via a dynamic QR code or 6-digit PIN.
- The Mac user has full authority to view connected devices, rename devices, or **revoke device authorization at any time**.
- If a tablet disconnects while a mouse button or key is held, the Mac application automatically releases all held inputs to prevent stuck states.

---

### 6. Contact & Support
For support inquiries or questions regarding this Privacy Policy:
- **Email**: support@tabsync.studio
- **Website**: https://tabsync.studio
