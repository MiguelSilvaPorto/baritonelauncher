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
arquitetura e [`docs/CHANGELOG.md`](docs/CHANGELOG.md) para o histórico de mudanças; o índice da
documentação (com as referências externas oficiais) está em [`docs/README.md`](docs/README.md).

> **Status: ponta a ponta funcionando, escopo mínimo.** A shell do app, os modelos de dados Rust, a
> identidade visual, a ponte real com o Baritone (addon Java em NeoForge → socket local → app, nos
> dois sentidos), um **viewer 3D de verdade** (Three.js/WebGL, câmera orbitável, voxels reais dos
> chunks explorados, o **jogador com o modelo e a skin reais do jogo** em coordenadas reais e os
> **mobs ao redor identificados** por nome/categoria/distância/vida), a **fila executando
> `travel_to`/`explore` de verdade** (com status e progresso vindos do addon), uma **aba Config** com
> preferências reais salvas em disco e a **aba Jogar**, que abre o Minecraft direto (instância do
> CurseForge, sessão offline) com seleção de mundo, estão implementados e testados manualmente. Baús e
> instruções de `#build`/`#mine`/craft ainda não existem — ver "O que falta" abaixo.

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
                         manda vitais, posição + rotação, skin do jogador, mobs ao redor e o chunk
                         em voxels; recebe instruções/cancelamento — baú ainda não trafega
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
- **`SurvivalProcess` (reagir a ameaça) e simulação de `ContainerScreen`** — a **detecção** de mobs
  já existe (o addon varre as criaturas ao redor e manda `entities`; o viewer identifica cada uma),
  mas nenhuma decisão de lutar/fugir/levantar escudo, e crafting/fundição continuam só descritos em
  `docs/SPEC.md`.
- **Modelos 3D reais dos mobs** — o viewer identifica cada mob com um marcador (nome/categoria/
  distância/vida), não com o modelo de entidade do jogo; o pipeline de modelo/UV/animação por tipo de
  entidade ainda não existe (o atlas atual cobre só texturas de bloco).
- **Terreno real com bloco real por posição** (greedy meshing, heightmap) — o viewer 3D
  (`src/viewer3d.ts`, Three.js/WebGL) renderiza os voxels reais do `chunk_voxels` em coordenadas
  reais, com uma textura por face extraída do jar local (`src-tauri/src/texture_atlas.rs`), tint de
  bioma real por coluna (grama/folhagem/água, resolvido pelo `BiomeColors` do client no addon) e os
  **modelos de verdade** dos blocos não-cúbicos assados do jar (`src-tauri/src/block_models.rs`:
  tocha, cogumelo, vitória-régia, flor, escada, cerca, grade...). O que falta é blocos de **mods**
  (caem no cubo), block entities (baú, texto de placa) e tint por energia (fio de redstone é vermelho
  fixo); o bioma é amostrado no topo da coluna (bloco subterrâneo usa o bioma da superfície). (O
  spec descreve esse renderer como wgpu nativo; aqui é WebGL dentro do próprio
  webview do app — decisão explícita pra evitar o risco de embutir uma superfície wgpu numa janela
  separada sem conseguir validar visualmente.)
- **Ingestão do `minecraft-data`** (itens/blocos/receitas) — os structs Rust (`Item`, `Block`,
  `Recipe`, `IngredientRef`) já existem em `src-tauri/src/items.rs`, incluindo a função
  `fits_inventory_2x2`, mas nada os popula ainda. (Diferente do atlas de texturas, que já lê o jar
  local de verdade — isso aqui ainda não foi implementado.)
- **Editor de schematic** — a base funciona (paleta visual com texturas reais, seleção de região,
  colocar/quebrar em ghost, diff contra o mundo real → instrução na fila), mas faltam: inspetor de
  **blockstate** (escolher a variante de escada/eixo de tora/laje — o editor ainda trabalha só com o
  nome do bloco), import de `.litematic`,
  paleta vinda de um registro real de blocos (hoje é derivada dos nomes de textura do atlas) e
  executor de `Mine`/`Build` no addon (a instrução fica na fila) — ver `docs/CHANGELOG.md`.
- **Login Microsoft (servidores online)** — a aba Jogar abre o jogo em **sessão offline**: mundos
  singleplayer entram normalmente, mas servidor com `online-mode` recusa. Login com device code (e
  token salvo) ainda não existe; o app não lê o token do CurseForge de propósito.
- **Detecção limitada ao CurseForge** — a aba Jogar procura a instalação do CurseForge (padrão
  `~/Documents/curseforge/minecraft`, configurável); outros launchers (Prism, Modrinth App, oficial)
  não são detectados ainda.
- **Persistência** do `StorageIndex` (hoje só em memória) — o **mundo explorado** já é salvo em
  disco (`world.log`, gravado chunk a chunk; `world.json` com a versão do jogo e a última posição do
  bot) e reaparece com o jogo fechado (ver `src-tauri/src/world_store.rs`). O viewer desenha uma
  **janela** desse mundo ao redor do bot/câmera (o resto fica no disco e volta quando você chega
  perto) — é o que mantém o fps estável por mais que você explore.

## Estrutura do repositório

- `src/` — frontend: `main.ts` (toda a lógica de UI, sem framework) + `viewer3d.ts` (o renderer 3D,
  Three.js/WebGL) + `styles.css`.
- `src-tauri/` — backend Rust/Tauri, incluindo `addon_socket.rs` (servidor TCP que fala com o addon),
  `texture_atlas.rs` (extrai texturas do client jar local, nunca baixa/empacota nada),
  `world_store.rs` (log de chunks do mundo explorado + metadados em disco), `settings.rs`
  (preferências da aba Config, em `settings.json` no diretório de dados do app) e
  `minecraft_launch.rs` (aba Jogar: monta a linha de comando do jogo a partir da instalação do
  CurseForge que já existe, sem baixar nada).
- `mod-addon/` — addon Java real (NeoForge), ver [`mod-addon/README.md`](mod-addon/README.md).
- `docs/README.md` — índice da documentação, incluindo as referências externas oficiais.
- `docs/PROTOCOL.md` — socket app ↔ addon: mensagens e formato binário do `chunk_voxels`.
- `docs/CONFIG.md` — aba Config: campos, faixas aceitas e padrões.
- `docs/CHANGELOG.md` — histórico de mudanças voltado ao usuário.
- `docs/SPEC.md` — especificação completa da arquitetura e do produto.
- `docs/mockup-visao-principal.html` — mockup original da UI (referência visual, não doc técnica).
