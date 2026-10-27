import Foundation
import CoreGraphics
import ApplicationServices
import AppKit

func checkAccessibility() -> Bool {
    return AXIsProcessTrusted()
}

func getMainScreenBounds() -> (CGFloat, CGFloat) {
    let mainDisplay = CGMainDisplayID()
    let bounds = CGDisplayBounds(mainDisplay)
    return (bounds.width, bounds.height)
}

let (screenWidth, screenHeight) = getMainScreenBounds()
var isMouseDown = false
var isEmergencyStopActive = false
var lastX: CGFloat = screenWidth / 2
var lastY: CGFloat = screenHeight / 2
var lastPressure: Double = 0.5
var totalEventsDispatched: UInt64 = 0

// Stuck Input Protection state
var activeHeldButtons: Set<String> = []
var activeHeldModifiers: Set<UInt16> = []

func releaseAllInputs() {
    let point = CGPoint(x: lastX, y: lastY)
    
    // Release any held mouse buttons
    for btn in activeHeldButtons {
        if btn == "right" {
            if let up = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right) {
                up.post(tap: .cghidEventTap)
            }
        } else if btn == "middle" {
            if let up = CGEvent(mouseEventSource: nil, mouseType: .otherMouseUp, mouseCursorPosition: point, mouseButton: .center) {
                up.post(tap: .cghidEventTap)
            }
        } else {
            if let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {
                up.post(tap: .cghidEventTap)
            }
        }
    }
    activeHeldButtons.removeAll()
    isMouseDown = false
    
    // Release any held modifier keys
    for code in activeHeldModifiers {
        if let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
            up.post(tap: .cghidEventTap)
        }
    }
    activeHeldModifiers.removeAll()
}

var inputBuffer = ""

FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty {
        releaseAllInputs()
        exit(0)
    }
    guard let input = String(data: data, encoding: .utf8) else { return }
    inputBuffer.append(input)
    if inputBuffer.count > 16384 {
        inputBuffer = ""
        return
    }
    
    while let newlineRange = inputBuffer.range(of: "\n") {
        let line = String(inputBuffer[..<newlineRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        inputBuffer.removeSubrange(..<newlineRange.upperBound)
        
        if line.isEmpty { continue }
        let parts = line.components(separatedBy: " ")
        guard let cmd = parts.first else { continue }
        
        switch cmd {
        case "quit", "exit":
            releaseAllInputs()
            exit(0)
            
        case "release_all":
            releaseAllInputs()

        case "emergency_stop":
            isEmergencyStopActive = true
            releaseAllInputs()

        case "resume_input":
            isEmergencyStopActive = false
            
        case "info":
            let (curWidth, curHeight) = getMainScreenBounds()
            let trusted = checkAccessibility()
            print("INFO \(curWidth) \(curHeight) \(trusted ? 1 : 0) \(isEmergencyStopActive ? 1 : 0)")
            fflush(stdout)

        case "status":
            let (curWidth, curHeight) = getMainScreenBounds()
            let trusted = checkAccessibility()
            print("STATUS width=\(curWidth) height=\(curHeight) trusted=\(trusted ? 1 : 0) emergency=\(isEmergencyStopActive ? 1 : 0) heldButtons=\(activeHeldButtons.count) events=\(totalEventsDispatched)")
            fflush(stdout)
            
        case "move":
            if isEmergencyStopActive { continue }
            let (curWidth, curHeight) = getMainScreenBounds()
            if parts.count >= 3,
               let nx = Double(parts[1]), nx.isFinite,
               let ny = Double(parts[2]), ny.isFinite {
                let x = CGFloat(nx) * curWidth
                let y = CGFloat(ny) * curHeight
                lastX = min(max(0, x), curWidth - 1)
                lastY = min(max(0, y), curHeight - 1)
                
                if parts.count >= 4, let p = Double(parts[3]), p.isFinite {
                    lastPressure = min(max(0.01, p), 1.0)
                }
                
                let point = CGPoint(x: lastX, y: lastY)
                let eventType: CGEventType = isMouseDown ? .leftMouseDragged : .mouseMoved
                
                if let event = CGEvent(mouseEventSource: nil, mouseType: eventType, mouseCursorPosition: point, mouseButton: .left) {
                    event.setDoubleValueField(.tabletEventPointPressure, value: lastPressure)
                    event.setDoubleValueField(.mouseEventPressure, value: lastPressure)
                    event.post(tap: .cghidEventTap)
                }
            }
            
        case "move_rel":
            if isEmergencyStopActive { continue }
            let (curWidth, curHeight) = getMainScreenBounds()
            if parts.count >= 3,
               let dx = Double(parts[1]), dx.isFinite,
               let dy = Double(parts[2]), dy.isFinite {
                if let cur = CGEvent(source: nil)?.location {
                    lastX = cur.x
                    lastY = cur.y
                }
                lastX = min(max(0, lastX + CGFloat(dx)), curWidth - 1)
                lastY = min(max(0, lastY + CGFloat(dy)), curHeight - 1)
                let point = CGPoint(x: lastX, y: lastY)
                let eventType: CGEventType = isMouseDown ? .leftMouseDragged : .mouseMoved
                if let event = CGEvent(mouseEventSource: nil, mouseType: eventType, mouseCursorPosition: point, mouseButton: .left) {
                    event.setDoubleValueField(.tabletEventPointPressure, value: lastPressure)
                    event.setDoubleValueField(.mouseEventPressure, value: lastPressure)
                    event.post(tap: .cghidEventTap)
                }
            }
            
        case "down":
            if isEmergencyStopActive { continue }
            let buttonType = parts.count >= 2 ? parts[1] : "left"
            if parts.count >= 3, let p = Double(parts[2]), p.isFinite {
                lastPressure = min(max(0.01, p), 1.0)
            }
            let point = CGPoint(x: lastX, y: lastY)
            activeHeldButtons.insert(buttonType)
            
            if buttonType == "right" {
                if let event = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right) {
                    event.post(tap: .cghidEventTap)
                }
            } else if buttonType == "middle" {
                if let event = CGEvent(mouseEventSource: nil, mouseType: .otherMouseDown, mouseCursorPosition: point, mouseButton: .center) {
                    event.post(tap: .cghidEventTap)
                }
            } else {
                isMouseDown = true
                if let event = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) {
                    event.setDoubleValueField(.tabletEventPointPressure, value: lastPressure)
                    event.setDoubleValueField(.mouseEventPressure, value: lastPressure)
                    event.post(tap: .cghidEventTap)
                }
            }
            
        case "up":
            let buttonType = parts.count >= 2 ? parts[1] : "left"
            let point = CGPoint(x: lastX, y: lastY)
            activeHeldButtons.remove(buttonType)
            
            if buttonType == "right" {
                if let event = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right) {
                    event.post(tap: .cghidEventTap)
                }
            } else if buttonType == "middle" {
                if let event = CGEvent(mouseEventSource: nil, mouseType: .otherMouseUp, mouseCursorPosition: point, mouseButton: .center) {
                    event.post(tap: .cghidEventTap)
                }
            } else {
                isMouseDown = false
                if let event = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {
                    event.setDoubleValueField(.tabletEventPointPressure, value: 0.0)
                    event.setDoubleValueField(.mouseEventPressure, value: 0.0)
                    event.post(tap: .cghidEventTap)
                }
            }
            
        case "click":
            if isEmergencyStopActive { continue }
            if let cur = CGEvent(source: nil)?.location {
                lastX = cur.x
                lastY = cur.y
            }
            let point = CGPoint(x: lastX, y: lastY)
            let btn = parts.count >= 2 ? parts[1] : "left"
            if btn == "right" {
                if let down = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right),
                   let up = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right) {
                    down.post(tap: .cghidEventTap)
                    up.post(tap: .cghidEventTap)
                }
            } else if btn == "middle" {
                if let down = CGEvent(mouseEventSource: nil, mouseType: .otherMouseDown, mouseCursorPosition: point, mouseButton: .center),
                   let up = CGEvent(mouseEventSource: nil, mouseType: .otherMouseUp, mouseCursorPosition: point, mouseButton: .center) {
                    down.post(tap: .cghidEventTap)
                    up.post(tap: .cghidEventTap)
                }
            } else {
                if let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                   let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {
                    down.post(tap: .cghidEventTap)
                    up.post(tap: .cghidEventTap)
                }
            }
            
        case "rclick":
            if isEmergencyStopActive { continue }
            if let cur = CGEvent(source: nil)?.location {
                lastX = cur.x
                lastY = cur.y
            }
            let point = CGPoint(x: lastX, y: lastY)
            if let down = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right),
               let up = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right) {
                down.post(tap: .cghidEventTap)
                up.post(tap: .cghidEventTap)
            }
            
        case "scroll":
            if isEmergencyStopActive { continue }
            if parts.count >= 3,
               let dy = Int32(parts[1]),
               let dx = Int32(parts[2]) {
                if let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
                    event.post(tap: .cghidEventTap)
                }
            }
            
        case "type":
            if isEmergencyStopActive { continue }
            if parts.count >= 2 {
                let text = parts.dropFirst().joined(separator: " ")
                let utf16Chars = Array(text.utf16)
                if !utf16Chars.isEmpty {
                    // Safe direct Unicode keyboard event dispatch without overwriting user clipboard
                    if let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                       let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
                        down.keyboardSetUnicodeString(stringLength: utf16Chars.count, unicodeString: utf16Chars)
                        up.keyboardSetUnicodeString(stringLength: utf16Chars.count, unicodeString: utf16Chars)
                        down.post(tap: .cghidEventTap)
                        up.post(tap: .cghidEventTap)
                    }
                }
            }
            
        case "key":
            if isEmergencyStopActive { continue }
            if parts.count >= 2, let code = UInt16(parts[1]) {
                var flags: CGEventFlags = []
                if parts.count >= 3 {
                    let mods = parts[2].components(separatedBy: ",")
                    if mods.contains("cmd") { flags.insert(.maskCommand) }
                    if mods.contains("shift") { flags.insert(.maskShift) }
                    if mods.contains("alt") { flags.insert(.maskAlternate) }
                    if mods.contains("ctrl") { flags.insert(.maskControl) }
                }
                if let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
                   let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
                    down.flags = flags
                    up.flags = flags
                    down.post(tap: .cghidEventTap)
                    up.post(tap: .cghidEventTap)
                }
            }
            
        default:
            break
        }
    }
}

// Clean up on termination
atexit {
    releaseAllInputs()
}

func handleTerminationSignal(_ sig: Int32) {
    releaseAllInputs()
    exit(sig)
}

signal(SIGINT, handleTerminationSignal)
signal(SIGTERM, handleTerminationSignal)

RunLoop.main.run()
