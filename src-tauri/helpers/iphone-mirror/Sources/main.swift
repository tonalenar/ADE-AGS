// ade-iphone-mirror: o helper que abre o espelhamento da tela de um iPhone ou iPad físico pelo CoreDevice e entrega
// os pacotes do vídeo à ADE. É um processo à parte de propósito: as interfaces do CoreDevice são privadas e escritas à
// mão (`stubs/`), e uma assinatura errada derruba só este processo. A ADE reabre o helper e mostra "reconectando".
//
// Só VÊ a tela: não manda toque, botão, teclado nem HID, não instala, não reinicia e não muda ajustes do aparelho.
//
// Uso: ade-iphone-mirror stream <identificador CoreDevice> [--tunnel <IPv6 do aparelho>]
//      ade-iphone-mirror version
//
// Saída (stdout), em quadros: [tipo u8][tamanho u32 big-endian][conteúdo]
//   tipo 1 = evento JSON (UTF-8): connecting, started, error, stopped
//   tipo 2 = um datagrama recebido (RTP do vídeo ou RTCP), como chegou
// Entrada (stdin), uma linha por comando: `keyframe` (pede quadro-chave), `stop`. Fim do stdin = stop.
// O stream sempre é parado no aparelho ao sair (stop, fim do stdin, SIGTERM ou stdout fechado).
import Foundation
import Darwin
@preconcurrency import CoreDevice
@preconcurrency import CoreDeviceProtocols

let VERSAO = "1"

signal(SIGPIPE, SIG_IGN)
setvbuf(stderr, nil, _IONBF, 0)

func agora() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }
let inicio = agora()
func log(_ s: String) { FileHandle.standardError.write((String(format: "[mirror %6.3f] ", agora() - inicio) + s + "\n").data(using: .utf8)!) }

// ── Saída em quadros ──

final class Saida: @unchecked Sendable {
  private let trava = NSLock()
  private(set) var fechada = false
  var aoFechar: (() -> Void)?

  private func escrever(_ tipo: UInt8, _ corpo: UnsafeRawBufferPointer) {
    trava.lock()
    defer { trava.unlock() }
    if fechada { return }
    let n = UInt32(corpo.count)
    var cabeca: [UInt8] = [tipo, UInt8(n >> 24), UInt8(n >> 16 & 0xFF), UInt8(n >> 8 & 0xFF), UInt8(n & 0xFF)]
    let ok = cabeca.withUnsafeMutableBytes { tudo(UnsafeRawBufferPointer($0)) } && tudo(corpo)
    if !ok {
      fechada = true
      let f = aoFechar
      DispatchQueue.global().async { f?() }
    }
  }

  private func tudo(_ b: UnsafeRawBufferPointer) -> Bool {
    var feito = 0
    while feito < b.count {
      let r = write(1, b.baseAddress!.advanced(by: feito), b.count - feito)
      if r < 0 { if errno == EINTR { continue }; return false }
      feito += r
    }
    return true
  }

  func evento(_ campos: [String: Any]) {
    guard let dados = try? JSONSerialization.data(withJSONObject: campos) else { return }
    dados.withUnsafeBytes { escrever(1, $0) }
  }

  func datagrama(_ b: UnsafeRawBufferPointer) { escrever(2, b) }
}

let saida = Saida()

/// Sai com um erro: `mensagem` é curta, para a interface; `detalhe` (o erro do CoreDevice) vai só para o log.
func erro(_ codigo: String, _ mensagem: String, detalhe: Any? = nil, sai status: Int32) -> Never {
  log("\(codigo): \(mensagem)" + (detalhe.map { " — \($0)" } ?? ""))
  saida.evento(["event": "error", "code": codigo, "message": mensagem])
  exit(status)
}

// ── Argumentos ──

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "version" {
  print("ade-iphone-mirror \(VERSAO)")
  exit(0)
}
guard args.count >= 3, args[1] == "stream", let alvo = UUID(uuidString: args[2]) else {
  FileHandle.standardError.write("uso: ade-iphone-mirror stream <identificador CoreDevice> [--tunnel <ipv6>]\n".data(using: .utf8)!)
  exit(64)
}
var tunelPedido: String? = nil
if let i = args.firstIndex(of: "--tunnel"), i + 1 < args.count { tunelPedido = args[i + 1] }

// ── Prazos: uma chamada do CoreDevice pode ficar parada com o túnel caído ──

struct Prazo: Error {}

final class UmaVez<T>: @unchecked Sendable {
  private let trava = NSLock()
  private var cont: CheckedContinuation<T, Error>?
  init(_ c: CheckedContinuation<T, Error>) { cont = c }
  func terminar(_ r: Result<T, Error>) {
    trava.lock(); let c = cont; cont = nil; trava.unlock()
    c?.resume(with: r)
  }
}

/// Corre `op` com prazo de `segundos`. Não espera a operação terminar depois do prazo (o grupo de tarefas esperaria).
func comPrazo<T>(_ segundos: Double, _ op: @escaping @Sendable () async throws -> T) async throws -> T {
  try await withCheckedThrowingContinuation { (c: CheckedContinuation<T, Error>) in
    let fim = UmaVez(c)
    Task { do { fim.terminar(.success(try await op())) } catch { fim.terminar(.failure(error)) } }
    Task { try? await Task.sleep(nanoseconds: UInt64(segundos * 1e9)); fim.terminar(.failure(Prazo())) }
  }
}

// ── Leituras do DeviceInfo e do DisplayInfo (tipos opacos: lidos pela reflexão) ──

/// O DeviceInfo guarda os campos num dicionário "com.apple.CoreDevice:<nome>"; o valor sai do dump textual.
func valorInfo(_ texto: String, _ chave: String) -> String? {
  let linhas = texto.components(separatedBy: "\n")
  guard let i = linhas.firstIndex(where: { $0.hasSuffix("key: com.apple.CoreDevice:" + chave) }) else { return nil }
  for l in linhas[(i + 1)...].prefix(6) {
    if let r = l.range(of: "value: ") { return String(l[r.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
  }
  return nil
}

func campo(_ v: Any, _ nome: String, _ prof: Int = 0) -> Any? {
  if prof > 6 { return nil }
  for c in Mirror(reflecting: v).children {
    if c.label == nome { return c.value }
    if let r = campo(c.value, nome, prof + 1) { return r }
  }
  return nil
}

/// O tamanho em pixels da tela principal (`displays` → a de `deviceName == "primary"`, senão a primeira).
func tamanhoDaTela(_ info: Any) -> (Int, Int)? {
  guard let lista = campo(info, "displays") else { return nil }
  let telas = Mirror(reflecting: lista).children.map { $0.value }
  let principal = telas.first { (campo($0, "deviceName") as? String) == "primary" } ?? telas.first
  guard let tela = principal, let bounds = campo(tela, "bounds") as? CGRect else { return nil }
  let (w, h) = (Int(bounds.size.width.rounded()), Int(bounds.size.height.rounded()))
  return w > 0 && h > 0 ? (w, h) : nil
}

/// O endereço do Mac no túnel: o mesmo /64 do endereço do aparelho, numa interface local.
func enderecoLocal(prefixoDe ip: String) -> String? {
  var alvo6 = in6_addr()
  guard inet_pton(AF_INET6, ip, &alvo6) == 1 else { return nil }
  let prefixo = withUnsafeBytes(of: alvo6) { Array($0.prefix(8)) }
  var ifa: UnsafeMutablePointer<ifaddrs>? = nil
  guard getifaddrs(&ifa) == 0 else { return nil }
  defer { freeifaddrs(ifa) }
  var p = ifa
  while let i = p {
    defer { p = i.pointee.ifa_next }
    guard let sa = i.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET6) else { continue }
    var s6 = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee }
    guard withUnsafeBytes(of: s6.sin6_addr, { Array($0.prefix(8)) }) == prefixo else { continue }
    var buf = [CChar](repeating: 0, count: 64)
    inet_ntop(AF_INET6, &s6.sin6_addr, &buf, 64)
    let s = String(cString: buf)
    if s != ip { return s }
  }
  return nil
}

// ── Recepção UDP: repassa cada datagrama à ADE e guarda o que o RTCP precisa ──

final class Receptor: @unchecked Sendable {
  let fd: Int32
  let trava = NSLock()
  var recepcao = Recepcao()
  var ssrcVideo: UInt32? = nil
  var ultimoSR: (meio: UInt32, quando: Double)? = nil
  var parar = false

  init(fd: Int32) { self.fd = fd }

  func rodar() {
    var buf = [UInt8](repeating: 0, count: 65536)
    var tv = timeval(tv_sec: 0, tv_usec: 250_000)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    while !parar {
      let n = recv(fd, &buf, buf.count, 0)
      if n <= 0 { continue }
      buf.withUnsafeBytes { saida.datagrama(UnsafeRawBufferPointer(rebasing: $0[0..<n])) }
      let pacote = Array(buf[0..<n])
      trava.lock()
      if Rtcp.ehRtcp(pacote) {
        if let meio = Rtcp.ntpMeioDoSR(pacote) { ultimoSR = (meio, agora()) }
      } else if n >= 12 && (pacote[0] >> 6) == 2 {
        let ssrc = UInt32(pacote[8]) << 24 | UInt32(pacote[9]) << 16 | UInt32(pacote[10]) << 8 | UInt32(pacote[11])
        if ssrcVideo == nil { ssrcVideo = ssrc }
        if ssrc == ssrcVideo { recepcao.registrar(seq: UInt16(pacote[2]) << 8 | UInt16(pacote[3])) }
      }
      trava.unlock()
    }
  }
}

// ── A sessão ──

final class Sessao: @unchecked Sendable {
  var funcoes: MediaStreamFunctions?
  var idStream: UInt32? = nil
  var ssrcAparelho: UInt32 = 0
  var ssrcNosso: UInt32 = 0
  var destino = sockaddr_in6()
  var fd: Int32 = -1
  var receptor: Receptor?
  var timerRR: DispatchSourceTimer?
  var seqFIR: UInt8 = 0
  let trava = NSLock()
  var encerrando = false

  func enviar(_ bytes: [UInt8]) {
    guard fd >= 0 else { return }
    var d = destino
    _ = bytes.withUnsafeBytes { b in
      withUnsafePointer(to: &d) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { sendto(fd, b.baseAddress, b.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in6>.size)) } }
    }
  }

  func relatorio() {
    guard let r = receptor else { return }
    r.trava.lock()
    let rec = r.recepcao
    let sr = r.ultimoSR
    let fonte = r.ssrcVideo ?? ssrcAparelho
    r.trava.unlock()
    let lsr = sr?.meio ?? 0
    let dlsr = sr.map { UInt32(min((agora() - $0.quando) * 65536, Double(UInt32.max))) } ?? 0
    enviar(Rtcp.relatorio(remetente: ssrcNosso, fonte: fonte, recepcao: rec, lsr: lsr, dlsr: dlsr))
  }

  func pedirQuadroChave() {
    guard let r = receptor else { return }
    r.trava.lock(); let fonte = r.ssrcVideo ?? ssrcAparelho; r.trava.unlock()
    seqFIR &+= 1
    enviar(Rtcp.pli(remetente: ssrcNosso, fonte: fonte) + Rtcp.fir(remetente: ssrcNosso, fonte: fonte, seq: seqFIR))
    log("pediu quadro-chave (PLI + FIR \(seqFIR))")
  }

  /// Para o stream no aparelho (com prazo) e sai. Só a primeira chamada vale.
  func encerrar(_ status: Int32 = 0) async {
    let primeira = trava.withLock { () -> Bool in
      if encerrando { return false }
      encerrando = true
      return true
    }
    guard primeira else { return }
    timerRR?.cancel()
    receptor?.parar = true
    if let f = funcoes, let id = idStream {
      do {
        _ = try await comPrazo(4) { try await f.stopMediaStream(with: DeviceMediaStream.StopRequest(stopAll: false, identifiers: [id])) }
        log("stream \(id) parado no aparelho")
      } catch {
        log("não conseguiu parar o stream \(id): \(error)")
      }
    }
    saida.evento(["event": "stopped"])
    if fd >= 0 { close(fd) }
    exit(status)
  }
}

let sessao = Sessao()
saida.aoFechar = { Task { await sessao.encerrar() } }

// SIGTERM e SIGINT param o stream antes de sair.
let sinais: [DispatchSourceSignal] = [SIGTERM, SIGINT].map { sinal in
  signal(sinal, SIG_IGN)
  let fonte = DispatchSource.makeSignalSource(signal: sinal, queue: .global())
  fonte.setEventHandler { Task { await sessao.encerrar() } }
  fonte.resume()
  return fonte
}

// Comandos pelo stdin. Fim do stdin = a ADE fechou ou caiu: para.
Thread.detachNewThread {
  while let linha = readLine() {
    switch linha.trimmingCharacters(in: .whitespaces) {
    case "keyframe": sessao.pedirQuadroChave()
    case "stop": Task { await sessao.encerrar() }; return
    default: break
    }
  }
  Task { await sessao.encerrar() }
}

saida.evento(["event": "connecting", "version": VERSAO])

let gerente = DeviceManager.shared
do {
  try await comPrazo(10) { await gerente.awaitFullInitialization() }
} catch {
  erro("coredevice", "O CoreDevice não respondeu.", sai: 10)
}
guard let aparelho = gerente.devices[alvo] else { erro("notFound", "O aparelho não está conectado.", sai: 2) }
do {
  try await comPrazo(15) { try await aparelho.connect() }
} catch {
  erro("connect", "Não deu para conectar ao aparelho.", detalhe: error, sai: 3)
}

var textoInfo = ""
dump(aparelho.deviceInfo, to: &textoInfo, maxDepth: 5)
guard let tunel = valorInfo(textoInfo, "tunnelIPAddressString") ?? tunelPedido else { erro("tunnel", "O aparelho está sem túnel do CoreDevice.", sai: 4) }
let transporte = valorInfo(textoInfo, "transportType") ?? "?"
guard let ipLocal = enderecoLocal(prefixoDe: tunel) else { erro("tunnel", "O Mac não tem endereço no túnel do aparelho (\(tunel)).", sai: 4) }

// O socket que recebe o vídeo, no endereço do Mac dentro do túnel.
let fd = socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP)
guard fd >= 0 else { erro("socket", "Não deu para abrir o socket UDP.", sai: 5) }
var buffer: Int32 = 8 << 20
setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &buffer, 4)
var local = sockaddr_in6()
local.sin6_family = sa_family_t(AF_INET6)
local.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
inet_pton(AF_INET6, ipLocal, &local.sin6_addr)
let ligou = withUnsafePointer(to: &local) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in6>.size)) } }
guard ligou == 0 else { erro("socket", "Não deu para escutar em [\(ipLocal)].", sai: 5) }
var tamanhoLocal = socklen_t(MemoryLayout<sockaddr_in6>.size)
_ = withUnsafeMutablePointer(to: &local) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &tamanhoLocal) } }
let portaLocal = UInt16(bigEndian: local.sin6_port)
sessao.fd = fd

// O negociador local do AVConference (modo 5 = CoreDeviceScreenSharing), com as opções que o CoreDevice dá.
var opcoesNeg: [String: Any] = [:]
for (k, v) in MediaStreamFunctions.getNegotiatorOptions(for: aparelho.deviceInfo) { opcoesNeg[k] = v }
var erroNeg: NSError? = nil
guard let negociador = AdeNegociadorCriar(5, opcoesNeg, &erroNeg), let oferta = AdeNegociadorOferta(negociador) else {
  erro("negotiator", "O macOS não montou a negociação do vídeo (AVConference).", detalhe: erroNeg, sai: 5)
}

let funcoes = MediaStreamFunctions(device: aparelho)
sessao.funcoes = funcoes
// Logo depois do connect, a 1ª consulta às vezes cai ("connection was invalidated"): tenta de novo antes de desistir.
var comuns: UInt64 = 0
for tentativa in 1...3 {
  do {
    comuns = try await comPrazo(8) { try await funcoes.mediaStreamSupportInfo }.common.supportedFeatures
    break
  } catch {
    if tentativa == 3 { erro("support", "O aparelho não respondeu ao pedido de espelhamento.", detalhe: error, sai: 6) }
    log("supportInfo falhou (tentativa \(tentativa)): \(error)")
    try? await Task.sleep(nanoseconds: 400_000_000)
  }
}

// O tamanho da tela (o vídeo vem com bordas de alinhamento à direita e embaixo).
final class Caixa<T>: @unchecked Sendable { var valor: T; init(_ v: T) { valor = v } }
let tela = Caixa<(Int, Int)?>(nil)
do {
  let info: DisplayInfo = try await comPrazo(4) {
    try await withCheckedThrowingContinuation { c in aparelho.getDisplayInfo(completingOn: nil) { c.resume(with: $0) } }
  }
  tela.valor = tamanhoDaTela(info)
} catch {
  log("sem DisplayInfo: \(error)")
}

let receptor = Receptor(fd: fd)
sessao.receptor = receptor
Thread.detachNewThread { receptor.rodar() }

let chaveCallID = AdeNegociadorConstante("kAVCMediaStreamOptionCallID") ?? "avcMediaStreamOptionCallID"
let opcoes: [String: CodableValue] = [
  DeviceMediaStream.kAVCMediaStreamOptionClientName: .string("ADE AGS"),
  // Tem de ser `.uuid`: com `.string` o aparelho responde 9005 ("Missing ClientName, CallID, or ClientSessionID").
  DeviceMediaStream.kAVCMediaStreamOptionClientSessionID: .uuid(UUID()),
  chaveCallID: .int(Int(arc4random_uniform(1_000_000)) + 1),
]
let pedido = DeviceMediaStream.StartRequest(timeout: 15, type: .video, direction: .output, negotiatorOffer: oferta,
  clientSupportedFeatures: comuns, receiverIP: ipLocal, receiverPort: portaLocal, options: opcoes)
let resposta: DeviceMediaStream.StartResponse
do {
  resposta = try await comPrazo(20) { try await funcoes.startMediaStream(with: pedido) }
} catch {
  erro("start", "O aparelho não abriu o espelhamento.", detalhe: error, sai: 6)
}
// O id que o stop aceita é o RemoteSSRC (o SSRC do lado do Mac); o LocalSSRC é o do vídeo do aparelho.
if let id = campo(resposta.connection.streamConfig, "RemoteSSRC") as? UInt32 { sessao.idStream = id; sessao.ssrcNosso = id }
if let s = campo(resposta.connection.streamConfig, "LocalSSRC") as? UInt32 { sessao.ssrcAparelho = s }
var erroResp: NSError? = nil
if !AdeNegociadorDefinirResposta(negociador, resposta.negotiatorAnswer, &erroResp) {
  log("o negociador recusou a resposta: \(String(describing: erroResp))")
}

// Para onde vai o RTCP: o endereço e a porta de onde o aparelho manda (RTP e RTCP na mesma porta).
let remetente = resposta.connection.sender
var destino = sockaddr_in6()
destino.sin6_family = sa_family_t(AF_INET6)
destino.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
destino.sin6_port = remetente.port.bigEndian
inet_pton(AF_INET6, remetente.ipv6Address, &destino.sin6_addr)
sessao.destino = destino

// Relatório de recepção a cada segundo: sem RTCP por 15 s, o aparelho derruba a sessão.
let timer = DispatchSource.makeTimerSource(queue: .global())
timer.schedule(deadline: .now() + 0.5, repeating: 1.0)
timer.setEventHandler { sessao.relatorio() }
timer.resume()
sessao.timerRR = timer

var iniciado: [String: Any] = ["event": "started", "transport": transporte, "stream": Int(sessao.idStream ?? 0)]
if let (w, h) = tela.valor { iniciado["display"] = ["w": w, "h": h] }
saida.evento(iniciado)
log("espelhando \(alvo) por \(transporte): [\(ipLocal)]:\(portaLocal) ← [\(remetente.ipv6Address)]:\(remetente.port)")

// Fica de pé até um stop (stdin, sinal ou stdout fechado).
while true { try? await Task.sleep(nanoseconds: 3_600_000_000_000) }
