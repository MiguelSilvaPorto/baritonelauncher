package dev.baritone.orchestrator.addon;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.food.FoodData;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.client.event.ClientTickEvent;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Client-only bridge: reads the local player's vitals through the Baritone API
 * (proving the {@code baritone.api} dependency resolves and works at runtime,
 * not just at compile time) and streams them as newline-delimited JSON to the
 * Rust app's local socket. Protocol is documented in
 * {@code src-tauri/src/lib.rs} (Rust side) and {@code mod-addon/README.md}.
 *
 * <p>This is intentionally the smallest possible end-to-end slice — see
 * {@code docs/CHANGELOG.md} for what's deliberately not sent yet (chunk
 * deltas, chest contents, threat detection, ...).
 */
@EventBusSubscriber(modid = BaritoneOrchestratorAddon.MODID, value = Dist.CLIENT)
public class BaritoneOrchestratorAddonClient {

    static final String HOST = BaritoneOrchestratorAddon.SOCKET_HOST;
    static final int PORT = BaritoneOrchestratorAddon.SOCKET_PORT;

    private static final int SEND_INTERVAL_TICKS = 20; // once a second
    private static final int RECONNECT_BACKOFF_MS = 5000;
    private static final String HELLO_MESSAGE =
            "{\"type\":\"hello\",\"addon_version\":\"0.1.0\",\"baritone_version\":\"1.20.0\",\"mc_version\":\"26.3\"}";

    private static Socket socket;
    private static OutputStream out;
    private static boolean helloSent;
    private static int ticksSinceLastSend;
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

        ticksSinceLastSend++;
        if (ticksSinceLastSend < SEND_INTERVAL_TICKS) {
            return;
        }
        ticksSinceLastSend = 0;

        FoodData food = player.getFoodData();
        String vitalsJson = String.format(
                Locale.ROOT,
                "{\"type\":\"vitals\",\"health\":%.1f,\"max_health\":%.1f,\"hunger\":%d,\"saturation\":%.1f,\"armor_points\":%d}",
                player.getHealth(),
                player.getMaxHealth(),
                food.getFoodLevel(),
                food.getSaturationLevel(),
                player.getArmorValue()
        );
        send(vitalsJson);
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
