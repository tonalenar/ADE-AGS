# Modo headless (CI e scripts)

`controlcode --headless` sobe a app sem mostrar janelas:

- não restaura o workspace nem as abas, então nenhum agente interativo é lançado;
- a janela principal fica criada e oculta;
- IPC, agendador, event bus e notificações continuam rodando.

Tudo se controla pela CLI `ccode`.

## Rodar uma missão

```bash
controlcode --headless &
ccode mission run --objective "Corrigir os testes de src/parser" --cwd . --wait --timeout 3600
```

O `mission run` cria a missão, inicia e espera. A saída é uma linha JSON com o status e as tarefas, e o código de saída diz o resultado:

| Código | Significado |
|---|---|
| 0 | Missão `done` |
| 1 | Missão `failed` ou `cancelled`, ou o tempo limite acabou |
| 2 | Erro de uso da CLI |
| 3 | A app não está rodando |

Opções:

| Opção | Uso |
|---|---|
| `--title` | Nome da missão |
| `--agent`, `--model`, `--account` | Fixam o Lead; sem `--account` a conta é automática |
| `--squad` | Usa um Squad |
| `--budget` | Orçamento em US$ |
| `--max-parallel` | Tarefas simultâneas |

Também dá para fazer passo a passo: `ccode mission create|start|status|wait <id>`.

## Revisar e aplicar

```bash
ccode mission review <id>          # o que cada tarefa isolada entregou
ccode mission accept <id> <tarefa> # junta no worktree de integração
ccode mission apply <id>           # um merge da integração no projeto
```

Um conflito sempre é abortado e devolvido com a lista de arquivos (código 1).

## Aprovações

Sem interface, um pedido de permissão espera e, ao vencer, é negado. Há duas saídas:

- **Regras de permissão escritas antes** (`Bash(cargo test*)`, `Edit(src/**)`). É o recomendado para CI.
- **Responder pela CLI:**

  ```bash
  ccode approval list
  ccode approval decide <id> --allow [--remember]
  ```

## Acompanhar

```bash
ccode events wait --after 0 --topics task.,mission. --timeout 60
```

## Cuidados

- **Uma instância por máquina e usuário.** O headless usa o mesmo `~/.controlcode/data.db` que a app. Com outra instância viva, a nova não limpa as tarefas "rodando", porque são da outra. Mesmo assim, rodar duas instâncias sobre o mesmo banco não é o caso de uso: em CI o runner tem o próprio home.
- **Linux:** o webview oculto ainda precisa de um display. Use `xvfb-run controlcode --headless`.
- **Contas:** as CLIs dos agentes precisam estar instaladas e logadas no runner. Uma conta por API key (Claude Code ou Codex) é o mais simples em CI.
- **`ccode`:** precisa encontrar o handshake. Com várias instâncias, aponte `CONTROLCODE_HANDSHAKE=~/.controlcode/ipc/<pid>.json`.

## Exemplo: GitHub Actions (Linux)

```yaml
- run: sudo apt-get install -y xvfb
- run: xvfb-run -a controlcode --headless &
- run: sleep 5 && ccode mission run --objective "${{ inputs.objective }}" --cwd . --wait --timeout 3600
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```
