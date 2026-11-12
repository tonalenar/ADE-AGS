import AVFoundation
import Foundation
import ScreenCaptureKit

final class RecordingDelegate: NSObject, SCRecordingOutputDelegate {
    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {}

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        print("ERROR:\(error.localizedDescription)")
        fflush(stdout)
        exit(2)
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {}
}

let outputURL = URL(fileURLWithPath: CommandLine.arguments.last ?? "")

Task {
    do {
        guard #available(macOS 15.0, *) else {
            throw NSError(domain: "ADEAGS.ScreenRecording", code: 1, userInfo: [NSLocalizedDescriptionKey: "A gravação da tela exige macOS 15 ou posterior."])
        }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw NSError(domain: "ADEAGS.ScreenRecording", code: 2, userInfo: [NSLocalizedDescriptionKey: "O macOS não encontrou uma tela para gravar."])
        }

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = display.width
        configuration.height = display.height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        configuration.queueDepth = 4
        configuration.capturesAudio = false
        configuration.showsCursor = true

        let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
        let recordingConfiguration = SCRecordingOutputConfiguration()
        recordingConfiguration.outputURL = outputURL
        recordingConfiguration.outputFileType = .mov
        recordingConfiguration.videoCodecType = .h264
        let delegate = RecordingDelegate()
        let output = SCRecordingOutput(configuration: recordingConfiguration, delegate: delegate)
        try stream.addRecordingOutput(output)
        try await stream.startCapture()

        print("READY")
        fflush(stdout)
        _ = readLine()
        try await stream.stopCapture()
        print("FINISHED")
        fflush(stdout)
        exit(0)
    } catch {
        // O domínio e o código deixam o Rust reconhecer a permissão negada (SCStreamError -3801).
        let nsError = error as NSError
        print("ERROR:\(error.localizedDescription) [\(nsError.domain) \(nsError.code)]")
        fflush(stdout)
        exit(2)
    }
}

dispatchMain()
