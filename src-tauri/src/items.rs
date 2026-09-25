//! Modelo de dados de itens, blocos e receitas — ver `docs/SPEC.md`, seção
//! "Mapeamento completo de itens do jogo". Os dados reais vêm da ingestão do
//! `minecraft-data` (não implementada ainda: ver `commands::list_items`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ItemCategory {
    Tool,
    Block,
    Food,
    Material,
    Armor,
    Misc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: u32,
    pub name: String, // "iron_ingot"
    pub stack_size: u8,
    pub category: ItemCategory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolTier {
    Hand,
    Wood,
    Stone,
    Iron,
    Diamond,
    Netherite,
}

impl ToolTier {
    /// Multiplicador de velocidade de mineração — ver `docs/SPEC.md`,
    /// seção "Agendamento por estimativa de tempo".
    pub fn mining_multiplier(self) -> f32 {
        match self {
            ToolTier::Hand => 1.0,
            ToolTier::Wood => 2.0,
            ToolTier::Stone => 4.0,
            ToolTier::Iron => 6.0,
            ToolTier::Diamond => 8.0,
            ToolTier::Netherite => 9.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    pub id: u32,
    pub item_drop: Option<u32>, // item id que dropa ao minerar (None = bedrock, etc.)
    pub hardness: f32,
    pub harvest_tool: Option<ToolTier>, // ferramenta mínima
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum IngredientRef {
    Item(u32),        // item exato, ex: stick
    Tag(String),      // grupo aberto, ex: "minecraft:planks"
    AnyOf(Vec<u32>),  // lista fechada, ex: [coal, charcoal]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecipeType {
    Shaped,
    Shapeless,
    Smelting,
    Blasting,
    Smoking,
    Campfire,
    Stonecutting,
    Smithing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Station {
    Inventory2x2,
    CraftingTable,
    Furnace,
    BlastFurnace,
    Smoker,
    Campfire,
    Stonecutter,
    SmithingTable,
}

pub type Pattern = [[Option<IngredientRef>; 3]; 3];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recipe {
    pub output_item: u32,
    pub output_count: u8,
    pub recipe_type: RecipeType,
    pub station: Station,
    pub ingredients: Vec<(IngredientRef, u8)>, // shapeless/smelting
    pub pattern: Option<Pattern>,              // grade 3x3, só para shaped
    pub cook_time_ticks: Option<u16>,          // smelting/campfire/blasting/smoking
}

/// Menor retângulo (linhas, colunas) que cobre os slots não-vazios do padrão.
fn bounding_box(pattern: &Pattern) -> (u8, u8) {
    let mut min_row = 3u8;
    let mut max_row = 0u8;
    let mut min_col = 3u8;
    let mut max_col = 0u8;
    let mut any = false;

    for (r, row) in pattern.iter().enumerate() {
        for (c, slot) in row.iter().enumerate() {
            if slot.is_some() {
                any = true;
                min_row = min_row.min(r as u8);
                max_row = max_row.max(r as u8);
                min_col = min_col.min(c as u8);
                max_col = max_col.max(c as u8);
            }
        }
    }

    if !any {
        return (0, 0);
    }
    (max_row - min_row + 1, max_col - min_col + 1)
}

/// Decide se a receita cabe no grid 2x2 do inventário pessoal, sem precisar de
/// mesa de trabalho — ver `docs/SPEC.md`, seção "Receitas 2×2".
pub fn fits_inventory_2x2(recipe: &Recipe) -> bool {
    match &recipe.pattern {
        None => recipe.ingredients.iter().map(|(_, qty)| *qty as u32).sum::<u32>() <= 4,
        Some(pattern) => {
            let (rows, cols) = bounding_box(pattern);
            rows <= 2 && cols <= 2
        }
    }
}
