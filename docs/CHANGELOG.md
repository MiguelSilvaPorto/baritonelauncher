# Changelog

Notable user-facing changes to **Baritone Orchestrator** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/). Dates use UTC.

> **Rule:** every feature addition, change, or removal must be recorded under
> `[Não lançado]` in the same task. During a release, `[Não lançado]` becomes the new
> dated version and a new empty `[Não lançado]` section is added at the top.

## [Não lançado]

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

### Known gaps

- Sem socket local Rust ↔ addon Java (`connection_status` sempre `false`).
- Sem addon Java implementado.
- Viewer é uma grade 2D fiel à identidade visual, não um renderer wgpu real ainda.
- Sem ingestão de `minecraft-data`/jar oficial (itens, blocos, receitas, texturas).
- `StorageIndex` só em memória, sem persistência.
- Editor de schematic é um painel de placeholder, sem implementação.
