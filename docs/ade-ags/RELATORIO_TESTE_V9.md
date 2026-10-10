# Relatório de teste v9 — ADE AGS 1.8.7 (master 6dc77c2) com o Jev

Missão "Teste completo v9 com o Jev (squad E2E)". Só teste e relato: nenhum código do produto, configuração, conta, chave ou `~/.ags/data.db` foi alterado (sqlite aberto em `mode=ro`). **A janela do app não foi aberta**: a revisão de telas foi só por código e o resto por CLI.

## 1. Achados (conferidos antes de listar)

### Média
1. **`ags run status --run-id <UUID>` ignora o `--run-id`.**
   - Repro: `ags run status --cwd <worktree absoluto> --run-id 00000000-0000-0000-0000-000000000000` devolve "ainda não há nenhum run lançado desta pasta".
   - Controle: com `--json-args` contendo `{"args":{"run_id":"…"}}` o ID é lido.
   - Causa provável: o parser normaliza a flag para `runId` no topo, mas `orchestration.rs:90` lê `payload.args.run_id`. Com um run anterior na pasta, o comando pode mostrar o run errado (não reproduzido).
   - `--cwd .` (relativo) também não resolve; só o absoluto funciona. Sem `--cwd` não infere a pasta.
2. **Decisões > Discordâncias não mostra qual provedor discordou** (`DecisionsSection.tsx:500-504`, `decisions/log.rs:289-310`).
   - A key do `<li>` (`point-stateHash-heuristic-providerDecision`) fica duplicada quando Jev e Laya divergem igual: aviso "same key" do React e linhas idênticas.
   - Repro: dois provedores ligados, os dois divergindo igual da heurística, Atualizar relatório. Não reproduzido na UI (só código).
   - Sugestão: incluir `provider` na linha e na key.

### Baixa
3. **Espanhol no CLI.** `ags --help` ("controla la app ADE AGS desde la terminal", "USO", "VENTANAS", "FLOTA", "MEMORIA COMPARTIDA") e mensagens:
   - `peer tell --file` inexistente: "No se pudo leer …"
   - run inexistente: "no hay ningún run <id>"
   - Em inglês: "memory path is unavailable in this scope" (`ags memory open` inexistente) e "Shared Memory MCP tools require a Lead or Worker Task" (`ags memory get`).
   - Corretas em português: missão/aba inexistente, args faltando, suíte desconhecida.
4. **Texto cortado (`truncate`) sem `title`**:
   - `SettingsSection.tsx:66` (dica de toda linha de Ajustes)
   - `MissionsPage.tsx:715,725,911` e `MissionDialog.tsx:300` (agente · modelo · conta)
   - `MissionTimingsPanel.tsx:70`
   - `runs/AgentCard.tsx:121` (título da tarefa na Frota)
   - `MissionOverview.tsx:179-180`
5. **Dois botões "Apagar a chave do cofre" idênticos** (`DecisionsSection.tsx:103-106`) quando as duas chaves estão salvas. Têm texto, mas nada indica qual provedor. Rotular com o provedor.
6. **Codepage:** respostas em espanhol com `ú` saem ilegíveis ("ningn") em consoles Windows sem `chcp 65001` (relatado pelo QA, não reconferido).

### Info
7. A dica `settings.decisions.keyHint` ("Opcional…") aparece também para o Jev, que é remoto, pago e precisa de chave. O rótulo do timeout mostra "(ms)" e há outro "ms" ao lado do campo.

### Descartado após conferência
O Frontend apontou ~40 valores de `es.json` iguais ao pt-BR. Os exemplos que verifiquei ("Detectando agentes…", "Exportar CSV") são espanhol válido, então não os listo como bug. Não conferi o restante da lista.

## 2. Limpo
- i18n: pt-BR, es e en com as mesmas 2846 chaves e os mesmos placeholders. Nenhuma chave crua e nenhum espanhol visível no pt-BR nas telas revisadas.
- 0 `<button>` sem rótulo acessível.
- `ags test smoke`: 9/9 passou, rodado no terminal do QA.
- `peer tell --file`: o arquivo com BOM (`Set-Content -Encoding utf8`) e o em UTF-16 (`Out-File`) chegaram íntegros, com "ação, configuração, memória, revisão, coração". Conferido pelo QA no decodificador `cli.rs:898-913`; o teste unitário de BOM passou.

## 3. Suítes e cache (Backend; rodadas em paralelo, não é benchmark isolado)
| suíte | resultado | tempo | base | dif. |
|---|---|---|---|---|
| rust | 1422 ok (1381 lib + 41 bin) | 132,8 s | ~135 s | −1,7% |
| frontend | 1675 ok (200 arquivos) | 16,3 s | 18 s | −9% |
| tsc | ok | 18,1 s | 23 s | −21% |

- A segunda execução das três voltou `cacheHit:true`, "já verde neste hash".
- `ags test affected` não encontrou mudanças ("Nada a testar"), então não exercitou a seleção de arquivos.

## 4. Jev x Laya (`decision_shadow_log`)
**O log só tem histórico anterior (27 linhas); a v9 não gerou amostra nova.** As propostas do QA ficaram pendentes porque `ags memory suggest` não dispara a consulta. `decision_human_log`: 0 linhas. Por isso não há "Contra a sua decisão".

Latências em ms; a média inclui erros; p95 por nearest-rank.
| provider | ponto | linhas | média | mediana | p95 | >2000 ms | erros |
|---|---|---|---|---|---|---|---|
| jev | memory_approval | 3 | 522,3 | 544 | 566 | 0 | 0 |
| laya_local | memory_approval | 20 | 849,0 | 554 | 2006 | 2 | 2 |
| laya_local | mission_gate | 4 | 463 | 414,5 | 633 | 0 | 0 |
| jev, laya_local | fleet_gate, dream_triage | 0 | n/a | n/a | n/a | 0 | 0 |
| jev | mission_gate | 0 | n/a | n/a | n/a | 0 | 0 |

- **Erros:** os dois da Laya têm texto exato `timeout` (id16 com 2013 ms, id18 com 2006 ms). Jev: 0 timeouts em 3. Nenhum 4xx, 401 ou malformado em nenhum dos dois.
- **Falso positivo de `segredo=sim`** (propostas sem credencial): Jev 1 de 3 respostas válidas; Laya 12 de 18 respostas válidas.

Mesmas propostas (`point` + `state_hash`):
| proposta | Jev acao;segredo | Laya acao;segredo | Jev ms | Laya ms |
|---|---|---|---|---|
| v8-espanhol-residual | revisar;não | timeout | 566 | 2006 |
| v8-laya-falsos-positivos-segredo | revisar;sim | aprovar;sim | 457 | 962 |
| v8-vigia-cutuca-quem-entregou | revisar;não | rejeitar;sim | 544 | 1345 |

- 3 hashes pareados, 2 com respostas válidas.
- Concordância em `acao`: 0/2. Em `segredo`: 1/2.
- Latência média nos pares válidos: Jev 500 ms, Laya 1154 ms.
- **Conclusão:** nesta amostra histórica minúscula (3 pares, em horários distintos, sem decisão humana de referência), o Jev foi mais rápido, sem timeout e com menos falso positivo de segredo. **Isso não demonstra vantagem de qualidade decisória.**

## 5. Propostas do QA — ação do usuário
Abra **Sugestões de memória** e aprove ou rejeite cada uma. A sua decisão é a referência de qualidade ("Contra a sua decisão") e alimenta `decision_human_log`.
- **9 pendentes:** `qa-v9-01` a `qa-v9-08` (técnicas, sem credencial) e `qa-v9-12` (ambígua, só um hash sha256).
- **3 bloqueadas pelo validador local, sem ir ao Jev:** `qa-v9-09`, `qa-v9-10`, `qa-v9-11` (segredos falsos óbvios). Erro: "A proposta parece conter uma credencial…". O validador funciona.
- O QA tentou 12 propostas e o Backend não gerou nenhuma, então o teto de 12 foi respeitado.

## 6. Vigia
- **Terminais do QA e do Backend:** 0 cutucadas, 0 útil, 0 ruído, nenhum `[Pasted text #N]` empacado, nenhuma cutucada em quem já tinha entregue.
- **Chat global e botão do olho:** não consegui verificar, porque não tenho acesso às linhas "Vigia" do chat nem à janela.
- **Laço do Codex (`gpt-6.1-sol`, Backend):** ~6m13s, sem travar o app. Não houve tela parada por mais de 8 min, então o aviso de laço não foi exercitado.
- O `start_stalled` do QA no boot foi seguido de `start_activity` e o QA arrancou.

## 7. Tempos da missão (`ags mission timings`)
- Todos trabalhando em 34 s; primeira delegação em 38 s.
- `qaWaitMs` 0; um `peer_ask` do Backend ao QA deu timeout depois de 55 s (QA ocupado).
- Maior tempo: rust, 132,8 s.

## 8. Não verificado
Layout real, tema escuro, foco por teclado e o fluxo de "Contra a sua decisão" com dados reais, tudo isso exige a janela. Squads, Histórico, Canvas e Novo agente tiveram só varredura automática. Terminais em branco, agentes Claude, Codex, Antigravity e Shell: sem anomalia nas 6 abas (`tab list`).
