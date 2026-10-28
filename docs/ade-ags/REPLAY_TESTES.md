# Testes por replay das telas dos agentes

O ADE descobre o estado de um agente lendo a tela dele: trabalhando, parado, esperando aprovação, mensagem colada sem envio. É a parte mais frágil do app, porque cada TUI (Claude Code, Codex, OpenCode, Gemini, Kimi, Hermes, Antigravity) desenha de um jeito e muda de versão sem aviso.

Os testes por replay pegam a **saída crua de um PTY**, pedaço por pedaço e no tempo em que chegou, e passam pelos **detectores de verdade**, sem app, sem PTY e sem relógio real. A ideia veio dos testes de transcrição gravada do T3 Code.

## Onde fica

| Arquivo | Papel |
|---|---|
| `src/features/terminal/tests/fixtures/replay/*.json` | as fixtures (uma por arquivo; o nome é o `id`) |
| `src/features/terminal/tests/replayHarness.ts` | harness do front: xterm real + detectores + relógio falso |
| `src/features/terminal/tests/replay.test.ts` | roda todas as fixtures no vitest |
| `src-tauri/src/terminal/replay.rs` | o formato no Rust (só nos testes) |
| `src-tauri/src/ipc/commands/replay_test.rs` | harness do backend: fim cru do PTY + detectores do envio |
| `src-tauri/src/terminal/recorder.rs` | o gravador (tap na thread que lê o PTY) |
| `src-tauri/src/ipc/commands/replay.rs` | `ags replay start / stop / status` |
| `scripts/replay-save.mjs` | salva a saída do `ags replay stop` na pasta das fixtures |

Rodar:

```
bunx vitest run src/features/terminal/tests/replay.test.ts
cd src-tauri && cargo test --lib replay
```

## Formato `ade-replay` v1

```json
{
  "format": "ade-replay",
  "version": 1,
  "id": "codex-colado-grande",
  "agent": "codex",
  "title": "Codex: colado grande vira [Pasted Content 3904 chars] e engole o Enter",
  "origin": { "kind": "synthesized", "basis": "de onde veio a tela", "recordedAt": null, "platform": null, "tuiVersion": null },
  "terminal": { "cols": 100, "rows": 30 },
  "message": "o texto que o ADE colou (opcional)",
  "task": { "atMs": 0 },
  "chunks": [
    { "atMs": 0, "data": "\u001b[2J\u001b[H..." },
    { "atMs": 200, "b64": "4pePIFdvcmtpbmc=" }
  ],
  "checkpoints": [
    { "atMs": 2000, "since": 400, "label": "Enter engolido", "expect": { "pastePending": true, "enterRetry": true } }
  ]
}
```

| Campo | O quê |
|---|---|
| `origin.kind` | `synthesized` (escrita a partir de uma tela real conhecida) ou `recorded` (gravada com o `ags replay`). Gravada exige `recordedAt` |
| `origin.basis` | de onde veio a tela: arquivo:linha, commit, bug, versão da TUI |
| `terminal` | colunas e linhas do PTY: o xterm do harness abre com esse tamanho |
| `chunks[]` | os bytes, em ordem de `atMs` (ms desde o início). `data` é texto com os escapes no lugar (`\u001b`); `b64` são os bytes exatos, quando o pedaço não é UTF-8 válido sozinho (um acento partido entre duas leituras). Exatamente um dos dois. `prelude: true` marca o fim do scrollback de antes da gravação |
| `message` | o texto colado; exigido por `typedPending`, `textShown`, `enterRetry` e `arrived` |
| `task.atMs` | quando o Orquestrador mandou a tarefa; exigido por `stalled` |
| `checkpoints[]` | em ordem de `atMs`. `since` abre a janela de "saída nova" (`fresh`, `enterRetry`, `arrived`) |
| `checkpoints[].xfail` | `{ rust: [...], ts: [...], reason }`: o detector daquele lado **ainda erra** estas chaves |

### Chaves do `expect`

Uma chave fora desta tabela falha a validação (erro de digitação não passa calado).

| Chave | Front (tela desenhada pelo xterm) | Backend (fim cru do PTY, sem escapes) |
|---|---|---|
| `working` | `isWorking(screenOf().lines)` (`stalled.ts`) | `working_in`, últimos 4 KB (`tui_working`, `tabs.rs`) |
| `pastePending` | `pasteStillPending(screenOf(…, 12).lines)` (`terminalRegistry.ts`) | `pending_paste_in`, últimos 32 KB |
| `typedPending` | `typedTextPending(beforeCursor(term), message)` | `typed_text_in`, últimos 32 KB |
| `textShown` | — | `text_shown_in`, últimos 32 KB (`text_on_screen`) |
| `fresh` | — | `varied_text` do que saiu em `(since, atMs]` (até 64 KB) |
| `enterRetry` | — | a decisão do laço de `submit_prompt_seen`: sem `working`, sem `fresh` e com o colado na caixa → outro Enter |
| `arrived` | — | `arrived(antes, depois, snippet_of(message))` (`peers.rs`); sem trecho, conta como chegou |
| `waitingApproval` | `isWaitingForUser` | — |
| `screenQuestion` | `screenQuestion(lines) !== null` (`leadStall.ts`) | — |
| `asksToClose` | `asksToClose(lines)` (`vigiaClosing.ts`) | — |
| `stalled` | `findStalls` com a tarefa de `task` e o relógio falso | — |
| `loopSuspect` | o vigia de laço (`loopStep`, `vigiaLoop.ts`) já avisou | — |
| `screenContains` | a tela desenhada contém o texto | o fim cru (64 KB, sem escapes) contém o texto |

### `xfail` é estrito

Uma chave em `xfail.rust` ou `xfail.ts` precisa **continuar errada**. Se o detector passar a acertar, o teste falha pedindo para tirar a marca. Assim a falha conhecida fica registrada e ninguém esquece de remover o `xfail` quando ela for corrigida.

## Relógio falso

- **Front.** O tempo é o `atMs`, somado a uma época fixa (`REPLAY_EPOCH`, nunca 0). `lastOutputAt` é o `atMs` do último pedaço escrito. `isActive` usa a mesma regra do app (`activeAgents`, 3 s). O vigia de laço dá um tique a cada pedaço e a cada checkpoint, como os tiques do Vigia, então 9 min de tela parada levam milissegundos.
- **Backend.** O "buffer do PTY" no instante `t` é a soma dos pedaços com `atMs <= t`, e cada chave lê o mesmo trecho que o código de produção (4, 32 ou 64 KB). As esperas por silêncio de `wait_until_quiet` não são reproduzidas: `since` diz onde começa o que saiu depois do Enter.

## Gravar uma tela real

O gravador é **só para desenvolvimento** e nasce desligado:

- só liga com o app aberto com `ADE_AGS_REPLAY_RECORD=1`; sem isso, `ags replay *` recusa;
- grava **uma aba pedida**, por no máximo 600 s (padrão 120 s) e 8 MB; passou disso, corta e marca `recording.truncated`;
- o app não escreve nada em disco: a fixture volta na resposta do `ags`;
- **se o texto gravado parece ter um segredo** (token, senha, chave; `looks_like_secret`), a gravação inteira é descartada e nada volta.

Na instância isolada (nunca no app instalado com missão rodando):

```powershell
$env:ADE_AGS_REPLAY_RECORD = "1"; pwsh scripts/dev-local.ps1 -Run
$env:ADE_AGS_DATA_DIR = "$env:LOCALAPPDATA\ade-ags-dev-data"
ags tab list                                     # ache o id da aba
ags replay start --tab <id> --seconds 60         # --prelude 0 para não levar o scrollback de antes
#   ... provoque a situação (cole a mensagem, espere o agente trabalhar, abrir o diálogo...)
ags replay status
ags replay stop --tab <id> | node scripts/replay-save.mjs codex-aprovacao-real
```

Depois:

1. Abra a fixture salva. Troque o `title` e complete `origin.basis` e `origin.tuiVersion` (`codex --version`, por exemplo).
2. Veja o que os detectores dizem a cada pedaço:
   `REPLAY_TIMELINE=1 bunx vitest run src/features/terminal/tests/replay.test.ts -t <id>`
3. Escreva os `checkpoints` com o estado **certo** (o que a pessoa vê na tela), não com o que o detector diz. Onde um lado erra, use `xfail` com o motivo, ou corrija o detector num commit próprio.
4. Leia a fixture inteira antes de commitar: a gravação é a tela da pessoa. Se tiver caminho, nome de cliente ou qualquer dado pessoal, edite ou descarte.

O `prelude` é o fim do scrollback de antes da gravação, cortado no começo de uma linha. Ele dá ao xterm do harness o que já estava na tela. No Windows, a saída gravada é a do ConPTY, que redesenha a tela do jeito dele: é exatamente o que os detectores do app recebem.

## Escrever uma fixture sintetizada

Quando não dá para gravar, sintetize a partir de uma tela real conhecida e diga qual em `origin.basis`. Imite o jeito de desenhar de cada família:

- **Ink (Claude Code)**: região viva no fim, apagada com `ESC[2K ESC[1A …` e reescrita com `\r\n`;
- **ratatui (Codex)**: viewport no fim da tela, cada linha posicionada com `ESC[<linha>;<col>H` e `ESC[2K`, sem quebra de linha;
- **opentui (OpenCode)**: tela alternativa (`ESC[?1049h`), tudo por posição.

## Fixtures atuais

Todas são **sintetizadas** (nenhuma gravada ainda).

| id | Agente | Cobre |
|---|---|---|
| `claude-pensando` | Claude Code | `✻ Thinking… (3s · esc to interrupt)`; tela congelada nele não é "parado" |
| `claude-ocioso` | Claude Code | fim de turno: saída nova, caixa vazia; parado depois de 2 min com tarefa aberta |
| `claude-lead-pede-ok` | Claude Code | Orquestrador termina com "Posso fazer o commit e abrir o PR?" (`asksToClose`, `screenQuestion`) |
| `claude-aprovacao` | Claude Code | "Do you want to proceed?" / "❯ 1. Yes": esperando o usuário, não parado |
| `codex-trabalhando` | Codex | `Working (5s • esc to interrupt)` com o brilho mudando a cada quadro |
| `codex-laco` | Codex | o mesmo Working por 9 min, só o contador muda: suspeita de laço aos 8 min |
| `codex-colado-grande` | Codex | `› [Pasted Content 3904 chars]` com o Enter engolido; o reenvio pega |
| `opencode-trabalhando` | OpenCode | `■■⬝⬝⬝⬝⬝⬝  esc interrupt` |
| `opencode-titulo-animado` | OpenCode | o título "Teste de resposta AZUL" anima sem parar com a mensagem parada na caixa: não é saída nova, reenviar o Enter |
| `caixa-com-borda-colado` | genérico | `│ › [Pasted Content 3904 chars] │` dentro de caixa com borda |

## O que as fixtures já acharam

Corrigido:

- **O OpenCode trabalhando não contava como trabalhando no front.** O `isWorking` só conhecia `esc to interrupt`, e o rodapé do OpenCode é `esc interrupt`. Com a tela parada, o aviso de agente parado disparava no meio do trabalho, e o Vigia podia cutucar. O backend (`working_in`) já reconhecia.
- **Marcador de colado dentro de caixa com borda não contava como pendente no backend.** O `pending_paste_in` exigia o prompt no começo da linha, e o laço de envio não reenviava o Enter. O front já tirava a borda.

Conhecido, marcado com `xfail` (não corrigido):

- **O backend acha que o agente ainda trabalha logo depois do fim do turno** (`claude-ocioso`, `claude-aprovacao`). `tui_working` procura `esc to interrupt` nos últimos 4 KB crus do PTY. Os quadros do spinner de antes do fim do turno continuam nesses 4 KB até sair mais saída. Um Enter engolido logo depois de um turno curto pode ser dado por enviado. Corrigir pede olhar só a saída depois do Enter, ou desenhar a tela no backend. Isso mexe no laço de envio, que está sendo refeito em outra frente.
- **No backend, o marcador de colado antigo ainda conta depois do envio quando a TUI desenha por posição** (`codex-colado-grande`, ratatui). Sem os escapes, linhas desenhadas com CUP ficam na mesma "linha" do texto cru. É inofensivo no laço, que olha o rodapé de trabalho antes. Mas o acerto do "pendente" também é por acaso: a "linha" começa com o `›` do composer.

As duas últimas dependem de como a TUI escreve os bytes. Uma gravação real (principalmente no Windows, pelo ConPTY) confirma ou derruba cada uma.

## Limites

- As fixtures sintetizadas imitam o jeito de desenhar de cada família, mas não são bytes gravados: não medido contra as TUIs atuais.
- O Rust não reproduz as esperas (`wait_until_quiet`) nem o reenvio em si: avalia a decisão em cada checkpoint.
- O `ags test affected` roda só o vitest quando uma fixture muda. A chave de cache do Rust (`testspeed/scope.rs`) inclui a pasta, mas o plano não chama o `cargo test`. Rode `cargo test --lib replay` à mão.
