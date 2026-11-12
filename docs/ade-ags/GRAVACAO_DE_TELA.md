# Gravação de tela

A gravação contínua cria um vídeo local para revisar movimentos e analisar os frames depois. Ela é diferente da captura pontual (SnapShot) em PNG e do replay dos eventos do PTY.

## Captura pontual (SnapShot)

O botão de câmera no composer salva um PNG em `Imagens/ADE AGS` e o anexa ao rascunho aberto. Ao lado dele, um seletor escolhe **o que** capturar: a tela principal (o padrão, como antes), outra tela ou uma janela. No macOS, **Cmd+Shift+S** faz a captura padrão, a da tela principal, no composer visível, sem mudar o seletor. O atalho tem o id `composer.snapshot` (`src/app/shortcuts.ts:223`), aparece em Configurações → Atalhos e pode ser trocado por outra combinação. Sem composer de conversa visível, o atalho não é consumido e segue para o app em foco.

A captura é explícita: nada é enviado até a pessoa decidir enviar a mensagem. A tela principal inclui tudo o que estiver visível nela (ADE, navegador, espelho e outras janelas). Uma janela sai só com o conteúdo dela, pelo `screencapture -l`.

### Escolher tela ou janela

O seletor ao lado da câmera lista a tela principal, as outras telas e as janelas visíveis, da frente para trás. A lista é lida quando a pessoa encosta no seletor, pelo helper `src-tauri/src/computer_use/snapshot/list.swift`. O helper só lê metadados: não captura e não pede permissão. Depois da escolha, a câmera captura só aquilo, e o seletor volta para a tela principal.

- **Tela principal:** sempre disponível. É o comando de sempre (`screencapture -x -t png`, sem `-D`).
- **Outra tela:** `screencapture -D 2`. O manual do macOS (`man screencapture`) diz que `1` é a principal e `2` a secundária. Essa correspondência só vale com **exatamente duas telas**. Com três ou mais, o manual não diz a ordem das secundárias, e essas telas ficam bloqueadas com o motivo, em vez de um número chutado. Depois da captura, a ADE confere o tamanho da foto com o da tela escolhida, em pixels ou em pontos, na vertical ou na horizontal. Se não bater, a foto sai do disco e nada é anexado.
- **Janela:** `screencapture -o -l <id da janela>`, sem a sombra da janela. A lista traz o app e, com a permissão, o título.
- **Permissão:** outra tela e janelas exigem a **Gravação de Tela** autorizada. Sem ela, a lista mostra só os nomes dos apps, essas opções ficam bloqueadas e o grupo explica por quê. A tela principal segue como antes.
- **Falha ao capturar:** a ADE preserva o código de saída e o `stderr` de `/usr/sbin/screencapture`. Quando o macOS retorna `could not create image from display`, o aviso mostra o caminho do painel Gravação de Tela e Áudio do Sistema. Se ADE AGS já estiver na lista e continuar falhando, remova-a e adicione-a novamente: uma troca de requisito de assinatura pode deixar a autorização TCC antiga associada à identidade anterior. Outros erros mostram o código e o diagnóstico do comando.
- **Ajustes:** o backend exporta `open_privacy_settings` e o wrapper `openPrivacySettings("screen_capture")` para abrir esse painel. A integração do botão de câmera fica no branch que mantém o componente `DesktopSnapshotButton`.
- **Limite conhecido:** com dois monitores de mesma resolução, a conferência pelo tamanho não distingue as telas, e a escolha depende só da numeração documentada.

### Metadados e legenda

Ao lado de cada PNG, a ADE grava `ADE-AGS_SnapShot_<carimbo>_<id>.json`, com a versão, o tipo (tela ou janela), o app e o título (quando a permissão deixa ver), o número da tela e a hora da captura. Só esses fatos, nenhum pixel. O anexo no composer mostra a legenda, como "Safari — Título", "Tela principal" ou "Tela 2", lida desse JSON. Por isso ela sobrevive a trocar de conversa e a recarregar. Foto sem JSON, como as feitas antes desta versão, aparece só com o nome. O título de uma janela pode revelar algo privado: ele fica só no disco, junto da foto, e sai da máquina apenas se a pessoa enviar o anexo.

### Fora desta fase

OCR da captura e árvore de acessibilidade continuam fora (ver a tabela da seção seguinte). Windows e Linux ainda não têm captura de tela do computador.

### Captura pendente

Uma captura (SnapShot ou gravação de tela, inclusive a de iPhone, simulador e Android que o painel de dispositivo anexa ao composer) fica **pendente** desde que é anexada ao rascunho até ser enviada, removida do rascunho ou guardada num stash do composer. Enquanto estiver pendente:

- **Troca de conversa:** ao voltar à conversa, a captura volta ao rascunho e a linha de status do composer pede para revisar. O composer desmonta ao trocar de conversa (`src/features/chat/ChatShell.tsx:224-225`, chave por aba), por isso o registro fica por alvo, fora do estado do componente.
- **Recarregar a janela:** o registro fica no `localStorage` desta máquina, na chave `cc-pending-captures`, e volta quando o composer do mesmo alvo abre de novo. Sem armazenamento disponível, a captura vale só nesta sessão.
- **Arquivo sumiu:** antes de devolver a captura ao rascunho, a ADE confere o arquivo. Se ele não existe mais, a captura sai do registro e o aviso diz isso. A ADE não apaga arquivo nenhum.
- **Limite:** o registro guarda até 50 capturas. Passado o limite, a mais antiga sai da lista e a ADE avisa; o arquivo continua na pasta de capturas.
- **Conversa lateral:** não tem alvo próprio (`quoteKey={null}`). Uma captura feita ali segue para o composer que a receber e não é restaurada depois.
- **Stash:** guardar o rascunho num stash tira a captura do registro, porque o stash é o guardado durável. Ao restaurar o stash, a captura volta ao rascunho como anexo comum: se a conversa trocar sem envio, ela sai do rascunho, mas continua no stash até ser removido. Essa volta a ser pendente só se for anexada de novo.

O registro guarda só caminhos e ids de alvo, nunca conteúdo de tela (`src/features/chat/attachments/pendingCaptures.ts`). A restauração e a limpeza ficam em `src/features/chat/attachments/useComposerCaptures.ts`. Enviar, guardar em stash ou remover o anexo tira a captura do registro, e o envio faz isso explicitamente, mesmo que o composer já tenha sido desmontado (a conversa nova é criada no envio). Uma captura enfileirada deixa de ser pendente do rascunho e passa a seguir a fila, como qualquer anexo enfileirado.

## Fontes disponíveis

| Fonte | Como gravamos | Formato e limite |
|---|---|---|
| iPhone/iPad físico | `xcrun devicectl` | MP4 H.264; máximo de 120 s |
| Simulador iOS | `xcrun simctl io recordVideo` | MP4 H.264; parada manual |
| Android físico ou emulador | `adb shell screenrecord` e `adb pull` | MP4; máximo de 120 s |
| Tela do Mac | ScreenCaptureKit, display principal | MOV H.264, 30 fps, sem áudio; parada manual; macOS 15 ou posterior |

O botão circular fica na barra inferior do espelho de iPhone e nos painéis iOS/Android. No composer, o botão de câmera faz o SnapShot (com o seletor de tela ou janela ao lado) e o botão **Tela principal** grava vídeo. A gravação de vídeo do Mac ainda grava só o display principal, inteiro — ADE, navegador, espelho e outras janelas — e não tem seletor. Windows e Linux ainda não têm captura nem gravação da tela do computador.

## Quando a gravação falha

Antes, a ferramenta de captura rodava com a saída descartada, e qualquer falha (o processo morrer, o arquivo não existir) virava "A gravação não gerou um vídeo finalizado". Além de esconder o motivo, a falha só aparecia ao parar: a ferramenta podia morrer um segundo depois de iniciar (aparelho bloqueado, iPhone desconectado, simulador desligado) e a ADE seguia dizendo "Gravando". Ao parar com erro, a gravação também continuava "ativa", e o botão ficava preso até reiniciar a ADE.

Agora (`src-tauri/src/screen_recording.rs`):

- **Saída capturada.** stdout e stderr da ferramenta ficam num registro curto (os últimos 8 KiB). `explain_failure` reconhece as causas que a pessoa resolve e, nas demais, mostra o código de saída e o fim da saída.
- **Falha logo ao iniciar.** O `simctl` é aguardado até imprimir "Recording started" (10 s); o `devicectl` e o `adb` têm uma janela de 3 s e 2 s para morrer cedo. Se saírem, o erro aparece ao iniciar, com o motivo.
- **Parar sem travar.** O Ctrl+C (SIGINT) enviado antes de a ferramenta instalar o tratador se perde: o `simctl` ignora o sinal e segue gravando (reproduzido num simulador). A parada repete o sinal 4 vezes (6 s cada) e só então encerra o processo à força, dizendo que o vídeo pode estar incompleto. Antes, `wait()` ficava preso para sempre, com o mutex da gravação travado, e o `screen_recording_status` (que roda na thread da interface) congelava junto.
- **Sempre solta o estado.** Depois de parar, com sucesso ou erro, não há mais gravação ativa.

| Situação | O que a pessoa vê |
|---|---|
| macOS negou a Gravação de Tela (tela do Mac) | aviso com botão **Abrir Gravação de Tela**, o caminho Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela e Áudio do Sistema e a dica de remover e adicionar a ADE de novo depois de trocar a assinatura. O backend marca o erro com `SCREEN_CAPTURE_PERMISSION_REQUIRED:` |
| Sem permissão de escrita na pasta de vídeos | caminho Arquivos e Pastas / Acesso Total ao Disco |
| Simulador desligado | "O simulador iOS não está ligado" |
| iPhone bloqueado, sem Modo de Desenvolvedor ou desconectado | o que fazer em cada caso |
| Outra falha | código de saída (ou sinal) e as últimas linhas que a ferramenta escreveu |

A permissão de Gravação de Tela só vale para a **tela do Mac** (ScreenCaptureKit). `devicectl` e `simctl` não dependem dela.

**Espelho do iPhone físico.** Gravar os próprios quadros do espelho (HEVC já recebido pelo app) evitaria depender do `devicectl`, mas exige empacotar o HEVC em MP4 (AVAssetWriter ou muxer próprio) e foi deixado de fora: sem um iPhone para validar, não há como provar que o arquivo sai tocável. Se o `devicectl screen-record` falhar de forma recorrente com o espelho aberto, o registro agora mostra por quê, e essa decisão pode ser revista com o texto real do erro em mãos.

## Arquivo e envio

Os arquivos ficam na pasta de vídeos reconhecida pelo sistema operacional, dentro de `ADE AGS`. Ao parar a gravação, a ADE anexa o caminho ao rascunho da conversa aberta. Nada é enviado automaticamente: a pessoa pode revisar o vídeo e decidir se envia.

O gravador aceita uma sessão por vez. Se um vídeo for interrompido antes de finalizar, ele pode não ser válido para análise. As gravações do Android usam armazenamento temporário no aparelho e são copiadas para o computador ao parar.

## Privacidade e permissões

- O áudio não é capturado pela gravação da tela do Mac. Nos demais métodos, o áudio depende da ferramenta nativa e não é configurado pela ADE.
- No macOS, a primeira captura pode exigir **Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela e Áudio do Sistema**. Se o acesso for liberado depois de abrir a ADE, feche e reabra a ADE para o macOS aplicar a permissão.
- A captura da tela principal ou de outra tela pode incluir notificações e informações de outras janelas. Uma janela sai só com o conteúdo dela, mas o título dela aparece na legenda (ver acima). Feche ou oculte conteúdo privado antes de iniciar.
- Os vídeos, os PNGs e os JSONs de legenda permanecem locais até a pessoa enviar o anexo pelo chat. Capturas pendentes continuam no disco até serem enviadas ou removidas. A ADE não apaga nenhum desses arquivos: se o PNG for apagado à mão, o JSON ao lado fica órfão até a pessoa o apagar.

## Auditoria de paridade com o SnapShot do T3 (Fase 7.1)

Referência de produto: [SnapShot do T3 Code](https://github.com/pingdotgg/t3code/blob/main/docs/user/snap-shot.md), lida como dado. O T3 captura a janela ativa, grava app e título, permite trocar o atalho e mantém a captura pendente até ela ser anexada. A página não diz o que acontece com uma captura pendente ao trocar de conversa sem fechar o app.

| Item do plano | O que existe hoje (arquivo:linha) | Lacuna | Nesta entrega |
|---|---|---|---|
| Seleção de janela | `src-tauri/src/computer_use/desktop.rs:47-48`: `screencapture -x -t png`, sem alvo de janela (`-l`). Não há listagem de janelas no código: nem `CGWindowList`, nem `NSWorkspace`, nem AX | Escolher janela exige listagem nativa nova (Swift), e a permissão pode mudar de escopo | Não implementado: exige Swift novo. Documentado |
| Seleção de display | `src-tauri/src/screen_recording.swift:25-26` usa `SCShareableContent` e pega `displays.first`. O SnapShot (`desktop.rs:48`) não recebe display | Não há lista de displays ligada à captura pontual. A numeração do `screencapture -D` não foi verificada com um segundo monitor | Não implementado: a checagem exige tela real. Documentado |
| App e título da janela | `desktop.rs:33-55` devolve só o caminho do PNG. Nenhuma API do código entrega app ou título | Não há API existente para reaproveitar; obter isso exige código nativo novo | Não implementado. Documentado |
| Acessibilidade (árvore) | Nenhum uso de AXUIElement no código. O driver de computer use lê texto por OCR (`desktop.rs:3`) | A árvore exige permissão de Acessibilidade, que o SnapShot não tem hoje | Fora desta tarefa. Documentado |
| OCR opcional | `src-tauri/src/computer_use/capture.rs:268` tem `ocr` (Vision), usado pelo `desk act`. O SnapShot não chama esse OCR | Ligar o OCR ao anexo é função nova, com regra de privacidade própria | Fora desta tarefa. Documentado |
| Atalho editável | Antes não havia atalho para o SnapShot. O único atalho de captura era o ditado (`src/app/shortcuts.ts:212`) | — | Implementado: `composer.snapshot` (`src/app/shortcuts.ts:213`), Cmd+Shift+S no macOS, `when` com `snapshotAvailable`, editável em `src/features/settings/ShortcutsSection.tsx:72` |
| Restauração da captura pendente | O anexo vivia no estado local (`src/features/chat/attachments/useAttachments.ts:34`) e o texto em `ChatComposer.tsx:122`. Trocar de conversa remonta o composer (`ChatShell.tsx:224-225`). Recarregar zerava tudo, e o PNG ficava órfão em `Imagens/ADE AGS` | Troca de conversa e recarregar perdiam a captura sem aviso | Implementado: registro por alvo, restauração ao montar, aviso e teto (`pendingCaptures.ts`, `useComposerCaptures.ts`, `ChatComposer.tsx:477`) |
| Captura fora do Mac | `desktop.rs:57-59` e `screen_recording.rs:320-322` recusam a captura em Windows e Linux | Sem API nativa de captura no outro sistema | Fora do plano desta fase. Documentado |

## Lacunas nativas: estado atual

A tabela acima é a auditoria da Fase 7.1, mantida como foi. Esta seção diz o que a entrega seguinte fechou das lacunas que exigiam código nativo.

| Item | Estado | Onde | Limite e o que não foi verificado |
|---|---|---|---|
| Seleção de janela | Implementado | `src-tauri/src/computer_use/snapshot.rs` (`plan_for`, `capture_args`), `snapshot/list.swift` (`CGWindowListCopyWindowInfo`), `src/features/recording/SnapshotTargetPicker.tsx` | `screencapture -o -l <id>`. Sem Gravação de Tela, as janelas aparecem bloqueadas com o motivo. Não capturei janela real. |
| Seleção de tela | Parcial | `snapshot.rs` (`number_displays`), `snapshot/list.swift` (`CGGetActiveDisplayList`) | A principal segue como padrão. Outra tela: `-D 2`, só com exatamente duas telas, conforme `man screencapture` ("1 is main, 2 secondary"). Com três ou mais, as secundárias ficam bloqueadas, porque a ordem delas não é documentada. A foto é conferida pelo tamanho. **Não verificado com dois monitores.** |
| App e título | Implementado | `snapshot.rs` (`SnapshotInfo`, `read_info`), `src/features/recording/snapshotInfo.ts` | JSON `ADE-AGS_SnapShot_*.json` ao lado do PNG. Sem permissão, só o app. |
| Metadados no anexo | Implementado | `src/features/chat/attachments/AttachmentStrip.tsx` (`ImageCard`) | A legenda também aparece nas mensagens já enviadas com a mesma foto. |
| Seletor na tela | Implementado | `SnapshotTargetPicker.tsx`, `DesktopSnapshotButton.tsx` | Acessível por teclado (seta para baixo abre, setas navegam, Enter escolhe). Padrão: tela principal, que volta a valer depois de capturar. O atalho segue na tela principal (`takeDesktopSnapshot` pede o padrão pelo evento `cc-desktop-snapshot-default`). |
| OCR da captura | Fora desta entrega | — | Continua sem ligação com o SnapShot. O `desk act` usa o OCR; ligar isso ao anexo é função nova, com regra de privacidade própria. |
| Árvore de acessibilidade | Fora desta entrega | — | Exige a permissão de Acessibilidade, que o SnapShot não pede. |

**Helper Swift.** O `build.rs` não compila Swift. O `snapshot/list.swift` entra no binário por `include_str!` e roda com `/usr/bin/swift -e`, como o `desk_input.swift` e o `screen_recording.swift` já faziam. Por isso `cargo build` não tem helper para compilar. A checagem de tipos foi feita com `swiftc -typecheck`, que não executa nada.

### Permissões da build assinada no macOS

`src-tauri/Entitlements.plist` declara somente `com.apple.security.device.audio-input`, ligado em `bundle.macOS.entitlements` no `tauri.conf.json`. A Apple exige o Audio Input entitlement para apps hardened que usam microfone ([documentação Apple](https://developer.apple.com/documentation/AVFoundation/requesting-authorization-to-capture-and-save-media)). O app usa o microfone para ditado; não há uso de câmera no código do produto. Não foram adicionados entitlements de câmera, JIT ou exceções de biblioteca. A configuração segue a seção de entitlements do [guia de bundle macOS do Tauri 2](https://v2.tauri.app/distribute/macos-application-bundle/).

O helper do ditado consulta `AVCaptureDevice.authorizationStatus(for: .audio)` e, em `notDetermined`, chama `requestAccess(for: .audio)` antes de iniciar o `AVAudioEngine`. Se a autorização não for concedida, o erro orienta e oferece abrir o painel Microfone. A descrição `NSMicrophoneUsageDescription` permanece no `Info.plist`.

Na comparação feita pelo shell local, `/usr/sbin/screencapture -x /tmp/ade-ags-screencapture-probe.png` terminou com código 1 e `could not create image from display`, sem PNG. O usuário também confirmou que, na ADE instalada, o seletor retorna `titles=false` embora ADE AGS esteja ligada em Gravação do Áudio do Sistema e da Tela; isso significa que `CGPreflightScreenCaptureAccess()` não reconhece a autorização. O conjunto reforça a hipótese de um requisito TCC antigo após a assinatura mudar de adhoc para `ADE AGS Local`, mas não a prova. Só nova build assinada e validação no app confirmarão a causa e a captura real. Não foi alterado TCC nem o app instalado.

Os deep links atuais `Privacy_ScreenCapture`, `Privacy_Microphone` e `Privacy_SpeechRecognition` foram abertos e conferidos na interface do macOS 27.2. A conferência não alterou nenhum toggle nem o banco TCC.

### Validação das lacunas nativas

- **Testes antes da implementação.** Rust: `src-tauri/src/computer_use/snapshot/test.rs`, 18 testes; antes, todos falhavam no `todo!()`. Vitest: `src/features/recording/tests/snapshotTargets.test.ts`, `snapshotPicker.test.tsx` e `src/features/chat/tests/snapshotCaption.test.tsx`, mais `composerSnapshot.test.tsx`, que passou a exigir o evento do atalho. Antes, três arquivos não importavam o módulo novo e a legenda não aparecia.
- **Depois.** `cargo test --lib computer_use::snapshot`: 19 testes, todos verdes (um a mais, de pixel zerado). `cargo test --lib --bin ags`: suíte inteira verde. Vitest de `src/features/recording`, `src/features/chat`, `src/app`, `src/i18n` e `src/features/compare`: 150 arquivos e 1116 testes verdes.
- **Checagens.** `bunx tsc --noEmit` sem erro; `bun run check:i18n` sem achado novo (0 faltando entre idiomas); `bun run check:test-lint` com as 40 violações do baseline e nenhuma nova; `bun run check:babel` sem erro; `swiftc -typecheck` do `list.swift` sem diagnóstico.
- **Não verificado.** Nenhuma captura real: não rodei `screencapture`, não pedi Gravação de Tela nem Acessibilidade, e o helper Swift não foi executado no Mac (só checado por tipo). Também não verificados: `-D 2` com dois monitores de verdade; uma janela real com `-l`; a conferência de tamanho com um PNG de verdade (a função é testada com números); o JSON ao lado de um PNG real; o `tauri build`, a instalação e a compilação para Windows e Linux.

## Validação da Fase 7.1

Validação de 10/11/2026, Fase 7.1 (SnapShot completo). Não houve captura real, e as permissões do macOS não foram alteradas.

- Os testes foram escritos antes da implementação: `src/features/chat/tests/pendingCaptures.test.ts`, `src/app/tests/snapshotShortcut.test.ts`, `src/features/chat/tests/composerSnapshot.test.tsx`, `src/features/chat/tests/composerCaptures.test.tsx` e `src/features/recording/tests/snapshotButton.test.tsx`. Antes da implementação, 17 testes falhavam e 2 arquivos nem importavam; depois, todos passam.
- `bunx tsc --noEmit`, `bun run check:i18n`, `bun run check:test-lint` (sem violação nova; 40 do baseline) e `bun run check:babel` passaram.
- `bun run test` (suíte inteira) passou em 460 arquivos e 3866 testes. Um teste de `src/app/tests/staticEntryGraph.test.ts` estourou o timeout de 5 s sob carga paralela. Rodado sozinho, passa 7 de 7; em um export limpo do `HEAD`, a mesma carga mostrou o mesmo estouro.
- Não houve mudança em Rust nesta entrega, por isso `cargo test --lib --bin ags` não foi rodado.

Não verificado nesta entrega:

- captura real do display e o PNG gerado; a permissão de Gravação de Tela não foi pedida nem testada;
- o atalho com teclado real no app, e a aparência do composer e da linha de status;
- restauração depois de recarregar o app de verdade: a regra está coberta por testes, mas não houve execução real;
- build (`tauri build`) e instalação: nada foi instalado e o app instalado não foi tocado.

Defeito anterior, fora deste escopo e não corrigido aqui: o atalho do ditado (`composer.dictation`, `src/app/shortcuts.ts:212`) não casa `Cmd+Shift+D` no macOS. Ele define `meta` e `shift`, mas não `ctrl: false`; `matchShortcut` trata o ausente como `true`, então o acorde exige Ctrl também. Uma linha corrige, mas a mudança ficou para outra entrega.
