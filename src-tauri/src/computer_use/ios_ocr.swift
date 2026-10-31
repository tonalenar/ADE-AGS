// OCR inteiramente local: não consulta serviço nem imprime caminhos/erros com dados da tela.
import Foundation
import Vision
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
do {
    guard CommandLine.arguments.count == 2 else { exit(2) }
    try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1]), options: [:]).perform([request])
    let lines: [[String: Any]] = (request.results ?? []).prefix(200).compactMap { observation in
        guard let text = observation.topCandidates(1).first?.string else { return nil }
        let r = observation.boundingBox
        return ["text": text, "left": r.minX, "right": r.maxX, "top": 1-r.maxY, "bottom": 1-r.minY]
    }
    let bytes = try JSONSerialization.data(withJSONObject: lines)
    FileHandle.standardOutput.write(bytes)
} catch { exit(1) }
