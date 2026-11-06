# Simulador iOS dentro da ADE

Os iPhones e iPads do Xcode, ligados **sem o app Simulator** e mostrados soltos no canvas. É o mesmo caminho que o Simulator e o Safari ("Desenvolvedor › Abrir Página com") usam, chamado direto pela ADE.

Os agentes ligados ao aparelho por corda o pilotam com `ags device …` e conversam com a pessoa pelo painel do nó.

## Como funciona

As APIs foram mapeadas com o REA (`inspect_macho` e `inspect_native_dispatch_metadata` no SimulatorKit, no CoreSimulator e nos frameworks internos), e as assinaturas foram conferidas no binário do Xcode 27.

| Parte | API | Onde |
|---|---|---|
| Aparelhos | `SimServiceContext` → `defaultDeviceSetWithError:` → `devices` (`SimDevice`: `name`, `UDID`, `runtime`, `state`, `deviceType.mainScreenSize/mainScreenScale`) | `simulator/native/device.rs` |
| Ligar e desligar | `-[SimDevice bootWithOptions:error:]` com `persist: NO`; `shutdownWithError:` | idem |
| Tela | a porta de IO cujo `descriptor` é um `SimScreen` com `screenType == 0` (LCD); `framebufferSurface` (`IOSurface`); `registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:` e `registerCallbackWithUUID:damageRectanglesCallback:` | `simulator/native/screen.rs`, `view.rs` |
| Toque, botões e teclado | o `dtuhidd` por XPC: `-[SimDevice lookup:error:]` com `com.apple.coredevice.feature.remote.hid.digitizer`, `xpc_endpoint_create_mach_port_4sim`, `xpc_connection_enable_sim2host_4sim`; eventos `IndigoDigitizerEvent`, `IndigoButtonEvent`, `IndigoKeyboardButtonEvent` | `simulator/native/dtu.rs` |
| Toque, botões e teclado (reserva) | `SimDeviceLegacyHIDClient` (`initWithDevice:error:`, `sendWithMessage:freeWhenDone:completionQueue:completion:`) com as mensagens Indigo `IndigoHIDMessageForMouseNSEvent`, `…ForButton` e `…ForKeyboardArbitrary` | `simulator/native/hid.rs`, `kit.rs` |
| Abrir URL, abrir e fechar app, foto | `xcrun simctl openurl / launch / terminate / io screenshot` (públicos) | `simulator/mod.rs` (`ops`) |
| Foto do computer use | `framebufferSurface` da tela LCD; `IOSurfaceLock` só leitura, cópia BGRA conferida pelo seed; PNG pelo CoreGraphics/ImageIO; `simctl io screenshot` de reserva | `simulator/native/screen.rs` (`Surface`), `computer_use/capture.rs` |

### Detalhes que importam

- **Proxies remotos.** Os objetos de tela e de IO são `ROCKRemoteProxy`, que encaminham as mensagens. O `msg_send!` do objc2 entra em pânico em debug porque o método não está na classe. Por isso as chamadas privadas vão pelo `objc_msgSend` com assinatura tipada (`native/objc.rs`).
- **HID novo do Xcode 27.** A partir do CoreSimulator 1155.4 (o deste Mac é o 1174.9.2), o iOS descarta botão e teclado vindos do Indigo legado, e o toque por ele fica intermitente. Isso foi observado pelo idb, da Meta, que usa o `dtuhidd` sem volta. O `dtuhidd` é um serviço que o CoreSimulator põe dentro do iOS: ele sobe sob demanda e pode sair sozinho.
  - Cada evento é um dicionário XPC `{messageType, isBarrier, featureIdentifier, payload}`.
  - O toque é `{pointOne: {x, y}, eventType: 0/1/2, edge, target}`, com o ponto em proporção 0..1 e a origem no topo.
  - O campo `edge` diz de que borda o toque saiu. `3` é a de baixo (conferido no aparelho: 0, 1, 2, 4, 5, 6 e 8 não chegam à tela inicial). Um toque que começa nos últimos 1,5% da tela leva esse valor do início ao fim, então arrastar a barra de início com o mouse funciona como no aparelho.
  - **Início:** em iPhone sem botão físico, em retrato e com o HID novo, o botão "início" faz o gesto da barra. O botão HID leva 390-450 ms até o primeiro quadro; em paisagem e no legado ele continua sendo usado.
  - Os botões usam a página HID 0x0C: home `0x40`, lock e side `0x30`, Siri `0xCF`. O teclado usa o uso HID da tecla, com `state` 1 para descer e 2 para subir.
  - Ao abrir, a ADE manda uma tecla 0 solta e espera a resposta por até 4 s, em até 3 tentativas. Se o `dtuhidd` não responder, a ADE usa o Indigo legado.
  - Os eventos vão por uma fila serial: a interface não espera. Com a conexão morta, o próximo evento abre outra.
  - `ADE_SIMULATOR_HID=legacy` força o legado, para comparar.
  - Os nomes foram conferidos no `CoreDeviceUtilities.framework` injetado. O envelope vem do idb e do Siniulator.
- **Toque como proporção (legado).** O SimulatorKit chama `IndigoHIDMessageForMouseNSEvent(&ponto, NULL, alvo, tipo, CGSize(1,1), borda)`, com o ponto de 0 a 1. O alvo da tela é `0x32` e o dos botões, `0x33`. Fases: `1` desce, `6` arrasta, `2` sobe. O construtor de mensagem devolve nulo para um arrasto a menos de 16 ms do anterior. Sem segundo ponto, ele já monta toque de um dedo.
- **Boot sem `persist`.** O aparelho fica preso ao processo da ADE e desliga junto com ela, mesmo se ela cair. Nenhum simulador fica órfão gastando memória.
- **Quadros fora da thread da interface.** O serviço do simulador espera o callback de quadro voltar antes de mandar o próximo. Com os callbacks na fila principal, qualquer trabalho do app atrasava os quadros, que chegavam juntos (o engasgo). Agora eles vão para uma fila serial própria, com QoS `userInteractive` (`view.rs::frame_queue`). A camada é atualizada lá, numa `CATransaction` explícita: fora da thread principal não há runloop para fechar a implícita.
- **Só os callbacks de tela.** `registerCallbackWithUUID:damageRectanglesCallback:` com o mesmo UUID substitui os de tela, e aí o `frameCallback` nunca chegava. Os retângulos de dano não são registrados.
- **Seed da superfície.** Em cerca de 13% dos avisos, o seed da `IOSurface` só muda 1 a 16 ms depois do aviso (medição do serve-sim, da Expo). O quadro só é mostrado quando o seed anda. Se ainda não andou, há reconferências em 1, 1, 2, 4, 8 e 16 ms, uma por vez (`Presenter::pending`).
- **Superfície em cache.** Ler `framebufferSurface` é uma ida e volta XPC: só se lê de novo quando o serviço avisa que a superfície mudou.
- **Latência baixa.** Com alguma tela à vista, a ADE pede ao macOS `NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical`: sem App Nap nem timers agrupados, e o Mac ainda dorme sozinho. A ADE devolve o pedido quando a última tela sai de vista.
- **Arrasto sem perda (legado).** O Indigo recusa arrasto acima de 60 por segundo (devolve mensagem nula). A ADE guarda o último ponto recusado e o manda 4 ms depois. Descer e subir o dedo descartam o que estiver guardado: nunca sai um arrasto depois do dedo subir.
- **Blocos com assinatura.** O ROCKit serializa cada bloco pela assinatura dele e lança `NSException` ("Block is missing signature field") se ela não existir. Em Objective-C o clang a põe sozinho; no Rust os blocos usam `RcBlock::with_encoding` (`native/objc.rs::blocks`). Uma exceção dessas dentro do runloop derruba o app inteiro ("Rust cannot catch foreign exceptions").
- **Máscara própria.** A camada não usa `cornerRadius`. O caminho da máscara é o retângulo arredondado da tela, cortado na parte visível e menos os buracos, feito com as operações booleanas do CoreGraphics. A origem da camada é embaixo; a da view, no topo.

## Exibição sem cópia

A tela é uma `NSView` nossa (`AdeSimulatorScreenView`), por cima do webview, com uma camada própria (*layer-hosting*) cujo `contents` é a `IOSurface` do simulador. A GPU compõe a superfície direto.

A cada quadro novo do iOS só se avisa a camada (`setContentsChanged`). Com a tela parada não chega aviso e nada acontece. Medido no protótipo: 0,1 ms de CPU em 3 s com a tela parada.

O frontend (`SimulatorScreen.tsx`) só reserva o espaço e diz onde a tela está, com a mesma medição do navegador nativo do Portal (`browser/nativeSurface.ts`): retângulo, parte à vista e buracos onde há menus ou diálogos do app por cima. A máscara da camada e o `hitTest:` respeitam essa região. O toque e o teclado vão da `NSView` para o HID, sem passar pelo JavaScript.

## Leveza

O que pesa é o próprio iOS, não a exibição. Medido no iPhone 17e (iOS 27.0), num MacBook Air de 8 núcleos e 16 GB:

| Momento | iOS (soma dos processos) | Quem mais gasta |
|---|---|---|
| 30 s depois do boot | 357% de CPU, 183 processos | `MercuryPosterExtension` (papel de parede animado) |
| 60 s | 264% | widgets (Agenda, Fitness, Saúde) |
| 90 s | 326% | `sirittsd`, Agenda, `medialibraryd` |
| ~10 min, com uso | 238%, 236 processos | `RhizomePoster`, `MercuryPosterExtension`, `EmojiPosterExtension`, `diagnosticd` |
| A ADE (debug) no mesmo momento | 6% de CPU, 62 MB | — |

O que **não** funciona: a opção de boot `disabled_jobs`. Nem o `simctl boot --disabledJob=` tira o `diagnosticd` do ar (`launchctl print` continua `running`), e um array em `disabled_jobs` derruba o `CoreSimulatorService`.

O que funciona (`simulator/slim.rs`, descoberto pela ferramenta simslim): o `launchd_sim` lê, quando sobe, a lista de serviços desligados de `/private/var/tmp/com.apple.CoreSimulator.SimDevice.<UDID>/disabled.plist` (rótulo → `true`). No modo leve, com o aparelho desligado, a ADE:
1. guarda o original (`disabled.ade-original.plist`);
2. acrescenta 157 rótulos;
3. liga o aparelho;
4. espera a tela e os primeiros serviços do `launchd_sim`;
5. devolve o original.

O `launchd_sim` não relê o arquivo nem o regrava, nem ao desligar. Assim, o aparelho fica leve na ADE e normal fora dela. Se a ADE cair no meio do boot, a cópia fica para trás, e a primeira listagem de aparelhos devolve o original.

Medido no iPhone 17 (iOS 27.0), ligado pelo `simctl boot`. A CPU e os processos são a soma da árvore do `launchd_sim` do aparelho no `ps -axo pid,ppid,%cpu`; a memória comprimida vem do `vm_stat`; o `phys_footprint` vem do `footprint -p`:

| | Sem o modo leve | Com o modo leve |
|---|---|---|
| Processos do iOS, 120 s depois do boot | 288 | 106 |
| CPU do iOS, 45 s | 343% | 1% |
| CPU do iOS, 120 s | 495% | 1% |
| Memória comprimida no Mac, 120 s | 7,0 GB | 0,5 GB |
| Soma do `phys_footprint` | ~20 GB | ~11,8 GB |

Os 14 rótulos de Wallet, mídia e tarefas de fundo do Safari vieram do catálogo do NeoSimulator, que também vem do simslim. Medido no iPhone 17 (iOS 27.1), pelo `simctl boot`, aos 120 s, em duas rodadas alternadas: 125 → 91 e 90 → 82 processos do iOS, com CPU de 0-1% nos dois casos. O Safari e os Ajustes abriram em todas as rodadas. As categorias "Loja" e "Web" do NeoSimulator ficam de fora: tirariam push, compras, App Store, universal links e push de sites.

Com o original devolvido logo depois do boot: 93 processos e 1% de CPU aos 45 s e aos 120 s, e o arquivo igual ao original antes e depois de desligar.

Com o modo leve continuam funcionando a tela inicial, o Safari (localhost, animação a 60 quadros/s) e os Ajustes. Ficam de fora:
- os widgets, que aparecem vazios;
- a Siri e o Intelligence;
- a busca do Spotlight e dos Ajustes;
- o iCloud e a conta Apple;
- Mail, Agenda e Contatos;
- Saúde, Mapas, News e iMessage.

Ficam ligados de propósito:
- push;
- compras e App Store;
- Safari e universal links;
- `assistantd`, `gamed` e `sharingd`, porque sem eles o iOS fica tentando subir de novo.

Desligar o ⚡ com o aparelho ligado devolve a prioridade normal na hora. Ligar só grava a preferência: o iOS vai para a prioridade baixa pela regra do ciclo de vida, quando a tela sair de vista. Os serviços só mudam quando o aparelho religa.

A tela recebe o que o iOS desenha. Com `ADE_SIMULATOR_FPS=1`, o log mostra a cada segundo:
- quantos quadros chegaram à camada;
- o maior intervalo entre eles e quantos passaram de 25 ms;
- quanto a thread da interface atrasou (uma sonda a cada 50 ms; por ela passam o mouse e o toque);
- com que idade o evento do mouse chegou à tela.

### Onde ainda engasga (medido)

Medido no iPhone 17 Pro Max (iOS 27.0), num Mac M2 de 8 núcleos e 16 GB, com o iOS em prioridade normal. A bancada conta os quadros pelos mesmos callbacks da tela e amostra a superfície a cada vsync do Mac (`CVDisplayLink`); a ADE isolada (`ADE_AGS_DATA_DIR`) foi pilotada por `ags device`.

| Situação | Resultado |
|---|---|
| Rolagem, na inércia (o iOS anima sozinho) | ~60 quadros/s; 0-1% dos vsyncs sem quadro novo |
| Rolagem, com o dedo na tela | 8-25% dos vsyncs sem quadro novo; p95 do intervalo ~30 ms |
| Toque a 120 Hz solto, a 60 Hz no vsync do Mac ou um por quadro do iOS | o mesmo resultado: o ritmo do toque não é a causa |
| Volta à 1ª página da tela inicial | parada de 230-300 ms, com e sem o modo leve |
| ADE isolada ociosa e com um terminal imprimindo sem parar (ADE a 150% de CPU) | a mesma cadência na camada; a interface atrasou no máximo 15 ms |

O que sobra vem do próprio iOS do simulador (SpringBoard, abertura de app, o ritmo do quadro enquanto há toque). Não vem da exibição nem do toque da ADE.

O que foi tentado para o iOS do simulador desenhar mais liso:

| Alavanca | Resultado |
|---|---|
| Aparelho sem ProMotion (iPhone 17e) no lugar do Pro Max | um pouco melhor na rolagem (com o dedo, 19% contra 27% dos vsyncs sem quadro novo; na inércia, 6% contra 19%); a parada de ~300 ms na troca de página fica. As rajadas abaixo de 8 ms também aparecem no 17e: não é o iOS tentando 120 Hz |
| Zoom da Tela (canvas menor, como o NeoSimulator faz) | não ajuda. O modo "Zoomed" do iPhone 17 pede um canvas de 960×2079 em vez de 1206×2622 (`DBSDisplayZoomConfigurationController` e `SFBDisplaySetCanvasSize`), mas a `IOSurface` continua com 1206×2622. Com um site animado no Safari, a CPU do iOS ficou em 66% e 57% com zoom, contra 47% e 56% sem zoom: está dentro do ruído. Além disso, o zoom aumenta a interface, e quem testa o app passaria a ver outra tela. O reinício do SpringBoard que o modo pede (`FBSSystemService`) exige um entitlement que o simulador recusa em assinatura ad-hoc |
| Escala menor na tela da ADE | não muda nada no iOS: ele desenha sempre na resolução do aparelho, e a camada só redimensiona |
| GPU | o Mac M2 tem uma GPU só; não há o que escolher |
| Prioridade acima da normal | sem root, não dá: `setpriority(PRIO_DARWIN_ROLE)` em processo do iOS devolve `ENOTSUP`. O `launchd_sim` já dá papel de foco ao SpringBoard e ao app à frente |
| O visualizador da Apple (Device Hub) | usa o mesmo `SimDisplayRenderableView` do SimulatorKit, sem display link próprio e sem sinal de visibilidade, foco ou taxa para o iOS (só `setDisplayBacklightActive:`). A comparação medida lado a lado depende de escolher o aparelho na janela dele (um clique) e não foi feita |

Para a ADE, o que dá para fazer é o que já faz: manter o iOS na prioridade normal com a tela à vista e mostrar cada quadro no vsync seguinte. Um iPhone menor ajuda um pouco na rolagem.

O ciclo de vida (`simulator/lifecycle.rs`) faz o iOS só gastar quando alguém usa:
- **Prioridade (modo leve, padrão, botão ⚡, junto com os serviços desligados acima):** `native::set_priority` aplica `PRIO_DARWIN_BG` via `PRIO_DARWIN_PROCESS` no `launchd_sim` do aparelho e em todos os descendentes. Essa política de CPU e I/O não aparece no `nice` do `ps`. Só entra em segundo plano com o aparelho fora de vista em **todas** as telas que o mostram (o nó do canvas e o painel do modo chat contam juntos) e sem ação de agente há pelo menos 60 s (`AGENT_PRIORITY_GRACE`). Ao mostrar a tela ou receber ação de agente, restaura a prioridade normal em uma thread, sem esperar o monitor. Não usamos `nice 10`: voltar a `nice 0` pode falhar com `EACCES` sem root no macOS.
  - Por que importa: com o iOS em `PRIO_DARWIN_BG`, a tela trava. Medido no iPhone 17 Pro Max (iOS 27.0, modo leve), num Mac M2 de 8 núcleos e 16 GB (com outro simulador ligado ao lado), com os quadros contados pelos mesmos callbacks da tela e os gestos pelo `dtuhidd`:

    | Cenário | Prioridade normal | `PRIO_DARWIN_BG` |
    |---|---|---|
    | Troca de página da tela inicial | 59-87 quadros/s; p95 do intervalo 22-34 ms | 19-34 quadros/s; p95 119-129 ms |
    | Abrir o Ajustes (`simctl launch`) | 50-64 quadros/s; p95 19-36 ms | 29-65 quadros/s; até 670 ms parado |
    | Gesto de início | 67-77 quadros/s; p95 19-26 ms; 1º quadro em 2-79 ms | 27-34 quadros/s; 1º quadro em 240-926 ms |

    Antes, o ⚡ baixava a prioridade com a tela à vista, e uma tela fora de vista (ou fechada) tirava de vista o aparelho que outra tela mostrava. Nos dois casos o iOS ficava na prioridade baixa com a pessoa usando.
- **Hibernar:** depois de N minutos fora de vista e sem ação de agente (padrão 10; Nunca/5/10/30 no "⋯"), o aparelho é desligado sem perder dados. O nó mostra "Pausado para economizar" com o botão Retomar.
- **Um por vez** (padrão): ligar um aparelho desliga os outros que a ADE ligou. Os do app Simulator ficam como estão.
- **Fora de vista:** o nó para de ouvir os quadros (`unregisterScreenCallbacks`) e esconde a view.
- **Desligar** fica no menu "⋯"; fechar a ADE desliga tudo (sem `persist`).

## Computer use: velocidade (medido)

O `ags sim act` fotografa, lê e confere a tela a cada passo (ver [COMPUTER_USE_SUPERFICIES.md](COMPUTER_USE_SUPERFICIES.md#laço-e-integração)). Antes, cada passo chamava o `simctl` duas vezes (observar e conferir antes do HID), o `sips` duas vezes e o `swift -e` uma. Agora tudo roda dentro do processo, pela `IOSurface` que o painel já mostra:

- **foto**: os pixels da superfície (cópia em ~1 ms, refeita se o seed mudou no meio), PNG reduzido pelo ImageIO;
- **revisão**: SHA-256 dos pixels crus; conferir antes de tocar é só ler e somar de novo, sem PNG;
- **OCR**: o Vision (`VNRecognizeTextRequest`) em processo, aquecido numa thread no primeiro `act`;
- **tela assentada**: pelos quadros (seed), não por pausas fixas.

O caminho antigo fica de reserva: aparelho girado, outro formato de tela, Intel (só o OCR) ou falha.

Medido em 2026-11-04 no iPhone 17e (iOS 27.0), num Mac M2, com a tela parada, só lendo (sem tocar nem abrir nada), mediana de 8, em release:

```sh
BENCH_UDID=<udid> cargo test --release --lib computer_use::capture::test::bancada -- --ignored --nocapture
```

| Etapa | Antes | Agora |
|---|---|---|
| Foto | `simctl io screenshot` 1.423 ms | `IOSurface` + PNG 72 ms (tela 6 ms, cópia 0,7 ms, hash 33 ms, PNG ~32 ms) |
| Redução a 1.200 px | `sips` 89 ms | dentro da foto (o ImageIO sozinho num PNG em disco: 45 ms) |
| OCR | `swift -e` 507 ms | Vision em processo 137 ms (máx. 268) |
| Conferência antes do HID | outra foto + `sips`, ~1,5 s | releitura dos pixels 40 ms |
| Espera da tela | 0,8 s fixos por tentativa, só com tela sem texto | 0,1 s sem quadro (1ª foto), 0,3 s sem quadro e ≥ 0,6 s após a ação |
| **Passo sem o Jev** (espera + foto + OCR + conferência) | **3.519 ms** | **340 ms** na 1ª foto; ~0,7-0,9 s depois de uma ação, por causa do mínimo de 0,6 s |

Com o Jev (~0,5 s, medido no `decision_shadow_log`, não refeito aqui: custa cota), o passo cai de ~4-5 s para ~0,9 s no primeiro e ~1,3-1,5 s nos seguintes (soma das etapas medidas; o percurso completo com o Jev real não foi medido).

Achados:

- **A primeira leitura do Vision num executável novo levou 70 s** (binário de teste recém-compilado; o mesmo binário de novo: 95-250 ms). É o mesmo custo visto com o `swiftc`. Num app recém-atualizado seria o primeiro `act` parado, então o OCR em processo só entra depois de uma leitura de aquecimento numa imagem fixa; até lá, o `swift -e`.
- **O hash pesa metade da foto** (33 ms para 11,8 MB). Ele é o que garante "nunca tocar numa tela diferente da que o Jev viu", então ficou inteiro: comparar só o seed não basta, porque uma troca de superfície ou uma escrita fora do ritmo dos quadros passaria.
- O `simctl` levava 1,4 s e, sem querer, dava tempo à tela de reagir ao toque. O mínimo de 0,6 s depois da ação substitui essa espera de propósito; com ela mais curta, a foto pode mostrar a tela antiga e o Jev mandaria tocar de novo.
- A foto nativa sai igual à do `simctl` (mesma tela, de pé, sem máscara), com 554 × 1.200 como o `sips`.

## No canvas

- **Ferramenta da barra do canvas:** "iPhone / iPad (Simulador iOS)". O nó é um `CanvasPortal` com `kind: "ios"`, `udid` e `chat`.
- **Bloco alinhado** (`simulator/geometry.ts`):
  - a barra flutuante em cima, com a largura exata do bloco;
  - o aparelho embaixo;
  - com a conversa aberta, o painel ao lado, com o mesmo topo e o mesmo pé do aparelho.
- **Escala:** sai da altura gravada no `box`.
- **Conversa:** o que a pessoa escreve vai, pela fila de cada terminal (`peer_queue::enqueue`), para todos os agentes ligados ao nó, com a foto da tela se ela quiser (`simulator_tell`). O que os agentes fazem e dizem (`ags device say`) chega pelo evento `simulator-activity`. A conversa fica só na memória.

## Agentes

`ags device …` aceita nós iOS. Veja a skill `ags-orchestrator`, seção "iOS simulators on the canvas".

**Área de transferência:** no "⋯" da barra do nó e do painel do chat, "Colar no aparelho o que o Mac copiou" e "Trazer para o Mac o que o aparelho copiou". Os agentes leem o que o aparelho copiou com `ags device clipboard <aparelho>` e põem texto nele com `ags device clipboard <aparelho> "texto"`. Tudo vai pelo `xcrun devicectl device pasteboard` (CoreDevice), que leva texto, imagem e os outros tipos. O `simctl pbcopy` (SimPasteboard) ainda lê, mas, segundo o NeoSimulator, no iOS 27.2 já não substitui o conteúdo do aparelho.

**Girar:** o botão ↻ da barra do nó, o do painel do chat e `ags device rotate <aparelho> [left|right]` giram um quarto de volta pelo mesmo caminho (`simulator::rotate_device`): um `GSEvent` de orientação para a `PurpleWorkspacePort` (`native/purple.rs`). Depois do giro, as telas abertas se endireitam e o evento `simulator-orientation` deita a moldura em todas as telas que mostram o aparelho, mantendo a escala. No Android, `ags device rotate` alterna retrato e paisagem.

As coordenadas são **pontos do iOS**. `open`, `button` e `say` só existem no iOS.

## Aparelho físico

O mesmo seletor também lista iPhones e iPads de verdade, com toque, botões e teclado pelo HID do CoreDevice. Ver [ESPELHAMENTO_IPHONE.md](ESPELHAMENTO_IPHONE.md).

## Ainda não

- `tree` e `tap --text`: a acessibilidade do iOS existe no SimulatorKit (`AXPTranslator`), mas ainda não foi ligada.
- Aviso automático de crash na conversa.
- A aba "Simulador" e o botão "Abrir no simulador" do navegador.
- Reconectar sozinho quando o `CoreSimulatorService` reinicia (hoje a tela some até a ADE reabrir).
- Tools MCP equivalentes.
