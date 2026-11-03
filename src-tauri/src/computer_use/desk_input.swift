// Entrada do computer use do Mac: tudo local, sem rede, sem imprimir nada além do pedido.
// check | bounds | click x y | scroll dy | type texto
import Foundation
import CoreGraphics
import ApplicationServices
let a = CommandLine.arguments
guard a.count >= 2 else { exit(2) }
func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }
switch a[1] {
case "check":
    if !AXIsProcessTrusted() { exit(3) }
    if !CGPreflightScreenCaptureAccess() { exit(4) }
case "bounds":
    let r = CGDisplayBounds(CGMainDisplayID())
    print("\(r.origin.x) \(r.origin.y) \(r.width) \(r.height)")
case "click":
    guard a.count == 4, let x = Double(a[2]), let y = Double(a[3]) else { exit(2) }
    let p = CGPoint(x: x, y: y)
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left))
case "scroll":
    guard a.count == 3, let dy = Int32(a[2]) else { exit(2) }
    post(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0))
case "type":
    guard a.count == 3 else { exit(2) }
    for u in a[2].utf16 {
        var c = u
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
        post(down)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
        post(up)
    }
default: exit(2)
}
