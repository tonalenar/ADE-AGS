# V13 — Frontend (so por codigo)

Janela do app NAO foi aberta. Tudo abaixo vem de leitura de codigo em `src/` (master 593fbac, 1.8.7). Nenhum codigo do produto foi alterado. Nao rodei suites (nao houve mudanca de codigo).

## Item 2 — restos da v12

| Arquivo | Status | Evidencia |
|---|---|---|
| `src/shared/ui/PageHeader.tsx` | CORRIGIDO | `:25` `<h2 ... truncate ... title={title}>`; `:27` subtitulo com `title={subtitle}` |
| `src/shared/ui/AppDialog.tsx` | CORRIGIDO | `:35-36` `<h2 ... truncate ... title={title}>`; botao fechar `:43-44` `title`+`aria-label={t("btn.close")}`; `:101` `aria-label={title}` no Modal |
| `src/app/SideHead.tsx` | CORRIGIDO | `:95-98` botao do menu (Logo) com `aria-label` e `title={t("sidebar.workspaceMenu")}`; botao do painel `:134` com `aria-label` + Tooltip |
| `src/features/prelaunch/PrelaunchSection.tsx` | CORRIGIDO | `:61-62` botao de criar (so icone) com `aria-label`/`title={t("btn.add")}`; editar/excluir `:137,:147` com `aria-label`. No modo edicao o botao tem texto "Salvar" (sem label extra, ok). |

### `truncate` sem `title` que sobraram (heuristica por arquivo; confirmado lendo o trecho)
- **Status bar** (`src/app/StatusBar.tsx:109`): OK — o `<Button>` pai tem `title` (`:101`).
- **Command palette** (`src/features/palette/CommandPalette.tsx:316,321`): OK — ambos com `title`.
- **Home** (`HomeCards.tsx:57,58`): OK, com `title`. `HomePage.tsx` sem `truncate`.
- **Workspaces — AINDA FALHA (3):**
  1. `src/features/workspaces/WorkspacesPanel.tsx:144` — nome da branch (`font-mono`, `truncate`) sem `title` (o `title` do `:109` e do botao do cabecalho, nao cobre esta linha). Branches longas (ex.: `cc/mission-<uuid>`) ficam cortadas sem tooltip.
  2. `src/features/workspaces/DeletedWorkspacesList.tsx:64` — nome do workspace excluido com `truncate` e sem `title`.
  3. `src/features/workspaces/WorkspaceList.tsx:62` e `WorkspacesPage.tsx:140` — linha de resumo (janelas/abas/ultimo uso) com `truncate` sem `title` (baixa gravidade: texto curto).
  - OK: `WorkspacesPanel.tsx:50` e `:92` (botao pai com `title`), `WorkspaceList.tsx:61`/`WorkspacesPage.tsx:139` (nome com `title`).

## Item 2b — outras telas

### Texto cortado sem tooltip (candidatos; pai NAO verificado salvo onde indicado)
- Missoes: `missions/MissionsPage.tsx:582` (branch), `MissionMap.tsx:249,252,253` (titulo/papel/agente do no). `MissionsSection.tsx:149`, `MissionChips.tsx:70` e `FleetView.tsx:73` OK (pai com `title`).
- Frota: `runs/AgentCard.tsx:125`, `FleetView.tsx:89` (estado da tarefa).
- Canvas: `canvas/CanvasView.tsx:746,751`, `ChatPanel.tsx:320` (agentLabel), `FloorBar.tsx:132` (aba `max-w-40`, sem title nas linhas vizinhas), `DesignPanel.tsx:258`, `ResponsePicker.tsx:59`.
- Novo agente: `tabs/wizard/AgentPickerStep.tsx:69`, `NewAgentDialog.tsx:163`.
- Abas: `tabs/TabItem.tsx:109` (titulo da aba; nao achei `title` no trecho — confirmar se ha Tooltip externo).
- Outros fora do escopo pedido (Contas/forge/marketplace): ~50 ocorrencias; lista completa gerada por script (`truncate` sem `title`/`aria-label` no mesmo elemento): accounts/*, marketplace/*, scm/*, search/*, editor/DiffTab, browser/*.
- Severidade geral: baixa/media (so afeta nomes longos). Ressalva: heuristica pode dar falso positivo quando um ancestral tem `title`; os itens "AINDA FALHA" de Workspaces foram lidos manualmente.

### Botoes sem rotulo acessivel
Varri todo `<Button variant="icon">` de missions/squads/settings/sessions/canvas/tabs/runs/app: todos tem `aria-label` ou `title`. Nenhum achado.

### Chaves i18n cruas
Extrai todas as chamadas `t("...")` literais de `src/` e comparei com `en.json`, `es.json` e `pt-BR.json` (2850 chaves cada, paridade total). Chaves ausentes: 0 (as 34 aparentes eram plurais `_one/_other` ou prefixos dinamicos). Nenhum achado.

### Espanhol / ingles visivel
- Strings de UI em `pt-BR.json`: sem espanhol (as palavras "Cancelar", "Abrir", "Guardar", "Buscar" sao portugues valido).
- Achado MENOR (consistencia): `pt-BR.json` mistura "Guardar" (`sharedMemory.saveAnyway`, `fleet.rollback.create`) com "Salvar" no resto; e mantem termos em ingles "Mission/Fleet/Missions" em `accounts.antigravity.scope:5` e `accounts.antigravity.oauth.access:2093`, e "Mission"/"Missions" em varias strings ("Missions" nao e traduzido). 
- Concordancia de genero: `workspace.resetDefault.body:42` "fechá-los e descartá-los" (guias → "fechá-las"), `explorer.delete.bodyFolder:1049` "restaurá-los" (pasta+conteudo), `editor.preview.remoteImages:1128` "Eles não carregam" (imagens → "Elas"). Cosmetico.
- Hardcoded em TSX: so comentarios em espanhol (nao visiveis). `placeholder`/`title` literais sao exemplos tecnicos (URLs, `Enter`, `IndexedDB`, `Cache Storage`, `Service workers`) — `browser/debug/StorageView.tsx:166-172` ficam em ingles sem i18n (menor).
- Textos em espanhol dentro de componentes (comentarios) nao contam.

## Resumo
- Item 2: 4/4 CORRIGIDO. Resto AINDA FALHA em Workspaces (branch no painel `:144`, lista de excluidos `:64`, resumos).
- Nenhum botao sem rotulo, nenhuma chave i18n crua, nenhum espanhol visivel nas telas revisadas.
- Vigia: nao observei mensagens do Vigia no meu terminal nesta sessao alem do lembrete "usuario nao ouviu de voce" (ruido, 2x: ~apos Read/Bash longos); nenhum "[Pasted text #N]" empacado; nenhuma cutucada apos entrega (ainda nao entreguei).
- Branch unica: nao criei branch, nao dei push, nao abri PR. Briefing recebido continha o bloco "BRANCH UNICA" (2x: no briefing inicial e na delegacao).
