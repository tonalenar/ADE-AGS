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
| Toque, botões e teclado | `SimDeviceLegacyHIDClient` (`initWithDevice:error:`, `sendWithMessage:freeWhenDone:completionQueue:completion:`) com as mensagens Indigo `IndigoHIDMessageForMouseNSEvent`, `…ForButton` e `…ForKeyboardArbitrary` | `simulator/native/hid.rs`, `kit.rs` |
| Abrir URL, abrir e fechar app, foto | `xcrun simctl openurl / launch / terminate / io screenshot` (públicos) | `simulator/mod.rs` (`ops`) |

### Detalhes que importam

- **Proxies remotos.** Os objetos de tela e de IO são `ROCKRemoteProxy`, que encaminham as mensagens. O `msg_send!` do objc2 entra em pânico em debug porque o método não está na classe. Por isso as chamadas privadas vão pelo `objc_msgSend` com assinatura tipada (`native/objc.rs`).
- **Toque como proporção.** O SimulatorKit chama `IndigoHIDMessageForMouseNSEvent(&ponto, NULL, alvo, tipo, CGSize(1,1), borda)`, com o ponto de 0 a 1. O alvo da tela é `0x32` e o dos botões, `0x33`. Fases: `1` desce, `6` arrasta, `2` sobe. O próprio Indigo descarta arrasto acima de 60 por segundo.
- **Boot sem `persist`.** O aparelho fica preso ao processo da ADE e desliga junto com ela, mesmo se ela cair. Nenhum simulador fica órfão gastando memória.
- **Callbacks na fila principal.** Os avisos de quadro só chegam com um runloop rodando, e a fila principal do app já tem um.
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

O que **não** funciona: desligar serviços no boot (`disabled_jobs`). Nem o `simctl boot --disabledJob=` tira o `diagnosticd` do ar (`launchctl print` continua `running`), e um array em `disabled_jobs` derruba o `CoreSimulatorService`.

O que a ADE faz:
- **Modo leve** (padrão; botão ⚡): o iOS inteiro roda com `nice 10` (`native::set_priority`). Pega o `launchd_sim` do aparelho, que o `ps` mostra com o UDID no caminho, e todos os descendentes. Os processos novos herdam do `launchd_sim`. A ADE e o resto do Mac ficam com a CPU primeiro. Desligar o ⚡ volta a `nice 0` na hora.
- **Fora de vista:** o nó para de ouvir os quadros (`unregisterScreenCallbacks`) e esconde a view.
- **Desligar** fica no menu "⋯"; fechar a ADE desliga tudo (sem `persist`).

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

As coordenadas são **pontos do iOS**. `open`, `button` e `say` só existem no iOS.

## Ainda não

- `tree` e `tap --text`: a acessibilidade do iOS existe no SimulatorKit (`AXPTranslator`), mas ainda não foi ligada.
- Girar o aparelho.
- Aviso automático de crash na conversa.
- A aba "Simulador" e o botão "Abrir no simulador" do navegador.
- Hibernar quando a aba fica oculta e "um aparelho por vez".
- Reconectar sozinho quando o `CoreSimulatorService` reinicia (hoje a tela some até a ADE reabrir).
- Tools MCP equivalentes.
