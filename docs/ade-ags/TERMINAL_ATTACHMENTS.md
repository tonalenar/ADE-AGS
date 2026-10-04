# Anexos nos terminais dos agentes

Dá para mandar arquivos e imagens a um agente pelo terminal da app. Só o **caminho** é inserido no prompt: nunca se aperta Enter, nunca se executa o arquivo e o conteúdo dos arquivos soltos não é lido.

## Como usar

- **Soltar arquivos do sistema** sobre um terminal: o evento de drag-drop da janela do Tauri entrega os caminhos reais; o terminal sob o cursor recebe o texto.
- **Colar uma imagem** (Ctrl+V com imagem na área de transferência): a imagem é salva como arquivo temporário e o caminho é inserido. Aparece o aviso "Imagem anexada: <nome>". Texto colado segue como antes.

## Sintaxe por agente (`formatPathsForAgent`, `src/features/terminal/formatPathsForAgent.ts`)

| Agente | Formato | Verificação |
|---|---|---|
| Claude Code | `@caminho` (`@"caminho com espaço"`) | convenção conhecida; não verificada por `--help` local |
| Gemini CLI | `@caminho` | CLI não instalada aqui; não verificada |
| OpenCode | `@caminho` | `--help` não documenta; não verificada |
| Codex | caminho puro | `--help` só confirma `-i` no lançamento; caminho puro no prompt não verificado |
| Antigravity / desconhecido | caminho entre aspas simples, sem prefixo | não verificado: formato genérico |

Vários caminhos vão separados por espaço, com um espaço no final.

## Temporários e limites

- Pasta: `~/.ags/tmp/pasted/<uuid>.<ext>`, criada só com permissão do usuário.
- Tipos aceitos: png, jpeg, webp, gif. Máximo 20 MB por imagem. A extensão vem do tipo; o nome é só o uuid.
- O comando Tauri `save_pasted_image` recebe bytes e devolve só o caminho; o chamador não escolhe o destino.
- Ao iniciar a app, arquivos de `pasted/` com mais de 24 h são apagados.
- Nada é enviado à rede.
