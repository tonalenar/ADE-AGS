# iPhone e iPad físicos ao lado do simulador

A tela de um iPhone ou iPad de verdade, pelo cabo ou pelo Wi-Fi, no mesmo lugar do simulador: no nó iOS do canvas e no painel iOS do modo chat. O seletor ganhou duas seções: **Aparelhos** (os físicos que o CoreDevice conhece, com USB ou Wi-Fi, modelo e iOS) e **Simuladores** (a lista do Xcode de sempre).

**Por enquanto, só ver.** Nada de toque, botão, teclado ou HID: o clique na tela espelhada não vai para o aparelho, e os controles do simulador (início, bloquear, girar, foto, aparência, localização, Face ID, teclado, modo leve, desligar, conversa com os agentes) somem quando o aparelho é físico. `ags device` e `sim act` recusam um nó que mostra aparelho físico. Nada é instalado, reiniciado ou mudado no aparelho.

Próximos passos (outros PRs): toque e botões, os painéis laterais (ajustes, informações, apps, falhas, build & run), `ags device` com controle pelos agentes e a captura para o computer use.

## Como funciona

```
devicectl (público) ──► lista ──► seletor "Aparelhos"
                                          │ escolhe
ADE (Rust) ── spawn ──► ade-iphone-mirror (Swift, processo à parte)
   ▲   stdin: keyframe / stop                │ CoreDevice + AVConference (privados)
   │                                         ▼
   └── stdout: eventos JSON + datagramas ◄── UDP/IPv6 no túnel do CoreDevice (RTP HEVC + RTCP)
   │
   ├─ model::Depacketizer (RFC 7798) ─► VideoToolbox (público) ─► CVPixelBuffer/IOSurface
   └─ AdeDeviceMirrorView (NSView por cima do webview) ◄── contents = IOSurface, contentsRect = recorte
```

### Por que um helper à parte

As interfaces do CoreDevice são privadas e de *library evolution*; o app só as conhece pelas `.swiftinterface` escritas à mão em `src-tauri/helpers/iphone-mirror/stubs/`. Uma assinatura errada não dá erro: dá `swift_retain` em ponteiro ruim e o processo cai. Por isso o que fala com o CoreDevice e com o AVConference fica num executável próprio (`ade-iphone-mirror`):

- se ele cair, a ADE vê o stdout fechar, mostra "Reconectando…" e o abre de novo, com espera crescente;
- a ADE não liga ao CoreDevice: abre e compila onde ele não existe (CI, outros Macs, Windows, Linux). Sem o Xcode 27, o seletor diz "precisa do Xcode 27" e a sessão fica "Sem conexão".

O que é público fica no app: a lista (`xcrun devicectl list devices --json-output`), a montagem dos quadros (pura, testada em `iphone/test.rs`), o VideoToolbox e a camada. O vídeo é pequeno (1 a 6 Mbit/s), então passar os datagramas pelo pipe custa pouco e evita compartilhar `IOSurface` entre processos (o caminho global de `IOSurfaceLookup` é obsoleto, e mach port ou XPC pediriam um serviço de launchd).

O HEVC chega pelo pipe; o decodificador é o do macOS. Um quadro ruim volta como erro do VideoToolbox, não derruba o app.

### Mapa das APIs (Xcode 27, CoreDevice 651.32, AVConference 2260.15.1)

| Passo | API | Onde |
|---|---|---|
| Lista | `xcrun devicectl list devices --json-output` (público): `identifier`, `hardwareProperties.{reality,platform,deviceType,marketingName}`, `deviceProperties.{name,osVersionNumber,developerModeStatus}`, `connectionProperties.{transportType,pairingState,tunnelState,tunnelIPAddress}` | `iphone/commands.rs`, `model::parse_devicectl` |
| Aparelho | `DeviceManager.shared` → `await awaitFullInitialization()` → `devices[UUID]`. A chave é o identificador do CoreDevice, **não** o UDID | `helpers/iphone-mirror/Sources/main.swift` |
| Conectar | `try await RemoteDevice.connect()` (com prazo de 15 s) | idem |
| Endereço no túnel | `deviceInfo` (lido pelo `dump`): `com.apple.CoreDevice:tunnelIPAddressString` e `transportType`. O endereço do Mac é o do mesmo /64 numa interface local (`utunN`, terminado em `::2`) | idem |
| Funções | `MediaStreamFunctions(device:)`. **Não** `RemoteDevice.startMediaStream`: está obsoleto e responde 9011 | idem |
| Suporte | `mediaStreamSupportInfo` (async throws) → `common.supportedFeatures` (0x8c: espelho da tela principal, áudio do sistema, informação da tela) | idem |
| Tela | `RemoteDevice.getDisplayInfo(completingOn:completion:)` → `displays[deviceName == "primary"].bounds` (1290×2796 no iPhone 15 Pro Max) | idem |
| Negociação | `AVCMediaStreamNegotiator` (AVConference, por `dlopen`): `initWithMode:5 options:error:` com `MediaStreamFunctions.getNegotiatorOptions(for: deviceInfo)`; `offer`; depois `setAnswer:withError:` | `Sources/Negociador.m` |
| Abrir | `startMediaStream(with: StartRequest(timeout: 15, type: .video, direction: .output, negotiatorOffer:, clientSupportedFeatures:, receiverIP:, receiverPort:, options:))`. Opções: `avcMediaStreamOptionClientName` (texto), `avcMediaStreamOptionClientSessionID` (**tem de ser `.uuid`**: com texto o aparelho responde 9005), `avcMediaStreamOptionCallID` (inteiro) | `main.swift` |
| Fechar | `stopMediaStream(with: StopRequest(stopAll: false, identifiers: [RemoteSSRC]))`: o id é o `RemoteSSRC` do `streamConfig` (o SSRC do lado do Mac) | `main.swift` (`Sessao.encerrar`) |

Cuidados que custaram horas na sondagem:

- `CodableValue` tem de ser `indirect` na interface; sem isso o layout não bate e o `swift_retain` cai.
- Os tipos de `DeviceMediaStream` moram no `CoreDeviceUtilities`, mas são mangleados como `CoreDevice`; o `DeviceInfo` é mangleado como `CoreDeviceProtocols`.
- O `MediaStreamSession` de alto nível (`CoreDeviceMediaStreamSupport`) exige o entitlement restrito `com.apple.videoconference.allow-conferencing`. Não é usado.
- Logo depois do `connect`, a primeira consulta às vezes falha ("connection was invalidated", erro 3/1001, ou 4000 `xpcConnectionUnavailable`). O helper tenta 3 vezes antes de desistir.

### O vídeo

- RTP sobre UDP/IPv6 dentro do túnel do CoreDevice, **sem criptografia**, com RTCP na mesma porta (RFC 5761). Payload type 100, relógio de 24 kHz, extensão de cabeçalho da Apple (perfis 0x9001 e 0x9011).
- HEVC pela RFC 7798: NAL simples, agregação (AP, 48) e fragmento (FU, 49). VPS, SPS e PPS vêm num AP antes de cada IDR (tipo 20, `IDR_N_LP`). 4:2:0, 8 bits, faixa cheia.
- O quadro decodificado tem 1296×2816 para uma tela de 1290×2796: as bordas de alinhamento ficam **à direita e embaixo** (medido: as colunas 1290–1295 são pretas). O recorte é o `contentsRect` da camada (`model::contents_rect`, com a origem embaixo do Core Animation).
- **Só um IDR no começo** (`KeyFrameInterval: 0`). Depois de uma perda, a ADE descarta os quadros até chegar um IRAP e pede um ao aparelho com RTCP PLI + FIR (`keyframe` no stdin do helper). Medido: o IDR chega em 30–150 ms. Sem resposta em 2,5 s, a sessão é refeita (stream novo começa com IDR).
- O aparelho derruba a sessão sem RTCP por 15 s (`RTCPTimeoutEnabled: true`, `RTCPTimeoutInterval: 15`). O helper manda um Receiver Report por segundo (RFC 3550, com a maior sequência, as perdas e o LSR/DLSR do último SR). Medido: 150 s ligados sem queda.
- Com a tela parada, o aparelho manda menos quadros e chega a parar o vídeo por até 11 s (medido), mas o Sender Report do RTCP continua a cada segundo. Por isso o vigia conta qualquer datagrama: 3 s sem nenhum quer dizer que caiu.
- Um quadro-chave a cada 10 s (`KEYFRAME_REFRESH`), mesmo sem perda: limita qualquer deriva que a montagem não veja. Uma vez, logo depois de o app de dev reiniciar, a tela saiu com blocos corrompidos sem nenhuma perda contada; não se repetiu. O aparelho atende ~metade desses pedidos com a tela parada.
- Um decodificador novo (parâmetros novos) só recebe quadros a partir de um IRAP.

## A conexão

`model::Link` (testado) e a thread da sessão (`iphone/session.rs`), uma por aparelho, compartilhada pelas telas que o mostram:

| Estado | Quando | Linha de estado |
|---|---|---|
| `connecting` | primeira abertura | Conectando… |
| `live` | o helper disse `started` | Ligado · USB / Wi-Fi |
| `reconnecting` | caiu (helper saiu, 3 s sem datagrama, 25 s sem abrir, sem IDR em 2,5 s) | Reconectando… (fica o último quadro) |
| `offline` | 4 tentativas seguidas sem ligar, ou falta o Xcode/helper | Sem conexão (a tela fica vazia, com o motivo) |
| `paused` | nenhuma tela à vista por 15 s | Pausado: o helper para o stream no aparelho |

Espera entre as tentativas: 0,5 s, 1 s, 2 s, 4 s e depois 8 s (30 s quando falta o Xcode ou o helper). A thread só espera no canal dela (mensagens do helper, das telas e os prazos); não há laço com `sleep`.

O stream sempre é parado no aparelho: no `stop` da ADE, quando a última tela fecha, quando o stdin do helper fecha (a ADE saiu ou caiu) e no SIGTERM. Se o helper não sair em 6 s depois do `stop`, a sessão encerra **só o processo que ela abriu** (pelo `Child` que guarda, nunca por nome nem por PID solto). Ninguém liga, desliga nem reinicia o aparelho.

## A tela

`AdeDeviceMirrorView` (`iphone/native/view.rs`) é a irmã da `AdeSimulatorScreenView`: uma `NSView` com camada própria por cima do webview, que o frontend posiciona com a mesma medição (`NativeScreen`, em `simulator/SimulatorScreen.tsx`: retângulo, parte à vista e buracos de menus). A máscara (cantos, recorte, buracos) é a mesma função do simulador (`simulator::native::view::apply_region`).

- Os quadros entram na camada por uma fila serial própria (`ade.iphone.frames`, QoS `userInteractive`), numa `CATransaction` explícita, e os 3 últimos `CVPixelBuffer` ficam retidos para o pool do VideoToolbox não escrever por cima do que a GPU compõe.
- A camada é transparente até o primeiro quadro e quando a conexão some: aí aparece o estado que o frontend desenha por baixo ("Abrindo a tela do aparelho…", "Sem conexão…").
- Só ver: dentro da região à vista a view fica com o clique e o rolar (para o canvas não arrastar por baixo) e não faz nada com eles.

## Interface

- **Seletor** (barra do nó e painel do chat): "Aparelhos" em cima, com etiqueta USB/Wi-Fi, modelo e iOS; os que não estão prontos aparecem apagados com o que falta ("Toque em “Confiar” no aparelho", "Ligue o Modo de Desenvolvedor", "Desconectado"). A lista é relida a cada 4 s só enquanto o seletor está aberto.
- **Estado vazio** (`iphone/ConnectHint.tsx`): o aparelho, o cabo e o Wi-Fi levando ao "Este Mac", com os passos (desbloquear, "Confiar", Modo de Desenvolvedor). Respeita `prefers-reduced-motion` (`App.css`, `ade-connect-*`).
- **Nó do canvas**: a mesma moldura do simulador, com a tela em pontos (@3x nos iPhones grandes, @2x nos pequenos e no iPad, `iphone/model.ts`), a linha de estado na barra e o "⋯" só com zoom e fechar.
- **Painel do chat**: `iphone/PhysicalPane.tsx`, sem a coluna de controles e sem a chave dos agentes. O aparelho físico não vai para `sharedDevices` (os agentes não o recebem).

## Medições

Tudo no iPhone 15 Pro Max (iOS 27.2), pelo Wi-Fi, num Mac com macOS 27.2 e Xcode 27, com a ADE de debug isolada (`ADE_AGS_DATA_DIR`) e `ADE_IPHONE_FPS=1`, que imprime no log a cada segundo:

```sh
ADE_AGS_DATA_DIR=<pasta> ADE_IPHONE_FPS=1 env -u CARGO_TARGET_DIR bun run tauri dev
```

| O quê | Resultado |
|---|---|
| Quadros por segundo na camada | mediana 59 por janela de 1 s (máx. 68); com a tela parada cai até parar (o aparelho não manda) |
| Chegada do último pacote → quadro decodificado | p50 3–4,3 ms; máx. 7 ms (fora o 1º quadro, 269 ms, que abre o decodificador) |
| Captura no aparelho → quadro decodificado (estimativa pelo RTCP SR, descontado o deslocamento mínimo dos relógios, ≈ atraso menos uma ida pela rede) | mediana do p50 ~50 ms (faixa 20–76 ms) |
| Banda | 0,8–1,7 Mbit/s |
| Abrir (spawn → `started`) | ~1–3 s com o túnel de pé; até 8 s quando o túnel do Wi-Fi está se refazendo |
| Sessão longa com Receiver Report | 150 s sem queda (helper sozinho); 170 s sem queda dentro da ADE: 2.902 quadros, 0 perdas, 0 descartes |
| PLI + FIR → IDR | 30–150 ms (3 de 3 pedidos) |

**USB não foi medido** (o aparelho estava só no Wi-Fi). O túnel do Wi-Fi caiu várias vezes na sondagem e no teste (`tunnelState: connecting` com o aparelho bloqueado): a sessão mostrou "Reconectando…" e voltou sozinha quando o túnel voltou.

## Desenvolver

- `bun run build:iphone-mirror`: compila o helper em `src-tauri/binaries/ade-iphone-mirror` (só no macOS com o Xcode 27; sem eles, avisa e sai com 0). O `stage-cli` o chama no build do `.app`, então ele vai junto com o `ags` em `Contents/Resources/binaries/`.
- `bun run build:iphone-mirror --test`: os testes da parte pura do helper (RTCP), sem XCTest.
- Em desenvolvimento, a ADE procura o helper também em `src-tauri/binaries/` (só em debug).
- O `tauri dev` observa `src-tauri/binaries/`: recompilar o helper com o app aberto reinicia o app (e o helper para o stream no aparelho ao perder o stdin).
