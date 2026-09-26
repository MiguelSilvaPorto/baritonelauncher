//! Fila de instruções que o bot executa em sequência/prioridade — ver
//! `docs/SPEC.md`, seção "O que é". Cada instrução vira, no fim, uma chamada
//! a um processo nativo do Baritone (`IBuilderProcess`, `IMineProcess`, ...)
//! disparada pelo addon Java.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InstructionStatus {
    Queued,
    Active,
    Paused,
    Done,
    Failed,
    /// Cancelada pelo usuário ou pelo app (ex: `queue_cancel`) — não é falha
    /// de execução, por isso não reusa `Failed`.
    Canceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InstructionKind {
    Explore,
    Mine,
    Build,
    FetchFromChest,
    Craft,
    Smelt,
    TravelTo,
}

/// Alvo horizontal (x, z) de uma instrução de deslocamento — é o que o
/// Baritone precisa pra `GoalXZ`/`explore(originX, originZ)`. Sem `y` de
/// propósito: o pathing resolve a altura sozinho (`TravelTo` navega até a
/// coluna, não até um bloco exato).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstructionTarget {
    pub x: i32,
    pub z: i32,
}

/// Padrão de varredura da exploração com raio (`ExploreParams`). O Baritone
/// sozinho só tem `explore(origem)` (anda pro chunk nunca visto mais próximo,
/// sem forma definida); os padrões abaixo são uma sequência de waypoints que o
/// addon percorre, com progresso real.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExploreStyle {
    /// Anéis concêntricos a partir da origem.
    Circles,
    /// Faixas de ida e volta cobrindo o quadrado do raio.
    Zigzag,
}

/// Exploração com área definida: raio em blocos + padrão. `radius` é validado
/// no comando (`queue_push`) porque um raio absurdo viraria uma lista de
/// waypoints enorme no addon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExploreParams {
    pub radius: u32,
    pub style: ExploreStyle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instruction {
    pub id: String,
    pub kind: InstructionKind,
    pub label: String,
    pub status: InstructionStatus,
    /// 0.0–1.0
    pub progress: f32,
    /// Ausente em instruções sem alvo no mundo (ex: `Explore` sem origem
    /// explícita — o addon usa a posição atual do bot).
    pub target: Option<InstructionTarget>,
    /// Só para `Explore`: raio + padrão de varredura. `None` = exploração
    /// nativa do Baritone (sem forma definida, até ser cancelada).
    pub explore: Option<ExploreParams>,
}

#[derive(Debug, Default)]
pub struct InstructionQueue {
    pub items: Vec<Instruction>,
}

impl InstructionQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, instruction: Instruction) {
        self.items.push(instruction);
    }

    pub fn active(&self) -> Option<&Instruction> {
        self.items.iter().find(|i| i.status == InstructionStatus::Active)
    }

    pub fn by_id_mut(&mut self, id: &str) -> Option<&mut Instruction> {
        self.items.iter_mut().find(|i| i.id == id)
    }

    /// Tira a próxima `Queued` da fila e a marca como `Active`, devolvendo uma
    /// cópia (o chamador precisa dela pra montar a mensagem do socket depois
    /// de soltar o lock). `None` = fila vazia.
    pub fn activate_next_queued(&mut self) -> Option<Instruction> {
        let next = self.items.iter_mut().find(|i| i.status == InstructionStatus::Queued)?;
        next.status = InstructionStatus::Active;
        next.progress = 0.0;
        Some(next.clone())
    }

    /// Aplica um status vindo do addon (`instruction_status`). Devolve `true`
    /// quando o status é terminal (`Done`/`Failed`) — quem chamou deve então
    /// liberar a próxima instrução da fila. Ids desconhecidos são ignorados
    /// (ex: addon reconectado com instrução de uma sessão anterior do app).
    pub fn apply_remote_status(&mut self, id: &str, status: InstructionStatus, progress: Option<f32>) -> bool {
        let Some(item) = self.by_id_mut(id) else {
            return false;
        };
        if matches!(item.status, InstructionStatus::Done | InstructionStatus::Failed | InstructionStatus::Canceled) {
            return false;
        }
        item.status = status;
        if let Some(progress) = progress {
            item.progress = progress.clamp(0.0, 1.0);
        }
        if status == InstructionStatus::Done {
            item.progress = 1.0;
        }
        matches!(status, InstructionStatus::Done | InstructionStatus::Failed)
    }
}
