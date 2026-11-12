// Confere com o AVFoundation (o mesmo motor do QuickTime e do Safari) que um MP4 gravado do espelho toca:
// abre, mede a duração, lê o tamanho da trilha e decodifica todos os quadros. Não toca em aparelho.
//   swiftc -O scripts/verificar-mp4.swift -o /tmp/verificar-mp4 && /tmp/verificar-mp4 arquivo.mp4 [duração_esperada_s] [largura altura]
import AVFoundation

let args = CommandLine.arguments
guard args.count >= 2 else { print("uso: verificar-mp4 <arquivo> [duração_esperada_s] [largura altura]"); exit(2) }
let url = URL(fileURLWithPath: args[1])
let asset = AVURLAsset(url: url)
let sem = DispatchSemaphore(value: 0)
var failed = false
func check(_ ok: Bool, _ what: String) { print((ok ? "ok    " : "FALHA ") + what); if !ok { failed = true } }

Task {
    do {
        let playable = try await asset.load(.isPlayable)
        let duration = try await asset.load(.duration).seconds
        let tracks = try await asset.loadTracks(withMediaType: .video)
        check(playable, "toca (isPlayable)")
        check(tracks.count == 1, "uma trilha de vídeo")
        guard let track = tracks.first else { sem.signal(); return }
        let size = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        let formats = try await track.load(.formatDescriptions)
        let codec = formats.first.map { CMFormatDescriptionGetMediaSubType($0) } ?? 0
        print(String(format: "info  duração %.3f s, tamanho %.0f×%.0f, codec %@, transform %@", duration, size.width, size.height,
              String(format: "%c%c%c%c", (codec >> 24) & 255, (codec >> 16) & 255, (codec >> 8) & 255, codec & 255), "\(transform)"))
        check(duration > 0, "duração > 0")
        if args.count >= 3, let expected = Double(args[2]) { check(abs(duration - expected) < 0.05, "duração ≈ \(expected) s") }
        if args.count >= 5, let w = Double(args[3]), let h = Double(args[4]) { check(size.width == w && size.height == h, "tamanho \(Int(w))×\(Int(h))") }
        check(transform.isIdentity, "sem rotação (a orientação vem do tamanho)")
        // Decodifica tudo pelo VideoToolbox.
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output)
        reader.startReading()
        var frames = 0, last = -1.0, monotonic = true
        var dims = Set<String>()
        while let sample = output.copyNextSampleBuffer() {
            frames += 1
            let t = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            if t < last { monotonic = false }
            last = t
            if let px = CMSampleBufferGetImageBuffer(sample) { dims.insert("\(CVPixelBufferGetWidth(px))×\(CVPixelBufferGetHeight(px))") }
        }
        check(reader.status == .completed, "decodificou até o fim (status \(reader.status.rawValue), \(reader.error?.localizedDescription ?? "sem erro"))")
        check(frames > 0, "\(frames) quadros decodificados")
        check(monotonic, "horários crescentes")
        print("info  tamanhos decodificados: \(dims.sorted().joined(separator: ", "))")
        // E uma imagem do meio, como o Finder faz para a miniatura.
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        let image = try await generator.image(at: CMTime(seconds: duration / 2, preferredTimescale: 600)).image
        check(image.width > 0, "miniatura do meio: \(image.width)×\(image.height)")
    } catch {
        check(false, "erro: \(error)")
    }
    sem.signal()
}
sem.wait()
exit(failed ? 1 : 0)
