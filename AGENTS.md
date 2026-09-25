# Baritone Orchestrator — working guide (AI)

## 1. What it is

A desktop app (Tauri 2, Rust backend + TypeScript frontend) that orchestrates a **Baritone**
(Minecraft pathfinding mod) bot from outside the game: its own world viewer, an instruction queue,
a WorldEdit-style schematic editor, and a chest/storage index. Full product spec in
[`docs/SPEC.md`](docs/SPEC.md).

> Status: **early scaffold**. Identifier: `dev.baritone.orchestrator`. The UI shell, visual identity,
> and Rust domain models exist; the Java addon that talks to Baritone and the socket that connects it
> to this app do not exist yet. See "Known gaps" in `README.md` before claiming something works.

## 2. Where you are

At the repository root — the app directory. It contains:

- `src/` — frontend: `main.ts` (all UI logic, no framework) + `styles.css`.
- `src-tauri/` — Rust/Tauri backend, single crate (`src/lib.rs` + one module per domain concept:
  `world_cache.rs`, `storage_index.rs`, `items.rs`, `vitals.rs`, `time_estimate.rs`,
  `instructions.rs`).
- `index.html` — the entire UI markup (titlebar, rail, the four views: viewer/editor/fila/armazém).
- `mod-addon/` — **documentation only**, no Gradle project yet — see its `README.md` for why.
- `docs/SPEC.md` — the full product/architecture spec. Treat it as the source of truth for behavior
  that isn't implemented yet; don't re-derive decisions it already made.
- `docs/CHANGELOG.md` — user-facing history.

There is no component framework and no bundled state library: `main.ts` renders views by toggling
`.active` on `<section class="view">` elements and re-rendering `innerHTML` strings for lists.

## 3. Stack

- **Frontend:** TypeScript (strict) · Vite 8 · vanilla DOM, no framework.
- **Backend:** Rust (edition 2021) · Tauri 2 · `serde`/`serde_json` · `tauri-plugin-opener` ·
  `tauri-plugin-dialog`. `tokio` is a dependency in anticipation of the local socket server to the
  Java addon, not wired to anything yet.
- **Styling:** one `src/styles.css`, plain CSS custom properties under `:root` — the fixed dark
  identity from `docs/SPEC.md` ("Identidade visual"), not a multi-theme system.

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
   (today: honestly empty) state — `connection_status` reports `connected: false` because there is no
   socket yet, `queue_snapshot`/`storage_totals` return empty vectors. If you're tempted to hardcode a
   sample queue or chest so the UI "looks alive," don't — render the honest empty state instead (see
   `renderQueueInto`/`renderStorage` in `src/main.ts` for the pattern) and say in your reply that the
   feature has no backend yet.
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
8. **Don't scaffold the Java addon (`mod-addon/`) as fake-working Gradle boilerplate.** It needs a real
   Forge/Fabric MDK and a real Baritone dependency to mean anything — see `mod-addon/README.md`.

## 6. Architecture at a glance

**Frontend (`src/main.ts`)**
- View router: `setMode(name)` toggles `.view.active` / `.rail-btn.active`; views are `viewer`,
  `editor`, `fila`, `armazem`.
- `refreshState()` calls all five Tauri commands once on load and renders each panel; there is no
  live push yet (no socket on the Rust side to push from), so this is a manual snapshot, not a stream.
- `renderViewer`/`renderHud`/`renderQueueInto`/`renderStorage` each render an honest empty state when
  the underlying data is empty — follow that pattern for new panels instead of inventing placeholder
  rows.

**Backend (`src-tauri/src/`)**
- `lib.rs` — `AppState` (in-memory `WorldCache`, `StorageIndex`, `InstructionQueue`,
  `Option<Vitals>`, all behind `Mutex`) + the five commands currently exposed:
  `connection_status`, `world_summary`, `queue_snapshot`, `storage_totals`, `vitals_snapshot`.
- `world_cache.rs` — sparse per-chunk block cache (`WorldCache`), populated by chunk deltas from the
  Java addon (not implemented). Also `CrossingStrategy` for the learned water/lava crossing policy
  from `docs/SPEC.md`.
- `storage_index.rs` — `StorageIndex` (chest position → contents) and `aggregated_totals()`.
- `items.rs` — `Item`, `Block`, `Recipe`, `IngredientRef`, `RecipeType`, `Station`, and
  `fits_inventory_2x2()` per the spec's "Receitas 2×2" section. Not populated from `minecraft-data`
  yet.
- `vitals.rs` — `Vitals`, `ArmorPiece`, `Effect`, and `classify_threat()` per "Combate e ameaças".
- `time_estimate.rs` — `estimate_mine`, `estimate_travel`, `pick_fill_task` per "Agendamento por
  estimativa de tempo".
- `instructions.rs` — `Instruction`, `InstructionStatus`, `InstructionQueue`.

## 7. Known gaps (be honest about these, don't paper over them)

- **No socket to the Java addon.** `connection_status` always reports disconnected.
- **No Java addon.** `mod-addon/` is documentation only.
- **No real 3D renderer.** The viewer is a 2D grid faithful to the documented visual identity
  (fog gradient, ghost outlines, glowing bot marker), not a wgpu surface yet.
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
