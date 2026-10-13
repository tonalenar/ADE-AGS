# V14 — Frontend (revisão por código)

**A janela do app NÃO foi aberta.** Tudo abaixo vem de leitura de código (master 7be8cb5). Nenhum código do produto foi alterado.
Nota: `TeamFeed.tsx` e `teamFeedModel.ts` EXISTEM em `src/features/canvas/` (o aviso automático "não existe" do briefing é falso).

## Item 2 — Chat da equipe
| Requisito | Resultado |
|---|---|
| Aba Equipe abre primeiro em missão | FUNCIONA. `ChatPanel.tsx:93` `teamView = missionId !== null && (tabId === null \|\| tabId === TEAM)` |
| `@Nome texto` só ao agente; nome inteiro ou 1ª palavra; `@QA` casa "QA / Tests" | FUNCIONA. `teamFeedModel.ts` `parseMention` (mais longo primeiro, sem diferenciar caixa, exige espaço/fim após o nome) |
| Sem `@` → orquestrador | FUNCIONA (`ChatPanel.tsx:235` `/^orquestrador/i`, senão o 1º agente — ver B4) |
| `@` desconhecido avisa e NÃO envia | FUNCIONA (`ChatPanel.tsx:239`, retorna antes do `chat_send`) |
| `@` no meio do texto | É texto comum (parseMention exige `@` no início) — correto |
| Permissões do run ativo com Permitir/Negar | FUNCIONA (`TeamFeed.tsx` `useMissionApprovals` filtra por `activeRunId`; usa `PermissionCard`) |
| i18n `canvas.team.*` (10 chaves) | FUNCIONA em pt-BR, en e es (`locales/*.json:2420-2429`), chaves idênticas |
| `title` em texto cortado | FUNCIONA no feed (de/para/permissão) e abas (`ChatPanel.tsx:321,331,359`) |
| Rótulo acessível | FUNCIONA: `role=log` + aria-label no feed, abas `role=tab`, botões de @ com `title`; botão `@` com aria-label |
| Atalhos y/n com compositor | OK: `PermissionCard.tsx:104-107` ignora quando o foco está em INPUT/TEXTAREA e com Ctrl/Meta/Alt; o compositor é `<textarea>` |

### Bugs de lógica (todos baixos/médios)
- **B1 (média) duplicatas no feed** — `TeamFeed.tsx` `useTeamMessages`: `pull()` usa `last.current` só ao RESOLVER. O evento `cc-peer-message` (+150 ms) e o intervalo de 5 s podem disparar dois `mission_messages` com o mesmo `afterId` e os dois resultados são anexados (`setMessages(all => [...all, ...fresh])`). Efeito: mensagem repetida e chave React `m<id>` duplicada. Repro: rajada de `ags peer tell` enquanto o IPC está lento. Correção: serializar (flag `inflight`) ou deduplicar por `id`.
- **B2 (baixa) `@Nome` sem texto** — `parseMention` devolve `null` quando o texto é vazio, e `sendTeam` mostra "Não achei esse agente" (mensagem enganosa; o agente existe). `ChatPanel.tsx:239`. Repro: digitar `@Backend` e Enter.
- **B3 (baixa) pontuação após o nome** — `@Backend, faça X` / `@QA: ...` falha (próximo caractere precisa ser espaço) → "agente não achado". Repro: `@Backend, rode os testes`.
- **B4 (baixa) fallback silencioso** — sem agente "Orquestrador" aberto (ex.: aba fechada), a mensagem sem `@` vai ao 1º agente (`addressees[0]`) sem avisar. Mensagem ao agente errado.
- **B5 (baixa) nomes repetidos** — dois agentes com a mesma 1ª palavra (ex.: "Claude A"/"Claude B") ou mesmo nome: `@Claude` vai ao primeiro, sem ambiguidade avisada (empate no sort).
- **B6 (baixa) atalhos y/n duplos** — `focused` vale por lista; se o feed da equipe e a página de Missões/frota (`MissionsPage.tsx:893`, `AgentCard.tsx:187`) estiverem montados ao mesmo tempo, dois cartões `focused` escutam `y`/`n` na janela e o mesmo atalho decide os dois. Não verificado em execução.
- **B7 (info)** — o feed não limita o tamanho (backend limita a 2000/missão); `notes` (o que você enviou) só existem na sessão da tela e somem ao trocar de missão/recarregar, e `chat_send` bem-sucedido não confirma entrega ao agente.

## Item 5(a) — `truncate` sem `title` em Workspaces: **FALHA (NÃO corrigido)**
Os quatro continuam sem `title`:
- `WorkspacesPanel.tsx:144` (`<span className="truncate font-mono …">` branch/worktree)
- `DeletedWorkspacesList.tsx:64` (`{w.name}`)
- `WorkspaceList.tsx:62` (resumo janelas/abas)
- `WorkspacesPage.tsx:140` (idem)

## Missões, Frota, Canvas, Novo agente
- **i18n cru:** nenhuma. As chaves `t("…")` "ausentes" na varredura (`canvas.links`, `canvas.usage.days`, `fleet.toast.openMore`, `missions.conflicts.blocks`, `missions.waitingNotice`) existem como `_one/_other` (plural). en e es têm todas as chaves do pt-BR (0 faltando).
- **Espanhol visível:** nenhum texto em português dentro de es.json nas seções canvas/missions/fleet/squads (varredura por ção/ão/não/você). Valores iguais ao pt-BR são legítimos nos dois idiomas ("Modelo específico", "Maximizar…", "Mostrar todas"). Dentro de código ainda há comentários e `aria`/mensagens em espanhol, p.ex. `PermissionCard.tsx` (comentários) — só internos.
- **`truncate` sem `title` (baixa)**, conferido nas ~5 linhas ao redor:
  - `runs/AgentCard.tsx:125` linha de branch (só o cwd interno tem `title`; a branch cortada não)
  - `canvas/FloorBar.tsx:132` pílulas de andar (`max-w-40 truncate`) — verificar se o botão tem `title`
  - `canvas/ResponsePicker.tsx:59` `<p truncate>{o.label}</p>` sem `title` (o botão tem aria-label)
  - os demais (FleetView, MissionChips, MissionMap, MissionsSection, CanvasView, DetectedAgents, MissionsPage:582) têm `title` por perto.
- **Botões sem rótulo acessível:** varredura por regex de `<button>` só com ícone em missions/runs/canvas/agents não achou nenhum sem `aria-label`/`title` (heurística; não substitui teste com leitor de tela).
