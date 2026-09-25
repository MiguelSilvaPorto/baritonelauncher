package dev.baritone.orchestrator.addon;

import com.mojang.logging.LogUtils;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.event.lifecycle.FMLCommonSetupEvent;
import org.slf4j.Logger;

// The value here must match the modid in src/main/templates/META-INF/neoforge.mods.toml
// (which is filled in from gradle.properties -> mod_id at build time).
@Mod(BaritoneOrchestratorAddon.MODID)
public class BaritoneOrchestratorAddon {

    public static final String MODID = "baritoneorchestrator";
    public static final Logger LOGGER = LogUtils.getLogger();

    // Shared here (not in the client-only class) so the common setup log below
    // never has to load a client-only class on a dedicated server.
    public static final String SOCKET_HOST = "127.0.0.1";
    public static final int SOCKET_PORT = 31173;

    public BaritoneOrchestratorAddon(IEventBus modEventBus, ModContainer modContainer) {
        modEventBus.addListener(this::commonSetup);
    }

    private void commonSetup(FMLCommonSetupEvent event) {
        LOGGER.info(
                "Baritone Orchestrator addon loaded — bridging to the Rust app at {}:{}",
                SOCKET_HOST,
                SOCKET_PORT
        );
    }
}
