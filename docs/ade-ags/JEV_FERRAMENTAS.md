# Ferramentas do Jev (protótipo, só leitura)

O Jev resolve uma tarefa uma vez no Portal; o caminho que deu certo vira uma **ferramenta determinística**, que roda depois sem o Jev (sem modelo, sem custo, em segundos). A ideia vem do [Pomerado](https://github.com/Pomerado/pomerado) (MIT): resolver com um modelo uma vez e publicar algo que não precisa dele.

## Uso

```bash
# 1. Gravar: o act normal, com --save. Só salva se o Jev chegar ao objetivo (e os --expect valerem).
ags portal act loja "buscar fone e ver os resultados" --fill "Buscar produtos=fone" \
  --save busca_loja --read "rows:li.produto|nome=h3|preco=.preco"

# 2. Rodar sem o Jev, com outra entrada (os --fill viram --input):
ags portal run loja busca_loja --input "Buscar produtos=teclado"

# 3. Ver e apagar
ags portal tools
ags portal forget busca_loja
```

`--read`: `text` (padrão: o texto visível da página, 60 linhas), `text:<linhas>`, ou `rows:<seletor das linhas>|campo=<seletor>|…|limit=<n>` (lê só o que uma pessoa vê; código adaptado do `readRows` do Pomerado). `--replace` grava por cima de uma ferramenta com o mesmo nome.

## O que fica gravado

`~/.ags/jev-tools/<nome>.json` (ou a pasta de `ADE_AGS_DATA_DIR`): a página de partida, os passos e a leitura. Cada passo acha o elemento de novo pelo **papel e nome** (desempatando pelo endereço do link e pelo texto vizinho), nunca pelo `ref`. O valor digitado nunca fica gravado: vira uma entrada.

## Regras (só leitura)

A gravação **não vira ferramenta** quando o caminho:
- toca num controle que muda o site (salvar, enviar, comprar, adicionar, excluir, confirmar…);
- digita num campo de senha ou código, ou digita um texto que não veio de um `--fill`;
- usa um toque por foto (um ponto da tela não é reproduzível);
- toca num elemento sem nome.

Fechar um aviso (aceitar cookies, fechar) é gravado como **opcional**: se ele não aparecer na próxima vez, o passo é pulado.

## Quando a página muda

A execução não chama o Jev. Um passo que não acha o seu elemento **para** e diz qual foi, com a instrução de gravar de novo (`--save <nome> --replace`).

## Medido

App isolado, loja de teste local: gravação com 1 consulta ao Jev (228 ms); execução sem o Jev em **0,3 s**, com a lista certa para outra entrada.

## Próximos passos (fora deste protótipo)

- Escrita com confirmação explícita (o Pomerado usa «marcas de commit» e `possible_commit`).
- Reparo automático: quando um passo falha, o Jev acha o elemento e regrava só aquele passo.
- Paginação e esperas por resultado (`pagination.ts`, `waitForOutcome` do Pomerado).
- Expor cada ferramenta como uma tool de MCP.
