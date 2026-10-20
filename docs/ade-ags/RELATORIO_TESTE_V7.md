# Relatório de teste v7 (squad E2E)

Versão testada: ADE AGS 1.8.7, master `fed4b59`. Nenhum código do produto foi alterado.
**A interface real não foi aberta por nenhum agente.** Tudo de UI abaixo vem de leitura de código.

## Resumo
- Bloqueante: 0. Alto: 0. Médio: 6. Baixo: 4.
- Suítes verdes e com cache funcionando. Laya sem erros e abaixo de 2 s, mas com falsos positivos de segredo.

## Achados

### Médio
1. **`peer tell --file` com BOM trava o auto-envio no Claude** (Backend, confirmado; QA reproduziu). O Claude mostra "Removed 1 invisible character · review and press Enter to send"; resposta `sent:false, unconfirmed:true`. Repro: `Set-Content -Encoding utf8` num arquivo com aspas, ação, `$HOME` e crase; `ags peer tell <claude> --file arq`. O reenvio concatena outro exemplar ao rascunho. Sem BOM funciona e o texto chega íntegro. Código: `src-tauri/src/bin/cli.rs:892` preserva o BOM; o detector de paste em `src-tauri/src/ipc/commands/tabs.rs:362` não cobre o aviso.
2. **Modal "Set up security" (Daybreak) do Codex prende o briefing** (Backend e QA). O texto fica colado como `[Pasted Content ...]` sem enviar. Eu o destravei com Esc e depois Enter via `ags tab send`. Repro: abrir Codex sem o setup de segurança e mandar `peer tell`.
3. **Laya marca `segredo=sim` em propostas sem credencial** (Backend, leitura sqlite `mode=ro`). v7: 3 de 4 propostas (IDs 10, 11, 13); com histórico, 7 de 11. Todas com ação `aprovar` (modo sombra, sem efeito). Só a ID 12 saiu `segredo=nao`.
4. **Erros em espanhol visíveis ao usuário** (Frontend, só código). A UI mostra `String(e)` do backend sem traduzir: `agents/custom.rs:154`, `runs/ledger.rs:54,57`, `prelaunch/presets.rs:12,15`, `database/queries/workspaces.rs:342`, `accounts/store.rs:22,25,34`, `accounts/secrets.rs:65-87`, `marketplace/github.rs:132,148,298`, `skills/install.rs:27,141,363`, `skills/files.rs:22`, `forge/commands.rs:130`, `sync/commands.rs:197`. Telas que exibem direto: `MissionDialog.tsx:82,271`, `MissionFinishDialog.tsx:29,68`, `CleanupPanel.tsx:50`, `ConflictsSection.tsx:19`, `MissionReviewPanel.tsx:45,165`, `MissionsPage.tsx:158-169,265,543`, `SquadDialog.tsx:77,206`, `SquadsPage.tsx:65`, `CliInstallSection.tsx:25`. Contas já tem mapeamento i18n (`accounts/problem.ts`).
5. **MemoryRail some em janela estreita** (`src/features/settings/MemoryRail.tsx:85,109`, classe `hidden @5xl:block/flex`). Painel e balão de pendências ficam inacessíveis abaixo do breakpoint. Inferido do código.
6. **Erros de CLI/agente em 3 idiomas** (`src/features/orchestrator/cliBridge.ts:77,78,124,138,174,176,186,236,245,253,272,282,300,313,326`, `browser/agentBridge.ts:197`). Vão ao terminal do agente, não à tela.

### Baixo
7. Plural ausente em `settings.memoryRail.badge` (`MemoryRail.tsx:83`): "1 sugestões pendentes" no aria-label.
8. `MemoryRail.tsx:71`: polling de 30 s sem guarda de workspace, com erros engolidos; resposta atrasada pode sobrescrever contagens ao trocar de workspace.
9. Texto truncado sem tooltip: `ConflictsPanel.tsx:43`, `MissionOverview.tsx:179-180`, `FleetView.tsx:73`, `MissionsPage.tsx:435,578,582,715,725,871,911`, `MemoryPanel.tsx:118-119`, `SessionsPage.tsx:216,254`, `CanvasView.tsx:749,754`, `UsageBoard.tsx:74,80`, `TabItem.tsx:109,112`, `DetectedAgents.tsx:171`.
10. `missions/terminals.ts:371`: erro fixo em pt-BR dentro de `throw new Error`, sem i18n.

## Resultados
- **Suítes** (Backend): rust 1362+40 testes, 10 ignorados, 127 s (linha de base ~136 s). frontend 199 arquivos/1664 testes, 23,2 s (base 18 s, +29%, com Rust rodando junto). tsc 21,3 s (base 23 s). Segunda execução de cada suíte: `cacheHit`, "já verde neste hash". `affected`: plano vazio, nada a testar.
- **`ags test smoke`** (QA, no próprio terminal): 9 passaram, 0 pularam, 0 falharam (~45 ms): app responde, tab output, tab inexistente recusada, missão inexistente recusada, peers, índice de memória, `--file` íntegro (aspas, acentos, `$HOME`, crase), `--file` inexistente, destino inexistente recusado.
- **CLI** (Backend): `tab list/send`, `peers`, `peer check`, `mission status/review/timings`, `memory index/search` OK. `peer tell` com destino ocupado retorna `queued:true, sent:true`; texto não visto na tela retorna `sent:false, unconfirmed:true` e libera o reenvio (QA).
- **Dreaming:** `ags memory dream` não existe (`memory.dream` desconhecido); só há o comando interno `memory_dream_start`. Não foi possível disparar por CLI. A interface real e o erro 206 de ponta a ponta **não foram verificados**. O teste unitário `prompt_grande_do_claude_vai_pelo_stdin` passou.
- **Shell:** abriu com prompt normal, sem tela em branco, e fechou limpo. Claude, Codex e Antigravity: PTY e CLI operando. Nenhum laço vazio de Codex observado.

## Balanço da Laya (só leitura)
- 13 linhas: `memory_approval` 11, `mission_gate` 2, `fleet_gate` 0, `dream_triage` 0.
- Latência: v7 média 499 ms, máx 514 ms; geral `memory_approval` média 536 ms, máx 671 ms; `mission_gate` média 397 ms. Erros 0; nenhuma ≥ 2 s.
- `ags memory suggest` não dispara a Laya; só a revisão pela interface (`memory/review.rs:241,338`). As 4 propostas do QA foram revisadas depois, o que gerou as linhas v7.
- **Controle positivo `senha=hunter2`:** `ags memory suggest` recusou a proposta antes de salvar (Exit 1, "A proposta parece conter uma credencial (chave, token ou senha)..."); não gerou entrada nem revisão. O QA atribui o bloqueio à Laya, mas o Backend confirma que o `memory suggest` não dispara a Laya e que não há linha dela para essa proposta; é provável que seja um detector local no próprio comando. A detecção da Laya em credencial real **não foi observada**.
- Impacto no tempo da missão: não medido (a sombra roda em segundo plano).

## Balanço do Vigia
- **Não foi avaliado.** O QA reporta o Vigia desligado (0 mensagens no chat); a instrução era ligá-lo, e não há confirmação de que isso tenha sido feito. Não houve cutucadas visíveis para contabilizar.
- Mensagens recebidas nos terminais (QA, inclui probes e um aviso do sistema sobre atraso do QA e mensagens do Orquestrador): Orquestrador 3, Backend 4, Frontend 2, QA 2. Nenhuma atribuível ao Vigia.
- Texto colado sem enviar: dois casos, ambos de causa externa ao Vigia (modal Daybreak no Backend; aviso de caractere invisível no Claude).
- Esc em popup: o Esc fechou o popup do Codex, mas o texto colado precisou de Enter manual.

## Tempos da missão (`ags mission timings`, durante a execução)
Ativo 434 s, primeira delegação 41 s, Orquestrador esperando 0 ms, QA esperando 0 ms.

## Não coberto
Interface real inteira (teclado, foco, Esc em tela cheia), Frota/Canvas/Histórico em profundidade, Antigravity e Codex como casos de borda além dos acima, chaves i18n dinâmicas, "Sonhar agora" pela interface, aviso de laço de 8 min.
