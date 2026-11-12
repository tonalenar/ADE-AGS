# Visualizador de mídia do chat

O chat abre anexos de imagem e arquivos de vídeo reconhecidos pela extensão (MP4, MOV, M4V, WebM, MKV e AVI) em um diálogo sobreposto. A galeria reúne anexos do composer e das mensagens, além de imagens Markdown locais citadas nas respostas e saídas de ferramentas. Miniaturas e setas navegam pela galeria; Esc fecha o diálogo e devolve o foco a quem o abriu.

O visualizador oferece zoom por controles, teclado e roda com Ctrl/Cmd, ajuste à tela, arraste com zoom, download e menu para abrir no app padrão ou revelar no Finder. Vídeos usam controles nativos, seletor de velocidade e avanço/retrocesso de quadro por botão ou pelas teclas `,` e `.`. Capturar um quadro cria uma imagem.

A barra inferior permite desenhar com espessura ajustável, desfazer/refazer, limpar, registrar comentários numerados em um ponto ou numa região arrastada e redimensionar por presets ou largura/altura com proporção travada. “Anexar imagem resultante” salva e coloca a imagem no composer; marcas e comentários são achatados no PNG e os comentários seguem como contexto com coordenadas.

No macOS com `ade-image-tools` empacotado, “Remover fundo” executa `VNGenerateForegroundInstanceMaskRequest` via helper Swift e anexa o PNG transparente ao composer. “Apagar” gera uma máscara PNG com a região marcada em branco e inclui a instrução ao agente no composer; a edição depende do agente, pois não há inpainting local.

## Limites desta entrega

- Captura de quadro, remoção de fundo e redimensionamento ficam disponíveis como anexos após “Anexar imagem resultante”.
- O helper Vision só é compilado no macOS. Fora dele ou sem o binário, o botão fica desabilitado e explica a indisponibilidade.
- A máscara de “Apagar” é contexto para o agente; a ADE não executa inpainting local.
- Imagens Markdown locais são lidas somente quando o caminho fica dentro da pasta da conversa. URLs remotas não são buscadas; imagens `data:` podem ser abertas e salvas como anexo.
- O seletor Imagem/Vídeo/Tudo filtra a galeria; o envio continua usando os anexos que a pessoa escolher no composer.

A referência visual foi a captura fornecida pelo usuário. A REA não foi usada: observar a janela do ChatGPT em execução poderia expor conversas reais, então não foi acessada.
