# Relatório de teste v13 — ADE AGS 1.8.7 (master 593fbac)

Missão: "Teste completo v13 (branch única, squad E2E)" (b29ced88). Só teste e relatório: nenhum código do produto foi alterado. Relatórios por papel: `V13_BACKEND.md`, `V13_FRONTEND.md`, `V13_QA.md` (nesta mesma branch, com as saídas exatas).

## 1. Fluxo de branch única — CORRIGIDO (com ressalvas)
- Branches da missão: 4 (Orquestrador e5876116, Backend 533333f7, Frontend 5c447586, QA 828c1164), todas provisionadas pelo app. Nenhum integrante criou branch extra.
- PRs da missão antes desta consolidação: 0. `gh pr list --head 'cc/*' --state open` → saída vazia (rc=0). Este é o PR único da missão (base `dev`, sem merge).
- Push/PR por integrante: nenhum declarado nos três relatórios; o Orquestrador não auditou o reflog remoto de cada um além do `gh pr list` vazio.
- Briefing com o bloco "BRANCH ÚNICA": Orquestrador sim (briefing original). Os três integrantes receberam o bloco `BRANCH UNICA` no arquivo de delegação enviado por `ags peer tell --file`; Frontend e Backend confirmam ter recebido.
- Integração: `git merge` das três branches na do Orquestrador (QA 11db0af2, Frontend b01ff778, Backend c37e89d7), sem conflitos. Descumprimentos: nenhum.
- `ags mission timings`: atividade 543 s; primeira delegação 47,2 s; todos trabalhando em 42,3 s; espera do Orquestrador 0. Houve `start_retry`/`start_stalled` do QA (~30 s após o briefing) e o aviso "[AGS] QA / Tests não mostrou atividade"; o QA estava processando (falso alarme, ver P3-3).

## 2. Restos da v12 (por código; janela do app NÃO aberta)
| Item | Status | Evidência |
|---|---|---|
| PageHeader.tsx | CORRIGIDO | `src/shared/ui/PageHeader.tsx:25,27` `title` |
| AppDialog.tsx | CORRIGIDO | `src/shared/ui/AppDialog.tsx:35-36` título com `title`; botão fechar com `aria-label` |
| SideHead.tsx | CORRIGIDO | `src/app/SideHead.tsx:95-98` `aria-label` + `title` |
| PrelaunchSection.tsx | CORRIGIDO | `src/features/prelaunch/PrelaunchSection.tsx:61-62` `aria-label`/`title` |

`truncate` sem `title` que AINDA FALHAM (Workspaces; conferidos pelo Orquestrador lendo o código):
- `src/features/workspaces/WorkspacesPanel.tsx:144` (nome da branch, mono)
- `src/features/workspaces/DeletedWorkspacesList.tsx:64` (nome do workspace excluído)
- `src/features/workspaces/WorkspaceList.tsx:62` e `WorkspacesPage.tsx:140` (resumo janelas/abas; o nome logo acima já tem `title`)
Home, Command palette e Status bar: OK. Candidatos nas demais telas (pai não verificado): Missões `MissionsPage.tsx:582`, `MissionMap.tsx:249-253`; Frota `AgentCard.tsx:125`, `FleetView.tsx:89`; Canvas `CanvasView.tsx:746,751`, `ChatPanel.tsx:320`, `FloorBar.tsx:132`, `DesignPanel.tsx:258`, `ResponsePicker.tsx:59`; Novo agente `AgentPickerStep.tsx:69`, `NewAgentDialog.tsx:163`; abas `TabItem.tsx:109`. Botões de ícone sem rótulo: 0. Chaves i18n ausentes: 0 (2850 em en/es/pt-BR). Espanhol visível: nenhum (só comentários).

## 3. Idioma
- CORRIGIDO: `ags --help` sem "UNTRUSTED DATA" (agora "DADOS NÃO CONFIÁVEIS") e "os custom" virou "inclui os personalizados" (grep sem ocorrências); rótulo `branch:` → `ramo:` em `run result`; erros de recurso inexistente em português (`ags run status --run-id zzz` → `{"error":"não há nenhum run zzz"}`; `--run-id` sem valor → `--run-id precisa de um valor`).
- Nenhuma frase em espanhol encontrada no CLI. Resta vocabulário em inglês técnico (baixa): "Tabs abertas agora", "modo Fast", "modo push", "headless", "worktree", "Run" no cabeçalho de `run status`, "worktree descartado" em `run result`. Menores em pt-BR da UI: "Guardar" x "Salvar", "Mission(s)" em inglês (`accounts.antigravity.*`), concordância ("fechá-los" para guias).

## 4. Regressão
- `ags test smoke` no terminal do QA: 9/9 (CORRIGIDO).
- `peer tell --file` BOM (EF BB BF) e UTF-16LE: enviados `queued:true,sent:true`; QA confirma integridade (`V13_BOM`/`V13_UTF16` com ação, coração, ç, á, 漢字). A prova de recebimento depende da transcrição do QA (CORRIGIDO).
- `ags run status|result|facts --run-id` inexistente, sem valor e válido: mensagens corretas em português (saídas no apêndice do `V13_BACKEND.md`).
- Suítes (Backend, via `ags test run`): rust 1374+45 ok, 10 ignorados, 127,9 s (linha de base ~135 s); frontend 1702/1702, 22,7 s (18 s); tsc 16,2 s (23 s). `ags test affected`: ok.

## 5. Jev x Laya (sqlite somente leitura, snapshot 17:27 -03:00: 81 shadow, 64 human)
| Provider / ponto | Linhas | Média ms | Mediana | p95 | Timeouts | segredo=sim |
|---|--:|--:|--:|--:|--:|--:|
| jev / memory_approval | 35 | 468,5 | 459 | 544 | 0 | 1 |
| laya_local / memory_approval | 36 | 848,9 | 703,5 | 2006 | 2 (erro "timeout") | 25 |
| jev / mission_gate | 4 | 561,5 | 576 | 618 | 0 | 0 |
| laya_local / mission_gate | 6 | 467,3 | 437 | 633 | 0 | 0 |
dream_triage e fleet_gate: 0 linhas nos dois.
Mesmas propostas (mesmo state_hash): 19 pares memory_approval — Jev 469/457/566 ms (média/mediana/p95) contra Laya 942/778/2006; Jev mais rápido em 19/19; timeouts 0 x 1; segredo=sim 1 x 15. 2 pares mission_gate: sem vantagem do Jev (526 x 476 ms). Decisões humanas associadas: Jev 32 (24 coincidem, 8 revisar, 0 contrárias); Laya 16 (9, 1, 6).
Ressalvas: amostra pequena e histórica, não ensaio controlado da v13; os logs não guardam o texto das propostas, então falsos positivos de `segredo=sim` em propostas sem credencial NÃO são mensuráveis. O Jev foi mais rápido e com menos `segredo=sim`, o que sugere (sem provar) menos falsos positivos. As propostas do QA não geraram consulta (só a revisão pela interface gera). 11 linhas novas do Jev (zero Laya) surgiram durante a missão sem origem atribuível ao QA ou ao Orquestrador (nenhum abriu a interface); origem não identificada.

## 6. Vigia
Backend, Frontend e QA: 0 mensagens úteis do Vigia; Frontend registrou 2 lembretes de ruído ("usuário não ouviu de você"); 0 "[Pasted text #N]" empacado; 0 cutucadas pós-entrega; nenhum Codex em "Working" parado >8 min (laço de raciocínio não observado). Contagem do chat/Orquestrador: sem linhas "Vigia" novas além do aviso de partida do QA (acima).

## 7. Achados por gravidade
Sem P0/P1/P2.
- **P3-1** `truncate` sem `title` em Workspaces (4 locais, seção 2). Repro: ler o código; nomes longos de branch/workspace aparecem cortados sem tooltip.
- **P3-2** `ags peer check` sem argumentos sai com código 1; o help define 2 = uso incorreto. Repro: `ags peer check; echo $?` (achado do QA, não reconferido pelo Orquestrador).
- **P3-3** Falso alarme "[AGS] QA / Tests não mostrou atividade": o QA estava trabalhando (spans `start_retry`/`start_stalled` em ~30 s). Repro: ver `ags mission timings b29ced88-54cd-4867-aa36-904706a87d01`.
- **P3-4** Backend (Codex) iniciou sem `ADE_TAB_ID` no helper e com `helper_unknown_error: setup refresh had errors` no sandbox; contornado via `tab list`. Não verificado nos outros terminais (conhecido: erro de sandbox do Codex no Windows).
- **P4** Vocabulário em inglês no `--help` e textos menores de i18n pt-BR (seção 3).

## 8. Memórias pendentes (decidir em "Sugestões de memória")
`tech.v13.smoke_suite_integrity`, `tech.v13.encoding_bom_le`, `tech.v13.test_caching_behavior`, `tech.v13.ipc_peer_messaging`, `tech.v13.cli_exit_codes`. Todas pendentes; ninguém decidiu nenhuma.
