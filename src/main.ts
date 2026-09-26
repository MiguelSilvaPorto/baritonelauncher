import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Viewer3D,
  CHUNKS_PER_REFRESH,
  NEARBY_CHUNK_LIMIT,
  type BotPos,
  type BotPose,
  type ChunkPos,
  type UvRect,
  type EditMode,
  type MobCategory,
  type NearbyMob,
} from "./viewer3d";

interface TextureAtlas {
  image_data_url: string;
  textures: Record<string, UvRect>;
  /** PNG das nuvens do jar local (ver `texture_atlas.rs`); ausente = sem nuvens. */
  cloud_data_url?: string | null;
}

/* ---------- Tipos (espelham as structs em src-tauri/src) ---------- */

interface ConnectionStatus {
  connected: boolean;
  endpoint?: string;
}

interface WorldSummary {
  chunks_explored: number;
  chunks_total_estimate: number;
  bot_pos?: BotPos | null;
  /** Onde o bot foi visto por último — persistido em `world.json`
   *  (`world_store.rs`) e usado como âncora com o jogo fechado, pra câmera não
   *  abrir na origem enquanto o terreno explorado está a centenas de blocos
   *  dali. */
  last_bot_pos?: BotPos | null;
}

/** Skin real do jogador (comando `player_skin`, ver `player_skin.rs`). */
interface PlayerSkin {
  name: string;
  model: string;
  image_data_url: string;
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

/** Padrão de varredura da exploração com raio — espelha `ExploreStyle`. */
type ExploreStyle = "Circles" | "Zigzag";
interface ExploreParams {
  radius: number;
  style: ExploreStyle;
}

interface Instruction {
  id: string;
  kind: InstructionKind;
  label: string;
  status: InstructionStatus;
  progress: number;
  target: InstructionTarget | null;
  explore: ExploreParams | null;
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

/** Snapshot dos mobs vivos ao redor do bot (comando `nearby_mobs`, ver
 *  `src-tauri/src/mobs.rs`). `radius` é o raio realmente varrido pelo addon. */
interface MobSnapshot {
  radius: number;
  mobs: NearbyMob[];
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
  // A aba Jogar lê o disco (instâncias/mundos): atualiza ao entrar nela em
  // vez de a cada segundo no polling geral.
  if (mode === "jogar") void refreshLaunch();
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
  // Barra só onde existe progresso real: `Explore` sem raio/estilo é contínuo
  // (o addon não manda `progress`) e cancelado/falhou não têm o que medir.
  const showBar =
    instruction.status !== "Canceled" &&
    instruction.status !== "Failed" &&
    !(instruction.kind === "Explore" && instruction.status === "Active" && !instruction.explore);
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
        <span class="detail">Clique num bloco do terreno pra mirar um destino ("Ir para" ou "Explorar daqui"), ou digite as coordenadas x/z acima. O addon executa com o pathing do Baritone e devolve status/progresso. Resolução automática de dependências (baú/craft) ainda não está ligada.</span>
      </div>
    `;
  } else {
    list.innerHTML = items.map(queueCard).join("");
  }
  if (countId) $(`#${countId}`).textContent = String(items.length);
}

/** Cancelado fica um tempinho visível (pra você ver que o cancelamento valeu)
 *  e depois some sozinho da fila — senão os cards cancelados se acumulam pra
 *  sempre. O backend mantém o histórico; isso é só apresentação. */
const CANCELED_LINGER_MS = 4000;
const canceledSeenAt = new Map<string, number>();

function visibleQueue(items: Instruction[]): Instruction[] {
  const now = performance.now();
  const visible: Instruction[] = [];
  for (const item of items) {
    if (item.status !== "Canceled") {
      visible.push(item);
      continue;
    }
    const seenAt = canceledSeenAt.get(item.id) ?? now;
    canceledSeenAt.set(item.id, seenAt);
    if (now - seenAt < CANCELED_LINGER_MS) visible.push(item);
  }
  return visible;
}

function renderQueue(items: Instruction[]) {
  const visible = visibleQueue(items);
  renderQueueInto("queue-list", "queue-count", visible);
  renderQueueInto("queue-list-full", "queue-count-full", visible);
}

/** Raio + estilo do "Explorar" a partir dos controles do painel/popup.
 *  `null` = exploração nativa do Baritone (sem raio, sem progresso); "auto" no
 *  select é essa opção, e sem raio digitado o padrão é 256 blocos. */
function readExploreParams(scope: HTMLElement): ExploreParams | null {
  const styleValue = scope.querySelector<HTMLSelectElement>('select[name="style"]')?.value ?? "auto";
  if (styleValue === "auto") return null;
  const rawRadius = Number(scope.querySelector<HTMLInputElement>('input[name="radius"]')?.value);
  const radius = Number.isFinite(rawRadius) && rawRadius > 0 ? Math.round(rawRadius) : 256;
  return {
    radius: Math.min(Math.max(radius, 16), 5000),
    style: styleValue === "Zigzag" ? "Zigzag" : "Circles",
  };
}

/** Enfileira e re-renderiza a fila na hora — o comando devolve o estado
 *  atualizado, então a UI não espera o polling de 1s. */
function pushQueueInstruction(kind: InstructionKind, target: InstructionTarget | null, explore: ExploreParams | null = null) {
  return invoke<Instruction[]>("queue_push", { kind, target, explore })
    .then((queue) => {
      renderQueue(queue);
      return queue;
    })
    .catch((err) => {
      console.error("[fila] enfileirar falhou:", err);
      return null;
    });
}

/** Mesma instrução "Ir para"/"Explorar" nos dois painéis de fila (viewer e
 *  view cheia) — `lastBotPos` vem do polling e é a origem do "Explorar".
 *  Digitar continua sendo o caminho secundário: o principal é clicar no
 *  terreno (ver `bootstrapTargetPopup`). */
function bootstrapQueueComposers() {
  $$<HTMLElement>(".queue-composer").forEach((composer) => {
    const xInput = composer.querySelector<HTMLInputElement>('input[name="x"]');
    const zInput = composer.querySelector<HTMLInputElement>('input[name="z"]');
    const travelBtn = composer.querySelector<HTMLButtonElement>('[data-queue-action="travel"]');
    const exploreBtn = composer.querySelector<HTMLButtonElement>('[data-queue-action="explore"]');

    const travel = () => {
      // Campo vazio não é zero: `Number("")` é 0 e passaria pelo
      // `Number.isFinite`, enfileirando "ir para (0, 0)" sem o usuário pedir.
      const xRaw = xInput?.value.trim() ?? "";
      const zRaw = zInput?.value.trim() ?? "";
      const x = Number(xRaw);
      const z = Number(zRaw);
      if (xRaw === "" || !Number.isFinite(x)) {
        xInput?.focus();
        return;
      }
      if (zRaw === "" || !Number.isFinite(z)) {
        zInput?.focus();
        return;
      }
      pushQueueInstruction("TravelTo", { x: Math.round(x), z: Math.round(z) });
    };

    travelBtn?.addEventListener("click", travel);
    // Enter no campo confirma o "Ir para" — digitar coordenada não deveria
    // exigir tirar a mão do teclado.
    for (const input of [xInput, zInput]) {
      input?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          travel();
        }
      });
    }

    exploreBtn?.addEventListener("click", () => {
      pushQueueInstruction(
        "Explore",
        lastBotPos ? { x: lastBotPos.x, z: lastBotPos.z } : null,
        readExploreParams(composer)
      );
    });
  });
}

/** Ações do alvo escolhido clicando no terreno (ver `viewer3d.setTarget`):
 *  "Ir para", "Explorar daqui" (com raio/estilo do próprio popup) e
 *  "dispensar". Só existe um popup, então o listener é único. */
function bootstrapTargetPopup() {
  const popup = $<HTMLElement>("#target-popup");
  popup.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-target-action]");
    const target = viewer3d?.getTarget();
    if (!btn || !viewer3d || !target) return;

    const action = btn.dataset.targetAction;
    if (action === "dismiss") {
      viewer3d.setTarget(null);
      return;
    }
    const kind: InstructionKind = action === "travel" ? "TravelTo" : "Explore";
    const explore = kind === "Explore" ? readExploreParams(popup) : null;
    pushQueueInstruction(kind, { x: target.x, z: target.z }, explore).then((queue) => {
      // Alvo virou instrução real: o marcador âmbar sai de cena.
      if (queue) viewer3d?.setTarget(null);
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
    // Sem isso, uma resposta de `chunk_voxels` em voo pousa depois do
    // `clear()` e repovoa um viewer desconectado.
    pendingChunks.clear();
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
  const pending = viewer3d?.getPendingCorner() ?? null;
  const place = viewer3d?.getPlaceBlock() ?? null;
  const tool = viewer3d?.getEditMode() ?? null;
  const parts: string[] = [];
  if (stats.total === 0) parts.push("nenhuma edição");
  else parts.push(`${stats.total} edições (${stats.breaks} quebrar / ${stats.builds} colocar)`);
  if (region) {
    const size = `${region.max.x - region.min.x + 1}×${region.max.y - region.min.y + 1}×${region.max.z - region.min.z + 1}`;
    parts.push(`região ${size} em (${region.min.x},${region.min.y},${region.min.z})`);
  } else if (pending) {
    // O primeiro clique precisa de retorno: sem isso parecia que o canto A
    // não tinha sido marcado (e o usuário tentava de novo, arrastando a
    // câmera sem querer).
    parts.push(`canto A em (${pending.x},${pending.y},${pending.z}) — clique (ou arraste) o canto oposto`);
  }
  if (place) parts.push(`bloco: ${place}`);
  // Com ferramenta ativa o botão esquerdo pertence ao editor (ver
  // `viewer3d.setEditMode`); sem ela, o viewer orbita como sempre.
  parts.push(
    tool
      ? "esquerdo edita (arraste marca a região) · direito orbita · meio move"
      : "nenhuma ferramenta ativa — esquerdo orbita"
  );
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

/* ---------- Mobs ao redor do bot ---------- */

const MOB_CATEGORY_LABEL: Record<MobCategory, string> = {
  hostile: "hostil",
  neutral: "neutro",
  passive: "passivo",
  other: "outro",
};

/** Teto de linhas do painel — o resto vira "+N" (o snapshot tem até 64 mobs;
 *  a lista inteira cobriria o viewer). */
const MOB_PANEL_LIMIT = 6;

/** Nomes de mob vêm do jogo (inclusive nome customizado de name tag), então
 *  não podem virar HTML no `innerHTML` do painel. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch
  );
}

/** Painel do viewer com os mobs do snapshot (`nearby_mobs`): hostis primeiro,
 *  depois por distância. `null` = o addon nunca mandou `entities` — o painel
 *  some em vez de fingir uma lista vazia ("sem dados" ≠ "varreu e não achou").
 */
function renderMobs(snapshot: MobSnapshot | null) {
  let panel = $<HTMLElement>("#mob-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "mob-panel";
    panel.className = "mob-panel";
    $("#viewer-canvas").appendChild(panel);
  }

  if (!snapshot) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "flex";

  if (snapshot.mobs.length === 0) {
    panel.innerHTML = `
      <div class="mob-panel-header">
        <span class="title">mobs</span>
        <span class="count mono">0</span>
      </div>
      <span class="mob-empty">Nenhum mob num raio de ${Math.round(snapshot.radius)} blocos.</span>
    `;
    return;
  }

  const ordered = [...snapshot.mobs].sort(
    (a, b) =>
      Number(b.category === "hostile") - Number(a.category === "hostile") || a.distance - b.distance
  );
  const shown = ordered.slice(0, MOB_PANEL_LIMIT);
  const hostiles = snapshot.mobs.filter((mob) => mob.category === "hostile").length;
  panel.innerHTML = `
    <div class="mob-panel-header">
      <span class="title">mobs</span>
      <span class="count mono">${snapshot.mobs.length}${hostiles > 0 ? ` · ${hostiles} hostis` : ""}</span>
    </div>
    ${shown
      .map(
        (mob) => `
      <div class="mob-row ${mob.category}" title="${escapeHtml(mob.kind)}">
        <span class="dot"></span>
        <span class="name">${escapeHtml(mob.name)}</span>
        <span class="meta mono">${MOB_CATEGORY_LABEL[mob.category]} · ${Math.round(mob.distance)} m</span>
      </div>`
      )
      .join("")}
    ${ordered.length > shown.length ? `<span class="mob-more mono">+${ordered.length - shown.length} mobs</span>` : ""}
  `;
}

/* ---------- Bootstrap ---------- */

let viewer3d: Viewer3D | null = null;
/** Última posição do bot (do polling) — origem do "Explorar" no composer. */
let lastBotPos: BotPos | null = null;
/** Enquadramento offline já feito nesta sessão (ver `refreshState`): a câmera
 * só é movida uma vez, na primeira resposta de estado sem bot — depois disso o
 * usuário é dono da câmera. */
let framedOfflineWorld = false;
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
  const [status, world, queue, totals, vitals, skin, mobs, worldTime, gameStatus] = await Promise.all([
    invoke<ConnectionStatus>("connection_status"),
    invoke<WorldSummary>("world_summary"),
    invoke<Instruction[]>("queue_snapshot"),
    invoke<ItemTotal[]>("storage_totals"),
    invoke<Vitals | null>("vitals_snapshot"),
    invoke<PlayerSkin | null>("player_skin"),
    invoke<MobSnapshot | null>("nearby_mobs"),
    invoke<number | null>("world_time"),
    invoke<GameStatus>("minecraft_game_status"),
  ]);

  lastBotPos = world.bot_pos ?? world.last_bot_pos ?? null;
  renderViewer(status, world);

  if (viewer3d) {
    // Atlas: não depende mais do jogo estar aberto — a versão do MC fica no
    // cache em disco (ver `world_store.rs`), então o mundo persistido abre
    // texturizado. Só tenta quando já existe versão conhecida (conectado ou
    // com cache); falha aqui é falha de verdade (jar ausente/extração
    // quebrada), então o viewer assume o modo degradado em vez de tentar de
    // novo a cada segundo.
    if (viewer3d.needsAtlas() && (status.connected || world.chunks_explored > 0)) {
      invoke<TextureAtlas>("get_texture_atlas")
        .then((atlas) =>
          viewer3d?.setAtlas(atlas.image_data_url, atlas.textures, atlas.cloud_data_url ?? null)
        )
        .catch((err) => {
          console.error("[atlas] falha ao carregar o atlas:", err);
          viewer3d?.setAtlasUnavailable();
        });
    }
    // Modelos de bloco reais (tocha, cogumelo, escada...): mesmo jar do
    // atlas, payload binário (ver `block_models.rs`). Uma tentativa só; se o
    // bake falhar, o viewer fica no cubo cheio de antes.
    if (viewer3d.needsBlockModels() && (status.connected || world.chunks_explored > 0)) {
      viewer3d.markBlockModelsLoading();
      invoke<ArrayBuffer | Uint8Array | number[]>("get_block_models")
        .then((raw) => viewer3d?.setBlockModels(raw))
        .catch((err) => {
          console.error("[models] falha ao carregar os modelos de bloco:", err);
          viewer3d?.setBlockModelsUnavailable();
        });
    }
    // Sem o jogo aberto o `bot_pos` do Rust volta a ser `None` — esconde o
    // modelo aqui (o polling de `bot_pose` faria o mesmo em 250ms, mas isso
    // mantém a garantia explícita de nunca ficar congelado na última pose).
    if (!world.bot_pos) viewer3d.setBotPose(null);

    // A skin real (ou `null` enquanto o addon não mandou) — o viewer mostra o
    // modelo sem textura em vez de inventar uma skin.
    viewer3d.setPlayerSkin(skin ? { model: skin.model, imageDataUrl: skin.image_data_url } : null);

    // Mobs ao redor do bot: o snapshot alimenta o painel (hostis primeiro,
    // distância). Os marcadores no mundo andam em `refreshPose`, na cadência
    // do addon — aqui é só o resumo de 1s.

    // Hora real do mundo pro ciclo de dia/noite. `null` (jogo fechado, logo
    // após abrir) não zera nada: o viewer congela na última hora real.
    viewer3d.setWorldTime(worldTime);

    // Instruções com alvo viram caixas de arame no mundo (âmbar = na fila,
    // teal = ativa) — o viewer reflete a fila real, não uma decoração.
    const ghosts: { id: string; active: boolean; x: number; z: number }[] = [];
    for (const item of queue) {
      if (!item.target || (item.status !== "Queued" && item.status !== "Active")) continue;
      ghosts.push({ id: item.id, active: item.status === "Active", x: item.target.x, z: item.target.z });
    }
    viewer3d.setInstructionTargets(ghosts);

    // Sem bot no jogo, a câmera abre onde ele foi visto por último — posição
    // persistida junto do mundo (`world.json`). Sem isso o viewer orbitava a
    // origem e o terreno explorado (longe de 0,0) ficava a centenas de blocos
    // de distância, como uma ilha no horizonte. `!status.connected` evita
    // enquadrar numa posição antiga um instante antes da pose real chegar.
    if (!status.connected && !world.bot_pos && world.last_bot_pos && !framedOfflineWorld) {
      framedOfflineWorld = true;
      viewer3d.frameOn(world.last_bot_pos);
    }

    // Prioridade: chunks ao redor do bot primeiro. O backend devolve os N
    // mais próximos já ordenados (`world_chunks_near`); antes disso o cache
    // inteiro vinha em ordem arbitrária de `HashMap` e o terreno ao redor do
    // bot podia chegar por último. Com o jogo fechado a âncora é onde o bot
    // foi visto por último; o ponto que a câmera orbita entra sempre como
    // segunda âncora, porque se o usuário afastou a câmera do bot o que está
    // na frente dele também precisa carregar (a janela do viewer cobre as
    // duas).
    const anchors: ChunkPos[] = [];
    const primary = world.bot_pos ?? world.last_bot_pos ?? null;
    if (primary) anchors.push({ x: primary.x >> 4, z: primary.z >> 4 });
    const focus = viewer3d.getFocusChunk();
    if (!anchors.some((anchor) => anchor.x === focus.x && anchor.z === focus.z)) anchors.push(focus);

    // Voxels são buscados aos poucos; a montagem em si já é orçada por frame
    // no viewer (`drainMeshQueue`), então pedir vários por refresh não trava —
    // só acelera o preenchimento ao redor do bot. O quanto é preferência da
    // aba Config; o padrão do backend vale até ela responder.
    let budget = settings?.chunks_per_refresh ?? CHUNKS_PER_REFRESH;
    for (const anchor of anchors) {
      if (budget <= 0) break;
      try {
        const chunks = await invoke<ChunkPos[]>("world_chunks_near", {
          x: anchor.x,
          z: anchor.z,
          limit: NEARBY_CHUNK_LIMIT,
        });
        for (const pos of chunks) {
          if (budget <= 0) break;
          // Fora da janela do viewer o chunk seria buscado e descartado no
          // sweep seguinte — não gasta o orçamento com ele.
          if (!viewer3d.isChunkInWindow(pos.x, pos.z)) continue;
          if (viewer3d.hasChunk(pos.x, pos.z) || pendingChunks.has(`${pos.x},${pos.z}`)) continue;
          requestChunk(pos);
          budget--;
        }
      } catch (err) {
        console.warn("[chunks] prioridade por distância indisponível:", err);
      }
    }
  }
  renderHud(vitals);
  renderMobs(mobs);
  renderGameStatus(gameStatus);
  renderQueue(queue);
  renderStorage(totals);
}

/* ---------- Configurações (aba Config) ---------- */

/** Espelha `Settings` em `src-tauri/src/settings.rs`. Os valores exibidos e
 *  aplicados vêm sempre do backend (`settings_get`) — o frontend não tem
 *  defaults próprios pra divergir. */
interface Settings {
  fog_far: number;
  mesh_budget_ms: number;
  max_pixel_ratio: number;
  fps_cap: number;
  state_interval_ms: number;
  pose_interval_ms: number;
  chunks_per_refresh: number;
  curseforge_root: string;
  offline_username: string;
  java_memory_mb: number;
}

let settings: Settings | null = null;

/** Números em pt-BR (vírgula decimal), como o resto da UI. */
function decimal(value: number): string {
  return String(value).replace(".", ",");
}

/** Rótulo do valor efetivo ao lado de cada controle. Os campos de texto da
 *  aba Jogar entram aqui também — o formato recebe o valor como veio do
 *  backend (número ou string). */
const CONFIG_VALUE_FORMAT: Record<keyof Settings, (value: number | string) => string> = {
  fog_far: (v) => `${decimal(Number(v))} blocos`,
  mesh_budget_ms: (v) => `${decimal(Number(v))} ms`,
  max_pixel_ratio: (v) => `${decimal(Number(v))}×`,
  fps_cap: (v) => (Number(v) === 0 ? "sem limite" : `${v} fps`),
  state_interval_ms: (v) => `${v} ms`,
  pose_interval_ms: (v) => `${v} ms`,
  chunks_per_refresh: (v) => `${v} chunks`,
  curseforge_root: (v) => (String(v).trim() === "" ? "detectar sozinho" : String(v)),
  offline_username: (v) => String(v),
  java_memory_mb: (v) => `${v} MB`,
};

let configStatusTimer: number | undefined;

/** Status no canto do header da aba. Erro fica visível até algo dar certo;
 *  confirmação de sucesso some sozinha (o controle já mostra o valor). */
function setConfigStatus(message: string, kind: "info" | "error" = "info") {
  const el = $<HTMLElement>("#config-status");
  if (configStatusTimer !== undefined) window.clearTimeout(configStatusTimer);
  el.textContent = message;
  el.classList.toggle("error", kind === "error");
  if (kind === "error") return;
  configStatusTimer = window.setTimeout(() => {
    el.textContent = "";
    configStatusTimer = undefined;
  }, 2500);
}

/** Reflete o estado real nos controles: desabilitados enquanto o backend não
 *  respondeu (nada de valor inventado no markup), depois com o valor efetivo
 *  — que pode ser diferente do pedido, se o backend prendeu na faixa. */
function renderConfig() {
  const loaded = settings !== null;
  $<HTMLButtonElement>("#config-reset").disabled = !loaded;
  $$<HTMLInputElement | HTMLSelectElement>("[data-setting]").forEach((el) => {
    el.disabled = !loaded;
    if (loaded) el.value = String(settings![el.dataset.setting as keyof Settings]);
  });
  $$<HTMLElement>("[data-setting-value]").forEach((el) => {
    if (!loaded) {
      el.textContent = "—";
      return;
    }
    const key = el.dataset.settingValue as keyof Settings;
    el.textContent = CONFIG_VALUE_FORMAT[key](settings![key]);
  });
}

function applySettings(next: Settings) {
  // O polling só reinicia quando o intervalo mudou de verdade — o slider de
  // fog, por exemplo, aplica a cada `input` e não precisa mexer nos timers.
  const intervalsChanged =
    settings === null ||
    settings.state_interval_ms !== next.state_interval_ms ||
    settings.pose_interval_ms !== next.pose_interval_ms;
  settings = next;
  viewer3d?.applySettings({
    fogFar: next.fog_far,
    meshBudgetMs: next.mesh_budget_ms,
    maxPixelRatio: next.max_pixel_ratio,
    fpsCap: next.fps_cap,
  });
  if (intervalsChanged) restartPolling();
  renderConfig();
}

/** Gravação com debounce: arrastar um slider dispara `input` por frame, e
 *  gravar a cada um seria uma escrita de disco por pixel. */
const SETTINGS_SAVE_DEBOUNCE_MS = 300;
let settingsSaveTimer: number | undefined;

function persistSettings() {
  settingsSaveTimer = undefined;
  const payload = settings;
  if (!payload) return;
  invoke<Settings>("settings_set", { settings: payload })
    .then((effective) => {
      // Se o usuário mexeu em outro controle enquanto a gravação estava em
      // voo, o estado local mais novo manda — não regride pra este snapshot.
      if (settings === payload) applySettings(effective);
      setConfigStatus("preferências salvas");
    })
    .catch((err) => {
      console.error("[config] salvar falhou:", err);
      setConfigStatus("não consegui salvar as preferências — veja o console", "error");
      // O backend recusou (ex: falha de escrita): volta pro que ele realmente
      // tem em vez de deixar a UI mostrando um valor que não foi salvo.
      void loadSettings();
    });
}

function scheduleSettingsSave() {
  if (settingsSaveTimer !== undefined) window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(persistSettings, SETTINGS_SAVE_DEBOUNCE_MS);
}

function updateSetting(key: keyof Settings, value: number | string) {
  if (!settings) return;
  applySettings({ ...settings, [key]: value });
  scheduleSettingsSave();
}

/** Recarrega do backend e limpa o status quando deu certo — usar nas ações em
 *  que "carregou" é a mensagem (Recarregar, boot). O rollback do save chama
 *  `loadSettings` direto pra não apagar o aviso de erro. */
function reloadSettings() {
  void loadSettings().then((ok) => {
    if (ok) setConfigStatus("");
  });
}

/** Valor de um controle da Config: campos de texto devolvem string; números
 *  (range/number/select) viram `Number`. */
function readConfigValue(el: HTMLInputElement | HTMLSelectElement): number | string {
  return el instanceof HTMLInputElement && el.type === "text" ? el.value : Number(el.value);
}

function bootstrapConfig() {
  $$<HTMLInputElement | HTMLSelectElement>("[data-setting]").forEach((el) => {
    const key = el.dataset.setting as keyof Settings;
    // `input` dá feedback ao vivo no viewer enquanto o slider anda; o
    // debounce segura a gravação em disco (ver `scheduleSettingsSave`).
    el.addEventListener("input", () => updateSetting(key, readConfigValue(el)));
    el.addEventListener("change", () => updateSetting(key, readConfigValue(el)));
  });

  $("#config-reset").addEventListener("click", () => {
    invoke<Settings>("settings_reset")
      .then((effective) => {
        applySettings(effective);
        setConfigStatus("padrões restaurados");
      })
      .catch((err) => {
        console.error("[config] restaurar falhou:", err);
        setConfigStatus("não consegui restaurar os padrões — veja o console", "error");
      });
  });

  $("#config-reload").addEventListener("click", reloadSettings);

  renderConfig();
  reloadSettings();
}

async function loadSettings(): Promise<boolean> {
  try {
    applySettings(await invoke<Settings>("settings_get"));
    return true;
  } catch (err) {
    console.error("[config] carregar falhou:", err);
    setConfigStatus("não consegui carregar as preferências — veja o console", "error");
    return false;
  }
}

/* ---------- Jogar (abrir o Minecraft direto) ---------- */

/** Espelha `minecraft_launch.rs` (aba Jogar). O app lê a instalação do
 *  CurseForge que já existe, lista mundos e abre o jogo direto pelo Java do
 *  próprio CurseForge — em sessão offline. */
interface MinecraftSetup {
  root: string | null;
  install_dir: string | null;
  assets_dir: string | null;
  java: string | null;
  java_version: string | null;
  problem: string | null;
}

interface MinecraftInstance {
  id: string;
  name: string;
  game_version: string;
  modloader: string;
}

interface MinecraftWorld {
  id: string;
  name: string;
  last_modified_ms: number;
}

interface GameStatus {
  running: boolean;
  pid: number | null;
  exit_code: number | null;
}

interface LaunchOutcome {
  pid: number;
  java: string;
  java_version: string | null;
  version: string;
  world: string | null;
}

interface LaunchPreview {
  command: string;
  java: string;
  java_version: string | null;
  log_path: string;
  version: string;
  world: string | null;
}

let launchSetup: MinecraftSetup | null = null;
let launchInstances: MinecraftInstance[] = [];
let launchWorlds: MinecraftWorld[] = [];
let launchInstanceId: string | null = null;
let launchLoading = false;

function setLaunchStatus(message: string, kind: "info" | "error" = "info") {
  const el = $<HTMLElement>("#launch-status");
  el.textContent = message;
  el.classList.toggle("error", kind === "error");
}

/** Instância padrão: a que tem "baritone" no nome (é a que tem o addon),
 *  senão a primeira em ordem alfabética. */
function defaultInstanceId(): string | null {
  if (launchInstances.length === 0) return null;
  const named = launchInstances.find((instance) => instance.name.toLowerCase().includes("baritone"));
  return (named ?? launchInstances[0]).id;
}

function launchReady(): boolean {
  return Boolean(launchSetup?.root) && launchInstanceId !== null;
}

async function refreshLaunchWorlds() {
  if (!launchInstanceId) {
    launchWorlds = [];
    return;
  }
  try {
    launchWorlds = await invoke<MinecraftWorld[]>("minecraft_worlds", { instanceId: launchInstanceId });
  } catch (err) {
    console.error("[jogar] listar mundos falhou:", err);
    launchWorlds = [];
    setLaunchStatus(String(err), "error");
  }
}

async function refreshLaunch() {
  if (launchLoading) return;
  launchLoading = true;
  try {
    launchSetup = await invoke<MinecraftSetup>("minecraft_setup");
    launchInstances = launchSetup.root ? await invoke<MinecraftInstance[]>("minecraft_instances") : [];
    if (launchInstanceId === null || !launchInstances.some((instance) => instance.id === launchInstanceId)) {
      launchInstanceId = defaultInstanceId();
    }
    await refreshLaunchWorlds();
    setLaunchStatus(launchSetup.problem ? "Jogar indisponível" : "");
  } catch (err) {
    console.error("[jogar] carregar falhou:", err);
    setLaunchStatus(String(err), "error");
  } finally {
    launchLoading = false;
  }
  renderLaunch();
}

function formatWorldDate(ms: number): string {
  if (!ms) return "data desconhecida";
  return new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/** Estado do processo aberto pela aba Jogar (polling do `refreshState`). */
function renderGameStatus(status: GameStatus) {
  const el = $<HTMLElement>("#launch-game-state");
  if (!el) return;
  el.classList.toggle("running", status.running);
  el.classList.toggle("exited", !status.running && status.exit_code !== null);
  if (status.running) {
    el.textContent = `jogando (pid ${status.pid})`;
  } else if (status.exit_code !== null) {
    el.textContent = `encerrado (código ${status.exit_code})`;
  } else {
    el.textContent = "parado";
  }
}

function renderLaunch() {
  const setupEl = $<HTMLElement>("#launch-setup");
  if (!launchSetup) {
    setupEl.innerHTML = `<span>carregando…</span>`;
  } else if (!launchSetup.root) {
    setupEl.innerHTML = `<span class="problem">${escapeHtml(launchSetup.problem ?? "instalação não encontrada")}</span>`;
  } else {
    const java = launchSetup.java
      ? `${escapeHtml(launchSetup.java)}${launchSetup.java_version ? ` (${escapeHtml(launchSetup.java_version)})` : ""}`
      : "não encontrado";
    setupEl.innerHTML = `
      <span>CurseForge: ${escapeHtml(launchSetup.root)}</span>
      <span>Java: ${java}</span>
    `;
    if (launchSetup.problem) {
      setupEl.innerHTML += `<span class="problem">${escapeHtml(launchSetup.problem)}</span>`;
    }
  }

  $<HTMLElement>("#launch-instances").innerHTML = launchInstances.length
    ? launchInstances
        .map(
          (instance) => `
      <button type="button" class="launch-instance ${instance.id === launchInstanceId ? "active" : ""}" data-instance="${escapeHtml(instance.id)}">
        <span class="name">${escapeHtml(instance.name)}</span>
        <span class="meta">${escapeHtml(instance.game_version)} · ${escapeHtml(instance.modloader || "vanilla")}</span>
      </button>`
        )
        .join("")
    : `<span class="composer-hint">Nenhuma instância encontrada${
        launchSetup?.root ? "" : " — aponte a pasta do CurseForge na aba Config"
      }.</span>`;

  const worldsEl = $<HTMLElement>("#launch-worlds");
  if (!launchInstanceId) {
    worldsEl.innerHTML = "";
  } else if (launchWorlds.length === 0) {
    worldsEl.innerHTML = `
      <div class="empty-state">
        <span class="headline">Nenhum mundo nesta instância</span>
        <span class="detail">Crie um mundo pelo jogo (dá pra abrir o Minecraft sem mundo e criar lá) — ele aparece aqui pra abrir direto.</span>
      </div>`;
  } else {
    worldsEl.innerHTML = launchWorlds
      .map(
        (world) => `
      <div class="launch-world">
        <div class="info">
          <span class="name">${escapeHtml(world.name)}</span>
          <span class="meta">última alteração: ${escapeHtml(formatWorldDate(world.last_modified_ms))}</span>
        </div>
        <button type="button" class="tool-btn flat" data-world="${escapeHtml(world.id)}">Abrir neste mundo</button>
      </div>`
      )
      .join("");
  }

  $<HTMLButtonElement>("#launch-game").disabled = !launchReady();
  $<HTMLButtonElement>("#launch-preview").disabled = !launchReady();
}

async function launchGame(worldId?: string) {
  if (!launchInstanceId) return;
  setLaunchStatus("abrindo o Minecraft…");
  try {
    const outcome = await invoke<LaunchOutcome>("minecraft_launch", {
      instanceId: launchInstanceId,
      worldId: worldId ?? null,
    });
    setLaunchStatus(
      `Minecraft aberto (pid ${outcome.pid})${outcome.world ? ` no mundo "${outcome.world}"` : ""} — o addon conecta sozinho.`
    );
    renderGameStatus({ running: true, pid: outcome.pid, exit_code: null });
  } catch (err) {
    console.error("[jogar] abrir falhou:", err);
    setLaunchStatus(String(err), "error");
  }
}

async function previewLaunch() {
  if (!launchInstanceId) return;
  try {
    const preview = await invoke<LaunchPreview>("minecraft_launch_preview", {
      instanceId: launchInstanceId,
      worldId: null,
    });
    const el = $<HTMLElement>("#launch-command");
    el.hidden = false;
    el.textContent = `${preview.command}\n\n# log: ${preview.log_path}`;
  } catch (err) {
    console.error("[jogar] prévia falhou:", err);
    setLaunchStatus(String(err), "error");
  }
}

function bootstrapLaunch() {
  $("#launch-game").addEventListener("click", () => void launchGame());
  $("#launch-preview").addEventListener("click", () => void previewLaunch());
  $("#launch-instances").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-instance]");
    if (!button) return;
    launchInstanceId = button.dataset.instance ?? null;
    void refreshLaunchWorlds().then(renderLaunch);
  });
  $("#launch-worlds").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-world]");
    if (!button) return;
    void launchGame(button.dataset.world ?? undefined);
  });
  renderLaunch();
}

/* ---------- Polling ---------- */

// Valores de partida até o `settings_get` responder (aba Config): 1s = cadência
// dos vitais do addon (ver addon_socket.rs); 250ms = cadência do `position`
// (4x/s). Depois disso quem manda é a preferência salva.
const BOOT_REFRESH_INTERVAL_MS = 1000;
const BOOT_POSE_INTERVAL_MS = 250;

let stateTimer: number | undefined;
let poseTimer: number | undefined;

/** (Re)inicia os dois pollings com os intervalos atuais — `setInterval` não
 *  aceita um intervalo novo sem ser recriado. Chamado no boot e quando a aba
 *  Config muda um dos dois. */
function restartPolling() {
  if (stateTimer !== undefined) window.clearInterval(stateTimer);
  if (poseTimer !== undefined) window.clearInterval(poseTimer);
  stateTimer = window.setInterval(refreshState, settings?.state_interval_ms ?? BOOT_REFRESH_INTERVAL_MS);
  poseTimer = window.setInterval(refreshPose, settings?.pose_interval_ms ?? BOOT_POSE_INTERVAL_MS);
}

async function refreshPose() {
  try {
    const [pose, mobs] = await Promise.all([
      invoke<BotPose | null>("bot_pose"),
      invoke<MobSnapshot | null>("nearby_mobs"),
    ]);
    viewer3d?.setBotPose(pose);
    // Marcadores de mob na mesma cadência da pose (250ms = `position` e
    // `entities` do addon): no polling de 1s os rótulos andariam aos pulos.
    // `null`/lista vazia limpam os marcadores.
    viewer3d?.setNearbyMobs(mobs?.mobs ?? []);
  } catch (err) {
    console.error("[bot_pose]", err);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  bootstrapRail();
  bootstrapTitlebar();
  bootstrapQueueComposers();
  bootstrapQueueActions();
  bootstrapTargetPopup();
  bootstrapConfig();
  bootstrapLaunch();

  viewer3d = new Viewer3D(
    $<HTMLElement>("#viewer-3d"),
    $<HTMLDivElement>("#bot-label"),
    $<HTMLDivElement>("#target-popup")
  );
  window.addEventListener("resize", () => viewer3d?.resize());
  bootstrapEditor();

  refreshState();
  refreshPose();
  restartPolling();
});
