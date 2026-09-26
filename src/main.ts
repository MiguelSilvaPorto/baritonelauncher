import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Viewer3D, CHUNKS_PER_REFRESH, type ChunkPos, type BotPos, type UvRect } from "./viewer3d";

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
  // A view-viewer fica display:none nos outros modos — o WebGLRenderer não
  // vê isso, então o tamanho do canvas fica desatualizado até isso rodar.
  if (mode === "viewer") viewer3d?.resize();
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
        <span class="detail">Clique num bloco do terreno pra mirar um destino ("Ir para" ou "Explorar daqui"), ou digite as coordenadas x/z acima. O addon executa com o pathing do Baritone e devolve status/progresso. Resolução automática de dependências (baú/craft) ainda não está ligada.</span>
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

/** Enfileira e re-renderiza a fila na hora — o comando devolve o estado
 *  atualizado, então a UI não espera o polling de 1s. */
function pushQueueInstruction(kind: InstructionKind, target: InstructionTarget | null) {
  return invoke<Instruction[]>("queue_push", { kind, target })
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
      const x = Number(xInput?.value);
      const z = Number(zInput?.value);
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        (Number.isFinite(x) ? zInput : xInput)?.focus();
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
      pushQueueInstruction("Explore", lastBotPos ? { x: lastBotPos.x, z: lastBotPos.z } : null);
    });
  });
}

/** Ações do alvo escolhido clicando no terreno (ver `viewer3d.setTarget`):
 *  "Ir para", "Explorar daqui" e "dispensar". Só existe um popup, então o
 *  listener é único. */
function bootstrapTargetPopup() {
  $("#target-popup").addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-target-action]");
    const target = viewer3d?.getTarget();
    if (!btn || !viewer3d || !target) return;

    const action = btn.dataset.targetAction;
    if (action === "dismiss") {
      viewer3d.setTarget(null);
      return;
    }
    const kind: InstructionKind = action === "travel" ? "TravelTo" : "Explore";
    pushQueueInstruction(kind, { x: target.x, z: target.z }).then((queue) => {
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

  if (status.connected) {
    empty.classList.add("hidden");
    endpoint.textContent = `socket: ${status.endpoint ?? "conectado"}`;
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
    chip.innerHTML =
      world.chunks_total_estimate > 0
        ? `
      <div class="bar"><span style="width:${Math.round((world.chunks_explored / world.chunks_total_estimate) * 100)}%"></span></div>
      <span class="pct mono">${Math.round((world.chunks_explored / world.chunks_total_estimate) * 100)}% · ${world.chunks_explored} / ${world.chunks_total_estimate} chunks</span>
    `
        : `<span class="pct mono">${world.chunks_explored} chunks vistos</span>`;

  } else {
    empty.classList.remove("hidden");
    endpoint.textContent = "socket: aguardando implementação do addon Java";
    viewer3d?.clear();
  }
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
  if (status.connected && viewer3d) {
    // Atlas só existe depois que o addon já mandou `hello` (é de lá que
    // vem a versão do MC, ver src-tauri/src/lib.rs) — busca uma vez só,
    // não a cada refresh.
    if (!viewer3d.hasAtlas() && !viewer3d.isLoadingAtlas) {
      invoke<TextureAtlas>("get_texture_atlas")
        .then((atlas) => viewer3d?.setAtlas(atlas.image_data_url, atlas.textures))
        .catch((err) => console.error("[atlas]", err));
    }
    viewer3d.setBotPos(world.bot_pos ?? null);

    // Instruções com alvo viram caixas de arame no mundo (âmbar = na fila,
    // teal = ativa) — o viewer reflete a fila real, não uma decoração.
    const ghosts: { id: string; active: boolean; x: number; z: number }[] = [];
    for (const item of queue) {
      if (!item.target || (item.status !== "Queued" && item.status !== "Active")) continue;
      ghosts.push({ id: item.id, active: item.status === "Active", x: item.target.x, z: item.target.z });
    }
    viewer3d.setInstructionTargets(ghosts);

    // Voxels são buscados aos poucos: montar malha é CPU na thread
    // principal, então um backfill de centenas de chunks numa tacada
    // travaria o viewer. O resto fica na fila implícita do Rust e chega
    // nos próximos refreshes.
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
  bootstrapTargetPopup();

  viewer3d = new Viewer3D(
    $<HTMLElement>("#viewer-3d"),
    $<HTMLDivElement>("#bot-label"),
    $<HTMLDivElement>("#target-popup")
  );
  window.addEventListener("resize", () => viewer3d?.resize());

  refreshState();
  setInterval(refreshState, REFRESH_INTERVAL_MS);
});
