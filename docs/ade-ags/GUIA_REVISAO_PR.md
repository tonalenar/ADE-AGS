# Guia de revisão de PR por IA

Inspirado no "Review Guide" do T3 Code. Na tela de um PR (Forge → Pull requests → um PR), o painel **Guia de revisão** pede a um agente um roteiro de leitura do PR, com **paradas**. Cada parada é uma área do PR: os arquivos (e linhas), por que importa, o que olhar de perto, um trecho do diff e perguntas em aberto.

**Nada é publicado no GitHub.** O guia só lê o PR (descrição, commit da cabeça, arquivos e diff) pela conta de git do app.

## Como usar

1. Abra um PR no painel Forge. O card **Guia de revisão** aparece acima da descrição.
2. Escolha o agente (ou **Automático**) e a conta, e clique em **Gerar guia de revisão**. Leva de segundos a alguns minutos. Dá para sair da tela: ao voltar, o resultado está lá.
3. Navegue pelas paradas: clique numa delas, use **Anterior/Próxima** ou o teclado (← →, j k) com o foco no guia. A parada vista ganha um ✓; o progresso fica guardado por PR e commit.
4. Clique num arquivo para ver o diff dele ali mesmo, com as linhas da parada destacadas. O ícone ao lado abre o arquivo no site (GitHub: aba de arquivos ancorada no arquivo e nas linhas; GitLab: aba de mudanças).
5. **Perguntar sobre isto** abre o assistente de agente novo na pasta do repo, ou no worktree do PR se ele estiver aberto. O texto com o PR, a parada, os arquivos e o trecho fica **pré-preenchido, sem enviar**: complete a pergunta e envie você.
6. Se o PR recebeu commits depois do guia, aparece **desatualizado**. **Gerar de novo** refaz o guia para o commit atual.

## Desenho

| Parte | Onde | O quê |
|---|---|---|
| Chamada ao modelo | `src-tauri/src/runs/oneshot.rs` | UMA chamada headless, esperada ali mesmo, sempre **somente leitura**. Reusa o `HeadlessAgent` da frota (argv e leitura do stream), a conta pelo ambiente e o sandbox. Sem fila, sem worktree, sem processo vivo depois. |
| Prompt grande | `util::spawn::output_with_input` | O prompt vai pelo stdin (Claude: `claude -p`; Codex: `codex exec -`). Na linha de comando o Windows recusa mais de ~32 mil caracteres. |
| Pedido, validação, cache | `src-tauri/src/forge/guide.rs` | `build_prompt`, `parse_guide`, `repair_prompt`, `save`/`load`. Puro, com testes em `forge/guide_test.rs`. |
| Comandos | `src-tauri/src/forge/guide_commands.rs` | `review_guide_get`, `review_guide_generate`, `forge_pull_files`. |
| Tela | `src/features/forge/ReviewGuidePanel.tsx`, `reviewGuide.ts`, `reviewGuideStore.ts` | Painel, passo a passo, diff, link e texto da pergunta (lógica pura em `reviewGuide.ts`). |
| Rascunho no agente | `tabActions.tsx` (`draft`), `terminalRegistry.ts` (`SendTimings.draft`) | Pega o texto na caixa do agente novo sem o Enter. |

### Quem gera

- Só TUIs que fazem cumprir o somente leitura sem terminal: Claude Code, Codex, Gemini CLI e OpenCode (`READ_ONLY_AGENTS`). Kimi e Antigravity ficam de fora.
- **Automático**: o tramo `standard` do ruteamento; se ele escolher uma TUI que não serve, ou falhar, vale a primeira da lista com sessão.
- Com agente escolhido: o modelo padrão da TUI e a conta escolhida (ou a automática do ruteamento).
- A escolha fica no `localStorage` (`cc-review-guide-agent`).

### O pedido

- Em inglês; o guia volta no idioma da interface.
- Leva título, branches, commit da cabeça, labels, descrição, a lista de arquivos com +/− e o diff.
- Descrição e diff vão entre `UNTRUSTED DATA BEGIN/END`: qualquer um abre um PR.
- Tetos: 120 mil caracteres de diff no total, 12 mil por arquivo, 12 mil de descrição. Lockfiles, `.min.js`, `.map`, `.snap` e `dist/` entram só listados. O que não cabe fica listado com aviso.
- Regras: não modificar, não rodar comandos, não publicar; 3 a 8 paradas (máximo 12) em ordem de leitura; caminhos copiados da lista; `lines` na versão nova.

### O contrato (JSON)

```json
{ "summary": "…", "risk": "low|medium|high",
  "stops": [{ "id": "kebab", "title": "…", "files": [{ "path": "…", "lines": { "start": 1, "end": 9 } }],
              "why": "…", "lookClosely": ["…"], "excerpt": "…", "questions": ["…"] }] }
```

`lines`, `excerpt` e `questions` são opcionais.

### Validação

- **Conserta só a forma**, sem custo:
  - cercas de código ou texto em volta;
  - resposta como string JSON;
  - `risk` em maiúsculas;
  - `lines` como `"L10-L20"`, `"10"`, `10` ou `[10, 20]`;
  - `lookClosely` como string;
  - arquivo como string;
  - caminho sem prefixo, se só um arquivo do PR casa;
  - `id` faltando (sai do título) ou repetido.
- **Recusa o conteúdo**, com a lista de erros:
  - campo obrigatório faltando ou vazio;
  - `risk` fora do enum;
  - caminho que não é do PR;
  - linhas inválidas;
  - zero ou mais de 12 paradas.
- Recusou: **uma** segunda tentativa, com o pedido, a resposta anterior e os erros. Recusou de novo: a tela mostra os erros e a resposta crua. Nada vai para o cache.

### Cache

- Arquivos em `<app_data>/review-guides/<host>/<owner__repo>/<número>/<sha>.json`. Respeita `ADE_AGS_DATA_DIR` (`util::datadir::app_data_dir`). Sem migração de banco.
- Abrir o PR lê o commit da cabeça atual. Há guia desse commit: mostra. Não há: mostra o mais novo, marcado **desatualizado**. Sem rede, mostra o mais novo sem marcar.
- Guarda os 5 commits mais novos por PR. Um arquivo de outra versão do formato, ou corrompido, é ignorado.
- Um segundo pedido do mesmo PR enquanto o primeiro corre é recusado, no backend e na tela.

## Testes

| Suíte | Cobre |
|---|---|
| `forge::guide_test` (Rust) | pedido (conteúdo, dado não confiável, tetos, idioma, lockfile), conserto, validação estrita, cache por SHA (atual, desatualizado, sem rede, poda, lixo, caminho seguro), escolha do agente |
| `runs::oneshot` (Rust) | prompt pelo stdin (Claude/Codex), resultado do evento de fecho, stderr como motivo, só TUIs somente leitura |
| `util::spawn` (Rust) | `output_with_input` entrega a entrada e fecha |
| `forge/tests/reviewGuide.test.ts` | passo a passo, teclas, visitadas, diff numerado, link do GitHub/GitLab, texto da pergunta, worktree do PR |
| `forge/tests/reviewGuidePanel.test.tsx` | gerar, navegar (clique e teclado), desatualizado, diff com foco, perguntar sem enviar, só comandos de leitura |
| `forge/tests/reviewGuideStore.test.ts` | pedido duplicado, erro do backend |
| `terminal/tests/draftWhenReady.test.ts` | rascunho sem Enter; envio normal com Enter |

## Não verificado

- Nenhuma chamada real a um agente nem ao GitHub nos testes.
- `codex exec -` lendo o prompt do stdin: segue a ajuda do Codex CLI, mas não foi rodado aqui.
- O Claude Code com `--disallowedTools` e sem broker: é o mesmo lançamento de um lead da frota, mas não foi rodado com este pedido.
- A âncora `#diff-<sha256>` do GitHub: segue o formato atual do site. GitHub Enterprise antigo pode não ancorar; a aba abre igual.
- Custo: não medido. Um PR médio leva o diff inteiro no pedido (até ~120 mil caracteres, ~30–40 mil tokens), em dobro se precisar do conserto.
