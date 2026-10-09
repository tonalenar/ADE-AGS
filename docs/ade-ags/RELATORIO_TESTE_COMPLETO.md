# Relatório de teste completo: ADE AGS 1.8.7

Missão: "Teste completo v3 (squad Opus)" · data: 2026-10-09 · base: `dcb4d2d` (master, 1.8.7).
Squad: Orquestrador, Generalist (backend/CLI), Frontend (telas), QA / Tests (casos de borda e Vigia).
Escopo: só teste e relato. Nenhum código do produto foi alterado.
Já conhecido e fora do relatório: erro de sandbox do Codex 0.161.0 no Windows.

## Como os achados foram conferidos

- O Orquestrador conferiu cada achado **alto** no código ou no estado real (banco `~/.ags/data.db` em modo só leitura, CLI). Os médios e baixos foram conferidos por amostragem (abaixo, "conferido" indica quem conferiu).
- Nenhuma tela foi vista renderizada: não havia dev server, e reiniciar o app derrubaria os terminais da missão. Os achados de layout (texto cortado) vêm de cálculo sobre as classes Tailwind e têm confiança média.
- Restauração de abas, reconexão de terminal e janela maximizada não foram exercitadas ao vivo pelo mesmo motivo (exigem reiniciar ou recarregar o app). Esses itens vêm de leitura de código e do banco.

## Suítes

| Suíte | Resultado |
|---|---|
| `ags test run rust` (`cargo test --lib --bin ags`) | passou: lib 1326 ok / 0 falhas / 10 ignorados; bin `ags` 39 ok |
| `ags test run tsc` | passou |
| `ags test run frontend` (vitest) | passou: 187 arquivos, 1600 testes, 0 falhas |

O flake conhecido `orchestrator::test::esperar_sin_nada_que_reportar_vence_vacio` passou nesta rodada.

## Resumo por gravidade

| Gravidade | Qtd. | Itens |
|---|---|---|
| Bloqueante | 0 | |
| Alto | 4 | A1 Vigia (unidade de tempo), A2 sessionId errado, A3 Limites de conta apagados, A4 Enter no Histórico |
| Médio | 21 | M1–M21 (Vigia e terminais M1–M6, telas M7–M16, CLI M17–M19, coordenação M20–M21) |
| Baixo | 13 | B1–B13 |

O ponto mais visível: **o Vigia dispara desde o primeiro ciclo de toda missão** (A1). Somado a M3, depois de cerca de 12 min ele esgota os lembretes e para de checar. Ou seja, nesta versão ele avisa à toa no começo e se cala quando um travamento real poderia acontecer.

---

## Alto

### A1. Vigia: `startedAt` em segundos comparado com `now` em milissegundos
- **Arquivo:** `src/features/missions/vigia.ts:193`: `startedAt: mission.startedAt ?? now`.
- **Causa:** `missions.started_at` é epoch em **segundos** (o próprio Rust multiplica por 1000 em `src-tauri/src/missions/active.rs:55` e `startcheck.rs:67`; a UI também, em `MissionOverview.tsx:237`). `now` é `Date.now()` em ms, então `now - startedAt ≈ 1,8e12` e a condição "sem tarefa" (`vigia.ts:122`) passa de imediato.
- **Reprodução:**
  1. Inicie uma missão com equipe.
  2. Olhe o chat do Orquestrador nos primeiros 30 s.
- **Esperado:** nenhum aviso antes de `UNTASKED_MS` (5 min).
- **Obtido:** "Vigia — travado: … sem tarefa há 29829610 min; o Orquestrador não enviou nada há 29829610 min. Feito: lembrete 1/3". Nesta missão o lembrete chegou ao Orquestrador no mesmo instante em que ele delegava. Os 3 lembretes e o "Parei de insistir" saem em cerca de 12 min.
- **Por que os testes não pegam:** `src/features/missions/tests/vigiaWatchdog.test.ts` usa `startedAt: 0`.
- **Conferido:** QA (em `~/.ags/chat.json`) e Orquestrador (código e recebimento ao vivo).

### A2. Aba do Claude Code grava `sessionId = "opencode_stream"` (resume quebrado)
- **Observado:** em `~/.ags/data.db`, `tabs` tem a aba `c20977ae-…` (QA / Tests, `agent_id = claude-code`) com `session_id = opencode_stream`. A conversa real é `e376f42c-….jsonl`, em `~/.claude/projects/C--Users-tonz1n--ags-worktrees-1092a83e/`. `session_history` tem o mesmo valor para uma aba "Frontend".
- **Efeito:**
  - `Terminal.tsx:307` (`if (knownSessionId) return;`) para a descoberta, então o valor errado nunca é corrigido enquanto a aba está aberta.
  - Ao restaurar, `buildResumeCommand` monta `claude --resume opencode_stream` (`TerminalPanel.tsx:74`). O id passa em `isSafeSessionId`.
  - A conversa não é retomada. Isso é inferido do código; não foi reaberto ao vivo.
- **Causa:** `claude_project_dir` (`src-tauri/src/session/title.rs:188-203`). Quando a pasta `projects/<slug>` ainda não existe (primeira sondagem, logo após abrir a aba), entra o fallback "legacy" `projects.join(cwd.replace('/', "-"))`. No Windows o cwd é absoluto e usa `\`, então o `replace` não muda nada e `PathBuf::join` com caminho absoluto **descarta a base**: o "legacy" vira o próprio worktree, que existe. Daí `claude_session_file` (`:205-220`) chama `collect_files`, que é recursivo, sobre o worktree inteiro, inclusive `node_modules` e `target`. `newest_matching` escolhe o `.jsonl` mais novo, que é a fixture `src-tauri/src/runs/fixtures/opencode_stream.jsonl`, e o `file_stem` vira o sessionId.
  - Afeta qualquer aba Claude Code no Windows cujo cwd tenha um `.jsonl` em qualquer subpasta. No repositório do ADE AGS isso acontece sempre.
  - O id errado só é corrigido ao fechar a aba (`resolve_for_archive`, `database/queries/sessions.rs:109-150`).
  - Causa conferida no código pelo Orquestrador e pelo QA. A descoberta não foi reproduzida ao vivo.
  - Detalhes do QA: `claude_stream.jsonl` e `opencode_stream.jsonl` têm o mesmo mtime (os dois vêm do checkout), e o desempate devolve `opencode_stream`. A janela de risco é a primeira sondagem (~3 s), antes de o Claude criar a pasta do projeto.
  - Evidência em dois worktrees: `1092a83e` (fixtures às 14:49:27, pasta do projeto às 14:49:35) e `6429bed1` (sem pasta de projeto; sessão arquivada às 14:44:32 com `opencode_stream`). O comportamento de `Path::join` foi confirmado com `rustc` à parte.
  - Correção sugerida (não aplicada): não usar o "legacy" quando o slug não existe; nunca varrer o cwd.
- **Reprodução:**
  1. `sqlite3 -readonly ~/.ags/data.db "select id,title,session_id from tabs where agent_id='claude-code';"`
  2. Esperado: o uuid do `.jsonl`. Obtido: `opencode_stream`.
- **Conferido:** QA e Orquestrador (consulta ao banco).

### A3. Contas › "Limites" pode apagar os limites salvos sem aviso
- **Arquivos:** `src/features/accounts/AgentAccountsPane.tsx:288-290` (`Promise.all(...).catch(() => {})`) e `:381` (fallback `{maxConcurrent:null, dailyBudgetUsd:null}`). O `LimitsDialog` só lê `limits` no `useState` inicial (`:84-85`).
- **Reprodução:**
  1. Configurações › Contas › Gerenciar.
  2. Abra "Limites" de uma conta com limites, antes de a carga terminar, ou quando um único `accountLimitsGet` falhar.
  3. Clique em Salvar.
- **Esperado:** os valores atuais, ou loading/erro com Salvar desabilitado.
- **Obtido:** os campos vêm vazios, e Salvar grava `null`, apagando o teto de concorrência e o orçamento diário.
- **Conferido:** Frontend e Orquestrador (código).

### A4. Histórico › Enter num botão da linha retoma a sessão marcada
- **Arquivo:** `src/features/sessions/SessionsPage.tsx:110-113`: o `onKeyDown` do contêiner (`:148`) faz `if (e.key === "Enter" && selected) { e.preventDefault(); resume(selected); }`, e o Enter dos botões filhos sobe até ele.
- **Reprodução:**
  1. Marque uma sessão com ↑/↓.
  2. Tab até "Apagar", "Exportar" ou o cabeçalho de pasta.
  3. Aperte Enter.
- **Esperado:** o botão focado é acionado.
- **Obtido:** a sessão marcada (talvez de outra linha) é retomada. Apagar, Exportar e recolher pasta ficam inacessíveis pelo teclado.
- **Conferido:** Frontend e Orquestrador (código).

---

## Médio

### Vigia e terminais (QA)

- **M1. "Sem tarefa" ignora a atividade do Orquestrador.**
  - `vigia.ts:122` não olha `lead.lastOutput`; a condição `silent` (`:139`) olha.
  - Resultado: um Orquestrador que está escrevendo há 6 min é rotulado "travado". Isso foi observado nesta missão.
- **M2. Integrante que está escrevendo é rotulado "travado" e recebe pedido de reenvio.**
  - A condição `open` (`vigia.ts:121`, `:129-135`) só olha a data da tarefa e do último reporte.
  - Depois de 3 lembretes, `:224` manda "reenvie a tarefa ao integrante parado", o que gera trabalho duplicado.
  - `vigiaWatchdog.test.ts:59-70` consagra esse comportamento.
- **M3. Depois do limite, a camada de modelo nunca mais roda na missão.**
  - `vigia.ts:221-227` faz `continue` antes da checagem por modelo (`:236-240`).
  - A linha "Parei de insistir" não diz que a checagem por modelo também parou.
  - Com A1, isso acontece por volta dos 12 min de toda missão.
- **M4. A chamada Claude do Vigia não usa a conta do Orquestrador.**
  - `vigia.ts:243-251` não passa conta, e `src-tauri/src/missions/vigia.rs:113-125` roda `claude -p` sem `CLAUDE_CONFIG_DIR`.
  - Com o Orquestrador numa conta alternativa, o Vigia usa a conta padrão em silêncio. Isso contraria a regra de contas isoladas.
  - Não reproduzido ao vivo.
- **M5. A chamada Claude do Vigia não restringe ferramentas.**
  - O Codex usa `--sandbox read-only` (`vigia.rs:98-103`); o Claude (`:113-125`) não tem restrição nenhuma.
  - O prompt inclui o fim da tela dos agentes (`vigia.rs:57-77`), que é texto não confiável.
  - Sugestão: `--tools ""` ou `--disallowedTools`.
- **M6. A reconexão de terminal pode perder saída.**
  - Em `Terminal.tsx`, o `ptyAttach` (`:366`) tira o snapshot, depois `await fitOnce()` (`:368`, até 1,5 s) e só então `attachListeners(reattachId)` (`:383`), **sem** replay.
  - A criação (`:512`) usa `withReplay`.
  - Efeito esperado: um trecho da TUI sem desenhar até o próximo repaint.
  - Só leitura de código.

### Telas (Frontend)

- **M7. Missões › depois de abrir uma missão pelo badge de memória, todas as missões abrem na aba "Memória".**
  - `MissionsPage.tsx:476` usa `if (focusNonce > 0) setTab("memory")`; o `focusNonce` (`:150`) nunca volta a 0, e `key={summary.id}` (`:347`) remonta o detalhe.
  - Reprodução: badge âmbar na lateral → clicar em outra missão.
- **M8. Missões › com a Frota aberta, o foco pedido pela lateral não aparece.**
  - `MissionsPage.tsx:145-153` não faz `setFleet(false)`; o caminho de `missionRequest` (`:112-117`) faz.
  - Variante: criar uma missão com a Frota aberta (`:384-385`) não mostra o rascunho, e parece que "Criar" não fez nada.
- **M9. Orçamento inválido vira "sem teto", sem aviso.**
  - `missionView.ts:196-205` (`parseBudget`) e `runs/NewTaskDialog.tsx:403-406` devolvem `null` para `$5`, `US$ 5`, `abc`, `0` e `-2`; o botão não valida.
  - Salva `budgetUsd: null`, e o usuário acha que definiu um teto.
- **M10. Motivos de indisponibilidade de Squad e erros do backend aparecem em inglês/espanhol na UI PT-BR.**
  - `src-tauri/src/squads/store.rs:185,192,204` devolve frases fixas em inglês ("… is not installed"), mostradas em `MissionsPage.tsx:662`, `MissionDialog.tsx:226`, `SquadsPage.tsx:140,156` e `SquadDialog.tsx:279`.
  - O banner de erro mostra o texto cru do Rust (`missions/mod.rs:501`, em espanhol).
  - O enum `squads.availability.*` já existe para traduzir.
- **M11. Contas › falha ao verificar aparece como "sem login".** `ContasSection.tsx:101` com `store.ts:58-61`: qualquer exceção vira `unknown`, que aparece como "off", e o `detail` é descartado.
- **M12. Contas › falha de carga aparece como estado vazio.**
  - `ContasSection.tsx:205`: `load().catch(() => undefined)` mostra "Nenhuma conta conectada ainda".
  - `:64`: falha de uso mostra "Esta TUI não informa quanta cota…".
- **M13. Configurações › Painel de memória mostra dados do workspace anterior.**
  - `SettingsPage.tsx:426`: `<MemoryPanel>` sem `key={workspaceId}` (o `SharedMemoryPanel`, em `:406`, tem).
  - O cache em `MemoryPanel.tsx:43,77` só recarrega quando está `null`.
- **M14. Frota › erros das ações só vão para o console.**
  - `FleetPage.tsx:274-284`: parar, passar para outro, permitir/negar e a decisão de correção usam `.catch(console.error)`.
  - O mesmo vale para retomar pelos diálogos do Histórico (`SessionsPage.tsx:262,278`).
- **M15. Canvas › Chat: o campo perde o foco a cada envio.** `AIChatCard.tsx:87` usa `disabled={disabled || busy}` durante o `chat_send` (`ChatPanel.tsx:217-228`). O Esc do painel também para de funcionar até um novo clique.
- **M16. Overflow: rótulos `shrink-0` cortam ou espremem texto** (confiança média, sem render).
  - Contas › Gerenciar (`AgentAccountsPane.tsx:182-249`): ~330 px de botões numa linha de ~376 px.
  - Frota › AgentCard (`AgentCard.tsx:99-123,199-271`): chip de modelo longo; botão "abrir" cortado.
  - Missões › Execução (`MissionsPage.tsx:871-876`): `agentId · model · conta` sem `title`.

### CLI (Generalist)

- **M17. `ags tab create` com cwd inexistente cria a aba e devolve sucesso.**
  - Comando: `ags tab create "C:/caminho/que/nao/existe" --agent claude-code`.
  - Obtido: exit 0 e a aba aparece em `tab list`. Esperado: erro e nenhuma aba.
  - A aba de teste foi fechada depois.
- **M18. Ajuda e erros de uso fora do contrato "JSON em stdout".**
  - `ags --help 2>/dev/null | wc -c` dá **0**: a ajuda vai toda para stderr, então `ags --help | grep` não acha nada.
  - Erros de uso (`Falta el argumento…`, `--file necesita una ruta`) saem em texto puro; os erros de negócio saem em JSON.
  - Conferido pelo Orquestrador.
- **M19. `peer tell --file` com arquivo vazio não é rejeitado** (suspeita, por código).
  - `src-tauri/src/bin/cli.rs:876-890` (`inline_file`) não checa vazio, e `peers.rs:613-621` aceita texto vazio (`ipc/protocol.rs:166`).
  - Não foi enviado a um peer vivo, para não entregar corpo vazio a um agente.

- **M20. `ags peer check` devolve uma tela antiga.**
  - Durante esta missão, `ags peer check "QA / Tests"` mostrou a mesma tela por mais de 15 min, como se o QA estivesse parado.
  - No mesmo momento, `ags tab output c20977ae-…` mostrava o QA trabalhando, editando o `ACHADOS_QA.md`.
  - O mesmo aconteceu com o Generalist.
  - Consequência: o Orquestrador e o Vigia, que leem essa tela, concluem "parado" para quem está trabalhando e podem reenviar tarefas sem necessidade. Isso agrava M2.
  - Reprodução: com um integrante trabalhando, compare `ags peer check <nome>` com `ags tab output <tabId>`.
  - Conferido pelo Orquestrador. A causa não foi investigada.
- **M21. O aviso automático "parado há N min" dispara para quem já entregou.**
  - Depois que o Frontend entregou o resultado e recebeu "aguarde", o app mandou ao Orquestrador: "O agente Frontend recebeu uma tarefa há 3 min 36 s e está parado…".
  - A mensagem de "aguarde" foi contada como tarefa nova.
  - Pede ação onde não há nenhuma; é a mesma família de M1 e M2.

## Baixo

- **B1. A geometria da janela fica NULL no banco** se o app fechar maximizado sem ter desmaximizado.
  - `persistence.ts:184-188` (`lastNormalBounds` começa `null`) e o upsert em `database/queries/windows.rs:106-109`.
  - Na próxima abertura, ao desmaximizar, a janela volta a 900×650.
- **B2. Traduções PT-BR erradas** (`src/i18n/locales/pt-BR.json`). Conferido pelo Orquestrador; vai além da Frota:
  - `fleet.card.branchOnly` "filial ·", `fleet.card.lead` "liderar", `fleet.status.running` "correndo", `fleet.group.running` "Correndo", `fleet.runs.title` "Corre", `fleet.runs.cancel` "Pare de correr", `settings.graphify.run` "Corre".
  - `fleet.runs.broken` "{{n}} não será concluído" não tem plural.
  - "filial" no lugar de "branch" também em `scm.branch.*`, `scm.publish`, `forge.pr.*`, `forge.branch.none`, `forge.release.target` e `fleet.worktree.discarded`; "controle remoto" no lugar de "remoto" em `scm.graph.outgoing/incoming`.
- **B3. Novo agente › Esc não fecha o wizard.** `NewAgentDialog.tsx:151` não passa `closeOnEsc`, e o padrão do `AppDialog` é `false` (`AppDialog.tsx:78`). O mesmo vale para `ResumeOptionsDialog` e `MissingSkillsDialog`.
- **B4. Histórico sem estado de carregamento;** quando dá erro, aparecem o erro e "nenhuma sessão" juntos (`SessionsPage.tsx:149-158`).
- **B5. Missões › "Cancelar" não pede confirmação** (`MissionsPage.tsx:617-622`). O mesmo vale para Frota › "Pare de correr" (`RunStrip.tsx:86-91`), que cancela a run inteira. Pode ser decisão de produto.
- **B6. Nova missão › "Você não tem squads" pisca enquanto os squads carregam** (`MissionDialog.tsx:44,228-233`).
- **B7. Contas › fechar o login de nova conta pelo X não recarrega a lista** (`AddAccountDialog.tsx:84`; "Concluído", em `:95`, recarrega).
- **B8. Memória › Aprovar/Rejeitar perde o motivo da falha** (`memory/review.ts:36-42`). Também falta o fluxo de "confirmar credencial" do `SharedMemoryPanel`.
- **B9. Códigos de saída do CLI diferem do help.** `ags foo bar` sai com 1, mas o help diz que 2 é "uso incorreto". `ags mission` sem ação sai com 2. Conferido pelo Orquestrador.
- **B10. Mensagens do CLI misturam espanhol e português** (help, `Falta el argumento`, `não está conectado com você`) e não usam os locales do app.
- **B11. As mensagens de argumento faltante não batem com o help.**
  - `mission status` pede `--mission`, `memory search` pede `--query` e `peer tell` pede `--text`, mas o help documenta esses argumentos como posicionais.
  - `memory search` funciona sem o `--mission` que o help indica como obrigatório.
- **B12. `--file` apontando para uma pasta** dá "Acesso negado (os error 5)" em vez de "é um diretório".
- **B13. Não existe comando para listar missões.** `ags mission list` dá "Comando desconocido" (conferido pelo Orquestrador); o help só tem `run|start|status|wait`.


---

## Verificado sem defeito

- **i18n:** nenhuma chave crua nas telas do escopo (en, es e pt-BR). As chaves dinâmicas cobrem todos os valores, e os plurais recebem `count`.
- **Telas:** nenhum `<button>` sem handler.
- **Criar Squad:** trocar o provedor zera modelo, esforço, fast e conta (`SquadDialog.tsx:236`), e Salvar fica bloqueado sem provedor.
- **Nova missão:** o botão de criar trava contra duplo clique.
- **Terminal:** o fit ignora contêiner 0×0. O resize tem debounce de 120 ms e deduplicação. WebGL só roda em terminal visível, com fallback para DOM. Conta ausente aborta o lançamento com mensagem, sem cair na conta do sistema.
- **Tela cheia:** são rotas internas (`RouteModal.tsx`), que saem com Esc ou X. Não existe F11 nem tela cheia do sistema; se isso é o desenho, não é defeito.
- **`ags peer tell --file`:** aspas, crase, `< >`, `$HOME`, `$(…)`, `%TEMP%`, barras invertidas, JSON, cedilha, emoji, tabulação e várias linhas chegaram íntegros ao destino (Generalist → QA). As palavras acentuadas (ação, coração, ÉÍÓÚ, ãõ, ü, ñ) foram testadas à parte (Orquestrador → Frontend, e Generalist → QA depois de sair da fila) e também chegaram íntegras. Envios para um peer ocupado ficam na fila (`queued:true`) e são entregues quando ele termina o turno.
- **CLI:** `tab list/close/output`, `memory index/open/search`, `mission status`, `peers`, `peer check` e erros de agente/peer desconhecido funcionam como esperado e devolvem JSON. `memory open` marca o conteúdo como `UNTRUSTED DATA`.

## Observações (não são defeitos)

- A memória aprovada `teste-containment-sandbox` diz que `terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente` falha dentro do sandbox. Nesta rodada ele passou, então a memória pode estar desatualizada.
- `ags test status` mostra um verde de `rust` com `clean:false`. Não foi verificado se o cache reaproveita esse registro.
