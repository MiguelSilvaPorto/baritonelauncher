package dev.baritone.orchestrator.addon;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import baritone.api.utils.BetterBlockPos;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.food.FoodData;
import net.minecraft.world.level.ChunkPos;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.event.level.ChunkEvent;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Client-only bridge: reads the local player's vitals and position through
 * the Baritone API (proving the {@code baritone.api} dependency resolves and
 * works at runtime, not just at compile time) and streams them as
 * newline-delimited JSON to the Rust app's local socket. Protocol is
 * documented in {@code src-tauri/src/addon_socket.rs} (Rust side) and
 * {@code mod-addon/README.md}.
 *
 * <p>This is intentionally the smallest possible end-to-end slice — see
 * {@code docs/CHANGELOG.md} for what's deliberately not sent yet (chunk
 * deltas, chest contents, threat detection, ...).
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

    private static Socket socket;
    private static OutputStream out;
    private static boolean helloSent;
    private static int ticksSinceLastVitals;
    private static int ticksSinceLastPosition;
    private static long nextReconnectAttemptMs;

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

        if (!helloSent) {
            helloSent = send(HELLO_MESSAGE);
        }

        ticksSinceLastPosition++;
        if (ticksSinceLastPosition >= POSITION_INTERVAL_TICKS) {
            ticksSinceLastPosition = 0;
            BetterBlockPos pos = baritone.getPlayerContext().playerFeet();
            send(String.format(
                    Locale.ROOT,
                    "{\"type\":\"position\",\"x\":%d,\"y\":%d,\"z\":%d}",
                    pos.x, pos.y, pos.z
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
        }
    }

    /**
     * Marks a client-rendered chunk as seen. Fires once per chunk load, so
     * this can be noisy right after joining a world (one message per chunk
     * already in render distance) — that's fine, each line is tiny and the
     * Rust side just does a HashMap insert.
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
        ChunkPos pos = event.getChunk().getPos();
        send(String.format(Locale.ROOT, "{\"type\":\"chunk_loaded\",\"x\":%d,\"z\":%d}", pos.x(), pos.z()));
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
        } catch (IOException e) {
            // The Rust app probably isn't running yet — quietly retry later.
            socket = null;
            out = null;
        }
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
