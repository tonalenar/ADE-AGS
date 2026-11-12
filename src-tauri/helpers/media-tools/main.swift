import Foundation
import ImageIO
import Vision
import CoreGraphics
import VideoToolbox

enum MediaToolsError: Error {
    case usage
    case inputMissing
    case noForeground
    case outputFailed
    case badDimensions
}

func writePNG(_ image: CGImage, to url: URL) throws {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        throw MediaToolsError.outputFailed
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw MediaToolsError.outputFailed }
}

func removeBackground(input: URL, output: URL) throws {
    guard FileManager.default.fileExists(atPath: input.path) else { throw MediaToolsError.inputMissing }
    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(url: input)
    try handler.perform([request])
    guard let observation = request.results?.first else { throw MediaToolsError.noForeground }
    let pixelBuffer = try observation.generateMaskedImage(ofInstances: observation.allInstances, from: handler, croppedToInstancesExtent: false)
    var image: CGImage?
    guard VTCreateCGImageFromCVPixelBuffer(pixelBuffer, options: nil, imageOut: &image) == noErr, let image else { throw MediaToolsError.outputFailed }
    try writePNG(image, to: output)
}

func resize(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
    guard width > 0, height > 0,
          let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw MediaToolsError.badDimensions }
    context.interpolationQuality = .high
    context.clear(CGRect(x: 0, y: 0, width: width, height: height))
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let result = context.makeImage() else { throw MediaToolsError.outputFailed }
    return result
}

func resizeImage(input: URL, output: URL, width: Int, height: Int) throws {
    guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw MediaToolsError.inputMissing }
    try writePNG(resize(image, width: width, height: height), to: output)
}

func syntheticResizeTest() throws {
    guard let context = CGContext(data: nil, width: 160, height: 90, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let image = context.makeImage() else { throw MediaToolsError.outputFailed }
    let result = try resize(image, width: 80, height: 45)
    guard result.width == 80, result.height == 45 else { throw MediaToolsError.badDimensions }
}

func syntheticForegroundTest() throws {
    let input = FileManager.default.temporaryDirectory.appendingPathComponent("ade-foreground-\(UUID().uuidString).png")
    let output = FileManager.default.temporaryDirectory.appendingPathComponent("ade-foreground-result-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: input); try? FileManager.default.removeItem(at: output) }
    guard let context = CGContext(data: nil, width: 256, height: 256, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw MediaToolsError.outputFailed }
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.fillEllipse(in: CGRect(x: 104, y: 178, width: 48, height: 48))
    context.fill(CGRect(x: 88, y: 72, width: 80, height: 116))
    guard let image = context.makeImage() else { throw MediaToolsError.outputFailed }
    try writePNG(image, to: input)
    try removeBackground(input: input, output: output)
    guard let source = CGImageSourceCreateWithURL(output as CFURL, nil), CGImageSourceCreateImageAtIndex(source, 0, nil) != nil else {
        throw MediaToolsError.outputFailed
    }
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["--test"] {
        try syntheticResizeTest()
        try syntheticForegroundTest()
    } else if args.count == 3, args[0] == "remove-background" {
        try removeBackground(input: URL(fileURLWithPath: args[1]), output: URL(fileURLWithPath: args[2]))
    } else if args.count == 5, args[0] == "resize", let width = Int(args[3]), let height = Int(args[4]) {
        try resizeImage(input: URL(fileURLWithPath: args[1]), output: URL(fileURLWithPath: args[2]), width: width, height: height)
    } else {
        throw MediaToolsError.usage
    }
} catch {
    fputs("falha no helper de mídia: \(error)\n", stderr)
    exit(1)
}
