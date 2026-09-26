# Changelog

Notable user-facing changes to **Baritone Orchestrator** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/). Dates use UTC.

> **Rule:** every feature addition, change, or removal must be recorded under
> `[Não lançado]` in the same task. During a release, `[Não lançado]` becomes the new
> dated version and a new empty `[Não lançado]` section is added at the top.

## [Não lançado]

### Fixed

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
