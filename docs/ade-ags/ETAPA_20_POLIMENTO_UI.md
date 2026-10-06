# Etapa 20 — Polimento de interface (pontos 2, 3, 4 e 5)

## 2. Chat
- **Markdown seguro** (`src/features/canvas/ChatMarkdown.tsx`): títulos, listas, negrito, código inline, blocos com botão *Copiar* e rolagem, tabelas, citações. Sem HTML cru (`react-markdown` sem `rehype-raw`, `skipHtml`), sem `dangerouslySetInnerHTML`; links só http/https (`safeHref`) e abrem no navegador externo; imagens não carregam. Mensagens do usuário continuam texto plano.
- **Redimensionar** (`chatSize.ts`): puxadores na borda esquerda, borda superior e canto; também por teclado (setas, Shift = passo maior). Mínimo 300×320, máximo = área disponível. Persistido em `localStorage` (`ags.chat.size.v1`). Botões *Restaurar tamanho* e *Maximizar* (`Ctrl+Shift+M`). `Esc` fecha o chat.
- **Trazer do terminal** (`ResponsePicker.tsx`, `terminal/responseSegments.ts`): `segmentResponses` (pura) divide o buffer em respostas, do prompt do usuário (`>`/`›`/`❯`) ao próximo; marcadores `●`/`⏺` (Claude), `•` (Codex), `✦` (Gemini), `◆`/`◇` (Antigravity). A caixa de entrada e suas rayas encerram a resposta. O modal destaca o bloco ao passar o mouse/↑↓, oferece *Enviar esta resposta* e *Enviar a seleção* (seleção livre do terminal). O texto vai ao campo de mensagem; nada é enviado sozinho.
  - Limite: é heurística visual; uma linha de código colada na coluna 0 com `>` conta como prompt (use a seleção livre). Em pantalla alternativa só há o que está visível.

## 3. Navegador/arquivos no modo Canvas
Causa: a faixa de abas ficava oculta com missão em Canvas e `usePlacements` ignorava a vista ativa. Agora a barra mostra **Canvas** (voltar) + as vistas do workspace, e `canvasPlacements` (pura, testada) coloca a vista ativa em tela cheia e esconde as terminais sem desmontá-las; voltar ao Canvas preserva o estado.

## 4. Barras de rolagem
`App.css`: variáveis `--cc-sb-thumb*` derivadas do acento (claro/escuro), pulgar fino, arredondado, translúcido, hover/ativo, sem trilho nem botões; sintaxe padrão só em motores sem `::-webkit-scrollbar` (WebKitGTK). Iframes de pranchetas: `SCROLLBAR_CSS` em `canvas/design/srcdoc.ts`, antes do HTML do agente. Verificação manual: ver no app o iframe de uma prancheta e o painel de chat.

## 5. Memória: modal único
`memory/MemoryInbox.tsx` + `bulkReview.ts` (puro, testado). Botão com contador na tela de Missões e no QG. Lista todas as sugestões pendentes agrupadas por missão (evidência, duplicada/contraditória), *Aceitar/Rejeitar todas*, *selecionadas* e uma a uma. Aceitar em massa pede confirmação com a contagem; com contradições mostra aviso e, sem confirmar, **não as aceita** (`approveBulk`). Esc cancela/fecha, Enter confirma. Nada é aprovado automaticamente. Limite: só sugestões de missões (o resumo do backend é por missão).

## 6. Acessibilidade / i18n
`aria-label` em puxadores, botões e diálogos; chaves em pt-BR/en/es (`canvas.chat.*`, `memoryInbox.*`).
