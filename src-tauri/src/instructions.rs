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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instruction {
    pub id: String,
    pub kind: InstructionKind,
    pub label: String,
    pub status: InstructionStatus,
    /// 0.0–1.0
    pub progress: f32,
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
}
