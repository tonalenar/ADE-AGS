// RTCP do lado de quem recebe (RFC 3550, RFC 4585 e RFC 5104): o relatório de recepção que mantém o stream vivo
// (o aparelho derruba a sessão sem RTCP por 15 s) e o pedido de quadro-chave depois de uma perda. Lógica pura,
// conferida por `Testes/main.swift`.

/// As contas de recepção de um SSRC: maior sequência estendida e perdas acumuladas.
struct Recepcao {
  private(set) var base: UInt32? = nil
  private(set) var maior: UInt32 = 0
  private(set) var recebidos: UInt32 = 0

  /// Um pacote RTP com a sequência `seq` chegou.
  mutating func registrar(seq: UInt16) {
    recebidos &+= 1
    guard base != nil else {
      base = UInt32(seq)
      maior = UInt32(seq)
      return
    }
    let ciclos = maior & 0xFFFF_0000
    let atual = UInt16(truncatingIfNeeded: maior)
    let delta = seq &- atual
    if delta != 0 && delta < 0x8000 {
      // À frente (com volta pelo zero, se for o caso).
      maior = (seq < atual ? ciclos &+ 0x1_0000 : ciclos) | UInt32(seq)
    }
  }

  /// Quantos se esperavam e não chegaram (24 bits, como no relatório). Atrasados que chegam depois descontam.
  var perdidos: UInt32 {
    guard let base else { return 0 }
    let esperados = maior &- base &+ 1
    return esperados > recebidos ? min(esperados - recebidos, 0x7F_FFFF) : 0
  }
}

enum Rtcp {
  private static func be32(_ v: UInt32, _ out: inout [UInt8]) {
    out += [UInt8(v >> 24), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)]
  }

  /// Receiver Report (PT 201) com um bloco sobre `fonte`. `lsr`/`dlsr`: os 32 bits do meio do NTP do último SR e
  /// a espera desde ele em 1/65536 s (0 se nenhum SR chegou).
  static func relatorio(remetente: UInt32, fonte: UInt32, recepcao: Recepcao, lsr: UInt32, dlsr: UInt32) -> [UInt8] {
    var out: [UInt8] = [0x81, 201, 0, 7]
    be32(remetente, &out)
    be32(fonte, &out)
    be32(recepcao.perdidos & 0x00FF_FFFF, &out)  // fração perdida 0 + perdas acumuladas
    be32(recepcao.maior, &out)
    be32(0, &out)  // jitter
    be32(lsr, &out)
    be32(dlsr, &out)
    return out
  }

  /// Picture Loss Indication (PSFB, PT 206, FMT 1).
  static func pli(remetente: UInt32, fonte: UInt32) -> [UInt8] {
    var out: [UInt8] = [0x81, 206, 0, 2]
    be32(remetente, &out)
    be32(fonte, &out)
    return out
  }

  /// Full Intra Request (PSFB, PT 206, FMT 4), com o número de sequência do pedido.
  static func fir(remetente: UInt32, fonte: UInt32, seq: UInt8) -> [UInt8] {
    var out: [UInt8] = [0x84, 206, 0, 4]
    be32(remetente, &out)
    be32(0, &out)
    be32(fonte, &out)
    out += [seq, 0, 0, 0]
    return out
  }

  /// Com RTP e RTCP na mesma porta (RFC 5761), o RTCP tem o 2º byte entre 192 e 223.
  static func ehRtcp(_ b: [UInt8]) -> Bool {
    b.count >= 8 && (b[0] >> 6) == 2 && b[1] >= 192 && b[1] <= 223
  }

  /// Os 32 bits do meio do NTP do primeiro Sender Report (PT 200) de um pacote composto; `nil` se não houver.
  static func ntpMeioDoSR(_ b: [UInt8]) -> UInt32? {
    var off = 0
    while off + 4 <= b.count {
      let pt = b[off + 1]
      let palavras = (Int(b[off + 2]) << 8 | Int(b[off + 3])) + 1
      if pt == 200 && off + 16 <= b.count {
        return UInt32(b[off + 10]) << 24 | UInt32(b[off + 11]) << 16 | UInt32(b[off + 12]) << 8 | UInt32(b[off + 13])
      }
      off += palavras * 4
    }
    return nil
  }
}
