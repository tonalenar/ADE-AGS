@preconcurrency import AVFoundation
import Darwin
import Foundation
@preconcurrency import Speech

struct VoiceEvent: Encodable {
    let type: String
    let text: String?
    let message: String?
}

func emit(_ type: String, text: String? = nil, message: String? = nil) {
    let event = VoiceEvent(type: type, text: text, message: message)
    guard let data = try? JSONEncoder().encode(event),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func failure(_ message: String) -> Never {
    emit("error", message: message)
    exit(2)
}

final class PermissionOutcome: @unchecked Sendable {
    private let lock = NSLock()
    private var granted = false

    func set(_ value: Bool) {
        lock.lock()
        granted = value
        lock.unlock()
    }

    func get() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return granted
    }
}

func requestMicrophone() -> AVAuthorizationStatus {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return .authorized
    case .denied:
        return .denied
    case .restricted:
        return .restricted
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        let outcome = PermissionOutcome()
        AVCaptureDevice.requestAccess(for: .audio) { result in
            outcome.set(result)
            semaphore.signal()
        }
        semaphore.wait()
        return outcome.get() ? .authorized : AVCaptureDevice.authorizationStatus(for: .audio)
    @unknown default:
        return AVCaptureDevice.authorizationStatus(for: .audio)
    }
}

func requestSpeechRecognition() -> Bool {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized:
        return true
    case .denied, .restricted:
        return false
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        let outcome = PermissionOutcome()
        SFSpeechRecognizer.requestAuthorization { status in
            outcome.set(status == .authorized)
            semaphore.signal()
        }
        semaphore.wait()
        return outcome.get()
    @unknown default:
        return false
    }
}

enum RecognitionResult {
    case success(String)
    case failure(String)
}

final class RecognitionOutcome: @unchecked Sendable {
    private let lock = NSLock()
    private var result: RecognitionResult?

    func set(_ value: RecognitionResult) {
        lock.lock()
        result = value
        lock.unlock()
    }

    func get() -> RecognitionResult? {
        lock.lock()
        defer { lock.unlock() }
        return result
    }
}

let localeIdentifier = CommandLine.arguments.last ?? "pt-BR"
guard #available(macOS 10.15, *) else {
    failure("O ditado local exige macOS 10.15 ou posterior.")
}
let microphoneStatus = requestMicrophone()
guard microphoneStatus == .authorized else {
    failure("MICROPHONE_PERMISSION_REQUIRED: status=\(microphoneStatus.rawValue)")
}
guard requestSpeechRecognition() else {
    failure("SPEECH_RECOGNITION_PERMISSION_REQUIRED: O macOS precisa de autorização de Reconhecimento de Fala para transcrever.")
}
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
    failure("O macOS não oferece reconhecimento para o idioma selecionado.")
}
guard recognizer.isAvailable else {
    failure("O serviço de Reconhecimento de Fala do macOS está indisponível agora.")
}
guard recognizer.supportsOnDeviceRecognition else {
    failure("Este idioma não tem reconhecimento local neste Mac; nenhum áudio foi enviado à rede.")
}

let engine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = false
request.requiresOnDeviceRecognition = true
request.taskHint = .dictation
request.contextualStrings = ["ADE", "AGS", "Codex", "Claude Code", "OpenCode", "Antigravity", "Jev", "Tauri", "Rust", "React"]

let inputNode = engine.inputNode
let format = inputNode.outputFormat(forBus: 0)
guard format.channelCount > 0 else {
    failure("O Mac não encontrou uma entrada de áudio ativa.")
}
if #available(macOS 27.0, *) {
    do {
        try inputNode.installAudioTap(onBus: 0, bufferSize: 8192, format: format) { buffer, _ in
            let mutableBuffer = AVAudioPCMBuffer(copying: buffer)
            request.append(mutableBuffer)
        }
    } catch {
        failure("Não consegui conectar a entrada de áudio: \(error.localizedDescription)")
    }
} else {
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
    }
}

// O reconhecedor entrega os resultados na fila principal por padrão, e a thread principal fica
// presa no `readLine` e no semáforo abaixo: o resultado nunca chegava e o ditado sempre estourava o prazo.
recognizer.queue = OperationQueue()

let completed = DispatchSemaphore(value: 0)
let outcome = RecognitionOutcome()
let recognitionTask = recognizer.recognitionTask(with: request) { result, error in
    if let result, result.isFinal {
        outcome.set(.success(result.bestTranscription.formattedString))
        completed.signal()
    } else if let error {
        outcome.set(.failure(error.localizedDescription))
        completed.signal()
    }
}

do {
    engine.prepare()
    try engine.start()
} catch {
    inputNode.removeTap(onBus: 0)
    recognitionTask.cancel()
    failure("Não consegui iniciar o microfone: \(error.localizedDescription)")
}

emit("ready")
let command = readLine() ?? "cancel"
inputNode.removeTap(onBus: 0)
engine.stop()

if command == "cancel" {
    recognitionTask.cancel()
    emit("cancelled")
    exit(0)
}

request.endAudio()
if completed.wait(timeout: .now() + 35) == .timedOut {
    recognitionTask.cancel()
    failure("O reconhecimento local não concluiu a tempo; o áudio foi descartado.")
}

switch outcome.get() {
case .success(let text):
    emit("result", text: text)
    exit(0)
case .failure(let message):
    failure("Não consegui transcrever o áudio localmente: \(message)")
case .none:
    failure("O reconhecimento local terminou sem texto.")
}
