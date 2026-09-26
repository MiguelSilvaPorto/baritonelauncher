# Changelog

Notable user-facing changes to **Baritone Orchestrator** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/). Dates use UTC.

> **Rule:** every feature addition, change, or removal must be recorded under
> `[Não lançado]` in the same task. During a release, `[Não lançado]` becomes the new
> dated version and a new empty `[Não lançado]` section is added at the top.

## [Não lançado]

### Fixed

- **App travava a cada gravação do mundo (justo quando o bot se move)**: o gravador periódico do
  `world_store` fazia **tudo** — serializar, comprimir e escrever — segurando o lock do `WorldCache`.
  Medido com o cache real desta máquina (19,6 MB crus, build debug): ~2,25 s só para serializar os
  chunks + ~1,3 s de zlib. Enquanto isso, todo comando que toca o mundo (`world_summary`,
  `world_chunks_near`, `chunk_voxels`) e o próprio handler do socket ficavam esperando o lock —
  resultado: segundos de travamento a cada 5 s, exatamente enquanto o bot anda e chunks novos chegam
  (o `world_revision` muda e dispara a gravação). Três correções: (1) cada chunk agora carrega o
  próprio payload binário em cache, montado uma vez quando o chunk chega (`Chunk::encoded_payload`) —
  o arquivo de cache já guarda exatamente esses bytes, então o load também não re-serializa nada;
  (2) a compressão e a escrita saem do lock, numa thread de blocking (`spawn_blocking`), sobrando só o
  memcpy de montar o arquivo (~92 ms medidos, 24× menos); (3) a compressão usa nível 1 (~0,46 s em vez
  de ~1,3 s, +0,6 MB no arquivo). O fechamento continua gravando, sem reescrever quando nada mudou
  (`LAST_SAVED_REVISION`). Reportado pelo usuário ("qualquer movimento... qualquer conclusão que meu
  Minecraft conclui o meu app trava").
- **"Separação"/grade visível entre os blocos de longe**: o atlas não tinha folga entre os tiles nem
  mipmaps, então de longe cada face de bloco amostrava um texel diferente do vizinho — blocos do mesmo
  terreno ganhavam tons ligeiramente distintos e o chão virava uma grade de quadrados ("separação") em
  vez de uma superfície contínua, além de cintilar com a distância (aliasing de minificação). Agora o
  atlas é empacotado com uma folga de 8px em volta de cada tile, preenchida replicando a borda do
  próprio tile — o mesmo truque do atlas do próprio Minecraft — e o viewer usa mipmaps
  (`NearestMipmapLinearFilter`: nítido de perto, média entre níveis de longe) com anisotropia. Cada
  nível de mip mistura só conteúdo do mesmo bloco, então some a grade e a cintilação. Reportado pelo
  usuário ("essa separação que fica quando eu enxergo de longe").
- **Videira (e líquen brilhante / veia de sculk) não apareciam no viewer**: o addon decide o que
  desenhar olhando `canBeReplaced()` do bloco — e no registro vanilla a videira é `.replaceable()`,
  então saía do payload com flags zero. Resultado: um bioma de selva cheio de videira aparecia sem
  nenhuma, mesmo o bloco existindo no chunk carregado. Agora videira e os blocos de face
  (`MultifaceBlock`) entram como renderizáveis de propósito — são geometria visível colada nas
  paredes, não decoração em cruz; grama alta, flor e muda continuam fora do desenho (virariam cubo
  cheio e poluiriam a cena). A textura `vine` e o tint de folhagem já existiam no viewer; o que
  faltava era o bloco chegar marcado. Reportado pelo usuário ("quero que vc arrume as videiras que
  não são carregadas o bioma que estou não mostra videira nenhuma").
- **Carregamento de chunks em ordem arbitrária, sem priorizar o que está ao redor do bot**: o viewer
  pedia `world_chunks` (o cache inteiro, que cresce sem limite) e usava os primeiros quatro na ordem
  em que o `HashMap` devolvia — o terreno ao redor do bot podia ser o último a chegar. Agora o
  backend expõe `world_chunks_near` (os N chunks mais próximos, já ordenados por distância) e o
  viewer carrega primeiro o que está ao redor do bot; com o jogo fechado, a âncora passa a ser o
  ponto que a câmera orbita, então o mundo em cache abre onde o usuário está olhando. Reportado pelo
  usuário ("começe a carregar as chunks ao meu redor primeiro antes de buscar algo novo em cache").
- **Montagem de malha travando o frame e custo alto por face**: cada chunk recebido remontava ele e
  os 4 vizinhos na hora (até 20 remontagens no mesmo tick com o polling antigo), e o laço de meshing
  refazia string/rect/cor e alocava arrays a cada face. Agora as malhas entram numa fila drenada com
  orçamento de ~8 ms por frame (um backfill de centenas de chunks aparece em frames seguidos, sem
  engasgo), um vizinho só é remontado se a borda do chunk que chegou tem algo desenhável, o laço de
  meshing usa cache de UV/tint por (bloco, face), UVs de fluido pré-rotacionadas e acesso local ao
  chunk sendo montado, e as meshes estáticas não recalculam matriz por frame
  (`matrixAutoUpdate = false`). Reportado pelo usuário ("melhore a perfomance das chunks").
- **Folhas, plantas e tochas saíam com o fundo preto**: o material do terreno não tinha `alphaTest`,
  então o canal alpha das texturas "cutout" do jogo era ignorado e os pixels vazios viravam quadrados
  opacos pretos — visível nas copas das árvores, que ficavam escuras por dentro. `alphaTest: 0.5` no
  material opaco faz o recorte como no jogo.
- **Sem o client jar, o viewer ficava em branco e tentava extrair o atlas pra sempre**: a falha do
  `get_texture_atlas` era só logada, e como `hasAtlas()` continuava `false`, o app repetia a extração
  a cada segundo (relendo o jar inteiro) sem nunca desenhar nada. Agora falha real marca o atlas como
  indisponível: o mundo é desenhado em modo degradado, com cor sólida por bloco em vez de textura, e a
  tentativa para — numa reconexão o app tenta de novo (caso a versão do jogo tenha sido instalada
  nesse meio tempo).
- **Blocos sem textura própria viravam `dirt`**: escada, laje, muro, cerca, porta, tapete e afins não
  têm textura com o nome do bloco, e caíam todos na textura de terra; blocos de mod idem. Agora o
  viewer tira o sufixo do modelo (`oak_stairs` → `oak_planks`, `stone_brick_wall` → `stone_brick`) e,
  quando ainda não acha textura, usa um tile branco neutro do atlas tingido de cinza — nunca a textura
  de outro bloco.
- **"Ir para" com campo vazio mandava o bot pra (0, 0)**: `Number("")` é `0`, então campo vazio
  passava pela validação e enfileirava uma viagem pra coordenada zero. Campo vazio agora só foca o
  input e não enfileira nada.
- **Resposta de chunk atrasada repovoava o viewer desconectado**: a fila de chunks em voo não era
  limpa no `clear()`, então um `chunk_voxels` que chegasse depois do disconnect podia voltar a
  desenhar bloco. Agora a limpeza acompanha o `clear()`.
- **Mensagem de protocolo desconhecido era descartada em silêncio**: quando o app recebe uma mensagem
  que o `AddonMessage` não conhece (ex: um jar do addon antigo ainda mandando `chunk_surface`, do
  protocolo antigo), ela era simplesmente ignorada — sem nenhum aviso, o viewer ficava vazio sem
  pista do motivo. Agora a primeira ocorrência de cada tipo vira um aviso no console com o `type` e o
  erro de parse, e ao fim da conexão sai um resumo por tipo (`chunk_surface × 412, chunk_loaded × 57`)
  junto com a contagem de linhas que nem eram JSON. Foi esse silêncio que transformou um jar do addon
  desatualizado (esquecido sem rebuild depois da mudança pra `chunk_voxels`) num "parou de carregar
  chunks" sem nenhuma mensagem de erro.
- **Folhas, videira e lírio-d'água saíam cinza**: essas texturas vêm em tons de cinza no próprio jar
  — o verde só existe em runtime via "biome tint" (colormap/JSON de bioma, não implementado). Agora
  levam tint fixo aproximado, igual já era feito com a grama: folhagem no tom de floresta (carvalho,
  jungle, acácia, dark oak, mangrove, videira) e as cores fixas que o jogo dá a spruce (`#619961`) e
  birch (`#80a755`). Cerejeira e azaleia já vêm coloridas no arquivo, e carvalho-pálido já vem com o
  tom pálido que dá o nome — esses ficam sem tint, senão escureceriam. Reportado pelo usuário ("as
  texturas que não carregam tipo as folhas que ainda estão zinzas").
- **Água, lava e fogo nem textura tinham (animadas eram puladas pelo atlas)**: `water_still`,
  `lava_still`, `fire_0`... são PNGs com os frames empilhados na vertical, e o atlas descartava tudo
  que não fosse 16×16 — esses blocos caíam no cinza de fallback. Agora todas as texturas animadas
  entram no atlas **com todos os frames** (`water_still_f0`, `_f1`…; frames 32×32 de
  `water_flow`/`lava_flow` são reduzidos pra 16×16, porque o atlas é uniforme) e o viewer resolve o
  nome certo por bloco (`water` → `water_still`, `lava` → `lava_still`, `fire` → `fire_0`). Água
  ainda leva um tint de azul aproximado, como no jogo. O cache do atlas em disco ganhou versão no
  nome (`atlas_v3_...`), senão o atlas antigo (sem essas texturas) continuaria sendo reaproveitado
  pra sempre.
- **Viewer travado a 2–5 fps depois do material por face**: cada bloco era um `Mesh` próprio e, com
  um material por face, cada um passou a custar 6 draw calls (um por grupo do `BoxGeometry`) — com
  milhares de blocos explorados, isso virava dezenas de milhares de draw calls por frame. Agora os
  blocos são renderizados **instanciados**: um `InstancedMesh` por tipo de bloco, com capacidade que
  dobra quando enche (copia as matrizes pra um lote maior, amortizado). O custo por frame caiu de
  "6 × blocos" para "6 × tipos de bloco" (algumas dezenas), independente do tamanho do mundo — sem
  mudar nada do visual (mesma textura por face, mesmo tint). De quebra, o dedupe de colunas do polling
  deixou de alocar uma string por coluna por segundo (chave numérica). Reportado pelo usuário ("o
  renderizador está estremamente travado 2fps a 5").
- **Faces laterais dos blocos usavam a textura de topo**: cada cubo recebia um único material nas 6
  faces, então o degrau de um bloco de grama mostrava a face lateral toda verde (textura
  `grass_block_top`) em vez de terra com a franja verde no topo, como no jogo. Agora o `BoxGeometry`
  usa um material por face, na ordem dos grupos do próprio Three.js: `"{bloco}_top"` em cima,
  `"{bloco}_side"` nos 4 lados (ex: `grass_block_side`, que já vem com a franja verde impressa sobre
  a terra) e `"{bloco}_bottom"` embaixo — com `dirt` no fundo de `grass_block`/`mycelium`/`podzol`,
  como no modelo vanilla. Blocos sem variantes (`stone`, `dirt`...) continuam com a mesma textura nos 6
  lados. Reportado pelo usuário ("arrume as texturas... normalmente as texturas renderizadas escolhem
  um lado só e aplica para os 4 lados").
- **Vão/grade preta entre os blocos do terreno**: cada bloco do viewer era um cubo de `0.98` (não
  `1.0`), deixando um vão de 2% entre colunas vizinhas. Como o addon só manda a camada de superfície
  (não existe bloco embaixo dela), esse vão deixava ver o fundo escuro da cena — um quadriculado de
  linhas pretas entre os blocos. Agora a geometria compartilhada é `1×1×1` de verdade, como no jogo:
  blocos vizinhos encostam e o limite visual entre eles passa a ser só a própria textura. Reportado
  pelo usuário ("quero que arrume esse vão de rederização").
- **Textura borrada — 1 tile esticado sobre o chunk inteiro em vez de 1 por bloco**: cada chunk é 16×16
  *blocos*, mas o UV mapeava o plano inteiro pra um único tile de 16×16 *pixels* do atlas — esticando
  uma textura de bloco 256x maior que deveria, virando borrão. Trocado por `buildTileTexture`: recorta
  só o tile do bloco representante (`dirt`) do atlas numa textura própria de 16×16px com
  `RepeatWrapping` + `repeat=(16,16)` e filtro nearest — agora repete uma vez por bloco de verdade
  dentro do chunk, nítido, igual o jogo. Reportado pelo usuário ("1 textura por chunk não por pixel...
  está tudo borrado").
- **Canvas 3D ficava visualmente pequeno/distorcido, rótulo de coordenada em lugar errado**:
  `renderer.setSize(w, h)` do Three.js escreve `width`/`height` inline no `style` do próprio elemento
  `<canvas>`, em pixels — isso sobrescreve o CSS que faz o canvas preencher o container
  (`.viewer-3d canvas { width: 100%; height: 100% }`). Se `resize()` rodasse uma vez com o container
  ainda sem layout pronto (0px — ex: durante um reload do HMR), o canvas ficava travado nesse tamanho
  errado pra sempre, mesmo depois do container ter o tamanho certo — só o rótulo de coordenada (que usa
  as dimensões reais do container a cada frame, não do canvas) continuava calculando a posição certa,
  daí o descompasso entre onde o marcador aparecia e onde o texto das coordenadas aparecia. Duas
  correções: `resize()` agora ignora chamadas com container de tamanho zero (não força um aspect ratio
  degenerado), e `renderer.setSize(w, h, false)` — o `false` impede o Three.js de mexer no `style`
  inline, deixando o CSS sempre no controle do tamanho visual. Reportado pelo usuário ("as coordenadas
  estão erradas em comparação ao boneco a visualização está erradíssima").
- **Placa texturizada saía sem cor nenhuma (cinza)**: o representante fixo usado enquanto o addon não
  manda o bloco real de cada chunk era `grass_block_top` — e essa textura, dentro do jar, é
  literalmente cinza (RGB médio 147,147,147, R=G=B); a cor verde real só existe em runtime, via
  "biome tint" (`textures/colormap/grass.png`, multiplicação de cor por bioma — ver `docs/SPEC.md`,
  "Blocos 3D"), não implementado. Confirmado lendo os pixels crus do jar (`dirt` = RGB 134,96,67 real,
  sem depender de tint nenhum). Trocado o representante pra `dirt`, que mostra cor de verdade sem
  precisar de tint. Reportado pelo usuário ("sem cores").
- **Chunks que chegavam antes do atlas terminar de carregar ficavam sem textura pra sempre**: o atlas
  é buscado de forma assíncrona (`get_texture_atlas`), mas o backfill de reconexão manda dezenas de
  `chunk_loaded` de uma vez (49 num caso real) — praticamente sempre antes do atlas resolver.
  `setChunks` só adicionava a textura em chunk *novo*, então todo chunk criado nessa janela nunca era
  revisitado. Agora `setAtlas` retrofita (`addTopTexture`) todo grupo já existente assim que a textura
  termina de carregar, além de continuar texturizando chunk novo normalmente. Reportado pelo usuário
  ("sem texturas").
- **HUD de vitais não atualizava sozinho**: `refreshState()` em `src/main.ts` só rodava uma vez, no
  carregamento da janela — se o addon conectasse depois disso, a UI ficava presa no estado antigo
  ("nenhum bot conectado") mesmo com a ponte já funcionando de verdade. Agora roda em loop
  (`setInterval`, 1s — mesmo intervalo de envio de vitais do addon). Confirmado em jogo: HUD passou a
  mostrar vida/fome reais assim que a página recarregou.
- **Vite disparava reload à toa**: o watcher do `vite dev` não ignorava `mod-addon/`, então artefatos
  de build do Gradle (`mod-addon/build/reports/**`) contavam como mudança de frontend e recarregavam a
  janela sem necessidade. `mod-addon/**` adicionado à lista de ignorados em `vite.config.ts`, junto de
  `src-tauri/`.
- **Placas de chunk invisíveis pra maioria das altitudes**: `viewer3d.ts` desenhava todo chunk em
  `y=0` fixo, mas o bot podia estar em qualquer altura (mundo moderno vai de -64 a 320+) — com o bot
  em `y=72`, por exemplo, as placas ficavam ~72 unidades abaixo do que a câmera enquadrava, fora de
  quadro. `setChunks` agora recebe a altura atual do bot e usa isso como aproximação de "chão local"
  pra chunk novo (não é altura de terreno real — ainda não temos esse dado —, mas é honesto: usa o
  único dado de altura que existe, em vez de um chute fixo).
- **Câmera do viewer 3D não seguia o bot**: `setBotPos` só enquadrava a câmera uma vez, na primeira
  posição recebida — depois disso a câmera ficava parada enquanto o bot andava, então bastava se
  afastar um pouco pra sumir de quadro. Agora, a cada posição nova, a câmera e o alvo do
  `OrbitControls` se movem pelo mesmo delta que o bot andou (preserva o ângulo/distância escolhido
  pelo usuário — não reenquadra do zero a cada frame). Reportado pelo usuário ("meu player saiu e não
  consigo mais ver").
- **Marcador do bot sumia no fog de distância**: o material da esfera teal não desabilitava `fog`, então
  em cenas grandes ele escurecia junto com o resto — mas é o indicador "você está aqui", nunca devia
  desaparecer. `fog: false` no material.
- **Chunks ao redor do spawn não apareciam no viewer**: `ChunkEvent.Load` só dispara uma vez por chunk;
  qualquer chunk já carregado antes do socket terminar de conectar (comum na própria área de spawn,
  carregada no join do mundo) nunca reenviava a mensagem, e a mensagem original tinha se perdido pra
  sempre. Addon agora faz uma varredura (`syncAlreadyLoadedChunks`, `getChunk(x,z,false)` — não força
  carregar nada) num quadrado de `getEffectiveRenderDistance()` chunks ao redor do jogador toda vez que
  conecta (primeira vez ou reconexão), preenchendo o que os eventos de load já perderam. Reportado pelo
  usuário ("as chunks em volta do meu player não mostra nada").

### Added

- **Céu no viewer 3D**: o fundo era uma cor chapada quase preta, então o horizonte e a profundidade do
  terreno sumiam — com o zoom afastado o mundo parecia flutuar no vazio. Agora há um domo de céu com
  gradiente (zênite azul → horizonte claro) numa textura de canvas, sempre centrado na câmera, e o
  *fog* passou a usar a cor do horizonte: o terreno distante se dissolve no céu em vez de virar um
  borrão escuro. É um céu fixo de dia claro — o addon ainda não manda a hora do mundo, então ele não
  cicla com o dia/noite do jogo (ver "Known gaps").
- **Editor de schematic (estilo WorldEdit): pintar, quebrar e selecionar região** — o modo Editor
  agora usa o mesmo renderer do viewer (o canvas é movido pra view ativa, sem abrir um segundo
  contexto WebGL) com: paleta lateral **visual** (busca + categorias, cada bloco com o ícone real
  tirado do atlas), ferramentas **Selecionar** (dois cliques fecham a região, como no WorldEdit),
  **Colocar** (bloco escolhido, na face clicada) e **Quebrar**, com o bloco/posição sob o cursor
  destacado por um cubo de arame teal e a região por um cubo âmbar. O picking é ray casting em
  voxels (DDA) sobre os chunks decodificados — as malhas são fundidas por chunk, então não dá pra
  mapear um `Raycaster` de volta pra um bloco. O que é pintado vira uma **camada de edição
  separada** do mundo real: ghost âmbar translúcido com a textura real (opacidade menor pra quebrar,
  maior pra colocar), e o `WorldCache` **nunca é mutado** — o app nunca mostra como existente algo
  que o bot ainda não construiu. "Aplicar" manda a camada pro Rust, onde o diff contra o mundo real
  (`schematic.rs`, com testes) vira instruções `Mine`/`Build` na fila; a lista de blocos fica
  guardada em `AppState.schematics` por id (a fila é pollada a cada segundo e não carrega centenas
  de blocos). Detalhe honesto: o addon ainda **não executa** build/mina, então a instrução fica
  `Queued` esperando executor — e, por isso, o dispatch da fila deixou de travar em instruções sem
  executor: ele pula pra próxima que sabe rodar em vez de pegar a mesma pra sempre. Reportado pelo
  usuário ("quero que vc adicione o sistema de poder posicionar blocos e destruir selecionar areas
  para quebrar" / "faça do jeito que o documento relata").
- **Explorar com raio e estilo (círculos/zigue-zague)**: o "Explorar" só tinha o modo nativo do
  Baritone (`explore(origem)`), que anda pro chunk nunca visto mais próximo sem forma definida — e
  ficava sem fim e sem progresso. Agora dá pra escolher o **raio** em blocos (16–5000) e o **padrão**:
  *círculos* (anéis concêntricos) ou *zigue-zague* (faixas de ida e volta), com *automático* mantendo
  o comportamento nativo. O addon gera os waypoints a partir da origem (o passo entre faixas/anéis vem
  da render distance efetiva do cliente — passar por dentro dela já carrega os chunks, então passos
  menores só fariam o bot andar mais devagar sem revelar nada novo) e percorre um a um com `GoalXZ`,
  reportando progresso real (waypoint atual / total); waypoint inalcançável é pulado em vez de travar
  a exploração inteira. Os controles ficam no popup do alvo ("Explorar daqui") e no painel da fila, ao
  lado do botão "Explorar". Reportado pelo usuário ("melhore o explorar daqui para poder escrever o
  raio e o estilo").
- **Card cancelado some sozinho da fila**: cancelar deixava o card "cancelado" na lista pra sempre,
  acumulando lixo visual. Agora ele fica ~4s visível (o suficiente pra confirmar que o cancelamento
  valeu) e depois sai da lista — o backend continua com o histórico, isso é só apresentação.
  Reportado pelo usuário ("se vc cancela ele não fica um pouco na fila e depois some").
- **Instruções sem digitar coordenada: clique no terreno pra mirar o destino** — a fila já executava
  de verdade, mas a única forma de criar uma instrução era digitar x/z no composer, o que não combina
  com a proposta de simplicidade do app. Agora um clique parado no terreno (a distinção com o arrastar
  de órbita do `OrbitControls` é movimento/tempo, não botão) marca o bloco com uma caixa âmbar e abre
  um popup no próprio ponto clicado com "Ir para" e "Explorar daqui" — o alvo vira instrução real e o
  marcador sai de cena. `Esc` (ou clicar no céu, ou o ×) limpa o alvo. A digitação continua como
  caminho secundário, com `Enter` confirmando o "Ir para". De quebra, toda instrução com alvo na fila
  aparece no mundo como caixa de arame — âmbar enquanto espera, teal enquanto o bot executa —, então
  a fila deixa de ser só uma lista lateral: dá pra ver onde cada destino fica antes de o bot chegar.
  Reportado pelo usuário ("o sistema foi feito para ser simples e não pode simplesmente fazer o
  usuário escrever todas as instruções automaticamente").
- **Mundo de verdade no viewer — cada chunk vem inteiro, não mais uma placa lisa**: quando o cliente
  carrega um chunk, o addon serializa todas as seções 16×16×16 não-vazias (paleta de blocos com o
  level de fluido + 4096 índices por seção, a mesma divisão e a mesma ordem do `PalettedContainer` do
  jogo), comprime com zlib e manda como `chunk_voxels` (base64, 2 chunks por tick). O Rust decodifica
  pro `WorldCache` e entrega os bytes crus ao viewer, que monta malhas por bucket de material com face
  culling real (inclusive contra chunks vizinhos já carregados). Água e lava são fluidos de verdade —
  altura pelo level, transparência da água, textura animada com todos os frames e rotação pela direção
  da correnteza — em vez de cubo sólido, e relevo, cavernas e minérios aparecem como no jogo. Tudo no
  mesmo socket local e no mesmo cache de mundo salvo em disco, então o mundo já explorado abre
  texturizado mesmo sem o jogo aberto.
- **Mundo explorado salvo em disco — o viewer abre sem o jogo aberto**: o cache era só em memória,
  então fechar o app apagava tudo que já tinha sido carregado e o viewer só mostrava algo com o addon
  conectado de novo. Agora o `WorldCache` é gravado em `world.cache`, no diretório de dados do app
  (`~/.local/share/dev.baritone.orchestrator/` no Linux), a cada 5s quando entra chunk novo e no
  fechamento do app — comprimido com zlib e escrito de forma atômica (tmp + rename), então um crash no
  meio da gravação não corrompe o cache bom. No boot, o app carrega esse arquivo antes de abrir a
  janela. A versão do Minecraft do último `hello` vai no mesmo arquivo, então o atlas de texturas
  também funciona offline e o mundo em cache abre já texturizado. A UI mantém a cena e busca
  atlas/voxels mesmo desconectada, com o chip mostrando "N chunks em cache" e o rodapé "jogo não
  conectado — mostrando o mundo em cache"; sem cache nenhum, continua o estado vazio honesto de
  sempre. Nada é inventado: é o dado real que o addon mandou e foi salvo. Reportado pelo usuário
  ("quero que adicione um cache que evita eu sempre ter o jogo aberto para ver oque já carreguei").
- **Renderizador do jogador de verdade — com a skin do próprio jogador**: o viewer mostrava uma bola
  teal no lugar do jogador. Agora desenha o modelo do Minecraft (cabeça, tronco, braços e pernas, nas
  proporções e UVs do `HumanoidModel`/`PlayerModel` do jogo, incluindo as camadas de sobreposição —
  chapéu, jaqueta, mangas, calças) com a skin real que o jogador usa em jogo, na variante `slim`
  (Alex, braço de 3px) ou `wide` (Steve, 4px). O addon lê a textura que o client **já tem carregada**
  (a skin baixada/customizada no cache de texturas ou a padrão do resource pack/jar — nada é baixado
  da Mojang, mesma regra do atlas de blocos) e manda um `player_skin` (PNG em base64) quando ela
  muda; o app valida, guarda em memória e expõe o comando `player_skin`. A caminhada usa as contas do
  `WalkAnimationState` do jogo, e a pose real (a mensagem `position` agora carrega yaw/pitch,
  expostos pelo comando `bot_pose`) é interpolada entre os updates de 4x/s — o modelo anda em vez de
  piscar de posição em posição e gira pra onde o jogador olha. Um anel teal raso no chão substitui o
  glow da esfera antiga, pra posição continuar legível de longe. Enquanto a skin não chega, o modelo
  aparece sem textura (cinza neutro) — nunca uma skin inventada. Reportado pelo usuário ("quero que
  vc adicione um renderizador do jogador no meu aplicativo hoje é só um bola azul... adicione um
  player do minecraft de verdade que pega a textura do próprio jogador").
- **Água e lava renderizadas de verdade — nível, transparência, animação e fluxo direcional** — o
  viewer tratava (quando renderizava) fluido como cubo opaco de 1×1×1, e `water_flow`/`lava_flow`
  eram puladas de vez, então não existia "fluxo" visual nenhum. Agora o protocolo `chunk_voxels`
  carrega, por entrada de paleta, o **nível** do fluido (`0` = fonte, `1–7` = fluindo, `8+` =
  caindo) e uma flag `FLUID` (formato 2; o addon Java e o Rust andam juntos). O viewer:
  - desenha a superfície na altura real (`(8 − nível) / 9`; fonte e queda = `8/9`), como o
    `WaterFluid#getHeight` do jogo — riacho vira degrau, cachoeira fica em pé;
  - some com as faces entre o **mesmo** fluido (nada de grade de cubos d'água) e mostra só o degrau
    quando o vizinho é mais raso;
  - água é **translúcida** (`depthWrite` desligado, como no jogo) e lava é opaca/emissiva;
  - toca **todos os frames** das texturas animadas (`water_still`, `water_flow`, `lava_still`,
    `lava_flow`) em sequência — o atlas passou a extrair frame a frame do jar;
  - calcula a direção da correnteza dos níveis dos vizinhos (mesma ideia do `FlowingFluid#getFlow`)
    e gira a textura pra acompanhar o fluxo: cachoeira escorre pra baixo, riacho corre pro lado.
  Reportado pelo usuário ("quero que vc arrume o carregamento de agua do meu app que ele não é capaz
  de renderizar o agua e o fluxo dela").
- **Canal reverso: a fila agora executa de verdade no jogo** — o socket só levava dados do jogo pro
  app; a fila era decorativa. Agora o app manda `instruction` (`travel_to` →
  `ICustomGoalProcess.setGoalAndPath(new GoalXZ(x, z))`, `explore` → `IExploreProcess.explore(x, z)`)
  e `cancel` pelo mesmo socket, e o addon devolve `instruction_status` (`active` com progresso,
  `done`/`failed`). O progresso do `travel_to` é real (fração da distância em linha reta até o alvo,
  medida da posição do bot) e o `explore`, que é contínuo, não tem progresso — a barra some de
  propósito em vez de fingir 0%. No app: comandos `queue_push`/`queue_cancel`, fila que anda em
  sequência (a próxima só é despachada quando a ativa termina, ou quando o addon reconecta) e um
  composer "Ir para" (x/z) / "Explorar" nos dois painéis de fila, com botão "cancelar" nos cards.
  Sem conexão a instrução fica `Queued` e sai no próximo `hello`. No addon, a leitura do socket roda
  numa thread própria que só enfileira as linhas; a execução (API do Baritone) acontece na thread do
  cliente, via `onClientTick`. Reportado pelo usuário ("o que seria o proximo item da fila para resolver").

- **Movimentação da câmera do viewer 3D — teclado + zoom livre**: antes a câmera só se movia pelo
  mouse (orbitar/arrastar do `OrbitControls`) e o zoom era travado entre 8 e 400 blocos, sem como
  chegar perto de um bloco pra inspecionar nem enquadrar o relevo de longe. Agora `WASD`/setas voam na
  horizontal (relativo à direção da câmera), `Q`/`E` (ou `Espaço`) descem/sobem, `Shift` acelera,
  `Alt` deixa preciso e `F` reenquadra o bot; a velocidade acompanha a distância do zoom (não fica
  lenta demais afastado nem rápida demais de perto). O zoom ficou livre na prática (`1.5`–`2000`
  blocos) e passou a aproximar/afastar no ponto do cursor (`zoomToCursor`), e o botão do meio do
  mouse também vira "arrastar". O fog, que antes sumia com o mundo além de ~260 blocos, acompanha a
  distância da câmera — mantém a profundidade no enquadramento normal sem engolir o terreno ao
  afastar. Um rodapé discreto no canto do viewer lista os atalhos. Reportado pelo usuário ("hoje só
  se movimenta pelo mouse e tem limite de zoom... está me incomodando").
- **Terreno real: bloco de superfície + altura de verdade por coluna** — o maior salto de fidelidade
  da sessão. Antes, cada chunk virava uma placa lisa com um bloco representante fixo; agora o addon
  escaneia as 256 colunas de cada chunk carregado (`ChunkEvent.Load`, e o backfill de reconexão) de
  cima pra baixo, pulando bloco "substituível" (`canBeReplaced()` — grama alta, samambaia, flor, muda
  — a mesma checagem que o próprio jogo usa pra "dá pra colocar bloco através disso"), e manda a altura
  real (Y) + o nome real do bloco de cada coluna numa nova mensagem `chunk_surface` (256 alturas +
  256 nomes, arrays paralelos). Isso pega copa de árvore de graça (folha não é substituível, então uma
  coluna sob uma árvore acha a folha como "superfície") — sem precisar de lógica dedicada pra árvore.
  Não escaneia até o limite de build (320) pra economizar: teto de 192, cobre a esmagadora maioria do
  terreno. O backfill de reconexão (que pode escanear 100+ chunks de uma vez, cada um até ~256×384
  buscas de bloco) não roda tudo numa tacada — enfileira e drena só 2 chunks por tick, evitando travar
  o jogo por um instante.
- **`world_columns`**: novo comando Tauri expondo os blocos de superfície como lista plana
  `{x,y,z,block}`, e `viewer3d.ts` reescrito — cada coluna vira um cubo de 1×1×1 na posição/altura
  reais, com a textura real resolvida por face do bloco (`"{bloco}_top"` em cima, `"{bloco}_side"`
  nos 4 lados, `"{bloco}_bottom"` embaixo — fallback pro nome puro quando a variante não existe, com
  cache por material/textura pra não recriar a cada coluna) em vez da placa lisa com um único bloco
  chutado pra todo chunk. `grass_block` ganha um tint verde fixo aproximado no topo (não é tint real
  por bioma — isso precisaria saber o bioma da coluna e amostrar o colormap, não implementado).
  Reportado pelo usuário ("cade as arvores vc está renderizando apenas uma camada... quero que mostre
  relevos de 16x como se fosse pequenos bloquinhos no minecraft").
- **Pipeline de atlas de texturas** (`src-tauri/src/texture_atlas.rs`): extrai as texturas de bloco do
  client jar do Minecraft **que o usuário já tem instalado localmente**
  (`~/.minecraft/versions/<versão>/<versão>.jar`) — nunca baixa nem empacota nada da Mojang neste
  repositório, por exigência explícita do usuário (licença da Mojang não permite redistribuir assets
  do jogo). Filtra só texturas 16×16 (pula as animadas, tipo água/lava, que vêm como PNG mais alto com
  frames empilhados), empacota num atlas em grid, cacheia em `src-tauri/.cache/` (gitignored) como PNG
  + JSON de UV por nome de textura. Testado com um teste de integração real
  (`cargo test texture_atlas`) contra o jar de `26.3` já instalado nesta máquina: 500+ texturas
  extraídas, `grass_block_top` confirmada. Novo comando Tauri `get_texture_atlas`, que usa a versão do
  MC real reportada pelo `hello` do addon (`AppState.mc_version`), não uma hardcoded.
- **Placas de chunk agora têm uma textura real por cima**: `viewer3d.ts` carrega o atlas uma vez
  (quando o addon conecta) e aplica `grass_block_top` como representante em toda placa nova — ainda não
  é o bloco real de cada chunk (o addon só manda presença, não conteúdo — ver "Known gaps"), mas prova
  que o pipeline de textura funciona ponta a ponta dentro da cena 3D de verdade.
- **Scaffold inicial do projeto**: shell Tauri 2 + Vite + TypeScript (sem framework), estrutura de
  pastas espelhando o padrão do launcher (`src/`, `src-tauri/`, `docs/`, `scripts/`, `public/`).
- **Identidade visual** implementada em `src/styles.css` fiel a `docs/SPEC.md`: fundo `#0a0c0f`,
  painéis `#101317`/`#14181d`, accent âmbar `#f2b155` (ação/planejado) e teal `#5eead4`
  (posição/progresso), tipografia IBM Plex Sans + IBM Plex Mono.
- **Shell de 4 modos** (rail de ícones, 56px): Viewer, Editor de schematic, Fila, Armazém — troca de
  view sem framework (`setMode` em `src/main.ts`), titlebar customizada com controles de
  janela (`decorations: false`).
- **Viewer**: grade de chunks com gradiente de fog, marcador do bot (círculo teal com glow),
  chip de progresso flutuante, ghost de instrução pendente (contorno tracejado âmbar) e HUD de vitais
  (vida/fome/armadura) — todos com estado vazio honesto enquanto não há conexão com um bot real.
- **Painel de fila** (cards com borda colorida por status) e **Armazém** (tabela de totais agregados
  por item) — vazios até o socket local existir.
- **Modelos de dados Rust** em `src-tauri/src/`: `WorldCache`/`ChunkPos`/`BlockPos` (mundo cacheado),
  `StorageIndex`/`ChestEntry`/`ItemTotal` (baús), `Item`/`Block`/`Recipe`/`IngredientRef` +
  `fits_inventory_2x2` (itens e receitas), `Vitals`/`ArmorPiece`/`Effect` + `classify_threat`
  (vida/fome/ameaças), `TimeEstimate` + `estimate_mine`/`estimate_travel`/`pick_fill_task`
  (agendamento por estimativa de tempo), `Instruction`/`InstructionQueue` (fila).
- **Comandos Tauri** expostos (`src-tauri/src/lib.rs`): `connection_status`, `world_summary`,
  `queue_snapshot`, `storage_totals`, `vitals_snapshot` — todos honestos: devolvem estado vazio porque
  ainda não existe socket nem addon Java conectado (ver `README.md`, "O que falta").
- **Ícone do app** gerado a partir de um mark geométrico próprio (nós de fila conectados: âmbar →
  teal → verde), pelo pipeline oficial do Tauri CLI (`tauri icon`), em todos os tamanhos/formatos
  necessários para Linux/Windows/macOS.
- **`docs/SPEC.md`**: especificação completa do produto/arquitetura (movida para `docs/`).
- **`mod-addon/README.md`**: descrição do addon Java planejado (Forge/Fabric consumindo
  `IBaritone`), deliberadamente sem scaffold Gradle fake — ver o próprio arquivo para o porquê.
  Atualizado com dados oficiais verificados direto do repositório `cabaletta/baritone`: qual variante
  de jar usar (`baritone-api-*`, não `baritone-standalone-*`, per `SETUP.md`), snippet de
  `build.gradle` pra dependência local (JitPack confirmado quebrado pra tag `v1.20.0`), e link dos
  Javadocs oficiais.

- **Socket local Rust ↔ addon Java** (`src-tauri/src/addon_socket.rs`): servidor TCP em
  `127.0.0.1:31173`, protocolo v0 documentado no próprio módulo — JSON por linha, mensagens `hello`
  (handshake) e `vitals` (vida/fome/saturação/armadura, ~1x/s). `connection_status` e `vitals_snapshot`
  agora refletem dados reais do jogo quando o addon está conectado, em vez de sempre vazios.
- **Addon Java real** em `mod-addon/`: projeto NeoForge a partir do MDK oficial
  ([`NeoForgeMDKs/MDK-26.3-ModDevGradle`](https://github.com/NeoForgeMDKs/MDK-26.3-ModDevGradle)),
  compilando contra `baritone-api-neoforge-1.20.0.jar` de verdade. A cada tick do cliente, lê vida/
  fome/armadura via `BaritoneAPI.getProvider().getPrimaryBaritone().getPlayerContext().player()` e
  manda pro socket acima, com reconexão automática se o app Rust não estiver de pé ainda.
  `neoforge.mods.toml` declara Baritone (`modId="baritoe"`, confirmado no jar oficial — não é
  `"baritone"`) como dependência obrigatória, então falta o Baritone vira erro claro do NeoForge, não
  crash confuso. Testado manualmente: addon carrega sem erro junto do Baritone real em NeoForge
  `26.3.0.22-beta`.
- **`mod-addon/scripts/fetch-baritone.sh`**: baixa `baritone-api-neoforge-1.20.0.jar` da release
  oficial e confere o SHA-1 contra `checksums.txt` antes de liberar o build — o jar não é commitado no
  git (binário de terceiros, `libs/*.jar` no `.gitignore` do addon).
- **Streaming de posição do bot**: addon manda `{"type":"position",...}` 4x/segundo (via
  `getPlayerContext().playerFeet()`, `BetterBlockPos`), separado do intervalo de `vitals` (1x/s).
  `AppState.bot_pos` no lado Rust, exposto por `world_summary`. Viewer mostra um indicador mono no
  canto superior esquerdo com as coordenadas reais — ainda não é o marcador posicionado no grid (isso
  depende do sistema de câmera/mapeamento de mundo, que não existe ainda), só confirma que o dado
  chegou. Testado em jogo: coordenadas reais aparecendo ao vivo na janela do app.
- **Streaming de chunk (contagem, não blocos ainda)**: addon assina `ChunkEvent.Load` do lado cliente
  e manda `{"type":"chunk_loaded","x":...,"z":...}` por chunk carregado. `WorldCache.apply_delta`
  (já existia, reaproveitado) marca presença — deliberadamente **não** remove no `ChunkEvent.Unload`,
  porque isso é o "já explorado" cumulativo, não a janela de render distance atual (comentado em
  `addon_socket.rs`). O chip de progresso do viewer troca "0% · 0 / 0 chunks" (dado inventado) por uma
  contagem real ("N chunks vistos") quando não há uma estimativa de total — mostrar uma porcentagem
  contra um total desconhecido seria inventar dado, então a barra some até existir uma estimativa de
  verdade.
- **Renderer 3D real (Three.js/WebGL)**: novo comando `world_chunks` expõe as coordenadas dos chunks
  vistos. Primeira tentativa foi uma grade 2D em DOM (`renderChunkGrid`/`worldToScreen`) — corrigido a
  pedido do usuário, que pediu especificamente o renderizador 3D que o spec descreve. `src/viewer3d.ts`
  monta uma cena Three.js de verdade (câmera perspectiva orbitável via `OrbitControls`, luz
  ambiente+direcional, fog) dentro do mesmo webview do app — decisão explícita do usuário em vez de
  wgpu nativo embutido numa segunda janela Tauri (mais fiel ao texto do spec, mas muito mais arriscado
  de acertar sem conseguir validar visualmente). Cada chunk explorado vira uma placa 16×16 na posição
  real (adicionada uma vez, nunca removida — mesma semântica cumulativa de antes); o marcador do bot é
  uma esfera teal emissiva + luz pontual na posição XYZ real, com label mono projetado em tela.
  Ainda não é blocos texturizados de verdade — isso continua dependendo do pipeline de atlas descrito
  em `docs/SPEC.md`, "Blocos 3D"; o que existe agora é a malha de chunks e o bot em 3D navegável.

### Known gaps

- Baús e recebimento de instruções da fila pelo addon — o socket manda vitais/posição/chunk, não
  inventário nem comandos do lado Rust pro addon ainda (ver `mod-addon/README.md`).
- `SurvivalProcess`/detecção de ameaça e simulação de `ContainerScreen` (crafting/fundição) no addon —
  ainda só descrito em `docs/SPEC.md`.
- Pipeline de atlas de texturas existe e funciona, mas ainda usa um representante fixo
  (`grass_block_top`) em toda placa — não o bloco real de cada chunk, porque `chunk_loaded` ainda não
  manda conteúdo de bloco (só presença). Sem isso, não dá pra ter terreno de verdade (altura por
  coluna) nem textura correta por posição.
- Sem ingestão de `minecraft-data` (itens, blocos, receitas) — diferente do atlas de texturas, que já
  lê o jar local, essa parte ainda não existe.
- `WorldCache`/`StorageIndex` só em memória, sem persistência — reiniciar o app Rust apaga todo chunk
  já visto (mesmo os que o Baritone Orchestrator estava rodando há horas), e o backfill de reconexão
  do addon só cobre os chunks que o *client* ainda tem carregados naquele momento, não o histórico
  completo de exploração. Reportado pelo usuário ("sem lembranças das chunks anteriores").
- Editor de schematic é um painel de placeholder, sem implementação.
