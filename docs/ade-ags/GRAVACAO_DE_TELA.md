# Gravação de tela

A gravação contínua cria um vídeo local para revisar movimentos e analisar os frames depois. Ela é diferente da captura pontual (SnapShot) em PNG e do replay dos eventos do PTY.

## Captura pontual (SnapShot)

O botão de câmera no composer salva um PNG do display principal do Mac em `Imagens/ADE AGS` e o anexa ao rascunho aberto. A captura é explícita: nada é enviado até a pessoa decidir enviar a mensagem. Assim como o vídeo do desktop, o PNG inclui o conteúdo visível de toda a tela principal; ainda não existe captura só da janela ativa.

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
- Os vídeos permanecem locais até a pessoa enviar o anexo pelo chat.

## Validação

- `swiftc -typecheck src-tauri/src/screen_recording.swift` — validou a sintaxe e as APIs ScreenCaptureKit disponíveis neste Mac; não iniciou uma gravação real nem verificou a permissão de tela.
- O SnapShot e a gravação foram incluídos em `cargo clippy --all-targets`, `bunx tsc --noEmit`, `bun run check:i18n`, `bun run check:babel` e `bun run build`. Não acionei a captura do display para evitar guardar conteúdo da tela atual.
- iPhone, simulador iOS e Android — gravação real não validada nesta etapa.
- Windows/Linux, captura por janela, árvore de acessibilidade anexada ao SnapShot e envio automático de frames ao Jev não fazem parte desta entrega.

Validação complementar de build local, 07/11/2026:

- `env -u CARGO_TARGET_DIR bun run tauri build --bundles app` — passou; gerou o `.app` macOS e incluiu `ags` e `ade-iphone-mirror` nos recursos.
- A gravação de iPhone agora passa ao `devicectl` o UUID extraído do id interno `device:<UUID>`.
- Abri o pacote num diretório de dados isolado. A inspeção visual foi bloqueada porque o Mac estava bloqueado; nenhuma gravação real foi iniciada.
