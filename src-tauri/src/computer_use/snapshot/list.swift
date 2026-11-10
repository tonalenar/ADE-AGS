// Listagem do SnapShot do Mac: telas ativas e janelas visíveis, em JSON. Só lê metadados.
// Não captura nada e não pede permissão. Sem a Gravação de Tela, o macOS esconde os títulos das janelas
// (`titles` sai false e o título vem `null`). O filtro de janelas e a numeração das telas ficam no Rust
// (`snapshot.rs`), que é testado com saídas sintéticas.
import CoreGraphics
import Foundation

var displayIds = [CGDirectDisplayID](repeating: 0, count: 16)
var displayCount: UInt32 = 0
guard CGGetActiveDisplayList(16, &displayIds, &displayCount) == .success else { exit(1) }

let displays: [[String: Any]] = displayIds.prefix(Int(displayCount)).map { id in
    let bounds = CGDisplayBounds(id)
    let mode = CGDisplayCopyDisplayMode(id)
    return [
        "id": Int(id),
        "main": CGDisplayIsMain(id) != 0,
        "w": Double(bounds.width),
        "h": Double(bounds.height),
        "pixelWidth": mode?.pixelWidth ?? 0,
        "pixelHeight": mode?.pixelHeight ?? 0,
    ]
}

let rawWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let windows: [[String: Any]] = rawWindows.map { window in
    let bounds = (window[kCGWindowBounds as String] as? [String: Any]).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } ?? .zero
    return [
        "id": window[kCGWindowNumber as String] as? Int ?? 0,
        "app": window[kCGWindowOwnerName as String] as? String ?? "",
        "title": window[kCGWindowName as String] as? String ?? NSNull(),
        "layer": window[kCGWindowLayer as String] as? Int ?? -1,
        "w": Double(bounds.width),
        "h": Double(bounds.height),
    ]
}

let payload: [String: Any] = [
    "titles": CGPreflightScreenCaptureAccess(),
    "displays": displays,
    "windows": windows,
]
do {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: payload))
} catch {
    exit(1)
}
