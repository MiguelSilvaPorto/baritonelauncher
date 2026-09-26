package dev.baritone.orchestrator.addon;

import baritone.api.schematic.AbstractSchematic;
import net.minecraft.world.level.block.state.BlockState;

import java.util.List;
import java.util.Map;

/**
 * Schematic <b>esparso</b> do editor do app: só as posições que o diff mandou
 * (o resto do volume fica como está, em vez de virar ar). Alvo
 * {@code Blocks.AIR} = quebrar — é o mesmo caminho que o {@code clearArea} do
 * Baritone usa — e qualquer outro estado = colocar.
 *
 * <p>As chaves são {@link net.minecraft.core.BlockPos#asLong(int, int, int)}
 * de posições <b>locais</b> ao canto mínimo da caixa (0..size-1), que é a
 * coordenada que o {@code BuilderProcess} passa pro {@link #desiredState}.
 * Ver {@code startSchematicInstruction} (lado cliente).
 */
class OrchestratorSchematic extends AbstractSchematic {
    private final Map<Long, BlockState> targets;

    OrchestratorSchematic(int sizeX, int sizeY, int sizeZ, Map<Long, BlockState> targets) {
        super(sizeX, sizeY, sizeZ);
        this.targets = targets;
    }

    @Override
    public BlockState desiredState(int x, int y, int z, BlockState current, List<BlockState> approxPlaceable) {
        BlockState target = targets.get(net.minecraft.core.BlockPos.asLong(x, y, z));
        // Fora da lista: mantém o que já está lá (é esparso, não uma caixa cheia).
        return target == null ? current : target;
    }
}
