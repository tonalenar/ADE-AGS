// Gera quadros HEVC sintéticos (codificador de hardware do macOS) para os testes do gravador do espelho do iPhone.
// Não toca em nenhum aparelho. Uso:
//   swiftc -O scripts/gerar-fixture-hevc.swift -o /tmp/gerar-hevc && /tmp/gerar-hevc <largura> <altura> <quadros> <saida.bin>
//
// Formato da saída (tudo big-endian):
//   "HEV1" | u32 vps_len vps | u32 sps_len sps | u32 pps_len pps | u32 n
//   n × ( u32 rtp_ts (relógio de 24 kHz) | u8 irap | u32 len | len bytes com as NALs em prefixo de 4 bytes )
import AVFoundation
import VideoToolbox

let args = CommandLine.arguments
guard args.count == 5, let width = Int(args[1]), let height = Int(args[2]), let count = Int(args[3]) else {
    FileHandle.standardError.write("uso: gerar-hevc <largura> <altura> <quadros> <saida.bin>\n".data(using: .utf8)!)
    exit(2)
}
let outPath = args[4]

struct Sample { var ts: UInt32; var irap: Bool; var data: Data }
var samples: [Sample] = []
var params: [Data] = []
let lock = NSLock()

var session: VTCompressionSession?
let status = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_HEVC,
    encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &session)
guard status == 0, let session else { fatalError("VTCompressionSessionCreate: \(status)") }
VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 12 as CFNumber)
VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: 400_000 as CFNumber)
VTCompressionSessionPrepareToEncodeFrames(session)

for i in 0..<count {
    var pixel: CVPixelBuffer?
    CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &pixel)
    guard let pixel else { fatalError("CVPixelBufferCreate") }
    CVPixelBufferLockBaseAddress(pixel, [])
    let base = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt8.self)
    let row = CVPixelBufferGetBytesPerRow(pixel)
    for y in 0..<height {
        for x in 0..<width {
            let p = base + y * row + x * 4
            // Faixa que anda: dá movimento real para o codificador.
            let on = (x + i * 6) % 64 < 24
            p[0] = UInt8(truncatingIfNeeded: y * 255 / height)
            p[1] = on ? 220 : UInt8(truncatingIfNeeded: x * 255 / width)
            p[2] = on ? 30 : 140
            p[3] = 255
        }
    }
    CVPixelBufferUnlockBaseAddress(pixel, [])
    // 30 quadros por segundo no relógio de 24 kHz: 800 ticks.
    let pts = CMTime(value: CMTimeValue(i * 800), timescale: 24000)
    VTCompressionSessionEncodeFrame(session, imageBuffer: pixel, presentationTimeStamp: pts, duration: CMTime(value: 800, timescale: 24000), frameProperties: nil, infoFlagsOut: nil) { st, _, sb in
        guard st == 0, let sb else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]]
        let notSync = (attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false
        guard let block = CMSampleBufferGetDataBuffer(sb) else { return }
        var length = 0
        var ptr: UnsafeMutablePointer<Int8>?
        CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &ptr)
        let data = Data(bytes: ptr!, count: length)
        let t = CMSampleBufferGetPresentationTimeStamp(sb)
        lock.lock()
        if params.isEmpty, let fd = CMSampleBufferGetFormatDescription(sb) {
            for k in 0..<3 {
                var p: UnsafePointer<UInt8>?
                var size = 0
                CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(fd, parameterSetIndex: k, parameterSetPointerOut: &p, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
                params.append(Data(bytes: p!, count: size))
            }
        }
        samples.append(Sample(ts: UInt32(truncatingIfNeeded: t.value), irap: !notSync, data: data))
        lock.unlock()
    }
}
VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
VTCompressionSessionInvalidate(session)

func be32(_ v: UInt32) -> Data { var b = v.bigEndian; return Data(bytes: &b, count: 4) }
var out = Data("HEV1".utf8)
// VPS, SPS, PPS (índices 0, 1, 2 do formato do VideoToolbox).
for p in params { out += be32(UInt32(p.count)); out += p }
out += be32(UInt32(samples.count))
for s in samples { out += be32(s.ts); out.append(s.irap ? 1 : 0); out += be32(UInt32(s.data.count)); out += s.data }
try! out.write(to: URL(fileURLWithPath: outPath))
print("ok: \(samples.count) quadros, \(samples.filter { $0.irap }.count) IRAP, \(out.count) bytes")
