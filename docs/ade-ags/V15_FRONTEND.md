# V15 — Frontend (retestes por código)

**Janela do app NÃO aberta.** Só leitura de código; árvore = master 7be8cb5 + docs (nada do produto mudou desde a v14). Nenhum código do produto alterado.

## (1) useTeamMessages — pull() concorrente: **FALHA (continua)**
`src/features/canvas/TeamFeed.tsx:21-40`. `pull()` lê `last.current` ao DISPARAR (`afterId: last.current`) e só o atualiza ao RESOLVER (`last.current = fresh[fresh.length-1].id`, depois `setMessages(all => [...all, ...fresh])`). Nada impede duas chamadas em voo.
Repro: abrir o chat da missão; mandar 2+ `ags peer tell` seguidos (cada um emite `cc-peer-message` → `setTimeout(pull,150)`), com o poll de 5 s coincidindo ou o IPC lento (>150 ms): as duas chamadas saem com o mesmo `afterId`, ambas resolvem com as mesmas linhas e as duas são anexadas → mensagem repetida e chave React `m<id>` duplicada (`buildFeed`).
**Desenho do conserto (não implementado):** (a) serializar: ref `inflight`; se `pull` for chamado em voo, marcar `again=true` e rodar de novo ao terminar; (b) defesa extra: no `setMessages`, descartar `fresh` com `id <= last.current` ou deduplicar por `id`; (c) atualizar `last.current` só com o maior id realmente aplicado. Teste: dois `pull()` simultâneos com `invoke` mockado devolvendo as mesmas linhas → 1 cópia (`teamFeedModel.test.ts` não cobre o hook).

## (2) ChatPanel.tsx:235-239 — `sendTeam`: **FALHA (todos continuam)**
- `@Backend` sem texto: `parseMention` (`teamFeedModel.ts`, `return text ? {…} : null`) devolve `null`; a linha 239 mostra `canvas.team.unknownMention` ("Não achei esse agente…") — mensagem errada, o agente existe. Repro: digitar `@Backend` + Enter. Conserto: distinguir "menção válida sem texto" (não enviar, avisar "escreva a mensagem") de "menção desconhecida".
- `@Backend, x` / `@QA: x`: o caractere após o nome precisa casar `\s` (`if (next !== "" && !/\s/.test(next)) continue`) → `,`/`:` falha → "agente não achado", nada é enviado. Conserto: aceitar `[\s,:;]` como terminador e tirar a pontuação do texto.
- Sem Orquestrador aberto (linha 235): `addressees.find(/^orquestrador/i) ?? addressees[0]` → a mensagem sem `@` vai ao 1º agente da lista sem aviso (o cartão "Você → Nome" só aparece depois do envio). Conserto: sem orquestrador, exigir `@` ou confirmar o destinatário.
- Mesma 1ª palavra ("Claude A"/"Claude B"): o sort por tamanho do rótulo empata e mantém a ordem do time → `@Claude` vai ao 1º, sem aviso de ambiguidade. `@Claude A texto` funciona (nome inteiro, mais longo). Nomes IGUAIS não se distinguem nem pelo nome inteiro. Conserto: se mais de um agente casar o mesmo rótulo, avisar (ambíguo) ou usar `suggestMentions`.
- As sugestões (`ChatPanel.tsx:357-362`) inserem `@<nome inteiro> ` e funcionam (`@QA / Tests texto`).

## (3) y/n com feed e Missões/frota montados juntos (B6): **CONFIRMADO por código — FALHA**
- `EditorArea` (logo `CanvasView`/`ChatPanel`) fica SEMPRE montado; fora de `/workspace` só recebe `visibility:hidden` (`app/AppShell.tsx:267-279`). `/missions` e `/fleet` renderizam por cima (`AppShell.tsx:286-288`). Com o chat aberto na aba Equipe e pedido pendente, o `TeamFeed` (invisível, mas montado) mantém um `PermissionCard focused` com `window.addEventListener("keydown")` (`runs/PermissionCard.tsx:100-117`).
- Ao mesmo tempo `MissionsPage.tsx:489,803` (`focused = approval.id === approvals[0].id`) ou `FleetPage.tsx:154,271` (`focusedId`) montam outro `PermissionCard focused`. São dois ouvintes na `window`; `preventDefault()` não impede o segundo. Um único `y` roda `decide(true)` nos dois.
- Efeitos: (i) mesmo pedido: `decideApproval` roda 2× (`runs/store.ts:135-140`); o 2º `ipc.decideApproval` provavelmente erra, e no TeamFeed é `void decide(...)` (rejeição sem tratamento); (ii) pedidos DIFERENTES: o feed usa o 1º por `askedAt` (`buildFeed` ordena por tempo) e Missões usa `approvals[0]` na ordem do store → podem divergir, e um `y` aprova DOIS pedidos distintos, um deles oculto. Risco real de aprovação indevida.
- Repro (não executado, janela fechada): missão com run ativo, chat aberto em Equipe; gerar 2 permissões; ir a `/missions` ou `/fleet`; teclar `y` com o foco fora de textarea.
- Conserto: só o cartão VISÍVEL escuta (checar `document.hidden`/visibilidade do ancestral, ou um "dono do teclado" único numa store), ou não montar o painel quando `visibility:hidden`.

## (4) `truncate` extras
- `runs/AgentCard.tsx:125`: **FALHA parcial**. O `<span truncate>` não tem `title`; só o `<span>` interno da branch tem `title={task.cwd}` (mostra o caminho, não a branch) e o caso sem branch (`task.cwd`, linha 133) fica sem `title`.
- `canvas/ResponsePicker.tsx:59`: **FALHA**. `<p className="truncate …">{o.label}</p>` sem `title`.
- `canvas/FloorBar.tsx:132`: **FUNCIONA / falso alarme**. É a classe `pill`; os botões que a usam têm `title` (`FloorBar.tsx:143,149,181`).

## Vigia: botão do olho e `vigiaSwitch.ts`
- Botão: `canvas/CanvasDock.tsx:186` `<Pill label={t(vigiaOn ? "canvas.vigia.on" : "canvas.vigia.off")} active={vigiaOn}>`; `Pill` (`CanvasDock.tsx:70-82`) dá `title`, `aria-label` e `aria-pressed={active}`. **FUNCIONA**: rótulo acessível, tooltip e estado ligado/desligado (estilo ativo + `aria-pressed`). Textos em pt-BR/en/es (`locales/*.json:2416-2417`).
- Observação (baixa): rótulo e `aria-pressed` dizem o estado duas vezes; um rótulo que muda com o estado junto de `aria-pressed` é desencorajado. Sem impacto funcional.
- `vigiaSwitch.ts`: **FUNCIONA**. Começa DESLIGADO (`read()` só liga com `"1"`), persiste em `localStorage` `ags.vigia.enabled` com try/catch (sem armazenamento vale só na sessão), `toggle`/`setEnabled` ok, coberto por `tests/vigiaSwitch.test.ts`. Limite: o estado é por origem e não há indicação do Vigia dentro do chat da equipe.
