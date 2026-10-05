
## Ponto 1 — Agente parado

**Problema:** o orquestrador manda uma tarefa com `ags peer tell` e, se o agente para por algum motivo, espera para sempre.

**Como funciona** (`src/features/missions/stalled.ts`, ligado em `watcher.ts`):

1. `peer_tell` e `peer_ask` (Rust) emitem `cc-peer-message { kind, fromTabId, toTabId, atMs }`.
2. `applyMessage`: um `tell` do orquestrador (aba `Orquestrador`) a um membro abre uma tarefa pendente; qualquer mensagem *do* membro (tell ou ask) a fecha. Um `tell` novo reinicia o relógio e o aviso. `ask` não abre tarefa (já espera sozinho).
3. A cada 5 s, `findStalls` avalia as pendentes. O silêncio conta desde o máximo entre a tarefa, a última saída do agente (`lastOutputAt`, novo em `terminal/activity.ts`) e a última digitação do usuário (`lastInputAt`). Passados `STALL_MS` = 120 s, avisa.
4. O aviso (`stallMessage`, PT-BR) vai ao orquestrador por `pasteIntoTab`, só quando ele não está no meio de um turno (senão tenta no tic seguinte). Traz nome, há quanto recebeu a tarefa, há quanto está parado, se chegou a trabalhar e a última linha da tela. Uma vez por tarefa.

**Sem falso alarme:**

| Situação | Tratamento |
|---|---|
| Pensando/executando (saída contínua) | `activeTabIds`: o relógio só corre com a aba quieta (`QUIET_MS`) |
| Espera aprovação/resposta do usuário | `isWaitingForUser` reconhece o diálogo nas últimas 8 linhas |
| Usuário digitando na aba | `lastInputAt` reinicia o relógio |
| Aba fechada | descartada da lista |

**Limites conhecidos:** um `tell` que não pede nada (ex.: "obrigado") também fica pendente; o agente que trabalha e responde sem `ags peer tell` gera um aviso ("trabalhou e se calou") que o orquestrador ignora após `ags peer check`. O plazo ainda não é configurável. Reconhecimento de diálogo é por texto da tela (EN/PT/ES).

**Testes:** `src/features/missions/tests/stalled.test.ts` (21 casos).

## Ponto 2 — Peer ask com prazo e gargalos

`ags peer ask "Backend" "pedido" --timeout 30` mantém o prazo configurável (10–3600 s; padrão 600 s). O orçamento inclui a espera para o destino ficar quieto e a espera do eco antes do Enter. Se o destino permanece ocupado, retorna `sent: false`, `finished: false`, `status: "busy"`, sem enviar uma segunda tarefa. Após envio, o prazo devolve a resposta disponível com `sent: true`, `status: "timed_out"`; não interrompe o agente. O transporte da tela/IPC e o polling podem acrescentar pequena latência ao prazo.

`ags peer check "Backend" --lines 100` consulta a tela atual e o parcial da última pergunta para o destino, sem reenviar o prompt. Qualquer peer conectado pode consultar durante a espera. `askStatus` contém `state` (`waiting`, `finished`, `timed_out`, `busy`), `fromTabId`, `sent`, `finished` e `elapsedMs`. O estado descreve a espera da pergunta, não certifica o estado atual da TUI: depois de timeout, `reply` continua permitindo ler o resultado mais recente. O histórico de consultas é volátil, limitado a 256 destinos; sem pergunta prévia, `askStatus` é nulo. Em TUIs de tela alternativa, o parcial é a tela visível, pois não existe scrollback incremental.

`ags mission timings <id>` inclui `summary.bottlenecks`, ordenado por `waitingMs` decrescente. Cada agente traz número de perguntas, solicitantes distintos, soma e máximo da espera, timeouts e soma de spans `turn`. Esperas simultâneas de dois solicitantes contam duas vezes: são dois agentes bloqueados, não tempo de relógio da missão. Não se soma `peer_ask` ao tempo de turno do agente. Agentes sem destino identificado não entram no ranking. A medição usa os spans persistidos existentes, sem alegar causalidade ou estimar tokens/custos ausentes.

Todos os turnos passam por um único `TurnTracker`: o briefing registra `detail: "briefing"` uma vez; Enter no terminal, `peer ask`, `peer tell`, recruit e `tab send` iniciam os próximos turnos. Saída sustentada detecta ainda turnos iniciados fora desses caminhos. `activitySnapshot()` apenas lê timestamps, preservando a lógica de atividade do ponto 1. O watcher continua medindo com a barra lateral recolhida. Cinco segundos sem saída encerram o span na última saída observada; fechamento da aba/missão descarrega o turno observado. Submissões sem saída não criam spans e deixam de ser acompanhadas após 20 minutos.

Limites: inferência por silêncio segue a heurística existente, portanto uma pausa longa pode dividir um turno. Duas submissões com saída separadas por menos de 5 s permanecem no mesmo turno; os 1,5 s do Rust são a preparação para enviar, enquanto o término do turno usa 5 s em ambos os lados. Uma nova submissão sem saída anterior reinicia o início, evitando contar um Enter perdido até 20 minutos depois. Eco nos primeiros 600 ms é descartado pela atividade; uma resposta inteira nesse intervalo pode não ser medida. O polling é de 1 s e a coleta precisa da janela da missão aberta. Totais `byKind` podem superar 100% do `wallMs`, pois há agentes em paralelo e espera dentro de turnos. A tela de gargalos no QG pertence ao ponto 4; este ponto entrega a API e o contrato TypeScript, sem novos textos visuais. A baseline histórica é registrada pelo QA antes da integração.

Testes focados: `cargo test --lib missions::timings`, `cargo test --lib ipc::commands::peers`; Vitest cobre briefing único, turnos seguintes, respostas curtas, saída tardia, redraw de inicialização e fechamento. No Windows: `node node_modules/typescript/bin/tsc --noEmit` e `node node_modules/vitest/vitest.mjs run` (sem `npx`).
# Eficiência entre agentes

## Ponto 3 — Setup do worktree

Prepare o worktree antes de iniciar uma missão ou abrir um recruit. Confirme o caminho e a branch atribuídos, ligue `node_modules` às dependências compartilhadas quando aplicável e configure o cache Rust na sessão do shell que executará os comandos. Não reutilize o clone principal como diretório de trabalho do agente.

No Windows, use PowerShell. Para esta missão, o worktree já está pronto em `C:\Users\tonz1n\.antigravity\ADE-AGS-e11-p3-worktree-setup`, na branch `feat/etapa11-p3-worktree-setup`, baseada em `origin/master`. O `node_modules` é uma junction para `C:\Users\tonz1n\.antigravity\ADE-AGS\node_modules`. Para outro worktree, ajuste os caminhos e crie a junction somente se `node_modules` ainda não existir:

```powershell
$worktree = 'C:\Users\tonz1n\.antigravity\ADE-AGS-e11-p3-worktree-setup'
$sharedNodeModules = 'C:\Users\tonz1n\.antigravity\ADE-AGS\node_modules'
$nodeModules = Join-Path $worktree 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) {
    New-Item -ItemType Junction -Path $nodeModules -Target $sharedNodeModules | Out-Null
} else {
    $link = Get-Item -LiteralPath $nodeModules
    if ($link.LinkType -ne 'Junction' -or $link.Target -notcontains $sharedNodeModules) {
        throw 'node_modules existe, mas não é a junction compartilhada esperada; pare e confira o worktree.'
    }
}

Set-Location $worktree
$env:CARGO_TARGET_DIR = Join-Path $worktree 'src-tauri\target'

node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
cargo test --manifest-path src-tauri/Cargo.toml --lib floors::test
```

Use `--lib` com um filtro correspondente ao módulo alterado para evitar rodar todos os testes Rust quando isso não for necessário; por exemplo, `cargo test --manifest-path src-tauri/Cargo.toml --lib floors::test`. Por padrão, o recruit aponta `CARGO_TARGET_DIR` para o target compartilhado do clone principal. Compilações simultâneas podem disputar o lock desse target. Se vários agentes precisarem rodar Cargo ao mesmo tempo, inicie a ADE com `ADE_AGS_CARGO_TARGET_DIR=per-worktree`: cada worktree terá seu próprio target, sem essa disputa, ao custo de recompilar as dependências uma vez em cada worktree.

Se uma próxima missão criar outro worktree Windows sem `node_modules`, crie uma junction para a instalação compartilhada antes de abrir o recruit. Preserve uma junction correta que já exista; não remova nem substitua um diretório desconhecido.

No Linux e no CI, instale as dependências no checkout (`bun install --frozen-lockfile`) e deixe Cargo usar `src-tauri/target`, que é o caminho cacheado pelo workflow. Não copie o `CARGO_TARGET_DIR` absoluto do Windows para scripts Linux ou CI. Os comandos Node acima usam caminhos relativos e funcionam nos dois sistemas; para os testes Rust no CI, use `cargo test --manifest-path src-tauri/Cargo.toml --lib` a partir da raiz. Durante trabalho concorrente, `ADE_AGS_CARGO_TARGET_DIR=per-worktree` também pode ser configurado no processo da ADE em Linux/macOS; isso separa os locks, mas recompila as dependências uma vez por worktree.

Inclua no briefing inicial do agente: caminho do worktree, branch e base, shell a usar, estado/alvo do link de dependências, configuração de `CARGO_TARGET_DIR` para aquele sistema e os comandos exatos de validação. Resolva os caminhos antes de abrir a missão ou executar `ags peer recruit`; o agente não deve precisar descobrir nem inferir o setup.
