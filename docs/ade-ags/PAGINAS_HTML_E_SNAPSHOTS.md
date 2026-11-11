# Aparelho flutuante, Páginas HTML e SnapShots (fusão com o T3 Code)

Três peças trazidas do T3 Code para a ADE: o aparelho que flutua sobre a conversa quando o agente o abre, as páginas HTML que o agente publica e a galeria de capturas. Referência de produto: `docs/user/html-renders.md`, `snap-shot.md` e `devices.md` do T3 Code. Parte da paridade do navegador está em [NAVEGADOR_PARIDADE.md](./NAVEGADOR_PARIDADE.md).

## 1. Aparelho flutuante (auto-show)

Quando o agente cria um aparelho (`ags device create`, iPhone/simulador ou Android), o aparelho aparece sobre a conversa, como o navegador faz. A regra segue o T3: a preferência "Mostrar prévia flutuante automaticamente" (Configurações → Navegador) vale por padrão, e o agente pode dizer o contrário na chamada.

| Peça | Onde |
|---|---|
| Hook: o pedido `canvas.portal` com `kind` ios/android chega ao front | `src/features/orchestrator/cliBridge.ts` (`handlePortal`) |
| Efeito: seleciona o aparelho do painel e aplica a decisão | `src/features/chat/deviceRevealAgent.ts` |
| Decisão pura: `float`, `panel` (aba da coluna) ou `none` | `src/features/chat/deviceReveal.ts` (`planDeviceReveal`, `revealFromShowFlag`) |
| Flags: `--mostrar` força o flutuante; `--sem-mostrar` deixa quieto | `src-tauri/src/bin/cli.rs` (`show_flags`) → `show` em `ipc/commands/devices.rs` |
| Só aparece se a conversa da aba do agente está à vista | `src/features/chat/conversationOnScreen.ts` |
| Um preview por vez: aparelho e navegador flutuante não coexistem | `src/features/chat/store.ts` (`openDeviceFloat`, `toggleChatBrowserFloating`) |
| Cartão no canto de baixo à direita, com o mesmo `IosPane`/`AndroidPane` da coluna, "Abrir no painel" e "Fechar" | `src/features/chat/DeviceFloatCard.tsx`, `deviceFloatModel.ts` |

Decisões:

- O aparelho entra nas superfícies da conversa mesmo flutuando. `sharedDevices` (o que os agentes controlam) lê `surfaces`; sem isso, o agente que acabou de abrir o aparelho ouve "não está conectado com você".
- Abrir um aparelho **não troca mais o canvas para o modo canvas**. Antes isso tirava a conversa da tela. O nó continua no canvas para quem quiser vê-lo lá.
- Os botões do painel do aparelho não mudaram (é a área do branch `feat/fusao-aparelho-controles`). O cartão só reaproveita o painel.
- Fechar o cartão não desliga o aparelho: a janela some, a sessão segue.

Fora desta fatia: abrir por `device start` ou `device open` (não há evento de front para isso); arrastar e redimensionar o cartão (fica fixo no canto); e um AVD recém-criado sem serial (o painel mostra o primeiro emulador pronto).

## 2. Páginas HTML

O agente publica uma página HTML completa (um gráfico, uma tabela, um diagrama, um mockup). Ela aparece na superfície **Páginas HTML** do painel (menu "⋯" e estado vazio; tecla H).

Já existia um caminho parecido: blocos `html` numa resposta do chat abrem como página visual (ROADMAP, *Respostas visuais do agente*). Esta fatia cobre o caso em que o agente publica a página para a pessoa guardar, listar e reabrir.

```bash
ags render publish --file relatorio.html --title "Vendas do trimestre"
ags render publish --file grafico.html --sem-mostrar   # publica sem abrir a superfície
ags render list                                        # as páginas desta aba
```

Fluxo: o `ags` lê o arquivo (UTF-8 ou UTF-16 com BOM) e manda `render.publish` → `src-tauri/src/ipc/commands/renders.rs` → `src-tauri/src/renders/store.rs` grava `<dados>/renders/<id>.html` e o índice `index.json`, por arquivo temporário e `rename`. Um índice ilegível dá erro e **não é sobrescrito**. Depois, o backend emite `cc-render-changed` e pede ao front `render.show`; a superfície abre na aba do agente só se a conversa está à vista.

Superfície (`src/features/renders/`): lista da mais nova para a mais antiga; abrir; voltar; recarregar (relê o arquivo); abrir no navegador do sistema (`render_open_external`); apagar em dois cliques (`render_delete`). Nada some sozinho.

**Isolamento.** A página entra em `srcdoc` com sandbox `allow-scripts`, sem `allow-same-origin`: origem opaca, sem acesso ao app, ao IPC nem ao armazenamento. A CSP é a do quadro isolado do MCP Apps (`ISOLATED_FRAME_CSP`): sem rede, sem navegação, sem frames e sem formulários. As `<meta http-equiv>` e as `<base>` do HTML são removidas, para o agente não afrouxar a CSP. Clique em link `http(s)` vai para `openExternalUrl`, que segue a política de links da pessoa.

**Diferença do T3, de propósito.** O T3 deixa a página carregar CDN pública. A ADE não: a página é offline, e o que ela precisa vai inline (scripts, estilos, imagens em `data:`). Liberar CDN é uma decisão de lista de hosts; fica para quando a pessoa quiser.

Limites: 2 MiB por página; título com 120 caracteres. Imagens locais por caminho (que o T3 embute na publicação) não entram nesta fatia.

**Autorização (F-09).** `render.publish` e `render.list` são `escopo:chamador` em `ipc/authz.rs`: a aba só publica e lista as próprias. Apagar não é método de agente. A família MCP `render_publish` e `render_list` só se oferece a abas (`--tab`), porque a página precisa de dono. A contagem do Anexo A de `docs/decisoes/HOST_REMOTO.md` passou para 223 métodos.

## 3. SnapShots (galeria)

Fonte: a pasta de capturas do usuário (`~/Pictures/ADE AGS`), a mesma que `computer_use/snapshot.rs` usa. Cada captura é um PNG `ADE-AGS_SnapShot_*.png` com o JSON ao lado (app, título, tela e instante). A captura em si não mudou; só `captures_dir` e o prefixo viraram `pub(crate)` para a galeria ler a mesma pasta.

Superfície **SnapShots** (tecla G, no "⋯"; `src/features/snapshots/`): grade de miniaturas com legenda (app · título · data). Por cartão: ver (visualizador existente), copiar (só macOS, pela cópia de PNG que o app já tem), anexar ao chat (`attachToComposer`) e apagar em dois cliques, que remove o PNG e o JSON. A galeria só lê a pasta: não apaga nem move nada sozinha.

Backend (`src-tauri/src/snapshot_gallery/`): `snapshot_gallery_list`, `snapshot_gallery_copy` e `snapshot_gallery_delete`, todos validando o id (prefixo do SnapShot, letras, números, `-` e `_`, sem barra). Não há comando de CLI nem de IPC para a galeria.

**Não feito: página "SnapShots" das configurações.** O T3 tem opções (ativar, incluir texto do app, sons, flash, animações), mas a ADE hoje não tem nenhuma delas: a captura usa `screencapture`, sem som, flash nem acessibilidade. Uma página com interruptores que não fazem nada seria falsa. O atalho já está em Atalhos. A página fica para quando a captura (outra peça) tiver essas opções.

Miniaturas: cada cartão lê o PNG inteiro (`readImage`, com cache por caminho). Não há miniatura em disco. Com muitas capturas, isso pesa: **não medido**.

## 4. Testes e verificação

- Rust: `cargo test --lib --bin ags` com 3045 testes no lib e 54 no binário `ags` passando, zero falhas (29 ignorados já existiam com motivo). Novos: `renders::test` (7), `snapshot_gallery::test` (5), `cli_test` (flags de exibição e `--file`). Contratos de `ipc/test.rs`: contagem por classe (27/190/4/2) e tamanho de `GROUPS` (21).
- Vitest: `renders/tests/model`, `snapshots/tests/model`, `chat/tests/deviceReveal`, `deviceFloatModel`, `deviceFloatStore`, `orchestrator/tests/catalogs`, e as pastas `chat`, `orchestrator`, `browser`, `tabs` e `canvas` (2172 testes passando, 1 falha corrigida no catálogo).
- `bunx tsc --noEmit`, `bun run check:i18n`, `bun run check:test-lint` (sem violação nova), `bun run check:babel`, `bun run gen:catalogs` + `check:catalogs`, e `node scripts/fingerprint.mjs` (schema e protocolo IPC inalterados).
- **Não verificado visualmente.** Nenhuma captura da instância isolada foi feita nesta fatia: o cartão flutuante, a lista de páginas e a galeria precisam de uma passada visual antes de virar PR.
- **Não medido:** custo das miniaturas e tempo de publicação de páginas grandes.
