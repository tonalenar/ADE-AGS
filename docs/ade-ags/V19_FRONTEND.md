# V19 — Frontend (revisão por código)

A janela do app NÃO foi aberta. Tudo abaixo vem de leitura de código, de i18n por script e de um script de probe das funções puras de `teamFeedModel.ts`. Nenhum código do produto foi alterado.

Os arquivos existem (o precheck errou): `src/features/canvas/{TeamFeed,ChatPanel}.tsx`, `src/features/canvas/teamFeedModel.ts`, `src/features/memory/{MemoryInbox.tsx,bulkReview.ts}`.

## Item 2 — Chat da equipe

| Ponto | Resultado |
|---|---|
| Filtros na barra fixa, fora da lista que rola | FUNCIONA. `TeamFilterBar` entra pelo slot `toolbar` do `ChatPanel` (linha 414). `TeamFeed` só tem o `role="log"`. |
| 1ª linha de mensagem longa em negrito | FUNCIONA para texto simples. FALHA quando a 1ª linha é um caminho (F1). |
| Caminhos, branches e arquivos em fonte de código, sem quebrar o que já era código | FALHA PARCIAL. Branch e arquivo relativo saem corretos e `` `src/a.ts` `` não é duplicado. Caminho `C:\` ou `~/` no título e links/URLs saem quebrados (F1, F2). |
| `VigiaCard` com gravidade, o que viu e o que fez | FUNCIONA para "travado" e "aviso". Há falhas nos rótulos com espaço ou sem rótulo (F3, F4). |
| `@Nome texto` envia só àquele agente | FUNCIONA. `resolveMention` + `chat_send` para o `tabId` do agente. Probe: `@QA oi` → QA / Tests, `@Backend: oi` → ok, `@Backend\noi` → ok. Sem `@`, vai ao Orquestrador. Sem Orquestrador aberto, avisa e não adivinha. |
| Textos cortados com `title` | FUNCIONA no chat: nomes, destinatário, chips, aba. Veja F8 para as outras telas. |
| Chaves `canvas.team.*` em pt-BR, en e es | FUNCIONA. 24 chaves, nenhuma faltando em nenhum idioma. Os três arquivos têm 2875 chaves cada. |

### Achados (gravidade, passos, saída)

**F1 (média) — Título em negrito + caminho absoluto quebra o negrito.**
- Passos: chamar `formatMessageText("C:\\Users\\a\\x.md\nlinha dois")`.
- Saída: `**`C:\Users\a\x.md**`\n\nlinha dois`. O mesmo ocorre com `~/docs/a.md`.
- Causa: `emphasizeTitle` põe `**…**` antes de `codeAddresses`. A regex de `C:\…` e `~/…` (`[^\s`,;)"']+`) engole o `**` final.
- Efeito: a crase abre antes do `**` de fechamento, então o negrito não fecha. Aparecem asteriscos soltos e o título não fica em negrito.
- Correção sugerida: excluir `*` da classe de caracteres do caminho, ou aplicar o código antes do negrito.

**F2 (média) — Links e URLs são mutilados por `codeAddresses`.**
- Passos: `formatMessageText("Ver [guia](docs/ade-ags/V19.md) e https://github.com/a/b/blob/x/README.md\nfim")`.
- Saída: `**Ver [guia](`docs/ade-ags/V19.md`) e http`s://github.com/a/b/blob/x/README.md**`.
- Efeito: o destino do link markdown vira código e o link quebra. A URL é cortada em `http` + `` `s://…` ``.
- O `\b(?:[\w.-]+\/)+…\.md` casa dentro da URL.
- Correção sugerida: não tocar em `://`, nem em `](...)`.

**F3 (baixa) — O rótulo do Vigia casa com o nome do agente.**
- Passos: `parseVigiaText("**Vigia** — Backend: não mostrou atividade. Feito: avisei.")`.
- Saída: `{tone:"info", label:"backend", body:"não mostrou atividade.", …}`.
- Efeito: o nome do agente some do corpo e vira "rótulo". O card mostra o pill genérico "Info" e perde quem parou.
- A regex `^([A-Za-zÀ-ÿ]{3,14}):` aceita qualquer palavra.
- Correção sugerida: aceitar só `travado|aviso|atenção|possível laço|…`.

**F4 (baixa) — Rótulos com espaço não viram gravidade.**
- Rótulos de dois termos: `"possível laço"` (`vigia.ts:260`) e `"equipe entregou"` (`doneLine`).
- Saída: `label:null`, tom `info`, sem pill. O aviso de laço, que é um alerta, aparece neutro e o prefixo fica no corpo.
- A regex `[A-Za-zÀ-ÿ]{3,14}` não aceita espaço.
- `doneLine` não tem "Feito:", então esse card não mostra "o que fez" (aceitável: é só informativo).

**F5 (baixa) — Falha do modelo do Vigia aparece como "Travado" (vermelho).**
- `vigia.ts:385` chama `reportLine("o modelo do Vigia não respondeu (…)", "nada; …")` sem o 3º argumento, então o rótulo padrão é `"travado"`.
- Efeito: o card sai com tom `stuck` (vermelho), "Travado", sobre uma falha do próprio Vigia e não de um integrante.
- Isso também polui a leitura do item 1 (avisos "travado" que não são de ninguém).
- Correção sugerida: passar `"aviso"` ou `"info"`.

**F6 (baixa) — O filtro de agente sobrevive à troca de missão.**
- `useTeamFeed` guarda `filter` em `useState` dentro do `ChatPanel`, e nada o zera quando `missionId` muda (só `notes` é zerado, na linha 98).
- Passos: filtrar `agent:Backend` na missão A e trocar para a missão B, que não tem esse nome.
- Efeito: lista vazia. Se B tiver ≤1 nome e nenhum pedido, `TeamFilterBar` retorna `null` e não há chip "Tudo" para sair. Só o `active` de "approvals" é revalidado.
- Correção sugerida: validar `agent:` contra `options.names`, igual ao que já se faz com "approvals".

**F7 (baixa, acessibilidade) — Menções e feed.**
- Prefixo parcial não resolve: `@back oi` → `unknown`, porque exige o nome ou a 1ª palavra inteira. O chip sugere, mas o envio direto falha com o aviso.
- `@Backend-x` também retorna `unknown`.
- `TeamFeed` rola ao fim a cada mudança de `items.length`, inclusive ao trocar de filtro. Não há pausa se a pessoa subiu para ler.
- `VigiaCard` não tem `role`/`aria-label` de gravidade. Fora do pill (que só existe com rótulo), a cor da borda é o único sinal.
- A lista tem `role="log"` com `aria-label`, o que é bom.

## Item 7 — Memória (`MemoryInbox.tsx`, `bulkReview.ts`)

| Ponto | Resultado |
|---|---|
| Enter no diálogo de lote só confirma com foco no botão | FUNCIONA. `inboxKeyAction` só trata Escape e o `onKeyDown` do diálogo ignora Enter. A confirmação é um `<button autoFocus>` e Enter vira clique nativo. Enter em "Cancelar" cancela. |
| Cada proposta mostra missão, autor, tipo e prioridade | FUNCIONA, com ressalva (M2). A linha `memoryInbox.origin` usa `g.title`, `evidence.actorKind`, `kind` e `priority`, com `title` para o texto cortado. |
| Aviso de prioridade alta | FUNCIONA. `asksHighPriority` (ator ≠ user e prioridade ≥ 3, que é o `MAX_AGENT_PRIORITY` do backend). O pill é "⚠ pede prioridade alta (N)", com `role="note"`, borda âmbar e a dica "isso não a torna mais confiável". As três línguas têm as chaves. |

**M1 (baixa, acessibilidade) — Foco não volta depois da confirmação.**
- O foco inicial vai ao root (`useEffect` único no mount). Ao abrir a confirmação, `autoFocus` leva o foco ao botão.
- Ao cancelar (Escape ou "Cancelar"), o botão desmonta e o foco cai no `body`. A partir daí o Esc não chega ao `onKeyDown` do diálogo, então o diálogo principal não fecha por teclado até clicar nele de novo.
- Não há armadilha de foco (`aria-modal="true"`, mas Tab sai para trás do modal) e os botões de fundo continuam focáveis com a confirmação aberta.

**M2 (baixa) — "Autor" é só o tipo de ator.**
- Mostra `actorKind` (usuário/agente/…), não o nome do agente. Se o requisito era "qual agente propôs", isso não atende.
- "Rejeitar tudo/selecionados" age num clique, sem confirmação.

## Missões, Frota, Canvas, Novo agente

- **Chaves i18n cruas:** nenhuma. Script: todo `t("literal")` nos módulos missions, fleet, runs, canvas, agents e memory existe no pt-BR.
- **Espanhol visível:** não vi texto em espanhol fora dos comentários. Há comentários em espanhol no `ChatPanel` (só código). O `ChatPanel.tsx:25-76` e outros trechos têm doc em espanhol, o que não é UI.
- **Botões só com ícone:** os que revisei (`ChatPanel` anexar, @, novo agente, "mais", threads) têm `aria-label` e `title`.
- **F8 (baixa) — texto cortado (`truncate`) sem tooltip dedicado:**
  - `FleetView.tsx:73`: o título da missão no card da frota é cortado e o botão pai tem só o `title` genérico `missions.fleet.open`, não o nome.
  - `MissionChips.tsx:70`: `max-w-40 truncate` com `title={m.objective}`, o objetivo e não o título.
  - `MissionsSection.tsx:149`: idem, `title={m.objective}`.
  - `MissionMap.tsx:252-253`: papel/agente e a 3ª linha cortados sem `title`.
  - `CanvasView.tsx:751`: a cauda do título da aba (`slice(1)`) cortada sem `title`.
  - `FloorBar.tsx:132`: pills de pasta com `max-w-40 truncate`; só o botão "+" tem `title`.
  - `AgentCard.tsx:173`: linhas de saída cortadas sem `title`.
- Não revisei a tela de Novo agente em profundidade (tempo); a varredura de chaves e de ícones sem rótulo cobriu `features/agents` e não achou nada.

## Testes

Nada executado: nenhum arquivo do produto foi alterado, só este relatório. O probe usou `node --experimental-strip-types` sobre `teamFeedModel.ts`, que é puro. Nenhum teste existente foi rodado nesta rodada.
