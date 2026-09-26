package dev.baritone.orchestrator.addon;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import baritone.api.pathing.goals.Goal;
import baritone.api.pathing.goals.GoalXZ;
import baritone.api.utils.BetterBlockPos;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.platform.NativeImage;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.renderer.texture.AbstractTexture;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.PlayerSkin;
import net.minecraft.world.food.FoodData;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.MultifaceBlock;
import net.minecraft.world.level.block.VineBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.material.FluidState;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.event.level.ChunkEvent;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Deque;
import java.util.HashMap;
import java.util.Locale;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.zip.Deflater;

/**
 * Client-only bridge: reads the local player's vitals and position through
 * the Baritone API (proving the {@code baritone.api} dependency resolves and
 * works at runtime, not just at compile time) and streams them as
 * newline-delimited JSON to the Rust app's local socket. Protocol is
 * documented in {@code src-tauri/src/addon_socket.rs} (Rust side) and
 * {@code mod-addon/README.md}.
 *
 * <p>Besides vitals/position it also streams the <b>whole chunk</b> when the
 * client loads one ({@code chunk_voxels}): every non-empty 16×16×16 section
 * serialized as palette + indices, deflated, base64. See
 * {@code src-tauri/src/world_cache.rs} for the exact binary layout. This is
 * still intentionally small — block updates after load, chest contents and
 * threat detection are not sent yet (see {@code docs/CHANGELOG.md}).
 */
@EventBusSubscriber(modid = BaritoneOrchestratorAddon.MODID, value = Dist.CLIENT)
public class BaritoneOrchestratorAddonClient {

    static final String HOST = BaritoneOrchestratorAddon.SOCKET_HOST;
    static final int PORT = BaritoneOrchestratorAddon.SOCKET_PORT;

    private static final int VITALS_INTERVAL_TICKS = 20; // once a second
    private static final int POSITION_INTERVAL_TICKS = 5; // 4x a second
    private static final int RECONNECT_BACKOFF_MS = 5000;
    private static final String HELLO_MESSAGE =
            "{\"type\":\"hello\",\"addon_version\":\"0.1.0\",\"baritone_version\":\"1.20.0\",\"mc_version\":\"26.3\"}";

    // Layout do payload binário de `chunk_voxels` — precisa bater com
    // `decode_voxels` em src-tauri/src/world_cache.rs (formato 2):
    //   u8 versão | u8 nº de seções
    //   por seção: i8 Y da seção | u16 tamanho da paleta
    //              por entrada: u16 tamanho do nome | bytes UTF-8 | u8 flags | u8 nível
    //              u16[4096] índices (x + z*16 + y*256)
    private static final byte VOXEL_FORMAT_VERSION = 2;
    private static final int VOXEL_FLAG_RENDER = 1;
    private static final int VOXEL_FLAG_OCCLUDES = 2;
    private static final int VOXEL_FLAG_FLUID = 4;
    private static final int SECTION_VOLUME = 4096; // 16×16×16

    private static Socket socket;
    private static OutputStream out;
    private static boolean helloSent;
    /** Identificador da textura + variante da última skin enviada — ver
     *  {@code sendPlayerSkinIfChanged}. `null` = nada enviado ainda (ou
     *  conexão nova: a skin precisa ser reenviada). */
    private static String lastSkinSignature;
    private static int ticksSinceLastVitals;
    private static int ticksSinceLastPosition;
    private static long nextReconnectAttemptMs;

    // Canal reverso (app → addon): linhas recebidas pela thread leitora e
    // drenadas na tick do cliente (a API do Baritone é de thread do cliente —
    // chamar `setGoalAndPath` da thread do socket seria corrida). A fila é
    // concorrente porque produtora e consumidora são threads diferentes.
    private static final Queue<String> pendingCommands = new ConcurrentLinkedQueue<>();
    private static final int ARRIVAL_RADIUS_BLOCKS = 1;
    /** Teto de waypoints por exploração — o app já limita o raio a 5000
     *  blocos; isso é a segunda barreira contra uma lista gigante. */
    private static final int MAX_EXPLORE_WAYPOINTS = 4000;

    // Instrução ativa hoje (só uma por vez — a fila do app despacha em
    // sequência). `activeInstructionId == null` = nada em execução.
    private static String activeInstructionId;
    private static String activeInstructionKind;
    private static double activeTargetX;
    private static double activeTargetZ;
    private static double activeInitialDistance;
    private static int ticksSinceLastInstructionStatus;

    /** Waypoints da exploração com raio/estilo (ver `buildExploreWaypoints`):
     *  "círculos" e "zigue-zague" são uma sequência de Goals que este addon
     *  percorre, porque o Baritone só tem `explore(origem)` sem forma definida. */
    private static ArrayList<int[]> exploreWaypoints;
    private static int exploreWaypointIndex;

    // Serializar um chunk inteiro (até 24 seções × 4096 blocos) + comprimir
    // dá trabalho pra caber num tick; o backfill de reconexão pode enfileirar
    // centenas de chunks de uma vez, então a fila drena só alguns por tick em
    // vez de travar o jogo por um instante.
    private static final int CHUNK_PAYLOADS_PER_TICK = 2;
    private static final Deque<LevelChunk> pendingChunkPayloads = new ArrayDeque<>();

    // Reutilizados entre chunks/seções pra não alocar 4096 shorts por seção.
    private static final short[] sectionIndices = new short[SECTION_VOLUME];
    private static final HashMap<BlockState, Integer> sectionPaletteIndex = new HashMap<>();
    private static final ArrayList<BlockState> sectionPalette = new ArrayList<>();

    @SubscribeEvent
    static void onClientTick(ClientTickEvent.Post event) {
        IBaritone baritone = BaritoneAPI.getProvider().getPrimaryBaritone();
        LocalPlayer player = baritone.getPlayerContext().player();
        if (player == null) {
            return;
        }

        ensureConnected();
        if (out == null) {
            return;
        }

        // Instruções do app (chegadas pela thread leitora) executam aqui, na
        // thread do cliente.
        drainCommands(baritone);

        if (!helloSent) {
            helloSent = send(HELLO_MESSAGE);
            if (helloSent) {
                // ChunkEvent.Load only fires once per chunk, when it's
                // loaded — any chunk already loaded before this connection
                // (e.g. the spawn area, loaded during world join before the
                // socket had a chance to connect) never fires again, so its
                // message would be lost forever without this. Runs on every
                // (re)connect, not just the first one — also re-syncs if the
                // Rust app was restarted while the game kept running.
                syncAlreadyLoadedChunks(baritone.getPlayerContext().playerFeet());
                // Reconexão no meio de uma instrução: reenvia o estado atual
                // pro app não ficar com o card preso em "ativo" sem update.
                tickActiveInstruction(baritone);
            }
        }

        // Skin do próprio jogador pro viewer desenhar o modelo de verdade em
        // vez do marcador genérico — só manda quando a textura muda.
        if (helloSent) {
            sendPlayerSkinIfChanged(player);
        }

        for (int i = 0; i < CHUNK_PAYLOADS_PER_TICK && !pendingChunkPayloads.isEmpty(); i++) {
            sendChunkVoxels(pendingChunkPayloads.poll());
        }

        ticksSinceLastPosition++;
        if (ticksSinceLastPosition >= POSITION_INTERVAL_TICKS) {
            ticksSinceLastPosition = 0;
            BetterBlockPos pos = baritone.getPlayerContext().playerFeet();
            send(String.format(
                    Locale.ROOT,
                    "{\"type\":\"position\",\"x\":%d,\"y\":%d,\"z\":%d,\"yaw\":%.1f,\"pitch\":%.1f}",
                    pos.x, pos.y, pos.z, player.getYRot(), player.getXRot()
            ));
        }

        ticksSinceLastVitals++;
        if (ticksSinceLastVitals >= VITALS_INTERVAL_TICKS) {
            ticksSinceLastVitals = 0;
            FoodData food = player.getFoodData();
            send(String.format(
                    Locale.ROOT,
                    "{\"type\":\"vitals\",\"health\":%.1f,\"max_health\":%.1f,\"hunger\":%d,\"saturation\":%.1f,\"armor_points\":%d}",
                    player.getHealth(),
                    player.getMaxHealth(),
                    food.getFoodLevel(),
                    food.getSaturationLevel(),
                    player.getArmorValue()
            ));
            sendWorldTime();
        }

        // Progresso da instrução ativa na mesma cadência da posição (4x/s) —
        // suficiente pro card da fila andar, sem linha por tick.
        ticksSinceLastInstructionStatus++;
        if (ticksSinceLastInstructionStatus >= POSITION_INTERVAL_TICKS) {
            ticksSinceLastInstructionStatus = 0;
            tickActiveInstruction(baritone);
        }
    }

    /**
     * Hora real do mundo (0..23999 ticks; 0 = nascer do sol, 6000 = meio-dia,
     * 12000 = pôr do sol, 18000 = meia-noite) — o viewer usa pro ciclo de
     * dia/noite. Usa o clock do overworld (`getOverworldClockTime`, o antigo
     * "day time"): é o relógio que cicla de verdade, mesmo se o bot estiver
     * numa dimensão de céu fixo. Mesma cadência dos vitais (1x/s): o app
     * interpola entre as mensagens, então não precisa de uma linha por tick.
     */
    private static void sendWorldTime() {
        ClientLevel level = Minecraft.getInstance().level;
        if (level == null) {
            return;
        }
        long dayTime = Math.floorMod(level.getOverworldClockTime(), 24000L);
        send(String.format(Locale.ROOT, "{\"type\":\"world_time\",\"day_time\":%d}", dayTime));
    }

    /**
     * Manda a skin do próprio jogador (PNG em base64) pro app desenhar o
     * modelo de verdade no viewer. Os bytes saem do que o jogo já tem: o
     * cache de texturas do client pra skin baixada/customizada, ou o
     * resource pack/jar instalado pra skin padrão — nada é baixado da Mojang
     * aqui (mesma regra de {@code texture_atlas.rs}: ler o que já está
     * instalado, nunca baixar/empacotar asset).
     *
     * <p>Roda a cada tick, mas só envia quando a textura muda: a skin do
     * perfil pode chegar um instante depois do join (até lá o client desenha
     * a skin padrão, que é a resposta honesta — é o que o jogo mostra), então
     * mandar uma vez só no hello perderia a skin real.
     */
    // Diagnóstico temporário: a skin ficava sempre no placeholder cinza e não
    // dava pra saber, sem log, se o problema era `getSkin()`/`skinPngBytes()`
    // nunca resolvendo, o PNG sendo rejeitado do lado Rust, ou outra coisa.
    // Loga só a primeira falha de cada tipo (não every tick) — remover depois
    // de confirmado o que estava acontecendo.
    private static boolean loggedSkinGetFailure;
    private static boolean loggedSkinPngFailure;
    private static boolean loggedSkinSent;

    private static void sendPlayerSkinIfChanged(LocalPlayer player) {
        PlayerSkin skin;
        try {
            skin = player.getSkin();
        } catch (RuntimeException e) {
            if (!loggedSkinGetFailure) {
                loggedSkinGetFailure = true;
                BaritoneOrchestratorAddon.LOGGER.warn("[skin] player.getSkin() falhou: {}", e.toString());
            }
            return; // player info/skin ainda não disponível — tenta no próximo tick
        }

        String signature = skin.body().texturePath() + "|" + skin.model().getSerializedName();
        if (signature.equals(lastSkinSignature)) {
            return;
        }

        byte[] png = skinPngBytes(skin);
        if (png == null) {
            if (!loggedSkinPngFailure) {
                loggedSkinPngFailure = true;
                BaritoneOrchestratorAddon.LOGGER.warn(
                        "[skin] skinPngBytes() não achou a textura ainda (texturePath={})",
                        skin.body().texturePath()
                );
            }
            return; // textura ainda não registrada/legível — tenta no próximo tick
        }

        lastSkinSignature = signature;
        if (!loggedSkinSent) {
            loggedSkinSent = true;
            BaritoneOrchestratorAddon.LOGGER.info(
                    "[skin] enviando player_skin: {} bytes de PNG, model={}, texturePath={}",
                    png.length,
                    skin.model().getSerializedName(),
                    skin.body().texturePath()
            );
        }
        send(String.format(
                Locale.ROOT,
                "{\"type\":\"player_skin\",\"name\":\"%s\",\"model\":\"%s\",\"png_base64\":\"%s\"}",
                player.getGameProfile().name(),
                skin.model().getSerializedName(),
                Base64.getEncoder().encodeToString(png)
        ));
    }

    /**
     * PNG da skin: textura em cache do client (skin baixada/customizada) ou
     * direto do resource pack/jar (skin padrão). {@code null} = ainda não dá
     * (tenta de novo no próximo tick).
     */
    private static byte[] skinPngBytes(PlayerSkin skin) {
        Identifier texturePath = skin.body().texturePath();
        try {
            AbstractTexture texture = Minecraft.getInstance().getTextureManager().getTexture(texturePath);
            if (texture instanceof DynamicTexture dynamic && !dynamic.getPixels().isClosed()) {
                return toPngBytes(dynamic.getPixels());
            }
            return Minecraft.getInstance()
                    .getResourceManager()
                    .getResource(texturePath)
                    .map(resource -> {
                        try (InputStream in = resource.open()) {
                            return in.readAllBytes();
                        } catch (IOException e) {
                            return null;
                        }
                    })
                    .orElse(null);
        } catch (RuntimeException | IOException e) {
            return null;
        }
    }

    /**
     * {@code NativeImage} não expõe um encoder PNG público em bytes; passar
     * por um arquivo temporário usa o encoder do próprio jogo (STB) e o
     * arquivo é apagado na sequência. Só roda quando a skin muda.
     */
    private static byte[] toPngBytes(NativeImage image) throws IOException {
        Path tmp = Files.createTempFile("baritone-orchestrator-skin", ".png");
        try {
            image.writeToFile(tmp);
            return Files.readAllBytes(tmp);
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    /** Drena a fila do canal reverso e executa na thread do cliente. */
    private static void drainCommands(IBaritone baritone) {
        String line;
        while ((line = pendingCommands.poll()) != null) {
            try {
                JsonObject message = JsonParser.parseString(line).getAsJsonObject();
                switch (message.get("type").getAsString()) {
                    case "instruction" -> handleInstruction(baritone, message);
                    case "cancel" -> cancelActiveInstruction(baritone);
                    default -> { }
                }
            } catch (RuntimeException e) {
                // Linha malformada (JSON quebrado, campo faltando) não pode
                // derrubar o jogo — ignora e segue.
            }
        }
    }

    /**
     * Executa uma instrução do app chamando o processo nativo do Baritone:
     * {@code travel_to} → {@link GoalXZ} + {@code ICustomGoalProcess};
     * {@code explore} → com `radius`+`style`, percorre waypoints próprios
     * ({@link #buildExploreWaypoints}); sem eles, {@code IExploreProcess}
     * nativo ({@code explore(origemX, origemZ)}), que não tem forma definida.
     */
    private static void handleInstruction(IBaritone baritone, JsonObject message) {
        String id = message.get("id").getAsString();
        String kind = message.get("kind").getAsString();
        BetterBlockPos feet = baritone.getPlayerContext().playerFeet();

        switch (kind) {
            case "travel_to" -> {
                int x = message.get("x").getAsInt();
                int z = message.get("z").getAsInt();
                baritone.getCustomGoalProcess().setGoalAndPath(new GoalXZ(x, z));
                activeInstructionId = id;
                activeInstructionKind = kind;
                activeTargetX = x;
                activeTargetZ = z;
                // Progresso = fração da distância em linha reta já vencida;
                // é aproximado (o caminho real do Baritone desvia de
                // obstáculos), mas é medido do mundo real, não chutado.
                activeInitialDistance = Math.max(1.0, Math.hypot(x - feet.x, z - feet.z));
                sendInstructionStatus("active", 0.0f);
            }
            case "explore" -> {
                int originX = message.has("x") ? message.get("x").getAsInt() : feet.x;
                int originZ = message.has("z") ? message.get("z").getAsInt() : feet.z;
                if (message.has("radius") && message.has("style")) {
                    ArrayList<int[]> waypoints = buildExploreWaypoints(
                            originX, originZ, message.get("radius").getAsInt(), message.get("style").getAsString());
                    if (!waypoints.isEmpty()) {
                        exploreWaypoints = waypoints;
                        exploreWaypointIndex = 0;
                        activeInstructionId = id;
                        activeInstructionKind = "explore_waypoints";
                        int[] first = waypoints.get(0);
                        baritone.getCustomGoalProcess().setGoalAndPath(new GoalXZ(first[0], first[1]));
                        sendInstructionStatus("active", 0.0f);
                        return;
                    }
                }
                baritone.getExploreProcess().explore(originX, originZ);
                activeInstructionId = id;
                activeInstructionKind = kind;
                // Explore nativo é contínuo (não tem "chegou"): fica ativo,
                // sem progresso, até o app cancelar.
                sendInstructionStatus("active", 0.0f);
            }
            default -> { }
        }
    }

    /**
     * Gera os waypoints do raio pedido nos dois padrões. O passo entre faixas
     * (zigue-zague) e anéis (círculos) vem da render distance efetiva do
     * cliente: passar por dentro dela já carrega os chunks, então repetir de 16
     * em 16 blocos só faria o bot andar mais devagar sem revelar nada novo.
     */
    private static ArrayList<int[]> buildExploreWaypoints(int originX, int originZ, int radius, String style) {
        int step = Math.max(16, Minecraft.getInstance().options.getEffectiveRenderDistance() * 16);
        ArrayList<int[]> points = new ArrayList<>();
        if ("zigzag".equals(style)) {
            boolean leftToRight = true;
            for (int dz = 0; dz <= radius && points.size() < MAX_EXPLORE_WAYPOINTS; dz += step) {
                // Faixa central uma vez; acima e abaixo dela, uma de cada lado.
                for (int sign = dz == 0 ? 1 : -1; sign <= 1 && points.size() < MAX_EXPLORE_WAYPOINTS; sign += 2) {
                    int z = originZ + dz * sign;
                    points.add(new int[]{leftToRight ? originX - radius : originX + radius, z});
                    points.add(new int[]{leftToRight ? originX + radius : originX - radius, z});
                    leftToRight = !leftToRight;
                }
            }
        } else {
            boolean clockwise = true;
            for (int ring = step; ring <= radius && points.size() < MAX_EXPLORE_WAYPOINTS; ring += step) {
                // Pontos a cada ~meio passo de arco: caminhar entre dois pontos
                // consecutivos é uma corda curta, então o anel sai suave.
                int samples = Math.max(8, (int) Math.round(2 * Math.PI * ring / (step / 2.0)));
                for (int i = 0; i < samples && points.size() < MAX_EXPLORE_WAYPOINTS; i++) {
                    double angle = 2 * Math.PI * i / samples * (clockwise ? 1 : -1);
                    points.add(new int[]{
                        originX + (int) Math.round(ring * Math.cos(angle)),
                        originZ + (int) Math.round(ring * Math.sin(angle)),
                    });
                }
                clockwise = !clockwise; // anéis em sentidos alternados: menos deslocamento entre eles
            }
        }
        return points;
    }

    private static void cancelActiveInstruction(IBaritone baritone) {
        if (activeInstructionId == null) {
            return;
        }
        baritone.getPathingBehavior().cancelEverything();
        clearActiveInstruction();
    }

    /**
     * Confere se a instrução ativa terminou e reporta progresso. `travel_to`:
     * o Baritone larga o goal ao chegar (`getGoal() == null`) — se estava
     * perto do alvo é `done`, senão foi interrompido (`failed`, ex: `#stop`
     * digitado no jogo). `explore_waypoints`: cada waypoint alcançado (ou
     * abandonado, se o pathing desistiu — um ponto sobre lava não pode travar
     * a exploração inteira) avança o índice; o último fecha a instrução.
     * `explore` nativo: se o processo parou sozinho, `failed`.
     */
    private static void tickActiveInstruction(IBaritone baritone) {
        if (activeInstructionId == null) {
            return;
        }
        if ("travel_to".equals(activeInstructionKind)) {
            BetterBlockPos feet = baritone.getPlayerContext().playerFeet();
            double distance = Math.hypot(activeTargetX - feet.x, activeTargetZ - feet.z);
            Goal goal = baritone.getCustomGoalProcess().getGoal();
            if (goal == null) {
                finishActiveInstruction(distance <= ARRIVAL_RADIUS_BLOCKS ? "done" : "failed");
                return;
            }
            if (distance <= ARRIVAL_RADIUS_BLOCKS) {
                finishActiveInstruction("done");
                return;
            }
            float progress = (float) Math.min(1.0, Math.max(0.0, 1.0 - distance / activeInitialDistance));
            sendInstructionStatus("active", progress);
        } else if ("explore_waypoints".equals(activeInstructionKind)) {
            BetterBlockPos feet = baritone.getPlayerContext().playerFeet();
            int[] waypoint = exploreWaypoints.get(exploreWaypointIndex);
            double distance = Math.hypot(waypoint[0] - feet.x, waypoint[1] - feet.z);
            boolean arrived = distance <= ARRIVAL_RADIUS_BLOCKS;
            if (arrived || baritone.getCustomGoalProcess().getGoal() == null) {
                exploreWaypointIndex++;
                if (exploreWaypointIndex >= exploreWaypoints.size()) {
                    finishActiveInstruction("done");
                    return;
                }
                int[] next = exploreWaypoints.get(exploreWaypointIndex);
                baritone.getCustomGoalProcess().setGoalAndPath(new GoalXZ(next[0], next[1]));
            }
            sendInstructionStatus("active", (float) exploreWaypointIndex / exploreWaypoints.size());
        } else if ("explore".equals(activeInstructionKind) && !baritone.getExploreProcess().isActive()) {
            finishActiveInstruction("failed");
        }
    }

    private static void finishActiveInstruction(String status) {
        sendInstructionStatus(status, "done".equals(status) ? 1.0f : null);
        clearActiveInstruction();
    }

    private static void clearActiveInstruction() {
        activeInstructionId = null;
        activeInstructionKind = null;
        exploreWaypoints = null;
        exploreWaypointIndex = 0;
    }

    /** `progress` só vai no JSON quando existe — ver `addon_socket.rs`. */
    private static void sendInstructionStatus(String status, Float progress) {
        if (activeInstructionId == null) {
            return;
        }
        if (progress == null) {
            send(String.format(
                    Locale.ROOT,
                    "{\"type\":\"instruction_status\",\"id\":\"%s\",\"status\":\"%s\"}",
                    activeInstructionId, status
            ));
        } else {
            send(String.format(
                    Locale.ROOT,
                    "{\"type\":\"instruction_status\",\"id\":\"%s\",\"status\":\"%s\",\"progress\":%.3f}",
                    activeInstructionId, status, progress
            ));
        }
    }

    /**
     * Enfileira o chunk recém-carregado pro envio de {@code chunk_voxels}.
     * Só enfileira: a serialização roda na fila drenada por
     * {@code onClientTick}, pra um teleport/join que carrega centenas de
     * chunks de uma vez não travar o jogo.
     *
     * <p>Deliberately does NOT send on {@link ChunkEvent.Unload} — see
     * {@code addon_socket.rs} for why this is a cumulative "seen" footprint,
     * not a live render-distance window.
     */
    @SubscribeEvent
    static void onChunkLoad(ChunkEvent.Load event) {
        if (!(event.getLevel() instanceof ClientLevel) || out == null) {
            return;
        }
        pendingChunkPayloads.add((LevelChunk) event.getChunk());
    }

    /**
     * Manda o chunk inteiro: cada seção 16×16×16 não-vazia vira paleta +
     * 4096 índices, tudo comprimido com zlib e base64 no JSON. É o mundo real
     * (relevo, cavernas, minérios), não só a superfície que dá pra ver de
     * cima — ver {@code docs/SPEC.md}, "Blocos 3D", e {@code world_cache.rs}.
     */
    private static void sendChunkVoxels(LevelChunk chunk) {
        ChunkPos pos = chunk.getPos();
        byte[] payload = serializeChunk(chunk);
        String encoded = Base64.getEncoder().encodeToString(payload);
        send(String.format(
                Locale.ROOT,
                "{\"type\":\"chunk_voxels\",\"x\":%d,\"z\":%d,\"data\":\"%s\"}",
                pos.x(), pos.z(), encoded
        ));
    }

    private static byte[] serializeChunk(LevelChunk chunk) {
        LevelChunkSection[] sections = chunk.getSections();

        int nonEmptySections = 0;
        for (LevelChunkSection section : sections) {
            if (!section.hasOnlyAir()) {
                nonEmptySections++;
            }
        }

        ByteArrayOutputStream raw = new ByteArrayOutputStream(64 * 1024);
        raw.write(VOXEL_FORMAT_VERSION);
        raw.write(nonEmptySections);

        for (int i = 0; i < sections.length; i++) {
            LevelChunkSection section = sections[i];
            if (section.hasOnlyAir()) {
                continue; // seção ausente = ar (ver decode_voxels no Rust)
            }

            sectionPalette.clear();
            sectionPaletteIndex.clear();

            // Ordem dos índices igual à do PalettedContainer vanilla:
            // x + z*16 + y*256.
            for (int y = 0; y < 16; y++) {
                for (int z = 0; z < 16; z++) {
                    for (int x = 0; x < 16; x++) {
                        BlockState state = section.getBlockState(x, y, z);
                        Integer index = sectionPaletteIndex.get(state);
                        if (index == null) {
                            index = sectionPalette.size();
                            sectionPalette.add(state);
                            sectionPaletteIndex.put(state, index);
                        }
                        sectionIndices[(y << 8) | (z << 4) | x] = (short) (int) index;
                    }
                }
            }

            writeI8(raw, chunk.getSectionYFromSectionIndex(i));
            writeU16(raw, sectionPalette.size());
            for (BlockState state : sectionPalette) {
                byte[] name = BuiltInRegistries.BLOCK
                        .getKey(state.getBlock())
                        .getPath()
                        .getBytes(StandardCharsets.UTF_8);
                writeU16(raw, name.length);
                raw.write(name, 0, name.length);
                raw.write(voxelFlags(state));
                raw.write(voxelLevel(state));
            }
            for (short index : sectionIndices) {
                writeU16(raw, index & 0xFFFF);
            }
        }

        return deflate(raw.toByteArray());
    }

    /**
     * Flags de renderização por entrada de paleta — o viewer do app usa isso
     * pro face culling sem precisar de uma lista de nomes de bloco:
     * {@code RENDER} = dá pra desenhar como cubo/bloco (ar e decoração
     * substituível, tipo grama alta, ficam de fora); {@code OCCLUDES} = o
     * bloco esconde as faces dos vizinhos; {@code FLUID} = água/lava — o
     * viewer desenha com altura de superfície (nível) e textura animada em
     * vez de cubo opaco.
     *
     * <p>Fluido de propósito NÃO é marcado como oclusor: se marcasse, a face
     * do chão/fundo contra a água sumiria e, como a água é translúcida, daria
     * pra ver o cenário vazio através dela. Mesmo-fluido o viewer culla pelo
     * nome do bloco.
     */
    private static int voxelFlags(BlockState state) {
        boolean liquid = state.getBlock() instanceof LiquidBlock;
        boolean fluid = liquid && !state.getFluidState().isEmpty();
        boolean render = !state.isAir() && (fluid || !isReplaceableDecoration(state));
        if (!render) {
            return 0;
        }
        int flags = VOXEL_FLAG_RENDER;
        if (fluid) {
            flags |= VOXEL_FLAG_FLUID;
        } else if (state.isSolidRender()) {
            flags |= VOXEL_FLAG_OCCLUDES;
        }
        return flags;
    }

    /**
     * Bloco substituível que o viewer escolhe não desenhar como cubo cheio:
     * grama alta, flor, muda (modelos em cruz) ficam fora — viram cubos e
     * poluiriam a cena. <b>Mas nem todo {@code canBeReplaced()} é planta</b>:
     * videira e os blocos de face ({@link MultifaceBlock}: líquen brilhante,
     * veia de sculk) também são {@code .replaceable()} no registro vanilla e
     * são geometria visível colada nas paredes. Sem esta exceção eles saíam do
     * payload com flags zero e um bioma de selva aparecia sem videira nenhuma.
     */
    private static boolean isReplaceableDecoration(BlockState state) {
        if (!state.canBeReplaced()) {
            return false;
        }
        return !(state.getBlock() instanceof VineBlock || state.getBlock() instanceof MultifaceBlock);
    }

    /**
     * Nível do fluido no formato do blockstate vanilla: {@code 0} = fonte,
     * {@code 1..=7} = fluindo (mais alto = mais raso), {@code 8} = caindo.
     * Fora de água/lava é sempre 0 (o viewer só interpreta com a flag FLUID).
     * O viewer converte isso na altura da superfície — ver
     * {@code PaletteEntry::fluid_height} no Rust e {@code fluidHeight} no
     * viewer.
     */
    private static int voxelLevel(BlockState state) {
        if (!(state.getBlock() instanceof LiquidBlock)) {
            return 0;
        }
        FluidState fluid = state.getFluidState();
        if (fluid.isEmpty() || fluid.isSource()) {
            return 0;
        }
        int amount = fluid.getAmount(); // 1..8, maior = mais cheio
        return amount >= 8 ? 8 : 8 - amount;
    }

    private static void writeU16(ByteArrayOutputStream out, int value) {
        out.write(value & 0xFF);
        out.write((value >>> 8) & 0xFF);
    }

    private static void writeI8(ByteArrayOutputStream out, int value) {
        out.write(value & 0xFF);
    }

    /** zlib (formato com header, igual ao `flate2::ZlibDecoder` do lado Rust). */
    private static byte[] deflate(byte[] input) {
        Deflater deflater = new Deflater(Deflater.DEFAULT_COMPRESSION);
        try {
            deflater.setInput(input);
            deflater.finish();
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(1024, input.length / 8));
            byte[] buffer = new byte[16 * 1024];
            while (!deflater.finished()) {
                int written = deflater.deflate(buffer);
                if (written > 0) {
                    out.write(buffer, 0, written);
                } else if (deflater.needsInput()) {
                    break; // não deve acontecer depois de finish(), mas evita loop infinito
                }
            }
            return out.toByteArray();
        } finally {
            deflater.end();
        }
    }

    /**
     * Backfills the chunks that were already resident on the client before
     * this connection existed — see the call site. Scans a square of
     * {@code getEffectiveRenderDistance()} chunks around the player and
     * enqueues each with {@code getChunk(x, z, false)} (non-forcing: returns
     * null instead of loading it), so this never pulls in chunks the client
     * doesn't already have.
     */
    private static void syncAlreadyLoadedChunks(BetterBlockPos center) {
        ClientLevel level = Minecraft.getInstance().level;
        if (level == null) {
            return;
        }
        int centerX = center.x >> 4;
        int centerZ = center.z >> 4;
        int radius = Minecraft.getInstance().options.getEffectiveRenderDistance();

        for (int dx = -radius; dx <= radius; dx++) {
            for (int dz = -radius; dz <= radius; dz++) {
                LevelChunk chunk = level.getChunkSource().getChunk(centerX + dx, centerZ + dz, false);
                if (chunk != null) {
                    pendingChunkPayloads.add(chunk);
                }
            }
        }
    }

    private static void ensureConnected() {
        if (socket != null && socket.isConnected() && !socket.isClosed()) {
            return;
        }
        long now = System.currentTimeMillis();
        if (now < nextReconnectAttemptMs) {
            return;
        }
        nextReconnectAttemptMs = now + RECONNECT_BACKOFF_MS;
        try {
            Socket newSocket = new Socket();
            newSocket.connect(new InetSocketAddress(HOST, PORT), 500);
            socket = newSocket;
            out = newSocket.getOutputStream();
            helloSent = false;
            lastSkinSignature = null; // conexão nova: o app precisa da skin de novo
            startReader(newSocket);
        } catch (IOException e) {
            // The Rust app probably isn't running yet — quietly retry later.
            socket = null;
            out = null;
        }
    }

    /**
     * Thread leitora do canal reverso: só acumula linhas em
     * {@link #pendingCommands} (concorrente); quem executa é {@code
     * onClientTick}, na thread do cliente, onde a API do Baritone é segura.
     * Daemon pra não segurar o processo do jogo se a conexão ficar pendurada.
     */
    private static void startReader(Socket newSocket) {
        Thread reader = new Thread(() -> {
            try (BufferedReader in = new BufferedReader(
                    new InputStreamReader(newSocket.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = in.readLine()) != null) {
                    pendingCommands.add(line);
                }
            } catch (IOException e) {
                // Conexão caiu — a próxima tick detecta (o `send` falha) e
                // tenta reconectar.
            }
        }, "baritone-orchestrator-socket-reader");
        reader.setDaemon(true);
        reader.start();
    }

    private static boolean send(String json) {
        try {
            out.write((json + "\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
            return true;
        } catch (IOException e) {
            socket = null;
            out = null;
            return false;
        }
    }
}
