# iPhone e iPad físicos ao lado do simulador

A tela de um iPhone ou iPad de verdade, pelo cabo ou pelo Wi-Fi, no mesmo lugar do simulador: no nó iOS do canvas e no painel iOS do modo chat. O seletor ganhou duas seções: **Aparelhos** (os físicos que o CoreDevice conhece, com USB ou Wi-Fi, modelo e iOS) e **Simuladores** (a lista do Xcode de sempre).

**Ver e controlar.** Clicar e arrastar na tela espelhada toca o aparelho; com a tela em foco, o teclado do Mac digita nele. A barra e o painel têm o início e o "⋯" com **Sistema** (Central de Controle, Central de Notificações, Busca) e **Botões** (volume, mudo, Siri, bloquear); a moldura do canvas tem os botões da lateral. Os agentes usam `ags device` e `sim act` com a mesma autorização do simulador e uma confirmação a mais por ser o aparelho de verdade (ver [Agentes](#agentes)). Nada é instalado, reiniciado ou mudado no aparelho por conta própria.

Próximos passos (outros PRs): os painéis laterais (ajustes, informações, apps, falhas, build & run) e o toque com dois dedos pela interface.

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
- HEVC pela RFC 7798: NAL simples, agregação (AP, 48), fragmento (FU, 49) e PACI (50, que embrulha um dos três: desembrulhado pela §4.4.4; não foi visto no aparelho, mas um PACI descartado sumiria com um quadro sem aviso). Um pacote de tipo sem definição (51–63) deixa o quadro incompleto. VPS, SPS e PPS vêm num AP antes de cada IDR (tipo 20, `IDR_N_LP`). 4:2:0, 8 bits, faixa cheia.
- O quadro decodificado tem 1296×2816 para uma tela de 1290×2796: as bordas de alinhamento ficam **à direita e embaixo** (medido: as colunas 1290–1295 são pretas). O recorte é o `contentsRect` da camada (`model::contents_rect`, com a origem embaixo do Core Animation).
- **Só um IDR no começo** (`KeyFrameInterval: 0`). Depois de uma perda, a ADE descarta os quadros até chegar um IRAP e pede um ao aparelho com RTCP PLI + FIR (`keyframe` no stdin do helper). Medido: o IDR chega em 30–150 ms. Sem resposta em 2,5 s, a sessão é refeita (stream novo começa com IDR).
- O aparelho derruba a sessão sem RTCP por 15 s (`RTCPTimeoutEnabled: true`, `RTCPTimeoutInterval: 15`). O helper manda um Receiver Report por segundo (RFC 3550, com a maior sequência, as perdas e o LSR/DLSR do último SR). Medido: 150 s ligados sem queda.
- Com a tela parada, o aparelho manda menos quadros e chega a parar o vídeo por até 11 s (medido), mas o Sender Report do RTCP continua a cada segundo. Por isso o vigia conta qualquer datagrama: 3 s sem nenhum quer dizer que caiu.
- Um quadro-chave a cada 10 s (`KEYFRAME_REFRESH`), mesmo sem perda: limita qualquer deriva que a montagem não veja. Uma vez, logo depois de o app de dev reiniciar, a tela saiu com blocos corrompidos sem nenhuma perda contada; não se repetiu. O aparelho atende ~metade desses pedidos com a tela parada.
- Um decodificador novo (parâmetros novos) só recebe quadros a partir de um IRAP.
- Qualquer quadro que sai incompleto da montagem (sem salto de sequência, por exemplo um tipo de pacote desconhecido) conta como perda: a tela segura o último quadro bom e a ADE pede um quadro-chave. O diagnóstico (`ADE_IPHONE_FPS=1`) mostra perdas, incompletos e os tipos de pacote por segundo.

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
- A fila acompanha o relógio RTP de 24 kHz, limita a espera adicional a 16,7 ms e recupera 50 µs por quadro para esvaziar a folga gradualmente quando a chegada varia. Quadros fora de ordem e pendências de uma sessão encerrada são descartados.
- A camada é transparente até o primeiro quadro e quando a conexão some: aí aparece o estado que o frontend desenha por baixo ("Abrindo a tela do aparelho…", "Sem conexão…").
- **Toque:** dentro da região à vista, o clique e o arrasto viram toque em proporção da tela (a view mostra a tela já recortada, sem as bordas de alinhamento do vídeo, então a proporção da view é a da tela: `model::view_touch`). O arrasto sai no máximo a cada 8 ms. Um arrasto que começa nos últimos 1,5% de baixo leva a borda `bottom` do início ao fim (a barra de início); nos de cima, `top` (as centrais).
- **Teclado:** com a view em foco, as teclas com nome pelo código da tecla e o resto pelo caractere (teclado US, o mesmo mapa do simulador).
- **Rolagem com dois dedos** (`scrollWheel:`): vira um dedo arrastando no digitalizador (`model::ScrollDrag`, testado). O dedo desce no cursor no começo do gesto, anda com os deltas (a direção já vem da preferência do Mac: rolagem natural move o conteúdo junto com os dedos) e solta no fim; a inércia do Mac fica de fora e o iOS aplica a dele pela velocidade do dedo ao soltar. Horizontal também. A roda do mouse vira um arrasto curto por clique. O HID de rolagem do CoreDevice (`ScrollHIDCapability`) não serve aqui: o alvo dele é o dial e a Digital Crown (`ScrollTarget.dial/digitalCrown`).
- **Pinça do trackpad** (`magnifyWithEvent:`): dois dedos em volta do cursor, que se afastam ou se aproximam com a ampliação (`model::Pinch`), pelo `pointTwo` do digitalizador.
- **Atalhos** com a tela em foco: ⌘↑ e ⌘↓ volume, ⌘L botão lateral, ⌘⇧H início (`model::shortcut`, por `performKeyEquivalent:`, só quando a tela é a primeira a responder).
- O botão direito para na view (o canvas não arrasta por baixo) e não vai ao aparelho.

## Interface

- **Seletor** (barra do nó e painel do chat): "Aparelhos" em cima, com etiqueta USB/Wi-Fi, modelo e iOS; os que não estão prontos aparecem apagados com o que falta ("Toque em “Confiar” no aparelho", "Ligue o Modo de Desenvolvedor", "Desconectado"). A lista é relida a cada 4 s só enquanto o seletor está aberto.
- **Estado vazio** (`iphone/ConnectHint.tsx`): o aparelho, o cabo e o Wi-Fi levando ao "Este Mac", com os passos (desbloquear, "Confiar", Modo de Desenvolvedor). Respeita `prefers-reduced-motion` (`App.css`, `ade-connect-*`).
- **Moldura** (`iphone/DeviceFrame.tsx`, no nó do canvas e no painel do chat): a do modelo (`model::frameLayout`), clara ou escura com o tema, com a Ilha Dinâmica (desenhada enquanto o vídeo não chega) e os **botões físicos na borda**: à esquerda o botão de ação (ou a chave de silêncio nos modelos antigos) e o volume, à direita o lateral; no iPad, o superior e o volume. Eles funcionam: descer o ponteiro aperta o botão de verdade e subir solta (`iphone_button_state`), então segurar o lateral chama a Siri como no aparelho. Acendem enquanto apertados e mostram o nome ao lado ao passar o mouse ("Aumentar volume ⌘↑", "Botão lateral ⌘L · segure para a Siri", "Botão de ação · modo silencioso"). As posições são das medidas da Apple, aproximadas.
- **Pílula embaixo do aparelho** (`iphone/DeviceBar.tsx`, painel do chat): o estado ao vivo, início, alternador de apps (subir da borda e segurar), foto da tela (salva em Imagens e oferece copiar para a área de transferência do Mac), gravação de tela e o "⋯" com Sistema e Botões. A rotação física acompanha o acelerômetro do iPhone; o botão de giro por comando permanece no simulador.
- **Sessão pausada:** quando nenhuma tela está visível, a ADE para o vídeo e mantém o pareamento. O painel explica o estado e permite retomar/reabrir a sessão caso ela não volte automaticamente. A moldura acompanha a orientação HEVC quando a resolução do fluxo troca entre retrato e paisagem.
- **Coluna da direita** do painel: digitar no aparelho por um campo, ampliar, reduzir, ajustar ao painel e tamanho real (1:1 = um pixel CSS por ponto do iOS), com o zoom atual embaixo.
- **Nó do canvas**: a mesma moldura, com a tela em pontos (@3x nos iPhones grandes, @2x nos pequenos e no iPad), a linha de estado e o início na barra de cima, e o "⋯" com zoom, Sistema, Botões e fechar. Sem o toque pronto, os controles ficam apagados.
- **Painel do chat**: `iphone/PhysicalPane.tsx`, com a chave "Permitir que agentes controlem dispositivos" embaixo. O aparelho vai para os agentes como o simulador (`sharedDevices`, id `device:<id>`).
- A moldura realista é só do aparelho físico; o simulador segue com a moldura dele (a troca fica para depois).

## HID: toque, botões e teclado

Mapeado pelos símbolos do `CoreDeviceUtilities.framework` (Xcode 27) e conferido nos descritores em tempo de execução: os protocolos `HIDDigitizer`, `HIDButton`, `HIDKeyboard` e `DeviceCapabilityProtocol` **não** são presos a classe (o bit `ClassConstraint` do descritor é 1) e são resilientes (`IsResilient`), então a existencial é a opaca comum e as chamadas vão pelos *dispatch thunks*. As enumerações (`DigitizerEventType`, `DigitizerEdge`, `DigitizerTarget`, `HIDButtonState`) também são resilientes: cada caso vem do símbolo `enum case for …`.

| Parte | API | Onde |
|---|---|---|
| Pegar a capacidade | `RemoteDevice.getImplementation<A: DeviceCapability>(for: CapabilityStaticMember<A>) async throws -> A.ProtocolType`, com `CapabilityStaticMember<HIDDeviceCapability>.digitizer/.button/.keyboard` | `helpers/iphone-mirror/Sources/main.swift` (dentro de um genérico, o valor sai como `Any` com o tipo real do framework e depois vira `any HIDDigitizer`) |
| Toque | `HIDDigitizer.send(pointOne: CGPoint, pointTwo: CGPoint?, eventType: .start/.position/.end, edge: .none/.top/.bottom, target: .mainScreen)`; `sendBarrier()` ao soltar | idem |
| Botões | `HIDButton.sendCustomButton(usagePage:usageCode:state: .down/.up)`; página 0x0C: início 0x40, bloquear/lateral 0x30, volume 0xE9/0xEA, mudo 0xE2, Siri 0xCF | idem; nomes em `iphone::model::button_usage` |
| Teclado | `HIDKeyboard.send(key: HIDKeyboardUsageCode(rawValue:), state:)` (uso HID; Shift = 0xE1) | idem; `iphone::model::text_lines` |
| Gestos do sistema | arrastos: Central de Controle de (0,9; 0,005) a (0,9; 0,45) com borda `top`; Notificações de (0,2; 0,005) a (0,2; 0,6) com `top`; Busca de (0,5; 0,35) a (0,5; 0,6); início de (0,5; 0,995) a (0,5; 0,7) com `bottom` | `iphone::model::gesture` |

O helper lê uma linha por comando no stdin (`touch start|move|end x y [x2 y2] edge`, `button página uso down|up`, `key uso down|up`) e as executa na thread do stdin, uma de cada vez, na ordem (a fila serial). O HID é pedido depois de o vídeo abrir; quando fica pronto, o helper avisa `inputReady` e a linha de estado libera os controles (`MirrorStatus.input`). Uma entrada que falha vira `inputError` no log. As coordenadas vão em proporção da tela em pé (0..1, origem no topo), o mesmo formato do `dtuhidd` do simulador.

## Agentes

O aparelho físico entra pelo mesmo alcance do simulador (`surfaces`): corda no canvas, ou o painel do chat com a chave "Permitir que agentes controlem dispositivos". `ags device list` devolve o id estável `device:<UDID>`, o `coreDeviceId` usado internamente pelo helper, o estado (`connected`, `reconnecting`, `offline`) e o transporte (`usb`, `wifi`, `none`); o agente só vê aparelhos ligados ao próprio ator. Esse id também é aceito por `ags device` e `sim act`. Resolver um UDID compartilhado por mais de um vínculo pede o id do nó, sem adivinhar. Por ser o celular de verdade, há uma camada a mais:

- **`ags device`** (`ipc::commands::simulators::physical`): `shot` passa; `tap`, `swipe`, `key` e `button` perguntam à pessoa no app, com a foto atual e o ponto, até ela responder "Autorizar sempre neste aparelho" (`computer_use.ios.trust.device:<id>`, a mesma chave do `sim act`, apagada quando a pessoa desliga a chave do painel); `type` pergunta **sempre** (não se sabe em que campo o texto cai). Sem resposta = recusa (`computer_use::ios::confirm_physical`, regra pura em `iphone::model::agent_asks`, testada).
- **MCP**: `device_list` (somente leitura), `device_shot` (somente leitura) e `device_action` (uma ação por chamada) usam o mesmo alcance, despachador e confirmação da CLI; contextos de tarefas da frota são recusados. `sim_act` também aceita um iPhone físico ligado ao agente.
- **`sim act`** (`computer_use::ios`): o mesmo laço do simulador, com um quadro do espelho somente se ele vier depois do IRAP/IDR que recuperou a sessão e se não houve anomalia desde então. Perda, quadro incompleto ou falha de decodificação invalida o quadro para agentes até outro quadro-chave. Se a sessão silenciosa não abrir ou não houver quadro seguro, usa `xcrun devicectl device capture screenshot`. O PNG do espelho já sai reduzido, evitando uma segunda recodificação. O log registra `fonte=espelho|devicectl` e `duração=N ms`, sem gravar pixels. O HID do aparelho continua em `iphone::ops`; a confirmação conserva o "sempre" por aparelho e `always_asks` (rótulos sensíveis, ícones sem rótulo, teclas).
- Não existem no aparelho físico: `start`, `open`, `launch`, `close`, `rotate`, `clipboard`, `tree` e `tap --text` (erro antes de qualquer pergunta).
- Sem ninguém olhando, a primeira ação de um agente liga o espelho (uma "tela" `agent:<id>`, que sai de vista no fim da ação) e espera o toque ficar pronto por até 20 s; a sessão para sozinha 15 s depois.
- Os cliques da pessoa no espelho, a barra, o "⋯" e os botões da moldura não perguntam nada: é a pessoa.

O teste da conversa por protocolo confirma que as skills que a pessoa deixou em "Ativa em todos os agentes" também chegam a uma conversa ativa sem aba TUI. `ags-orchestrator` continua fora do conjunto padrão sempre ativo: a pessoa liga essa skill só nos agentes/projetos em que deseja um orquestrador.

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
| Foto do computer use em quadro íntegro | PNG reduzido diretamente de BGRA; origem e duração no log |
| Foto sem quadro confiável | reserva via `devicectl`; duração a medir no E2E desta entrega |

O painel e a barra do canvas mostram a taxa medida a cada segundo. A contagem usa os quadros entregues à camada nativa, uma vez por aparelho, mesmo quando mais de uma tela mostra o vídeo. A taxa real varia com os quadros enviados pelo iPhone.

**Corrupção durante rolagem rápida (USB).** A oferta padrão do AVConference incluía `VRAE:0`, que impedia o encoder de adaptar a resolução. Sob movimento rápido, o iPhone descartava quadros para se manter no limite de banda. O mosaico aparecia também ao decodificar a gravação no FFmpeg, com zero perdas de sequência. O helper remove `VRAE:0` da oferta e preserva os outros recursos. No iPhone 15 Pro Max com iOS 27.2, o CoreDevice confirmou `FLS;SW:1`, e o teste no X deixou de mostrar blocos misturados na rolagem rápida. [Medições independentes do pymobiledevice3](https://github.com/doronz88/pymobiledevice3/blob/776d601cec83b894c3ad0eeee8ab4db375a46e4a/pymobiledevice3/remote/core_device/MOTION_TEAR_FINDINGS.md).

Outra descoberta: com duas sessões abertas no mesmo aparelho, só a mais recente recebe o vídeo.

**Toque:** a pessoa confirmou que clique e arrasto chegam ao aparelho. O log ("entrada→1º quadro novo", com `ADE_IPHONE_FPS=1`) mostrou de 3 a 33 ms até o primeiro quadro novo chegar, mais ~4 ms de decodificação. É um teto otimista: um quadro que já vinha chegando também conta.

**Validação visual por USB (05/11/2026).** Na gravação de tela de 37 s, a rolagem rápida no X ficou sem mosaico perceptível. O contador mostrou 30 fps enquanto um vídeo do TikTok tocava e 42–60 fps depois, no X. Isso registra o comportamento observado, sem medir latência ou banda USB. O túnel do Wi-Fi caiu várias vezes na sondagem e no teste (`tunnelState: connecting` com o aparelho bloqueado): a sessão mostrou "Reconectando…" e voltou sozinha quando o túnel voltou.

**Captura confiável para agentes.** O presenter retém o timestamp monotônico de cada buffer. A fence invalida a foto em lacuna RTP, unidade incompleta, falha do decodificador, troca do decodificador ou sessão nova; só um quadro emitido a partir do IRAP/IDR de recuperação pode voltar a ser usado. Se não houver um quadro aprovado, o computer use e `ags device shot` pedem uma captura independente ao `devicectl`. O tempo inclui abertura silenciosa da sessão e da captura de reserva; meça no log da execução antes de comparar.

**E2E supervisionado desta branch (05/11/2026).** Não executado: a janela ADE já aberta tinha terminais/missões do usuário e o painel mostrava "Sem conexão", então não a usei nem iniciei uma segunda sessão do espelho. A leitura do CoreDevice encontrou um aparelho físico pareado, com Modo de Desenvolvedor ligado, mas túnel `unavailable`; nenhum helper `ade-iphone-mirror` estava rodando. Não houve chamada Jev nem entrada no aparelho. A foto, as confirmações, a recusa sem resposta, `type`, a autorização persistente e sua revogação ainda precisam do teste supervisionado. O tempo completo (foto + Jev + confirmação/toque + verificação) e a comparação com o simulador **não foram medidos**.

**Inspiração de fluxo.** O projeto [PhoneUse Local](https://github.com/phoneuse-official/phoneuse) (MIT) motivou conferir o efeito visual após a entrada, usar rótulos de OCR para escolher alvos e encerrar tarefas como "relatado" ou "precisa de revisão". A ADE reaproveita seus próprios `--expect visual:changed`, OCR Vision e estados `done`/`unverified`; nenhum código do PhoneUse foi copiado e a plataforma não é embutida. A árvore nativa de acessibilidade do iPhone exigiria WebDriverAgent assinado e fica fora deste trabalho.

## Desenvolver

- `bun run build:iphone-mirror`: compila o helper em `src-tauri/binaries/ade-iphone-mirror` (só no macOS com o Xcode 27; sem eles, avisa e sai com 0). O `stage-cli` o chama no build do `.app`, então ele vai junto com o `ags` em `Contents/Resources/binaries/`.
- `bun run build:iphone-mirror --test`: os testes da parte pura do helper (RTCP), sem XCTest.
- Em desenvolvimento, a ADE procura o helper também em `src-tauri/binaries/` (só em debug).
- O `tauri dev` observa `src-tauri/binaries/`: recompilar o helper com o app aberto reinicia o app (e o helper para o stream no aparelho ao perder o stdin).
