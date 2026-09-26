# Baritone Orchestrator — working guide (AI)

> **Mirror:** [`CLAUDE.md`](CLAUDE.md) is a byte-for-byte copy of this file. Every edit here must be
> applied to both — the cheap way is `cp AGENTS.md CLAUDE.md` after editing.

## 1. What it is

A desktop app (Tauri 2, Rust backend + TypeScript frontend) that orchestrates a **Baritone**
(Minecraft pathfinding mod) bot from outside the game: its own world viewer, an instruction queue,
a WorldEdit-style schematic editor, and a chest/storage index. Full product spec in
[`docs/SPEC.md`](docs/SPEC.md).

> Status: **minimal end-to-end slice working**. Identifier: `dev.baritone.orchestrator`. The UI shell,
> visual identity, Rust domain models, the Java addon (real NeoForge project), and the local socket
> between them are implemented and manually tested — the addon streams real player vitals from an
> actual Baritone-controlled game into the app's HUD, streams each loaded chunk's real blocks for the
> 3D viewer, and executes queued `travel_to`/`explore` instructions through Baritone. Chest data and
> `minecraft-data` ingestion do not exist yet. See "Known gaps" in `README.md` before claiming
> something works.

## 2. Where you are

At the repository root — the app directory. It contains:

- `src/` — frontend: `main.ts` (all UI logic, no framework) + `styles.css`.
- `src-tauri/` — Rust/Tauri backend, single crate (`src/lib.rs` + one module per domain concept:
  `world_cache.rs`, `storage_index.rs`, `items.rs`, `vitals.rs`, `time_estimate.rs`,
  `instructions.rs`, `addon_socket.rs`).
- `index.html` — the entire UI markup (titlebar, rail, the four views: viewer/editor/fila/armazém).
- `mod-addon/` — **real NeoForge project** (from the official MDK), bridges Baritone to the socket
  above. See its `README.md` for what's implemented vs. still missing.
- `docs/SPEC.md` — the full product/architecture spec. Treat it as the source of truth for behavior
  that isn't implemented yet; don't re-derive decisions it already made.
- `docs/CHANGELOG.md` — user-facing history.

There is no component framework and no bundled state library: `main.ts` renders views by toggling
`.active` on `<section class="view">` elements and re-rendering `innerHTML` strings for lists.

## 3. Stack

- **Frontend:** TypeScript (strict) · Vite 8 · vanilla DOM, no UI framework · Three.js for the 3D
  viewer only (`src/viewer3d.ts` + `src/player_model.ts`) — a graphics library, not an app framework;
  everything else stays plain DOM/innerHTML.
- **Backend:** Rust (edition 2021) · Tauri 2 · `serde`/`serde_json` · `tauri-plugin-opener` ·
  `tauri-plugin-dialog` · `tokio` (powers `addon_socket.rs`, the local TCP server the Java addon
  connects to) · `flate2` (zlib payloads: `chunk_voxels` and the persisted `world.cache`) ·
  `image`/`zip`/`base64` (read-only jar/texture extraction in `texture_atlas.rs`, see rule 9 below).
- **Styling:** one `src/styles.css`, plain CSS custom properties under `:root` — the fixed dark
  identity from `docs/SPEC.md` ("Identidade visual"), not a multi-theme system.
- **Addon:** Java 25 · NeoForge (ModDevGradle) · `mod-addon/`, a normal Gradle project you build with
  `./gradlew` from inside that directory — it is not part of the npm/cargo build.

## 4. Commands (from `package.json`)

```bash
npm install
npm run app      # = tauri dev — full app with hot reload (RECOMMENDED WAY)
npm run dev      # Vite frontend only, at http://localhost:1420
npm run build    # tsc --noEmit + vite build — must pass before considering a change done
```

Rust-only check without a full Tauri build:

```bash
cd src-tauri && cargo check
```

Rust unit/integration tests:

```bash
cd src-tauri && cargo test   # world_cache (payload round-trip) + texture_atlas (skips if no local jar)
```

## 5. Non-negotiable rules

1. **No fabricated data in shipped UI.** Every Tauri command in `src-tauri/src/lib.rs` returns real
   state — `connection_status`/`vitals_snapshot` reflect the addon's actual socket messages when
   connected, `queue_snapshot` reflects the real instruction queue (`queue_push`/`queue_cancel` +
   `instruction_status` from the addon), and `storage_totals` still returns an empty vector because
   nothing populates it yet. If you're tempted to hardcode a sample queue or chest so the UI "looks
   alive," don't — render the honest empty state instead (see `renderQueueInto`/`renderStorage` in
   `src/main.ts` for the pattern) and say in your reply that the feature has no backend yet.
2. **Never hardcode colors in CSS/inline styles.** Use the custom properties in `:root` in
   `src/styles.css` (`--bg-*`, `--amber`, `--teal`, `--success`, `--text-*`, `--border*`). They are the
   literal tokens from `docs/SPEC.md`'s "Identidade visual" table — don't introduce new colors without
   updating that section first.
3. **Color has meaning, never decoration.** Âmbar = ação/planejado (ghost instructions, primary
   actions). Teal = estado atual/progresso (bot position, active queue item). Verde = concluído. Don't
   reach for a new accent color for something that already fits one of these.
4. **Changelog is mandatory for features.** Every feature addition, change, or removal must update
   [`docs/CHANGELOG.md`](docs/CHANGELOG.md) in the same task, under the **`[Não lançado]`** section
   (top of the file).
5. **PT-BR is the UI language.** All user-facing strings (labels, empty states, error messages) are in
   Brazilian Portuguese. Code, comments, commit messages, and this file are in English.
6. **New Rust commands** go under `mod commands` in `lib.rs` and must be added to both the
   `tauri::generate_handler![...]` list inside `commands::register` — Tauri won't expose one without
   the other.
7. **Commits follow the worktree flow (section 9).** Commit on your task branch; merging it into
   `main` **and pushing `main` to `origin`** are pre-authorized by that workflow (fetch, resolve
   conflicts on the branch, verify, merge, push — finished work is expected to land on `origin/main`).
   Committing directly on the primary checkout is still not allowed, and pushing anything else
   (other branches, tags, force-pushes) still needs explicit permission.
8. **Never commit `mod-addon/libs/*.jar`.** The Baritone jar is fetched by `mod-addon/scripts/
   fetch-baritone.sh` (which verifies its SHA-1 against the official release's `checksums.txt`) and is
   gitignored — don't vendor third-party binaries into the repo.
9. **The addon must always compile against `baritone-api-*`, never `baritone-standalone-*`.** The
   standalone variant obfuscates the `baritone.api` package too, so it silently can't be used as a
   dependency — see `mod-addon/README.md` for the full explanation (sourced from Baritone's own
   `SETUP.md`).
10. **Never download, bundle, or commit Mojang/Minecraft assets (textures, models, sounds, the client
    jar itself) anywhere in this repo.** Explicit user requirement — Mojang's license doesn't allow
    redistributing game files. `texture_atlas.rs` only reads the client jar the user already has
    installed locally (`~/.minecraft/versions/...`) and writes its derived atlas to the gitignored
    `src-tauri/.cache/`. If you extend asset ingestion (models, sounds, `minecraft-data` itself),
    follow the same pattern: read from what's already installed, cache outside git, never fetch from
    Mojang's CDN or vendor a copy into the repo.

## 6. Architecture at a glance

**Frontend (`src/main.ts`)**
- View router: `setMode(name)` toggles `.view.active` / `.rail-btn.active`; views are `viewer`,
  `editor`, `fila`, `armazem`.
- `refreshState()` polls the Tauri commands every `REFRESH_INTERVAL_MS` (1s, matching the addon's
  vitals cadence) — there is no push from the Rust side, so this is polling, not a stream. It used to
  run once on load only; that was a real bug (UI froze on whatever was true at page load) fixed once
  the addon bridge existed and made it observable — don't reintroduce a one-shot call. Player pose is
  polled separately (`refreshPose`, 250ms = the addon's `position` cadence) so the model walks
  smoothly instead of jumping once a second.
- `renderViewer`/`renderHud`/`renderQueueInto`/`renderStorage` each render an honest empty state when
  the underlying data is empty — follow that pattern for new panels instead of inventing placeholder
  rows.
- **`src/viewer3d.ts`** (`Viewer3D` class) — the real 3D renderer (Three.js/WebGL, not DOM). Owns its
  own `WebGLRenderer`/`Scene`/`PerspectiveCamera`/`OrbitControls` and a `requestAnimationFrame` loop;
  `main.ts` only calls `setAtlas()`/`addChunkVoxels()`/`setPlayerSkin()`/`setBotPose()`/
  `setNearbyMobs()`/`clear()`/`resize()`/`getFocusChunk()` on it. Each `chunk_voxels` payload becomes
  per-bucket meshes with real
  face culling (including against already-loaded neighbors); the mesh work is queued and drained with
  a per-frame budget (`drainMeshQueue`), and `main.ts` asks for the nearest chunks first
  (`world_chunks_near`, anchored on the bot or on the camera target when the game is closed). Chunks
  are added once and never removed (cumulative "explored" semantics, matching `WorldCache`). It also
  hosts the **schematic editor**: voxel DDA picking (`pickBlock` — meshes are merged per chunk, so a
  `Raycaster` can't map back to a block), the edit layer (`edits` + `rebuildGhosts`, amber
  translucent ghost, never mutates `WorldCache`), region selection/hover wire boxes, and `mountTo()`
  — the viewer and the editor share this one renderer, the canvas is moved to the active view instead
  of opening a second WebGL context (`main.ts`, `setMode`). The click-to-target popup and the editor
  share one pointer handler: with an editor tool active the click edits, otherwise it picks the queue
  target. This intentionally uses WebGL inside the existing webview instead of a native wgpu surface
  (which the spec's architecture diagram shows) — an explicit user decision, because embedding wgpu in
  a separate window synced to the Tauri window is much higher-risk to get right blind. Don't silently
  redo that tradeoff; if wgpu comes up again, confirm first.
- **`src/player_model.ts`** (`MinecraftPlayerModel`) — the player the viewer draws: a port of the
  game's `ModelPart.Cube` geometry/UVs (64×64 skin layout, `slim`/`wide` arms, overlay layers) plus
  the `WalkAnimationState` walk cycle. The skin is the real PNG sent by the addon (see
  `player_skin.rs`); with no skin yet the model renders untextured (neutral gray) instead of an
  invented skin. `viewer3d.ts` feeds it the interpolated `bot_pose` at 4x/s, and a flat teal ring on
  the ground keeps the position readable now that the old glowing sphere is gone.

**Backend (`src-tauri/src/`)**
- `lib.rs` — `AppState` (in-memory `WorldCache`, `StorageIndex`, `InstructionQueue`,
  `Option<Vitals>`, `ConnectionStatus`, `Option<String>` mc_version, `bot_pose`/`player_skin`, the mob
  snapshot (`mobs.rs`), plus
  `addon_tx` — the outbound
  write channel to the addon, all behind `Mutex`) + the commands currently exposed:
  `connection_status`, `world_summary`, `world_chunks`, `world_chunks_near`, `chunk_voxels`,
  `queue_snapshot`, `queue_push`, `queue_cancel`, `schematic_apply`, `storage_totals`,
  `vitals_snapshot`, `bot_pose`, `player_skin`, `nearby_mobs`,
  `get_texture_atlas`. Spawns
  `addon_socket::listen` in `setup()`. `dispatch_next_instruction`/`send_to_addon`/`encode_instruction`
  are the reverse-channel helpers (queue → socket), called from `queue_push`, from the `hello`
  handler and when an instruction reaches a terminal status. `setup()` also loads the persisted world
  (`world_store::load`) and spawns `world_store_task`, which saves when `world_revision` changes;
  `RunEvent::Exit` does a final save.
- `addon_socket.rs` — TCP server on `127.0.0.1:31173`, one JSON message per line, **both
  directions**. Addon → app: `hello` (marks `AppState.connection` as connected + dispatches queued
  instructions), `vitals` (fills `AppState.vitals`), `position` (fills `AppState.bot_pos` and
  `AppState.bot_pose` — feet coordinates plus yaw/pitch), `player_skin` (the player's own skin as a
  base64 PNG, sent whenever the texture changes → `player_skin.rs`), `entities` (snapshot of the
  living mobs within 32 blocks, ~4x/s, category/name/health/distance per entity → `mobs.rs`),
  `chunk_voxels` (full chunk, palette + indices per section, deflate+base64 → `world_cache.rs`) and
  `instruction_status` (`active` with progress / `done` / `failed`; updates the queue and dispatches
  the next instruction). App → addon: `instruction` (`travel_to`/`explore`) and `cancel` — written by
  a task consuming `AppState.addon_tx`, registered per connection. Stores the version from `hello`
  in `AppState.mc_version` (used by `texture_atlas.rs` to find the matching local jar — never
  hardcode a version here, read it from this field). The matching Java client is
  `mod-addon/src/main/java/dev/baritone/orchestrator/addon/BaritoneOrchestratorAddonClient.java`.
  Extending the protocol further (e.g. chest contents) means updating the `AddonMessage` enum here
  **and** the Java sender/receiver in lockstep — they're not generated from a shared schema.
- **`player_skin.rs`** — the player's own skin (PNG data URL + `slim`/`wide` variant) as sent by the
  addon. Validates the base64/PNG before trusting it. The addon reads the texture the running client
  already has (its texture cache for downloaded skins, or the installed resource pack/jar for the
  default one) — **never** fetched from Mojang's CDN, same rule as `texture_atlas.rs`.
- `world_cache.rs` — sparse per-chunk voxel cache (`WorldCache`), filled by `chunk_voxels` (palette
  + indices per 16×16×16 section). Also `CrossingStrategy` for the learned water/lava crossing policy.
- **`world_store.rs`** — persists `WorldCache` + the last `mc_version` to `world.cache` in the app
  data dir (`~/.local/share/dev.baritone.orchestrator/` on Linux), zlib-compressed with a magic +
  version header and atomic writes (`tmp` + rename). Loaded in `setup()`; saved every 5s only when
  `AppState.world_revision` changed (bumped by `addon_socket` per chunk) and once on
  `RunEvent::Exit`. Reuses `encode_voxels`/`decode_voxels` — one binary format for socket, IPC and
  disk. `crossing_hints` are **not** persisted yet.
- **`texture_atlas.rs`** — extracts block textures from the **local, already-installed** client jar
  (`~/.minecraft/versions/<mc_version>/<mc_version>.jar`) and packs them into a grid atlas, cached in
  `src-tauri/.cache/` (gitignored; the cache name carries `ATLAS_CACHE_VERSION`). **Never download or
  bundle Mojang assets** — this reads only what the user already has installed, per explicit user
  requirement (Mojang's license doesn't allow redistributing game assets). Animated textures (water,
  lava, fire) contribute every frame as `{stem}_fN` tiles (32×32 frames are downscaled to 16×16), with
  the bare name aliasing frame 0; a synthetic white tile (`WHITE_TILE_NAME`) is the tintable fallback
  for blocks with no matching texture. Has a real integration test (`cargo test texture_atlas`) that
  runs against whatever local jar exists, skipping itself (not failing) if none is found — keep that
  skip behavior if you touch this file, other environments won't have the jar.
- `storage_index.rs` — `StorageIndex` (chest position → contents) and `aggregated_totals()`.
- `items.rs` — `Item`, `Block`, `Recipe`, `IngredientRef`, `RecipeType`, `Station`, and
  `fits_inventory_2x2()` per the spec's "Receitas 2×2" section. Not populated from `minecraft-data`
  yet.
- `vitals.rs` — `Vitals`, `ArmorPiece`, `Effect`, and `classify_threat()` per "Combate e ameaças".
- `time_estimate.rs` — `estimate_mine`, `estimate_travel`, `pick_fill_task` per "Agendamento por
  estimativa de tempo".
- `instructions.rs` — `Instruction`, `InstructionStatus`, `InstructionQueue`. `activate_next_queued`
  takes a `can_execute` predicate so instructions without an executor (`Mine`/`Build` from the editor)
  stay queued **without blocking** the executable ones behind them.
- **`schematic.rs`** — editor diff (spec: "Como isso vira o editor estilo WorldEdit"): takes the
  frontend edit layer (`BlockEdit`, `None` = break) and compares it against the real `WorldCache`
  (`world_cache::block_at`), producing `break_blocks`/`build_blocks` (`SchematicBlock` = position +
  block, the shape Baritone's `BuilderProcess` consumes). Edits on unknown chunks are ignored. The
  spec's `blockstate_key` is just the block name for now (blockstates aren't modeled — see "Known
  gaps"). Has unit tests. `schematic_apply` stores the resulting lists in `AppState.schematics` keyed
  by instruction id (the queue is polled every second, so it must not carry hundreds of blocks).

**Addon (`mod-addon/`)**
- `BaritoneOrchestratorAddon.java` — common `@Mod` entry point. Holds `SOCKET_HOST`/`SOCKET_PORT` as
  constants (deliberately *not* on the client-only class — referencing a client-only class from common
  code risks a `NoClassDefFoundError` on a dedicated server).
- `BaritoneOrchestratorAddonClient.java` — `Dist.CLIENT`-only. On `ClientTickEvent.Post`, reads the
  player through `BaritoneAPI.getProvider().getPrimaryBaritone()` (proof the Baritone dependency works
  at runtime, not just compiles) and streams vitals (1x/s) and position + yaw/pitch (4x/s,
  `playerFeet()`) to the socket, with a 5s reconnect backoff if the Rust app isn't up. Also sends the
  player's own skin (`player_skin`, only when the texture changes — read from the client's own
  texture cache/resource pack) and subscribes to `ChunkEvent.Load` (filtered to `ClientLevel`) to
  send one `chunk_voxels` per chunk — separate from the tick loop.
- `neoforge.mods.toml` (templated from `gradle.properties`) declares Baritone as a required dependency
  — modid is `baritoe`, confirmed from the real jar, not `baritone`.

## 7. Known gaps (be honest about these, don't paper over them)

- **No chest/inventory data.** `StorageIndex` stays empty — `chunk_voxels` carries terrain, but no
  block entities, and there's no `ContainerScreen` simulation to read chests (see `docs/SPEC.md`,
  "Índice de armazenamento").
- **Chunks are a snapshot, not a live world.** `chunk_voxels` carries the chunk as it was when the
  client loaded it; block changes after that (mining, placing, opening a chest) aren't resent, so the
  viewer goes stale there until the chunk reloads. There is no per-block update delta channel yet.
- **Instructions only cover `travel_to`/`explore`.** The reverse channel works end to end
  (`queue_push` → addon → `instruction_status`), but `Mine`/`Build`/`FetchFromChest`/`Craft`/`Smelt`
  have no executor in the addon yet, and the UI composer only creates the two executable kinds.
- **No `SurvivalProcess`/threat *reaction* or `ContainerScreen` simulation in the addon** — the mob
  scan exists (the addon streams `entities` and the viewer identifies each mob with a label), but
  nothing fights, flees or raises a shield; the rest is still only described in `docs/SPEC.md`.
- **Mobs are identified, not modeled.** The viewer draws a projected label (real game name, category,
  distance, health) per mob — there is no entity-model/UV/animation pipeline for mob types (the
  atlas only covers block textures).
- **Biome tint is a fixed approximation, not the real colormap.** Grass/foliage/water textures are
  gray in the jar and get fixed tints (`GRASS_TINT` and friends in `viewer3d.ts`) instead of a
  per-column biome lookup — visually close, not exact. Blockstates (stair orientation, log axis,
  slabs) also aren't modeled yet: every block renders as a full cube.
- **No `minecraft-data` ingestion.** Item/block/recipe structs exist but nothing populates them.
  (Texture *extraction* is solved — see `texture_atlas.rs` — this is specifically about recipes/drops.)
- **`StorageIndex` is in-memory only** — no persistence across restarts. (The explored world *is*
  persisted now — one global `world.cache` per app, so switching between servers/worlds mixes their
  chunks in the same cache; there's no per-world separation yet.)
- **The schematic editor's blockstate/litematic/executor gaps.** The base editor works (visual
  palette from the atlas textures, region selection, place/break with an amber ghost layer, diff →
  queued instruction), but: every block renders as a full cube (no stair/log-axis/slab states, so no
  variant inspector and `blockstate_key` degrades to the block name), `.litematic` import isn't
  implemented, the palette derives block names from atlas texture names instead of a real block
  registry (`minecraft-data` ingestion still pending), and the addon has **no `Mine`/`Build`
  executor**, so applied schematics sit `Queued` in the queue.

## 8. Language and comment rules

- English is the default language for source code, comments, commit messages, and this file.
- User-facing strings in the app itself (`index.html`, template literals rendered to the DOM, error
  messages shown to the user) are in Brazilian Portuguese — see rule 5 above.
- Keep comments concise; add them only to explain non-obvious behavior or point back to the relevant
  `docs/SPEC.md` section, not to restate what the code already says.

## 9. Parallel work: one worktree per request, auto-merge and push into `origin/main`

More than one agent session can be working on this repo at the same time. Concurrent edits to the
same checkout lose writes and leave half-refactored trees behind (a Rust refactor and a texture fix
already landed on top of each other once). So: **one request = one worktree + one branch**, and
finished work is merged into `main` and pushed to `origin/main` — see "Finish" below.

### Start a task

**Every request gets its own worktree** — a feature, an edit, or a fix for something an agent
forgot. Don't reuse a previous task's worktree or branch, even for a one-line follow-up: the base
has to be the current `origin/main`, and mixing tasks in one branch is how this tree got
half-refactored before.

```bash
git fetch origin
git worktree add ../baritonelauncher-<slug> -b <slug> origin/main
cd ../baritonelauncher-<slug>
# Dependências: NÃO rode `npm install` — aponte pro que já está instalado no checkout primário.
ln -s /media/miguelsp/16a390df-c228-4540-a9b5-b4eeda5b6324/Github/baritonelauncher/node_modules node_modules
```

- Branch from **`origin/main`** (after `git fetch`), never from a stale local `main`.
- **Reuse the primary checkout's builds — this is what makes a fresh worktree cheap:**
  - `node_modules` → symlink the primary checkout's copy (above). It's already installed and works
    for `tsc`/`vite`. Only when `package.json`/`package-lock.json` actually changed: run `npm install`
    in the **primary checkout** (the shared install) and re-symlink — don't install per worktree.
  - Rust → `export CARGO_TARGET_DIR=/media/miguelsp/16a390df-c228-4540-a9b5-b4eeda5b6324/Github/baritonelauncher/src-tauri/target`
    before `cargo check`/`cargo test`, so the Tauri dependency tree isn't rebuilt from scratch
    (concurrent builds serialize on the same lock — that's fine).
- Worktrees live **as siblings** of the repo (`../baritonelauncher-<slug>`), never inside it — Vite,
  `tsc` and the app watchers would pick them up and rebuild over each other's files.
- If your harness can move the session's working directory into the worktree (e.g. OpenCode's
  `session_move`), do that — a `cd` inside one shell command does **not** change where the file
  editing tools write, and you'd silently keep editing the primary checkout.
- `<slug>` is short kebab-case for the task (`player-renderer`, `leaf-tint`, …).
- Never edit files in another session's worktree, and never edit the primary checkout while you have
  a task branch.
- Do the work, follow rule 4 (changelog), run the checks **in the worktree** (`npm run build`; `cd
  src-tauri && cargo check`, plus `cargo test` when you touched Rust), then commit — English commit
  messages, per section 8.

### Finish: integrate `origin/main`, verify, merge, push

Run this from inside the task worktree, only with the branch committed and its checks green:

1. Integrate the **remote** tip into your branch first — this is where conflicts show up, and fixing
   them on your own branch keeps the context fresh:
   ```bash
   git fetch origin
   git merge origin/main
   ```
   Resolve every conflict, re-run the checks, commit. Optional dry run, without touching anything:
   `git merge-tree --write-tree origin/main <slug>` — exit 0 = no textual conflict.
2. Merge into `main` and push — finished work is expected to land on `origin/main`. Prefer the
   primary checkout when it is **clean**; when it has another session's uncommitted work, don't
   touch it — use a temporary worktree of `main` instead:
   ```bash
   # primário limpo:
   cd /media/miguelsp/16a390df-c228-4540-a9b5-b4eeda5b6324/Github/baritonelauncher
   # primário sujo (nunca mexa no trabalho não commitado de outra sessão):
   # git worktree add ../baritonelauncher-main-merge main && cd ../baritonelauncher-main-merge
   git fetch origin
   git merge --ff-only origin/main     # o main local acompanha a origin
   git merge --no-ff <slug>
   ```
3. Verify the merged `main` with the same checks (`npm run build`; `cargo test` when Rust was
   touched). If it broke, `git reset --hard ORIG_HEAD` and go back to the worktree — **never push a
   broken `main`**.
4. Push: `git push origin main` (pre-authorized by this workflow, see rule 7).
5. Clean up only after the push: `git worktree remove ../baritonelauncher-<slug>` and `git branch -d
   <slug>`. If you used a temporary worktree of `main`, remove it too.

Notes:

- Textual conflicts are the easy case — the dangerous ones are semantic (main renamed a command
  while your branch still calls the old name). The checks **after** the merge are the real gate.
- One merge/push at a time: if `.git/MERGE_HEAD` exists, another session is mid-merge; wait. If the
  push is rejected because `origin/main` moved, go back to step 1 (`git fetch` + `git merge
  origin/main` on your branch) — never force-push.
- Abandoning a task? `git worktree remove --force ../baritonelauncher-<slug>` and `git branch -D
  <slug>` — don't leave stale worktrees around.
