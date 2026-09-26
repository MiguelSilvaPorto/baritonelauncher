import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Viewer3D,
  CHUNKS_PER_REFRESH,
  type ChunkPos,
  type BotPos,
  type UvRect,
  type EditMode,
} from "./viewer3d";

interface TextureAtlas {
  image_data_url: string;
  textures: Record<string, UvRect>;
}

/* ---------- Tipos (espelham as structs em src-tauri/src) ---------- */

interface ConnectionStatus {
  connected: boolean;
  endpoint?: string;
}

interface WorldSummary {
  chunks_explored: number;
  chunks_total_estimate: number;
  bot_pos?: BotPos;
}

type InstructionStatus = "Queued" | "Active" | "Paused" | "Done" | "Failed" | "Canceled";
type InstructionKind =
  | "Explore"
  | "Mine"
  | "Build"
  | "FetchFromChest"
  | "Craft"
  | "Smelt"
  | "TravelTo";

/** Alvo horizontal (x, z) — ver `InstructionTarget` em src-tauri/src/instructions.rs. */
interface InstructionTarget {
  x: number;
  z: number;
}

interface Instruction {
  id: string;
  kind: InstructionKind;
  label: string;
  status: InstructionStatus;
  progress: number;
  target: InstructionTarget | null;
}

interface ItemTotal {
  item_id: number;
  total: number;
  chest_count: number;
}

interface ArmorPiece {
  item_id: number;
  durability_pct: number;
}

interface Vitals {
  health: number;
  max_health: number;
  hunger: number;
  saturation: number;
  armor_points: number;
  armor_pieces: (ArmorPiece | null)[];
  active_effects: { name: string; duration_ticks: number; amplifier: number }[];
}

/* ---------- Helpers ---------- */

const $ = <T extends Element = Element>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends Element = Element>(sel: string) => Array.from(document.querySelectorAll(sel)) as T[];

/* ---------- Navegação (rail) ---------- */

function setMode(mode: string) {
  $$(".view").forEach((el) => el.classList.toggle("active", el.id === `view-${mode}`));
  $$(".rail-btn").forEach((el) => el.classList.toggle("active", (el as HTMLElement).dataset.mode === mode));
  // O mesmo renderer WebGL serve viewer e editor (spec: "mesmo motor de
  // render") — o canvas é movido pra view ativa em vez de abrir um segundo
  // contexto WebGL. A view trocada fica display:none, então o tamanho só pode
  // ser corrigido depois da troca.
  if (mode === "editor") {
    viewer3d?.mountTo($<HTMLElement>("#editor-canvas"));
  } else if (mode === "viewer") {
    viewer3d?.mountTo($<HTMLElement>("#viewer-3d"));
  }
  if (mode === "editor" || mode === "viewer") viewer3d?.resize();
}

function bootstrapRail() {
  $$<HTMLButtonElement>(".rail-btn").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode ?? "viewer"));
  });
  setMode("viewer");
}

/* ---------- Titlebar customizada ---------- */

function bootstrapTitlebar() {
  const win = getCurrentWindow();
  $("#win-min").addEventListener("click", () => win.minimize());
  $("#win-max").addEventListener("click", () => win.toggleMaximize());
  $("#win-close").addEventListener("click", () => win.close());
}

/* ---------- Fila de instruções ---------- */

const STATUS_LABEL: Record<InstructionStatus, string> = {
  Queued: "na fila",
  Active: "ativo",
  Paused: "pausado",
  Done: "concluído",
  Failed: "falhou",
  Canceled: "cancelado",
};

function queueCard(instruction: Instruction): string {
  const statusClass = `status-${instruction.status.toLowerCase()}`;
  const cancellable = instruction.status === "Queued" || instruction.status === "Active";
  // `Explore` é contínuo e não tem progresso mensurável (o addon não manda
  // `progress`) — barra só onde existe progresso real, nada de fingir 0%.
  const showBar = !(instruction.kind === "Explore" && instruction.status === "Active");
  return `
    <div class="queue-card ${statusClass}">
      <div class="row1">
        <span class="label">${instruction.label}</span>
        <span class="kind mono">${STATUS_LABEL[instruction.status]}</span>
      </div>
      ${showBar ? `<div class="bar"><span style="width:${Math.round(instruction.progress * 100)}%"></span></div>` : ""}
      ${cancellable ? `<button type="button" class="queue-cancel" data-queue-cancel="${instruction.id}">cancelar</button>` : ""}
    </div>
  `;
}

function renderQueueInto(listId: string, countId: string | null, items: Instruction[]) {
  const list = $(`#${listId}`);
  if (items.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <span class="headline">Fila vazia</span>
        <span class="detail">Enfileire uma instrução acima: "Ir para" manda o bot viajar até as coordenadas x/z e "Explorar" cobre a área a partir de onde ele está — o addon executa com o pathing do Baritone e devolve status/progresso. Resolução automática de dependências (baú/craft) ainda não está ligada.</span>
      </div>
    `;
  } else {
    list.innerHTML = items.map(queueCard).join("");
  }
  if (countId) $(`#${countId}`).textContent = String(items.length);
}

function renderQueue(items: Instruction[]) {
  renderQueueInto("queue-list", "queue-count", items);
  renderQueueInto("queue-list-full", "queue-count-full", items);
}

/** Mesma instrução "Ir para"/"Explorar" nos dois painéis de fila (viewer e
 *  view cheia) — `lastBotPos` vem do polling e é a origem do "Explorar". */
function bootstrapQueueComposers() {
  $$<HTMLElement>(".queue-composer").forEach((composer) => {
    const xInput = composer.querySelector<HTMLInputElement>('input[name="x"]');
    const zInput = composer.querySelector<HTMLInputElement>('input[name="z"]');

    composer.querySelector('[data-queue-action="travel"]')?.addEventListener("click", () => {
      const x = Number(xInput?.value);
      const z = Number(zInput?.value);
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        (Number.isFinite(x) ? zInput : xInput)?.focus();
        return;
      }
      invoke<Instruction[]>("queue_push", { kind: "TravelTo", target: { x: Math.round(x), z: Math.round(z) } })
        .then(renderQueue)
        .catch((err) => console.error("[fila] ir para falhou:", err));
    });

    composer.querySelector('[data-queue-action="explore"]')?.addEventListener("click", () => {
      const target = lastBotPos ? { x: lastBotPos.x, z: lastBotPos.z } : null;
      invoke<Instruction[]>("queue_push", { kind: "Explore", target })
        .then(renderQueue)
        .catch((err) => console.error("[fila] explorar falhou:", err));
    });
  });
}

function bootstrapQueueActions() {
  // Delegação: os cards são innerHTML recriado a cada refresh, então o
  // listener fica no container, não no botão.
  $$<HTMLElement>(".queue-list").forEach((list) => {
    list.addEventListener("click", (event) => {
      const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-queue-cancel]");
      if (!btn) return;
      invoke<Instruction[]>("queue_cancel", { id: btn.dataset.queueCancel })
        .then(renderQueue)
        .catch((err) => console.error("[fila] cancelar falhou:", err));
    });
  });
}

/* ---------- Armazém ---------- */

function renderStorage(totals: ItemTotal[]) {
  const body = $("#storage-body");
  const footer = $("#storage-footer");

  if (totals.length === 0) {
    body.innerHTML = `
      <div class="empty-state" style="height: 100%;">
        <span class="headline">Nenhum baú indexado</span>
        <span class="detail">Baús aparecem aqui assim que o addon Java reporta posição e conteúdo pelo socket local — ver <code>docs/SPEC.md</code>, seção "Índice de armazenamento".</span>
      </div>
    `;
    footer.innerHTML = `<div class="footer-row"><span class="label">totais</span><span class="value mono">—</span></div>`;
    return;
  }

  body.innerHTML = `
    <table class="item-table">
      <thead><tr><th>item</th><th>baús</th><th>quantidade</th></tr></thead>
      <tbody>
        ${totals
          .map(
            (t) => `<tr><td class="mono">#${t.item_id}</td><td class="num mono">${t.chest_count}</td><td class="num mono">${t.total}</td></tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;

  footer.innerHTML = totals
    .slice(0, 6)
    .map((t) => `<div class="footer-row"><span class="label">#${t.item_id}</span><span class="value mono">${t.total}</span></div>`)
    .join("");
}

/* ---------- Viewer: status de conexão + resumo do mundo ---------- */

function renderViewer(status: ConnectionStatus, world: WorldSummary) {
  const empty = $("#viewer-empty");
  const endpoint = $("#viewer-endpoint");
  const hasWorld = world.chunks_explored > 0;

  // Sem conexão e sem nada em cache não há o que renderizar — estado honesto,
  // e a cena é limpa (ex: primeira execução, ou cache apagado).
  if (!status.connected && !hasWorld) {
    empty.classList.remove("hidden");
    endpoint.textContent = "socket: aguardando o addon Java";
    viewer3d?.clear();
    return;
  }

  empty.classList.add("hidden");
  endpoint.textContent = status.connected
    ? `socket: ${status.endpoint ?? "conectado"}`
    : "jogo não conectado — mostrando o mundo em cache";

  let chip = $<HTMLElement>("#progress-chip");
  if (!chip) {
    chip = document.createElement("div");
    chip.id = "progress-chip";
    chip.className = "progress-chip";
    $("#viewer-canvas").appendChild(chip);
  }
  // Sem uma noção real de "total do mundo" (isso exigiria saber o quanto
  // falta explorar, que não temos), a barra de progresso só faz sentido
  // quando chunks_total_estimate vem preenchido. Sem isso, mostrar "0%"
  // seria inventar um dado — então só a contagem crua.
  if (!status.connected) {
    chip.innerHTML = `<span class="pct mono">${world.chunks_explored} chunks em cache</span>`;
  } else if (world.chunks_total_estimate > 0) {
    const pct = Math.round((world.chunks_explored / world.chunks_total_estimate) * 100);
    chip.innerHTML = `
      <div class="bar"><span style="width:${pct}%"></span></div>
      <span class="pct mono">${pct}% · ${world.chunks_explored} / ${world.chunks_total_estimate} chunks</span>
    `;
  } else {
    chip.innerHTML = `<span class="pct mono">${world.chunks_explored} chunks vistos</span>`;
  }
}

/* ---------- Editor de schematic ---------- */

interface SchematicApplyResult {
  breaks: number;
  builds: number;
  instruction_ids: string[];
}

/** Categorias são conveniência de UI (agrupamento por nome), não dado do
 * jogo — o registro de blocos do `minecraft-data` ainda não existe. A ordem
 * importa: o primeiro padrão que casar define a categoria. */
const PALETTE_CATEGORIES: { id: string; label: string; match: RegExp | null }[] = [
  { id: "all", label: "Todas", match: null },
  { id: "terrain", label: "Terreno", match: /(dirt|grass|sand|gravel|clay|mud|snow|podzol|mycelium|moss|farmland|path)/ },
  { id: "stone", label: "Pedra", match: /(stone|cobble|deepslate|andesite|diorite|granite|tuff|basalt|obsidian|brick|terracotta|calcite|dripstone|quartz|prismarine|blackstone)/ },
  { id: "wood", label: "Madeira", match: /(planks|log|wood|stem|hyphae|bamboo)/ },
  { id: "plants", label: "Plantas", match: /(leaves|sapling|flower|grass|fern|vine|cactus|mushroom|wheat|kelp|seagrass|lily|berry|azalea|torchflower|pitcher)/ },
  { id: "glass", label: "Vidro", match: /(glass|pane)/ },
  { id: "wool", label: "Lã", match: /(wool|carpet)/ },
  { id: "metal", label: "Metal", match: /(iron|gold|copper|netherite|anvil|chain|rail|lantern)/ },
  { id: "other", label: "Outros", match: null },
];

/** Teto de itens desenhados por vez — a busca filtra o resto (o atlas tem
 * centenas de texturas). */
const PALETTE_LIMIT = 120;

let paletteCategory = "all";
let paletteQuery = "";

function paletteCategoryOf(block: string): string {
  for (const category of PALETTE_CATEGORIES) {
    if (category.id !== "all" && category.match?.test(block)) return category.id;
  }
  return "other";
}

function setEditorStatus(message: string) {
  $("#editor-status").textContent = message;
}

function renderPalette() {
  const grid = $("#palette-grid");
  const categoriesEl = $("#palette-categories");
  const countEl = $("#palette-count");
  const blocks = viewer3d?.getEditableBlocks() ?? [];

  if (blocks.length === 0) {
    countEl.textContent = "0";
    grid.innerHTML = `
      <div class="empty-state">
        <span class="headline">Paleta vazia</span>
        <span class="detail">
          A paleta é montada com as texturas reais do atlas, que só existe depois da primeira
          conexão do addon (é de lá que vem a versão do Minecraft).
        </span>
      </div>
    `;
    return;
  }

  // Só categorias com pelo menos um bloco — nada de botão que não filtra nada.
  const present = new Set(blocks.map(paletteCategoryOf));
  categoriesEl.innerHTML = PALETTE_CATEGORIES.filter(
    (category) => category.id === "all" || present.has(category.id)
  )
    .map(
      (category) =>
        `<button type="button" class="palette-category${category.id === paletteCategory ? " active" : ""}" data-palette-category="${category.id}">${category.label}</button>`
    )
    .join("");

  const query = paletteQuery.trim().toLowerCase();
  const filtered = blocks.filter((block) => {
    if (paletteCategory !== "all" && paletteCategoryOf(block) !== paletteCategory) return false;
    return query === "" || block.toLowerCase().includes(query);
  });

  countEl.textContent = String(filtered.length);
  const shown = filtered.slice(0, PALETTE_LIMIT);
  const selected = viewer3d?.getPlaceBlock() ?? null;
  grid.innerHTML =
    shown
      .map((block) => {
        const icon = viewer3d?.blockIconDataUrl(block);
        const active = block === selected ? " active" : "";
        return `
          <button type="button" class="palette-item${active}" data-palette-block="${block}" title="${block}">
            ${icon ? `<img src="${icon}" alt="" />` : ""}
            <span>${block.replace(/_/g, " ")}</span>
          </button>
        `;
      })
      .join("") +
    (filtered.length > shown.length
      ? `<div class="palette-more">+${filtered.length - shown.length} blocos — refine a busca</div>`
      : "");
}

function updateEditorStatus() {
  const stats = viewer3d?.getEditStats() ?? { total: 0, breaks: 0, builds: 0 };
  const region = viewer3d?.getSelection() ?? null;
  const place = viewer3d?.getPlaceBlock() ?? null;
  const parts: string[] = [];
  if (stats.total === 0) parts.push("nenhuma edição");
  else parts.push(`${stats.total} edições (${stats.breaks} quebrar / ${stats.builds} colocar)`);
  if (region) {
    const size = `${region.max.x - region.min.x + 1}×${region.max.y - region.min.y + 1}×${region.max.z - region.min.z + 1}`;
    parts.push(`região ${size} em (${region.min.x},${region.min.y},${region.min.z})`);
  }
  if (place) parts.push(`bloco: ${place}`);
  setEditorStatus(parts.join(" · "));
  $<HTMLButtonElement>("#editor-apply").disabled = stats.total === 0;
}

async function applyEdits() {
  if (!viewer3d) return;
  const edits = viewer3d.getEdits();
  if (edits.length === 0) return;
  try {
    const result = await invoke<SchematicApplyResult>("schematic_apply", { edits });
    viewer3d.clearEdits();
    viewer3d.clearSelection();
    if (result.breaks === 0 && result.builds === 0) {
      setEditorStatus("As edições já batem com o mundo real — nada pra enfileirar.");
      return;
    }
    setEditorStatus(
      `Na fila: ${result.breaks} blocos pra quebrar e ${result.builds} pra construir. ` +
        "O addon ainda não executa build/mina — a instrução espera um executor (ver Known gaps)."
    );
  } catch (err) {
    console.error("[editor] aplicar falhou:", err);
    setEditorStatus("Falha ao aplicar as edições — veja o console.");
  }
}

function bootstrapEditor() {
  if (!viewer3d) return;
  viewer3d.onEditChange = updateEditorStatus;
  viewer3d.onNotice = (message) => setEditorStatus(message);
  viewer3d.onAtlasReady = renderPalette;

  $$<HTMLButtonElement>("[data-editor-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tool = btn.dataset.editorTool as EditMode;
      // Clicar de novo na ferramenta ativa desliga (volta a só orbitar).
      const next = viewer3d?.getEditMode() === tool ? null : tool;
      viewer3d?.setEditMode(next);
      $$("[data-editor-tool]").forEach((el) =>
        el.classList.toggle("active", el === btn && next !== null)
      );
      if (next === "place" && !viewer3d?.getPlaceBlock()) {
        setEditorStatus("Escolha um bloco na paleta pra colocar.");
      }
    });
  });

  $("#editor-apply").addEventListener("click", () => void applyEdits());
  $("#editor-clear-edits").addEventListener("click", () => viewer3d?.clearEdits());
  $("#editor-clear-selection").addEventListener("click", () => viewer3d?.clearSelection());

  $("#palette-search").addEventListener("input", (event) => {
    paletteQuery = (event.target as HTMLInputElement).value;
    renderPalette();
  });

  $("#palette-categories").addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-palette-category]");
    if (!btn) return;
    paletteCategory = btn.dataset.paletteCategory ?? "all";
    renderPalette();
  });

  // Delegação: o grid é innerHTML recriado a cada render.
  $("#palette-grid").addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-palette-block]");
    if (!btn) return;
    viewer3d?.setPlaceBlock(btn.dataset.paletteBlock ?? null);
    // Escolher bloco já arma a ferramenta de colocar; clicar de novo nela fecha.
    viewer3d?.setEditMode("place");
    $$("[data-editor-tool]").forEach((el) =>
      el.classList.toggle("active", (el as HTMLElement).dataset.editorTool === "place")
    );
    renderPalette();
  });

  renderPalette();
  updateEditorStatus();
}

/* ---------- HUD de vitais ---------- */

function armorClass(pct: number): string {
  if (pct > 50) return "ok";
  if (pct >= 20) return "warn";
  return "crit";
}

function renderHud(vitals: Vitals | null) {
  let hud = $<HTMLElement>("#hud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "hud";
    hud.className = "hud";
    $("#viewer-canvas").appendChild(hud);
  }

  if (!vitals) {
    hud.innerHTML = `
      <div class="hud-stat"><span class="stat-label">vida</span><span class="stat-value mono">—</span></div>
      <div class="hud-stat"><span class="stat-label">fome</span><span class="stat-value mono">—</span></div>
      <div class="hud-stat"><span class="stat-label">armadura</span><span class="stat-value mono">—</span></div>
    `;
    return;
  }

  const healthPct = Math.round((vitals.health / vitals.max_health) * 100);
  const hungerPct = Math.round((vitals.hunger / 20) * 100);
  const armorPips = vitals.armor_pieces
    .map((piece) => `<span class="armor-pip ${piece ? armorClass(piece.durability_pct * 100) : ""}"></span>`)
    .join("");

  hud.innerHTML = `
    <div class="hud-stat">
      <span class="stat-label">vida</span>
      <div class="stat-row">
        <div class="stat-track health"><span style="width:${healthPct}%"></span></div>
        <span class="stat-value mono">${vitals.health.toFixed(0)}/${vitals.max_health.toFixed(0)}</span>
      </div>
    </div>
    <div class="hud-stat">
      <span class="stat-label">fome</span>
      <div class="stat-row">
        <div class="stat-track hunger"><span style="width:${hungerPct}%"></span></div>
        <span class="stat-value mono">${vitals.hunger}/20</span>
      </div>
    </div>
    <div class="hud-stat">
      <span class="stat-label">armadura</span>
      <div class="armor-pips">${armorPips}</div>
    </div>
  `;
}

/* ---------- Bootstrap ---------- */

let viewer3d: Viewer3D | null = null;
/** Última posição do bot (do polling) — origem do "Explorar" no composer. */
let lastBotPos: BotPos | null = null;
/** Chunks já pedidos e ainda não resolvidos — evita pedir de novo no próximo
 * refresh antes da resposta do anterior chegar. */
const pendingChunks = new Set<string>();

function requestChunk(pos: ChunkPos) {
  const key = `${pos.x},${pos.z}`;
  if (!viewer3d || viewer3d.hasChunk(pos.x, pos.z) || pendingChunks.has(key)) return;
  pendingChunks.add(key);
  invoke<ArrayBuffer | number[]>("chunk_voxels", { x: pos.x, z: pos.z })
    .then((raw) => {
      // `tauri::ipc::Response` chega como ArrayBuffer; o fallback cobre uma
      // resposta JSON antiga em vez de estourar.
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw);
      viewer3d?.addChunkVoxels(pos.x, pos.z, bytes);
    })
    .catch((err) => console.error(`[chunk_voxels] (${pos.x}, ${pos.z})`, err))
    .finally(() => pendingChunks.delete(key));
}

async function refreshState() {
  const [status, world, chunks, queue, totals, vitals] = await Promise.all([
    invoke<ConnectionStatus>("connection_status"),
    invoke<WorldSummary>("world_summary"),
    invoke<ChunkPos[]>("world_chunks"),
    invoke<Instruction[]>("queue_snapshot"),
    invoke<ItemTotal[]>("storage_totals"),
    invoke<Vitals | null>("vitals_snapshot"),
  ]);

  lastBotPos = world.bot_pos ?? null;
  renderViewer(status, world);

  if (viewer3d) {
    // Atlas: não depende mais do jogo estar aberto — a versão do MC fica no
    // cache em disco (ver `world_store.rs`), então o mundo persistido abre
    // texturizado. Sem versão conhecida (nunca conectou), o comando falha e
    // a tentativa se repete no próximo refresh.
    if (
      !viewer3d.hasAtlas() &&
      !viewer3d.isLoadingAtlas &&
      (status.connected || world.chunks_explored > 0)
    ) {
      invoke<TextureAtlas>("get_texture_atlas")
        .then((atlas) => viewer3d?.setAtlas(atlas.image_data_url, atlas.textures))
        .catch((err) => console.warn("[atlas] ainda indisponível:", err));
    }

    // Sempre chamado: com o jogo fechado o `bot_pos` do Rust volta a ser
    // `None`, e sem isso o marcador ficaria congelado na última posição.
    viewer3d.setBotPos(world.bot_pos ?? null);

    // Voxels são buscados aos poucos: montar malha é CPU na thread
    // principal, então um backfill de centenas de chunks numa tacada
    // travaria o viewer. O resto fica na fila implícita do Rust e chega
    // nos próximos refreshes — vale igual pro mundo vindo do cache em
    // disco, que também chega inteiro de uma vez em `world_chunks`.
    let budget = CHUNKS_PER_REFRESH;
    for (const pos of chunks) {
      if (budget <= 0) break;
      if (viewer3d.hasChunk(pos.x, pos.z) || pendingChunks.has(`${pos.x},${pos.z}`)) continue;
      requestChunk(pos);
      budget--;
    }
  }
  renderHud(vitals);
  renderQueue(queue);
  renderStorage(totals);
}

// 1s = mesmo intervalo de envio de vitais do addon (ver addon_socket.rs) — não
// há push do backend pro frontend ainda, então isso é polling, não streaming.
const REFRESH_INTERVAL_MS = 1000;

window.addEventListener("DOMContentLoaded", () => {
  bootstrapRail();
  bootstrapTitlebar();
  bootstrapQueueComposers();
  bootstrapQueueActions();

  viewer3d = new Viewer3D($<HTMLElement>("#viewer-3d"), $<HTMLDivElement>("#bot-label"));
  window.addEventListener("resize", () => viewer3d?.resize());
  bootstrapEditor();

  refreshState();
  setInterval(refreshState, REFRESH_INTERVAL_MS);
});
