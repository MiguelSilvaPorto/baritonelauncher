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

> **Status: scaffold inicial.** A shell do app (viewer, editor, fila, armazém), os modelos de dados
> Rust (`WorldCache`, `StorageIndex`, itens/blocos/receitas, vitais, estimativa de tempo) e a
> identidade visual estão implementados. O socket que conecta ao addon Java, o renderer 3D real e o
> próprio addon Java (que fala com o Baritone) ainda não existem — ver "O que falta" abaixo.

## Arquitetura

```
Minecraft (Baritone, mod já pronto)
        ↓ consumido via IBaritone
Addon Java (mod-addon/ — planejado, não implementado)      App Rust/Tauri (este repositório)
├─ chama baritone.api (pathing, build, explore)             ├─ WorldCache (src-tauri/src/world_cache.rs)
├─ implementa processos próprios (Survival, etc.)           ├─ StorageIndex (src-tauri/src/storage_index.rs)
├─ escuta eventos de chunk/bloco/baú                   ←──→ ├─ Fila de instruções (src-tauri/src/instructions.rs)
├─ executa instruções recebidas                             ├─ Itens/blocos/receitas (src-tauri/src/items.rs)
└─ reporta posição/progresso/vitais                          └─ Vitais/ameaças (src-tauri/src/vitals.rs)
        socket local (TCP/WebSocket) — não implementado ainda
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

- **Socket local** entre o app Rust e o addon Java — hoje `connection_status` sempre devolve
  `connected: false`, não existe nada do outro lado pra conectar.
- **Addon Java** em si — ver [`mod-addon/README.md`](mod-addon/README.md) para o porquê de não haver
  um scaffold Gradle fingindo funcionar sem o toolchain Forge/Fabric + Baritone real.
- **Renderer 3D real** (wgpu, greedy meshing, atlas de texturas do jar do Minecraft) — o viewer hoje é
  uma grade 2D fiel à identidade visual documentada, pronta para ser substituída por uma superfície
  wgpu sem mudar o resto da shell.
- **Ingestão do `minecraft-data`** (itens/blocos/receitas) e do jar oficial (texturas/modelos/atlas) —
  os structs Rust (`Item`, `Block`, `Recipe`, `IngredientRef`) já existem em
  `src-tauri/src/items.rs`, incluindo a função `fits_inventory_2x2`, mas nada os popula ainda.
- **Editor de schematic** — placeholder na UI explicando a dependência do atlas de texturas.
- **Persistência** do `StorageIndex` (hoje só em memória).

## Estrutura do repositório

- `src/` — frontend: `main.ts` (toda a lógica de UI, sem framework) + `styles.css`.
- `src-tauri/` — backend Rust/Tauri.
- `mod-addon/` — addon Java planejado (documentação, sem código ainda).
- `docs/CHANGELOG.md` — histórico de mudanças voltado ao usuário.
- `docs/SPEC.md` — especificação completa da arquitetura e do produto.
