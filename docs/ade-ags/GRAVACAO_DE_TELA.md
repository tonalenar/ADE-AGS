# Gravação de tela

A gravação contínua cria um vídeo local para revisar movimentos e analisar os frames depois. Ela é diferente da captura pontual (SnapShot) em PNG e do replay dos eventos do PTY.

## Captura pontual (SnapShot)

O botão de câmera no composer salva um PNG do display principal do Mac em `Imagens/ADE AGS` e o anexa ao rascunho aberto. No macOS, **Cmd+Shift+S** faz a mesma captura no composer visível. O atalho tem o id `composer.snapshot` (`src/app/shortcuts.ts:213`), aparece em Configurações → Atalhos e pode ser trocado por outra combinação. Sem composer de conversa visível, o atalho não é consumido e segue para o app em foco.

A captura é explícita: nada é enviado até a pessoa decidir enviar a mensagem. Assim como o vídeo do desktop, o PNG inclui o conteúdo visível de toda a tela principal; ainda não existe captura só da janela ativa.

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

O botão circular fica na barra inferior do espelho de iPhone e nos painéis iOS/Android. No composer, o botão de câmera faz o SnapShot e o botão **Tela principal** grava vídeo. No Mac, a captura inclui tudo que estiver visível no display principal — ADE, navegador, espelho e outras janelas. Não há seletor de janela nesta etapa. Windows e Linux ainda não têm gravação da tela do computador.

## Arquivo e envio

Os arquivos ficam na pasta de vídeos reconhecida pelo sistema operacional, dentro de `ADE AGS`. Ao parar a gravação, a ADE anexa o caminho ao rascunho da conversa aberta. Nada é enviado automaticamente: a pessoa pode revisar o vídeo e decidir se envia.

O gravador aceita uma sessão por vez. Se um vídeo for interrompido antes de finalizar, ele pode não ser válido para análise. As gravações do Android usam armazenamento temporário no aparelho e são copiadas para o computador ao parar.

## Privacidade e permissões

- O áudio não é capturado pela gravação da tela do Mac. Nos demais métodos, o áudio depende da ferramenta nativa e não é configurado pela ADE.
- No macOS, a primeira captura pode exigir **Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela e Áudio do Sistema**. Se o acesso for liberado depois de abrir a ADE, feche e reabra a ADE para o macOS aplicar a permissão.
- A captura do display principal pode incluir notificações e informações de outras janelas. Feche ou oculte conteúdo privado antes de iniciar.
- Os vídeos e os PNGs permanecem locais até a pessoa enviar o anexo pelo chat. Capturas pendentes continuam no disco até serem enviadas ou removidas.

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

## Validação

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
