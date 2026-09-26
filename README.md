# Baritone Orchestrator

App desktop (Rust/Tauri) que transforma o [Baritone](https://github.com/cabaletta/baritone) — mod
de pathfinding do Minecraft — de uma ferramenta controlada por comando de chat em um sistema
orquestrado externamente, com:

- **Visualização própria** do mundo que o bot já explorou, renderizada fora do jogo
- **Fila de instruções** que o bot executa em sequência/prioridade (explorar, minerar, construir,
  buscar item em baú)
- **Editor de schematic** onde desenhar/importar uma build já *é* a instrução, estilo WorldEdit
- **Índice de armazenamento**: baús mapeados e catalogados, com totais agregados por item

O bot é "burro" — só executa instruções literais — mas confiável. O app é o "cérebro" que decide o
quê, quando e em que ordem. Ver [`docs/SPEC.md`](docs/SPEC.md) para a especificação completa da
arquitetura, e [`docs/CHANGELOG.md`](docs/CHANGELOG.md) para o histórico de mudanças.

> **Status: ponta a ponta funcionando, escopo mínimo.** A shell do app, os modelos de dados Rust, a
> identidade visual, a ponte real com o Baritone (addon Java em NeoForge → socket local → app, nos
> dois sentidos), um **viewer 3D de verdade** (Three.js/WebGL, câmera orbitável, voxels reais dos
> chunks explorados e o bot em coordenadas reais do jogo) e a **fila executando `travel_to`/`explore`
> de verdade** (com status e progresso vindos do addon) estão implementados e testados manualmente.
> Baús e instruções de `#build`/`#mine`/craft ainda não existem — ver "O que falta" abaixo.

## Arquitetura

```
Minecraft (Baritone, mod já pronto)
        ↓ consumido via IBaritone
Addon Java (mod-addon/ — NeoForge, real)                    App Rust/Tauri (este repositório)
├─ chama baritone.api (pathing, build, explore)             ├─ WorldCache (src-tauri/src/world_cache.rs)
├─ implementa processos próprios (Survival, etc.)           ├─ StorageIndex (src-tauri/src/storage_index.rs)
├─ escuta eventos de chunk/bloco/baú                   ←──→ ├─ Fila de instruções (src-tauri/src/instructions.rs)
├─ executa instruções recebidas                             ├─ Itens/blocos/receitas (src-tauri/src/items.rs)
└─ reporta posição/progresso/vitais ────────────┐            └─ Vitais/ameaças (src-tauri/src/vitals.rs)
                                                 ↓
                         socket TCP local 127.0.0.1:31173 (src-tauri/src/addon_socket.rs)
                         manda vitais, posição e presença de chunk — baú/fila ainda não trafegam
```

## Identidade visual

Ferramenta técnica de desenvolvedor — escura, precisa, sem enfeite. Ver `docs/SPEC.md`, seção
"Identidade visual", para a tabela completa de tokens. Resumo:

| Token | Hex | Uso |
|---|---|---|
| Fundo base | `#0a0c0f` | Viewer, fundo geral |
| Painel | `#101317` / `#14181d` | Sidebars, cards |
| Accent âmbar | `#f2b155` | Ações primárias, instrução planejada |
| Accent teal | `#5eead4` | Posição do bot, progresso |
| Sucesso | `#4ade80` | Conectado, concluído |

Tipografia: **IBM Plex Sans** (UI) + **IBM Plex Mono** (dados/coordenadas).

## Rodando localmente

```bash
npm install
npm run app      # = tauri dev — app completo com hot reload (RECOMENDADO)
npm run dev      # só o frontend Vite, em http://localhost:1420
npm run build    # tsc --noEmit + vite build
```

Checagem só do backend Rust:

```bash
cd src-tauri && cargo check
```

No Linux, se o ícone não aparecer na barra de tarefas em modo dev, rode
`scripts/install-desktop-linux.sh` uma vez.

## O que falta (honesto, sem maquiar)

- **Baús e instruções além de `travel_to`/`explore`** — o addon já manda o chunk inteiro
  (`chunk_voxels`) e a fila já executa de verdade pelo canal reverso (o app manda `instruction`/
  `cancel` e recebe `instruction_status` com status e progresso); `StorageIndex` continua vazio (sem
  leitura de baú/`ContainerScreen`) e `Mine`/`Build`/`Craft`/`Smelt` ainda não têm executor no addon.
- **`SurvivalProcess`/detecção de ameaça e simulação de `ContainerScreen`** no addon — só descrito em
  `docs/SPEC.md`, sem código ainda.
- **Terreno real com bloco real por posição** (greedy meshing, heightmap) — o viewer 3D
  (`src/viewer3d.ts`, Three.js/WebGL) renderiza os voxels reais do `chunk_voxels` em coordenadas
  reais, com uma textura por face extraída do jar local (`src-tauri/src/texture_atlas.rs`); o que
  falta é blockstate (escada/eixo de tora/slab) e tint real por bioma — hoje todo bloco é um cubo com
  tint fixo aproximado. (O spec descreve esse renderer como wgpu nativo; aqui é WebGL dentro do próprio
  webview do app — decisão explícita pra evitar o risco de embutir uma superfície wgpu numa janela
  separada sem conseguir validar visualmente.)
- **Ingestão do `minecraft-data`** (itens/blocos/receitas) — os structs Rust (`Item`, `Block`,
  `Recipe`, `IngredientRef`) já existem em `src-tauri/src/items.rs`, incluindo a função
  `fits_inventory_2x2`, mas nada os popula ainda. (Diferente do atlas de texturas, que já lê o jar
  local de verdade — isso aqui ainda não foi implementado.)
- **Editor de schematic** — placeholder na UI explicando a dependência do atlas de texturas.
- **Persistência** do `StorageIndex` (hoje só em memória) — o **mundo explorado** já é salvo em
  disco e reaparece com o jogo fechado (ver `src-tauri/src/world_store.rs`).

## Estrutura do repositório

- `src/` — frontend: `main.ts` (toda a lógica de UI, sem framework) + `viewer3d.ts` (o renderer 3D,
  Three.js/WebGL) + `styles.css`.
- `src-tauri/` — backend Rust/Tauri, incluindo `addon_socket.rs` (servidor TCP que fala com o addon),
  `texture_atlas.rs` (extrai texturas do client jar local, nunca baixa/empacota nada) e
  `world_store.rs` (grava/carrega o mundo explorado em disco).
- `mod-addon/` — addon Java real (NeoForge), ver [`mod-addon/README.md`](mod-addon/README.md).
- `docs/CHANGELOG.md` — histórico de mudanças voltado ao usuário.
- `docs/SPEC.md` — especificação completa da arquitetura e do produto.
