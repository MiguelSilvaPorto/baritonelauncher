# Baritone Orchestrator — working guide (AI)

## 1. What it is

A desktop app (Tauri 2, Rust backend + TypeScript frontend) that orchestrates a **Baritone**
(Minecraft pathfinding mod) bot from outside the game: its own world viewer, an instruction queue,
a WorldEdit-style schematic editor, and a chest/storage index. Full product spec in
[`docs/SPEC.md`](docs/SPEC.md).

> Status: **minimal end-to-end slice working**. Identifier: `dev.baritone.orchestrator`. The UI shell,
> visual identity, Rust domain models, the Java addon (real NeoForge project), and the local socket
> between them are implemented and manually tested — the addon streams real player vitals from an
> actual Baritone-controlled game into the app's HUD. Chunk/chest/instruction streaming, the 3D
> renderer, and `minecraft-data` ingestion do not exist yet. See "Known gaps" in `README.md` before
> claiming something works.

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

- **Frontend:** TypeScript (strict) · Vite 8 · vanilla DOM, no framework.
- **Backend:** Rust (edition 2021) · Tauri 2 · `serde`/`serde_json` · `tauri-plugin-opener` ·
  `tauri-plugin-dialog` · `tokio` (powers `addon_socket.rs`, the local TCP server the Java addon
  connects to).
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

There is no test suite yet.

## 5. Non-negotiable rules

1. **No fabricated data in shipped UI.** Every Tauri command in `src-tauri/src/lib.rs` returns real
   state — `connection_status`/`vitals_snapshot` now reflect the addon's actual socket messages when
   connected; `queue_snapshot`/`storage_totals` still return empty vectors because nothing populates
   them yet. If you're tempted to hardcode a sample queue or chest so the UI "looks alive," don't —
   render the honest empty state instead (see `renderQueueInto`/`renderStorage` in `src/main.ts` for
   the pattern) and say in your reply that the feature has no backend yet.
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
7. **Do not commit/push without explicit permission** for that specific change. Leave changes in the
   working tree and say so; committing is the user's call.
8. **Never commit `mod-addon/libs/*.jar`.** The Baritone jar is fetched by `mod-addon/scripts/
   fetch-baritone.sh` (which verifies its SHA-1 against the official release's `checksums.txt`) and is
   gitignored — don't vendor third-party binaries into the repo.
9. **The addon must always compile against `baritone-api-*`, never `baritone-standalone-*`.** The
   standalone variant obfuscates the `baritone.api` package too, so it silently can't be used as a
   dependency — see `mod-addon/README.md` for the full explanation (sourced from Baritone's own
   `SETUP.md`).

## 6. Architecture at a glance

**Frontend (`src/main.ts`)**
- View router: `setMode(name)` toggles `.view.active` / `.rail-btn.active`; views are `viewer`,
  `editor`, `fila`, `armazem`.
- `refreshState()` polls all six Tauri commands every `REFRESH_INTERVAL_MS` (1s, matching the addon's
  vitals cadence) — there is no push from the Rust side, so this is polling, not a stream. It used to
  run once on load only; that was a real bug (UI froze on whatever was true at page load) fixed once
  the addon bridge existed and made it observable — don't reintroduce a one-shot call.
- `renderViewer`/`renderChunkGrid`/`renderHud`/`renderQueueInto`/`renderStorage` each render an honest
  empty state when the underlying data is empty — follow that pattern for new panels instead of
  inventing placeholder rows.
- `renderChunkGrid` + `worldToScreen` — real DOM chunk grid (one `div.chunk-cell` per explored chunk,
  camera centered on `world.bot_pos`) and the bot marker, positioned from actual game coordinates.
  Not the 3D block renderer from the spec — see "Known gaps."

**Backend (`src-tauri/src/`)**
- `lib.rs` — `AppState` (in-memory `WorldCache`, `StorageIndex`, `InstructionQueue`,
  `Option<Vitals>`, `ConnectionStatus`, all behind `Mutex`) + the six commands currently exposed:
  `connection_status`, `world_summary`, `world_chunks`, `queue_snapshot`, `storage_totals`,
  `vitals_snapshot`. Spawns `addon_socket::listen` in `setup()`.
- `addon_socket.rs` — TCP server on `127.0.0.1:31173`, one JSON message per line. Handles `hello`
  (marks `AppState.connection` as connected), `vitals` (fills `AppState.vitals`), `position` (fills
  `AppState.bot_pos`), and `chunk_loaded` (marks presence in `AppState.world` via `apply_delta` with
  an empty block map — deliberately cumulative, not removed on unload; see the module doc-comment for
  why). The matching Java client is
  `mod-addon/src/main/java/dev/baritone/orchestrator/addon/BaritoneOrchestratorAddonClient.java`.
  Extending the protocol further (e.g. real block data, chest contents) means updating the
  `AddonMessage` enum here **and** the Java sender in lockstep — they're not generated from a shared
  schema.
- `world_cache.rs` — sparse per-chunk block cache (`WorldCache`). Chunk presence is real
  (`chunk_loaded` messages), but no chunk has actual block data yet — that depends on the texture
  atlas pipeline from `docs/SPEC.md`, "Blocos 3D", not implemented. Also `CrossingStrategy` for the
  learned water/lava crossing policy.
- `storage_index.rs` — `StorageIndex` (chest position → contents) and `aggregated_totals()`.
- `items.rs` — `Item`, `Block`, `Recipe`, `IngredientRef`, `RecipeType`, `Station`, and
  `fits_inventory_2x2()` per the spec's "Receitas 2×2" section. Not populated from `minecraft-data`
  yet.
- `vitals.rs` — `Vitals`, `ArmorPiece`, `Effect`, and `classify_threat()` per "Combate e ameaças".
- `time_estimate.rs` — `estimate_mine`, `estimate_travel`, `pick_fill_task` per "Agendamento por
  estimativa de tempo".
- `instructions.rs` — `Instruction`, `InstructionStatus`, `InstructionQueue`.

**Addon (`mod-addon/`)**
- `BaritoneOrchestratorAddon.java` — common `@Mod` entry point. Holds `SOCKET_HOST`/`SOCKET_PORT` as
  constants (deliberately *not* on the client-only class — referencing a client-only class from common
  code risks a `NoClassDefFoundError` on a dedicated server).
- `BaritoneOrchestratorAddonClient.java` — `Dist.CLIENT`-only. On `ClientTickEvent.Post`, reads the
  player through `BaritoneAPI.getProvider().getPrimaryBaritone()` (proof the Baritone dependency works
  at runtime, not just compiles) and streams vitals (1x/s) and position (4x/s, `playerFeet()`) to the
  socket, with a 5s reconnect backoff if the Rust app isn't up. Also subscribes to `ChunkEvent.Load`
  (filtered to `ClientLevel`) to send one `chunk_loaded` per chunk — separate from the tick loop.
- `neoforge.mods.toml` (templated from `gradle.properties`) declares Baritone as a required dependency
  — modid is `baritoe`, confirmed from the real jar, not `baritone`.

## 7. Known gaps (be honest about these, don't paper over them)

- **`chunk_loaded` only marks presence, no block data.** `WorldCache.chunks[pos].blocks` stays empty —
  no chest/inventory data, no instructions sent from the Rust side to the addon yet either;
  `StorageIndex`/`InstructionQueue` stay empty even with the addon connected.
- **No `SurvivalProcess`/threat detection or `ContainerScreen` simulation in the addon** — still only
  described in `docs/SPEC.md`.
- **No 3D block rendering.** The viewer's chunk grid and bot marker use real game data (real chunk
  positions, real coordinates), but no chunk has actual block content — that needs the texture atlas
  pipeline from `docs/SPEC.md`, "Blocos 3D", not a wgpu surface change (the DOM-based grid can stay for
  the chunk-level view; textured blocks are a separate, additive layer).
- **No `minecraft-data`/jar ingestion.** Item/block/recipe/texture structs exist but nothing
  populates them.
- **`StorageIndex` is in-memory only** — no persistence across restarts.
- **Schematic editor is a placeholder panel**, not an implementation.

## 8. Language and comment rules

- English is the default language for source code, comments, commit messages, and this file.
- User-facing strings in the app itself (`index.html`, template literals rendered to the DOM, error
  messages shown to the user) are in Brazilian Portuguese — see rule 5 above.
- Keep comments concise; add them only to explain non-obvious behavior or point back to the relevant
  `docs/SPEC.md` section, not to restate what the code already says.
