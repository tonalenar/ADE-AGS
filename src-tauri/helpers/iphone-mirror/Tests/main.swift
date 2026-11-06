// Testes da parte pura do helper (RTCP), sem XCTest: `bun run build:iphone-mirror --test`.
import Darwin

var falhas = 0
func confere(_ ok: Bool, _ nome: String, linha: Int = #line) {
  if ok { print("ok   \(nome)") } else { falhas += 1; print("FALHOU \(nome) (linha \(linha))") }
}

do {
  var r = Recepcao()
  for s in [100, 101, 102] as [UInt16] { r.registrar(seq: s) }
  confere(r.maior == 102 && r.perdidos == 0, "sequência sem perda")
  r.registrar(seq: 105)
  confere(r.maior == 105 && r.perdidos == 2, "perda de dois pacotes")
  r.registrar(seq: 103)
  confere(r.maior == 105 && r.perdidos == 1, "atrasado que chega desconta")
}
do {
  var r = Recepcao()
  r.registrar(seq: 65534); r.registrar(seq: 65535); r.registrar(seq: 0); r.registrar(seq: 1)
  confere(r.maior == 0x1_0001 && r.perdidos == 0, "volta pelo zero conta um ciclo")
}
do {
  var r = Recepcao()
  r.registrar(seq: 7)
  let rr = Rtcp.relatorio(remetente: 0xAABBCCDD, fonte: 0x11223344, recepcao: r, lsr: 0x01020304, dlsr: 0x10000)
  confere(rr.count == 32, "RR tem 32 bytes")
  confere(Array(rr[0..<4]) == [0x81, 201, 0, 7], "cabeçalho do RR")
  confere(Array(rr[4..<12]) == [0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44], "SSRCs do RR")
  confere(Array(rr[16..<20]) == [0, 0, 0, 7], "maior sequência no RR")
  confere(Array(rr[24..<32]) == [1, 2, 3, 4, 0, 1, 0, 0], "LSR e DLSR")
  confere(Rtcp.ehRtcp(rr), "RR é RTCP")
}
do {
  let pli = Rtcp.pli(remetente: 1, fonte: 2)
  confere(pli == [0x81, 206, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2], "PLI")
  let fir = Rtcp.fir(remetente: 1, fonte: 2, seq: 9)
  confere(fir == [0x84, 206, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 9, 0, 0, 0], "FIR")
  confere(!Rtcp.ehRtcp([0x90, 100, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]), "RTP do vídeo não é RTCP")
}
do {
  // SR (28 bytes) seguido de SDES, como o aparelho manda.
  var sr: [UInt8] = [0x80, 200, 0, 6, 0, 0, 0, 1, 0xE9, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]
  sr += [UInt8](repeating: 0, count: 12)
  let sdes: [UInt8] = [0x81, 202, 0, 1, 0, 0, 0, 1]
  confere(Rtcp.ntpMeioDoSR(sr + sdes) == 0x0203_0405, "meio do NTP do SR")
  confere(Rtcp.ntpMeioDoSR(sdes) == nil, "sem SR")
  confere(Rtcp.ntpMeioDoSR([0x80, 200, 0]) == nil, "SR cortado")
}

print(falhas == 0 ? "todos os testes passaram" : "\(falhas) falhas")
exit(falhas == 0 ? 0 : 1)
