# Changelog

Notable user-facing changes to **Baritone Orchestrator** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/). Dates use UTC.

> **Rule:** every feature addition, change, or removal must be recorded under
> `[Não lançado]` in the same task. During a release, `[Não lançado]` becomes the new
> dated version and a new empty `[Não lançado]` section is added at the top.

## [Não lançado]

### Fixed

- **HUD de vitais não atualizava sozinho**: `refreshState()` em `src/main.ts` só rodava uma vez, no
  carregamento da janela — se o addon conectasse depois disso, a UI ficava presa no estado antigo
  ("nenhum bot conectado") mesmo com a ponte já funcionando de verdade. Agora roda em loop
  (`setInterval`, 1s — mesmo intervalo de envio de vitais do addon). Confirmado em jogo: HUD passou a
  mostrar vida/fome reais assim que a página recarregou.
- **Vite disparava reload à toa**: o watcher do `vite dev` não ignorava `mod-addon/`, então artefatos
  de build do Gradle (`mod-addon/build/reports/**`) contavam como mudança de frontend e recarregavam a
  janela sem necessidade. `mod-addon/**` adicionado à lista de ignorados em `vite.config.ts`, junto de
  `src-tauri/`.

### Added

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
- **Grade do viewer renderizada com dados reais**: novo comando `world_chunks` expõe as coordenadas
  dos chunks vistos; `src/main.ts` ganhou `worldToScreen`/`renderChunkGrid`, que desenha um `div` por
  chunk explorado (câmera centrada na posição real do bot) e move o marcador teal + label mono pra
  posição exata do jogador — tudo em coordenadas de mundo de verdade, sem framework, mesmo padrão do
  resto do app. O grid CSS decorativo (sempre visível) foi removido do fundo do viewer: agora a malha
  só aparece onde já foi explorado, como o spec pede ("área nunca explorada fica escura, sem grid
  visível"). Ainda não é o renderer 3D com blocos texturizados — isso continua dependendo do pipeline
  de atlas descrito em `docs/SPEC.md`, "Blocos 3D".

### Known gaps

- Streaming de chunk pro `WorldCache`, índice de baús, e recebimento de instruções da fila pelo addon
  — o socket hoje só manda vitais, não posição/mundo/inventário (ver `mod-addon/README.md`).
- `SurvivalProcess`/detecção de ameaça e simulação de `ContainerScreen` (crafting/fundição) no addon —
  ainda só descrito em `docs/SPEC.md`.
- Viewer é uma grade 2D fiel à identidade visual, não um renderer wgpu real ainda.
- Sem ingestão de `minecraft-data`/jar oficial (itens, blocos, receitas, texturas).
- `StorageIndex` só em memória, sem persistência.
- Editor de schematic é um painel de placeholder, sem implementação.
