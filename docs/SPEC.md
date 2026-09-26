# Orquestrador Baritone — Visão do Projeto

## O que é

App desktop (Rust/Tauri) que transforma o Baritone — mod de pathfinding do Minecraft — de uma ferramenta controlada por comando de chat em um sistema orquestrado externamente, com:

- **Visualização 3D própria** do mundo que o bot já explorou, renderizada fora do jogo (o client do Minecraft roda no mínimo gráfico possível, só como motor de física/rede/pathing)
- **Fila de instruções** que o bot executa em sequência/prioridade (explorar, minerar, construir, buscar item em baú)
- **Editor de schematic** onde desenhar/importar uma build já *é* a instrução — a diferença entre o mundo cacheado e o que foi desenhado vira a lista de blocos que o bot vai colocar
- **Índice de armazenamento**: baús mapeados e catalogados, com totais agregados por item, usados para decidir "buscar no baú" vs. "minerar" antes de uma build

O bot é "burro" — só executa instruções literais — mas confiável: segue exatamente o que for mandado. O app é o "cérebro" que decide o quê, quando e em que ordem.

## Por que existe

O Baritone já resolve pathing e automação básica (`#build`, `#mine`, `#explore`) muito bem, mas:
- Não tem gestão de inventário/baús nativa
- Não tem visualização fora do jogo — só o que a tela do client mostra
- Comando por comando de chat não escala pra orquestração de múltiplas tarefas encadeadas

Prior art parcial existe (SkyNet controla bots via WebSocket; prismarine-viewer renderiza mundo de bot Mineflayer em 3D externo), mas ninguém juntou pathing robusto do Baritone + viewer 3D externo + edição-como-instrução num produto único.

## Arquitetura

**Importante — o que é reaproveitado vs. o que é construído:** o Baritone **não é recriado**. Ele é instalado como mod separado no client, do jeito que sempre foi (Forge/Fabric), exatamente como o Impact ou o Meteor Client já fazem. O que você constrói é um **addon** — um segundo mod, instalado ao lado do Baritone, que **consome** a interface pronta `IBaritone` (via `BaritoneAPI.getProvider()`) pra acionar os processos nativos dele (pathing, `#build`, `#explore`, `#mine`) e **implementa por cima** só a lógica que o Baritone não cobre (`SurvivalProcess`, gestão de baú, `FollowAndAttackProcess`, etc.). Ou seja: Baritone = biblioteca de pathing já pronta; seu addon = a camada de decisão/orquestração/socket que fala com o Rust.

```
Minecraft (Baritone, mod já pronto)
        ↓ consumido via IBaritone
Addon Java (seu mod — o "cérebro ponte")             App Rust/Tauri
├─ chama baritone.api (pathing, build, explore)       ├─ WorldCache (voxels esparsos, por chunk)
├─ implementa processos próprios (Survival, etc.)     ├─ StorageIndex (baús: posição → conteúdo)
├─ escuta eventos de chunk/bloco/baú             ←──→ ├─ Renderer (wgpu, greedy meshing, dirty-flag)
├─ executa instruções recebidas                       ├─ Fila de instruções (prioridade, status)
└─ reporta posição/progresso/vitais                   └─ Editor (diff = instrução)
        socket local (TCP/WebSocket, mensagens binárias/JSON)
```

**Fluxo de um bloco de terreno:** mod Java detecta chunk carregado → serializa só posições não-ar → manda delta pro Rust → `WorldCache` atualiza → chunk marcado "sujo" → remesh (throttled, thread separada) → GPU recebe buffer atualizado.

**Fluxo de uma instrução:** usuário desenha/seleciona no viewer ou importa `.litematic` → vira entrada na fila → app calcula o que falta (`getMissing()` do `BuilderProcess`) → cruza com `StorageIndex` (tem no baú? busca. não tem? minera) → libera `BuilderProcess` nativo do Baritone pra completar.

**Processos do Baritone usados como base:** `ICustomGoalProcess` (ir até ponto), `IExploreProcess` (cobrir raio sem repetir chunk), `IMineProcess`, `IBuilderProcess`, mais um `IBaritoneProcess` customizado próprio pra interceptar antes do build (logística de baú/craft).

## Mapeamento completo de itens do jogo

O app precisa saber, pra qualquer item do Minecraft: como craftar, de qual bloco vem (mineração), qual ferramenta é necessária, e em qual estação (mesa de trabalho, forno, etc.). Isso alimenta diretamente a lógica de "tem no baú → minera → craft" da fila de instruções.

### Não reinventar a base de dados

Não vale a pena mapear ~1400 itens e ~450 blocos à mão — isso já existe, versionado, mantido pela comunidade: **`minecraft-data`** (projeto PrismarineJS, usado por Mineflayer e outros bots). Fornece, por versão do jogo, JSON pronto com:

- `items.json` — id, nome, `stackSize`, categoria
- `blocks.json` — id, nome, dureza, `harvestTools` (ferramenta mínima pra dropar item), o que dropa ao ser minerado
- `recipes.json` — receitas de crafting (shaped/shapeless), fundição (smelting) e o que cada uma produz
- `biomes.json` — útil futuramente pra decisão de "onde explorar pra achar X"

A vantagem de usar essa fonte em vez de extrair direto do jar do Minecraft: já é JSON limpo, versionado por release do jogo, sem precisar decompilar nada.

### Ingestão no lado Rust

- No build ou no primeiro boot, o app baixa/empacota o `minecraft-data` da versão correspondente ao client conectado (a versão vem do handshake do mod Java)
- Parse pra structs Rust internas via `serde`, carregado uma vez em memória (é pequeno, poucos MB) — não precisa banco de dados pra isso, só o `StorageIndex` (baús) é que precisa persistência

### Modelo de dados interno

```rust
struct Item {
    id: u32,
    name: String,           // "iron_ingot"
    stack_size: u8,
    category: ItemCategory, // Tool, Block, Food, Material, ...
}

struct Block {
    id: u32,
    item_drop: Option<u32>, // item id que dropa ao minerar (None = drop nenhum, ex: bedrock)
    hardness: f32,
    harvest_tool: Option<ToolTier>, // ferramenta mínima (ex: precisa picareta de ferro+)
}

enum IngredientRef {
    Item(u32),           // item exato — ex: stick (não tem variação, só existe um)
    Tag(String),          // grupo aberto por propriedade — ex: "minecraft:planks" (qualquer madeira)
    AnyOf(Vec<u32>),      // lista fechada de alternativas específicas — ex: [coal, charcoal]
}

struct Recipe {
    output_item: u32,
    output_count: u8,
    recipe_type: RecipeType, // Shaped, Shapeless, Smelting, Blasting, Smoking, Campfire, Stonecutting, Smithing
    station: Station,       // CraftingTable, Inventory2x2, Furnace, BlastFurnace, Smoker, Campfire, Stonecutter, SmithingTable
    ingredients: Vec<(IngredientRef, u8)>, // shapeless/smelting
    pattern: Option<[[Option<IngredientRef>; 3]; 3]>, // grade 3x3 — só para receitas shaped
    cook_time_ticks: Option<u16>, // smelting/campfire/blasting/smoking
}
```

### Resolução de "como conseguir X"

Dado um item que falta pra uma build (vindo do `getMissing()` do Baritone), o app resolve em árvore:

1. **Tem no baú indexado?** → gera instrução "buscar no baú"
2. **Não tem, mas tem receita de craft** e os ingredientes estão disponíveis (baú ou já craftáveis recursivamente) → gera instrução "craftar", que pode disparar sub-instruções pros ingredientes primeiro
3. **É um item que só vem de minério/bloco** (sem receita, ex: ferro bruto) → cruza com `Block.item_drop` pra achar qual bloco minerar, e gera instrução "minerar", verificando se a ferramenta atual do bot atende `harvest_tool` — se não atender, isso vira uma instrução anterior na fila ("craftar ferramenta X primeiro")
4. Resultado final é uma **árvore de dependências linearizada em fila**: ferramentas antes dos recursos que exigem elas, ingredientes antes das receitas que os usam

Essa árvore de resolução é o motor por trás do `ResourceManagerProcess` (mencionado na arquitetura) — ele não decide "na sorte", ele resolve a dependência completa antes de liberar o `BuilderProcess`.

### Painel de itens no app (extensão da UI)

Vale um painel de busca/catálogo (acessível pelo rail de ícones) que mostra, pra qualquer item selecionado:
- Onde já foi visto (baús indexados + quantidade)
- Receita de craft (se houver), com sub-ingredientes navegáveis
- Bloco de origem + ferramenta mínima (se for minerável)
- Botão "adicionar à fila" que já dispara a resolução acima

## Mapeamento completo de receitas — o que o bot precisa executar

`minecraft-data` também cobre `recipes.json` com todos os tipos de receita do jogo, mas cada tipo exige uma **sequência de ações diferente** do bot — não é só "ter os ingredientes". Isso é o que efetivamente vira instrução de baixo nível pro mod Java executar.

### Os tipos de receita e o que cada um exige

| Tipo | Estação | O que o bot precisa fazer |
|---|---|---|
| **Shapeless** | inventário (2x2) ou mesa (3x3) | Colocar os ingredientes em qualquer slot do grid — ordem não importa. O mais simples de resolver. |
| **Shaped** | inventário (2x2) só se couber num 2x2; senão mesa (3x3) | Precisa respeitar o **padrão exato** de posição (ex: picareta = 3 no topo, cabo no meio das 2 linhas seguintes). O bot tem que colocar cada ingrediente no slot certo da grade, não só "ter os itens". |
| **Smelting** | forno | Precisa de **combustível** além do insumo — e leva tempo real (ticks), não é instantâneo como crafting. |
| **Blasting** | forno a lava (blast furnace) | Igual smelting, mas só pra minérios/metais, 2x mais rápido. |
| **Smoking** | defumador (smoker) | Igual smelting, mas só pra comida, 2x mais rápido. |
| **Campfire** | fogueira | Como smelting, mas sem gastar item de combustível separado (a fogueira já queima sozinha) — só mais lento. |
| **Stonecutting** | serra de pedra | Sem combustível, instantâneo, mas cada bloco de entrada pode ter **múltiplas saídas possíveis** (ex: pedra → 4 receitas diferentes de escada/laje/etc.) — o bot precisa escolher a certa na lista, não só colocar o item. |
| **Smithing** | mesa de ferraria | Exige **3 componentes** (molde/template + item base + material), não 2 — usado pra upgrade de netherite. |

### Sequência de execução por tipo (o que o mod Java precisa simular)

**Crafting (shaped/shapeless):**
1. Se o resultado couber no grid pessoal 2×2 (receita usa no máximo 4 slots em formato 2×2) → não precisa ir até uma mesa, usa o inventário direto
2. Senão, pathing até a mesa de trabalho mais próxima conhecida (ou craftar/colocar uma nova se não tiver nenhuma indexada)
3. Abrir a tela de crafting (`ContainerScreen`)
4. Para shaped: colocar cada ingrediente no slot exato do padrão (mapear `pattern` da receita pros índices reais do grid da UI)
5. Clicar no slot de resultado pra coletar — repetir o craft (ou usar "craft all" do recipe book, se disponível na versão) até atingir a quantidade necessária
6. Fechar a tela, seguir pra próxima instrução da fila

**Smelting/Blasting/Smoking:**
1. Pathing até forno conhecido (ou construir um novo)
2. Verificar se tem combustível suficiente no inventário — se não tiver, isso vira uma **sub-instrução anterior**: escolher o combustível mais eficiente disponível (carvão > madeira > lava, considerando itens por unidade de combustível — 1 carvão funde 8 itens, por exemplo)
3. Inserir insumo + combustível nos slots corretos
4. **Esperar** o tempo de cozimento (`cook_time_ticks` × quantidade, menos se tiver múltiplos fornos rodando em paralelo) — diferente de crafting, aqui o bot pode ir fazer outra coisa da fila enquanto espera, e só voltar pra coletar
5. Coletar resultado do slot de saída

**Stonecutting:**
1. Pathing até a serra de pedra
2. Colocar o bloco de entrada
3. Escolher a receita certa na lista de saídas possíveis (a UI da serra mostra várias opções pro mesmo insumo — o app já sabe qual escolher porque resolveu isso na árvore de dependência antes de gerar a instrução)
4. Coletar

**Smithing:**
1. Pathing até mesa de ferraria
2. Colocar os 3 componentes nos slots certos (molde, base, material)
3. Coletar — processo raro o suficiente (upgrade de netherite) pra não precisar de otimização especial

### O que isso muda na árvore de resolução

A resolução "como conseguir X" (seção anterior) agora também decide **qual estação construir/visitar** e, pra receitas com tempo de espera (fundição), pode **paralelizar**: enquanto um forno cozinha, o bot segue outras instruções da fila em vez de ficar parado — isso é coordenado pelo orquestrador, não pelo `BuilderProcess` nativo do Baritone (que não tem esse conceito de "esperar e voltar depois").

Isso também é o motivo de precisar simular cliques em tela de container (`ContainerScreen`) diretamente via packet, já que o Baritone não tem essa camada — é lógica nova do seu mod Java, na mesma linha do que discutimos pra abrir/ler baús.

## Blocos 3D — texturas e o editor de schematic (estilo WorldEdit)

### Divisão de fonte formalizada

Receita/item e bloco 3D são dois problemas independentes, com fontes diferentes:

| Precisa de | Fonte | Por quê |
|---|---|---|
| Receita de crafting, categoria de item, o que um bloco dropa | JEI (via API, se o mod estiver no client) → `minecraft-data` como fallback | JEI cobre automaticamente mods instalados; `minecraft-data` cobre vanilla sem depender de nada opcional |
| Textura real + geometria do bloco pra renderizar em 3D | Client jar oficial (baixado do Mojang) ou resource pack ativo | JEI só desenha o ícone achatado do item no inventário — não expõe as texturas por face nem o modelo 3D; o jar oficial sempre existe, é o próprio jogo, não uma dependência opcional |

### De dentro do client jar pro renderer

O jar do Minecraft já vem organizado exatamente pra isso:

- `assets/minecraft/textures/block/*.png` — as texturas cruas, uma por face/variante (ex: `grass_block_top.png`, `grass_block_side.png`)
- `assets/minecraft/models/block/*.json` — define **quais texturas vão em quais faces** de cada modelo (um bloco pode ter até 6 faces diferentes, mais casos especiais tipo cross-model das plantas)
- `assets/minecraft/blockstates/*.json` — mapeia cada **estado de bloco** (ex: escada virada pra norte vs. sul, metade de cima vs. baixo) pro modelo correto, incluindo rotação
- `assets/minecraft/textures/colormap/grass.png` e `foliage.png` — mapas de cor usados pro *biome tint* (grama e folhas mudam de cor por bioma, aplicado em runtime sobre a textura base)

### Pipeline de ingestão (uma vez, cacheado)

1. Baixa o jar oficial (endpoint público de metadata do Mojang), extrai os três diretórios acima
2. Resolve cada `blockstate` → modelo → lista de `(textura, face, tint_index)`
3. Empacota todas as texturas num **atlas único** (textura grande combinando todas as pequenas, com UV mapeado) — essencial pra performance: o greedy meshing já discutido usa esse atlas pra desenhar todo o mundo com uma textura só, sem trocar de material a cada bloco
4. Resultado vira um `BlockDef` compilado, guardado em cache local (não precisa refazer isso toda sessão, só quando a versão do jogo muda):

```rust
struct BlockDef {
    id: u32,
    blockstate_key: String,       // "minecraft:oak_stairs[facing=north,half=bottom]"
    faces: Vec<FaceUV>,           // até 6 entradas, cada uma apontando pro atlas
    biome_tint: bool,
}

struct FaceUV {
    direction: Direction,         // Up, Down, North, South, East, West
    atlas_rect: (f32, f32, f32, f32),
    tint_index: Option<u8>,
}
```

### Como isso vira o editor estilo WorldEdit

O editor (modo separado do viewer, mesmo motor de render) usa esse mesmo `BlockDef`/atlas pra tudo:

- **Paleta de blocos**: painel lateral com busca + categorias, cada entrada já renderizada com a textura real (via atlas) — não é lista de texto, é visual, igual o inventário criativo do próprio jogo
- **Seletor de estado**: ao escolher um bloco com variantes (escada, log, porta, laje), abre um pequeno inspetor de propriedades — rotação, metade, "com água" — espelhando as mesmas opções que o `blockstate` real do jogo aceita, porque a instrução final precisa gerar exatamente essa string de estado
- **Pintura na cena**: usuário seleciona região ou clica bloco a bloco; blocos pintados viram uma **camada separada** do `WorldCache` real — renderizados com o mesmo atlas mas em opacidade reduzida (ghost), pra sempre dar pra distinguir "o que já existe no mundo" de "o que foi desenhado mas ainda não construído" (é o mesmo ghost tracejado âmbar que já está no mockup, só que agora com blocos texturizados de verdade em vez do placeholder isométrico simplificado)
- **Geração de instrução**: ao aplicar, o diff entre `WorldCache` (real) e a camada de edição vira lista de `(posição, blockstate_key)` — isso é literalmente o schematic, no formato que o `BuilderProcess` do Baritone consome
- **Import de `.litematic`**: mesmo caminho — o arquivo já traz `blockstate` por posição, só precisa resolver cada um contra o `BlockDef` compilado pra saber que textura desenhar na prévia antes de construir

Esse pipeline garante que **paleta, prévia da build e mundo real renderizado sejam sempre visualmente consistentes** — todos passam pelo mesmo atlas, então uma escada de carvalho no editor parece exatamente igual à escada de carvalho já existente no mundo cacheado.

### O que realmente define shaped vs. shapeless

O critério **não é** "quais itens estão envolvidos" nem "em que slot absoluto da mesa" — é se existe uma **relação de posição relativa entre os ingredientes** que precisa ser respeitada:

- **Shapeless**: os itens podem estar em qualquer slot, sem relação entre si — só importa quais itens e quantos, a posição de cada um é irrelevante
- **Shaped**: existe uma relação relativa que precisa valer — não fixa em *qual* slot exato do grid, mas fixa *como os ingredientes precisam estar dispostos entre si*. O grid inteiro pode deslizar (a receita funciona em qualquer posição do 2x2 ou 3x3), mas o padrão relativo entre os ingredientes é obrigatório

### Exemplo resolvido: tocha

A tocha ilustra bem essa distinção, porque à primeira vista parece simples — "carvão + stick" — mas é **shaped**, não shapeless: o carvão precisa estar **diretamente acima** do stick. Não importa em qual posição do grid isso acontece (topo-esquerda, centro, qualquer lugar), mas a relação vertical entre os dois ingredientes é obrigatória — trocar a ordem (stick em cima, carvão embaixo) não funciona. É isso que classifica a receita como shaped: a posição relativa importa, mesmo a posição absoluta sendo livre.

```
pattern: [
  [ Some(AnyOf([coal_id, charcoal_id])) ],  // linha 0
  [ Some(Item(stick_id)) ],                  // linha 1
]
output_item: torch_id
output_count: 4
recipe_type: Shaped
station: Inventory2x2   // cabe no 2x2, não precisa de mesa
```

Rodando pelo algoritmo genérico de posicionamento shaped (seção anterior): o bot testa esse padrão de 1 coluna × 2 linhas deslizando por todas as posições possíveis do grid disponível — sem precisar de nenhum caso especial só pra tocha. O mesmo executor resolve qualquer receita shaped, tocha incluída, desde que o padrão relativo e os `IngredientRef` de cada slot estejam corretos.

### Exemplo resolvido: isqueiro (flint and steel)

Contraste direto com a tocha — mesma ideia de "dois ingredientes", mas aqui **é** shapeless de verdade: ferro + pederneira, em **qualquer slot**, qualquer ordem, até em cantos opostos do grid (slot 1 e slot 9 funcionam igual a slots vizinhos). Não existe relação de posição nenhuma entre os dois itens.

```
recipe_type: Shapeless
ingredients: [
  (Item(iron_ingot_id), 1),
  (Item(flint_id), 1),
]
output_item: flint_and_steel_id
output_count: 1
station: Inventory2x2
pattern: None
```

Sem `pattern` nenhum — só a lista de ingredientes. É essa ausência de padrão relativo que diferencia estruturalmente do caso da tocha.

### Receitas 2×2 — quando não precisa de mesa

Todo jogador tem, sem craftar nada, um grid **2×2** no próprio inventário (tecla `E`). A mesa de trabalho só é necessária quando a receita não cabe nesse espaço. O que decide isso, no modelo:

- **Shapeless**: cabe no 2×2 se tiver **no máximo 4 unidades de ingrediente ao todo** (contando repetição) — não importa quais, já que posição é livre. Isqueiro (2 itens) cabe fácil.
- **Shaped**: cabe no 2×2 só se o **bounding box do padrão** (menor retângulo que envolve todos os slots não-vazios) for **no máximo 2 colunas × 2 linhas**. A tocha (1 coluna × 2 linhas) cabe. Uma receita shaped que ocupa 3 colunas (ex: qualquer coisa em formato de U ou linha horizontal completa) **não cabe**, mesmo tendo só 2 ou 3 itens no total — o que importa é a extensão do padrão, não a quantidade de ingredientes.

Isso vira uma função de decisão simples no app, calculada uma vez ao carregar cada receita (não em runtime):

```rust
fn fits_inventory_2x2(recipe: &Recipe) -> bool {
    match &recipe.pattern {
        None => recipe.ingredients.iter().map(|(_, qty)| *qty as u32).sum::<u32>() <= 4,
        Some(p) => {
            let (rows, cols) = bounding_box(p); // menor retângulo cobrindo slots não-vazios
            rows <= 2 && cols <= 2
        }
    }
}
```

Isso decide automaticamente o `station` de cada receita ao ingerir os dados (JEI/`minecraft-data`) — se cabe no 2×2, o bot nunca perde tempo indo até uma mesa de trabalho à toa; se não cabe, a instrução de craft já inclui pathing até a mesa (ou construir uma nova, se não tiver nenhuma indexada) antes de executar.

## Vida, fome e armadura — monitoramento e controle

Além do mundo e do inventário, o app precisa saber o **estado vital** do bot em tempo real pra tomar decisões de segurança — isso é o que evita o bot morrer no meio de uma instrução longa (minerando numa caverna, por exemplo) sem ninguém perceber.

### Dados a capturar (mod Java → socket)

| Dado | Fonte no client | Faixa |
|---|---|---|
| Vida | `getHealth()` / `getMaxHealth()` da entidade do jogador | 0–20 (cada "coração" = 2 pontos) |
| Fome | `FoodStats.getFoodLevel()` | 0–20 |
| Saturação | `FoodStats.getSaturationLevel()` | 0–20 (reserva oculta antes da fome cair) |
| Armadura | soma de `getArmorValue()`, ou por peça (capacete/peito/perna/bota) | 0–20 pontos totais |
| Durabilidade da armadura | por peça, `getDamage()` / `getMaxDamage()` do item | % por peça |
| Efeitos ativos | `getActiveEffectsMap()` | veneno, fome (debuff), regeneração, etc. |

Igual posição, isso é transmitido **a cada tick ou só quando muda** (evita tráfego desnecessário) — mesmo canal de socket já usado pra chunks/posição.

### Modelo de dados (Rust)

```rust
struct Vitals {
    health: f32,
    max_health: f32,
    hunger: u8,
    saturation: f32,
    armor_points: u8,
    armor_pieces: [Option<ArmorPiece>; 4], // capacete, peito, perna, bota
    active_effects: Vec<Effect>,
}

struct ArmorPiece {
    item_id: u32,
    durability_pct: f32,
}
```

### No viewer: HUD sobreposto

Barra de status fixa (canto inferior, junto dos controles do viewer que já existem), estilo consistente com o resto da UI — não os corações/ícones literais do jogo, e sim indicadores abstratos que seguem a identidade visual:
- Barra de vida: preenchimento vermelho sobre trilho escuro, valor mono ao lado (`14/20`)
- Barra de fome: mesma lógica, tom âmbar/laranja
- Armadura: 4 indicadores pequenos (um por peça), cor por durabilidade — verde acima de 50%, âmbar entre 20–50%, vermelho abaixo disso
- Clique em qualquer barra expande um popover com detalhe (efeitos ativos, durabilidade exata por peça)

Isso fica sempre visível, independente de qual modo (viewer/editor/fila) estiver ativo — é status do bot, não de uma tela específica.

### Controle: o que o app faz automaticamente com esses dados

Isso vira um **processo de sobrevivência** (`SurvivalProcess`), rodando com prioridade **mais alta que qualquer instrução da fila** — igual o `InventoryPauserProcess` nativo do Baritone, que já pausa tudo pra resolver inventário:

1. **Vida abaixo de um limiar** (configurável, ex: 30%) → interrompe a instrução atual, foge de mobs próximos ou se afasta de lava/queda, e só retoma a fila quando a vida estabilizar
2. **Fome abaixo de um limiar** (ex: 6/20) → dispara sub-instrução "comer": abre inventário, usa o melhor alimento disponível (prioriza por saturação, não só por quantidade de fome), sem depender de nenhuma instrução manual do usuário
3. **Armadura não equipada mas presente no inventário** → equipa automaticamente antes de continuar
4. **Durabilidade de armadura crítica** (ex: abaixo de 10%) → gera instrução na fila pra reparar (bigorna + material, se aplicável) ou substituir a peça, usando a mesma árvore de resolução de itens já desenhada
5. **Efeito negativo ativo** (veneno, fogo) → prioridade extra pra sair da situação de perigo antes de qualquer outra coisa

Esse processo nunca aparece como um "item da fila" pro usuário — ele roda por baixo, como uma rede de segurança, e só fica visível no app através do HUD e (quando interrompe algo) de um aviso rápido tipo "pausado: vida baixa, retomando em breve" no lugar do card da instrução ativa.

## Combate e ameaças — quando lutar, fugir, defender e por que nunca depender só do totem

Correção de premissa antes de desenhar isso: **o Baritone não luta**. Ele tem um "mapa de aversão" opcional que só influencia o cálculo de caminho pra evitar passar perto de mobs — não ataca, não levanta escudo, não usa item nenhum de defesa. É zero decisão de combate, no mesmo nível de gap que a natação: área onde a lógica é inteiramente nova, do `SurvivalProcess`.

### Por que "continuar pegando o minério" é a pior opção

Creeper é o caso mais crítico: dano de explosão à queima-roupa pode passar de 24 corações — o suficiente pra matar mesmo com armadura de diamante completa sem encantamento, principalmente empurrado por knockback pra lava/queda. E o detalhe que faz toda diferença: **o escudo bloqueia quase toda a explosão**, de forma muito mais confiável que só confiar na redução de dano da armadura. Continuar minerando de costas pra um creeper — mesmo "equipado" — ignora a defesa mais barata e mais rápida que existe no jogo.

### Classificação de ameaça (o que o `SurvivalProcess` precisa distinguir)

| Tipo de ameaça | Resposta ideal | Por quê |
|---|---|---|
| Creeper / creeper carregado a ≤3 blocos (dentro do raio de detonação) | **Escudo na hora**, de frente pro creeper, e recuar ao mesmo tempo se possível | Explosão é bloqueada quase por completo pelo escudo; recuar também cancela a detonação se sair do raio a tempo |
| Esqueleto / mob de ataque à distância | Escudo quando detecta flecha vindo, ou quebrar linha de visão (atrás de bloco) | Escudo bloqueia dano de projétil também |
| Zumbi / mob de combate corpo a corpo comum | Prioridade baixa — pode continuar a instrução atual se vida/armadura estão OK, só interrompe se vida cair abaixo do limiar já definido | Não é ameaça de dano alto instantâneo, o `SurvivalProcess` de vida já cobre isso |
| Enxame (múltiplos mobs ao mesmo tempo) | Recuar pra posição defensável (corredor de 1 bloco, ou fechar com bloco) em vez de lutar todos | Reduz quantos conseguem atacar ao mesmo tempo |

### Ordem de prioridade da resposta (o que substitui "totem primeiro")

1. **Escudo** — reação mais barata e mais rápida, primeira linha de defesa sempre que uma ameaça de dano alto é detectada (creeper próximo, projétil chegando)
2. **Interromper a instrução atual e recuar** — a mesma lógica de override que já existe pro `SurvivalProcess` (prioridade acima de qualquer instrução da fila): pegar o minério vira instrução **pausada**, não abandonada — retoma depois que a ameaça passar
3. **Totem de undying equipado, sempre, como rede passiva** — não é uma ação que o bot "usa" ativamente, é um item que fica no slot off-hand o tempo todo (igual já cobrimos: reequipar automaticamente se cair pra fora do slot) — só entra em jogo se as duas defesas anteriores falharem. Nunca é o plano, é o seguro contra imprevisto

### Detecção

O mod Java escaneia entidades próximas (raio configurável, ex: 16 blocos — mesmo alcance de detecção de um creeper) a cada poucos ticks, classifica pelo tipo e distância, e manda pro Rust como parte do mesmo canal de vitals já existente. O `SurvivalProcess` cruza isso com a tabela acima pra decidir a resposta, com a mesma prioridade máxima (acima de qualquer instrução da fila) que já usamos pra vida/fome baixa.

> **Implementado até agora (ver `docs/CHANGELOG.md`):** a varredura existe — o addon manda o snapshot `entities` (raio de 32 blocos, categoria/nome/vida/distância por criatura) e o viewer identifica cada mob no mundo e num painel. A *resposta* da tabela abaixo (escudo, recuar, prioridade sobre a fila) continua não implementada.

## Agendamento por estimativa de tempo — preenchendo janelas de espera

Essa é a peça que faz o tier 5 (fundição/etc.) funcionar de verdade: o app precisa saber **quanto tempo cada ação leva** pra decidir se vale mandar o bot fazer outra coisa enquanto uma fornalha cozinha, e voltar bem na hora que terminar — sem ficar parado, mas também sem se arriscar a voltar tarde demais ou cedo demais.

### O que precisa ser estimado

**Tempo de mineração** — o jogo usa uma fórmula real, não é arbitrário:
```
tempo_base = dureza_do_bloco × (1.5 se a ferramenta for correta, senão 5)
tempo_final = tempo_base ÷ multiplicador_da_ferramenta
```
Multiplicador por ferramenta: mão/errada = 1, madeira = 2, pedra = 4, ferro = 6, diamante = 8, netherite = 9. Exemplo real: tora de carvinho (dureza 2) — na mão dá 3 segundos, com machado de madeira dá 1,5 segundo.

**Tempo de deslocamento** — aqui vale usar o **próprio Baritone**, não uma fórmula de distância em linha reta: ao pedir um `PathingCommand`/cálculo de rota (sem executar ainda), o Baritone já retorna o **custo estimado do caminho** em ticks, já considerando obstáculos, desvios, subidas — muito mais preciso que `distância ÷ velocidade`. Como fallback (sem caminho calculado ainda), velocidade de referência: andando ≈ 4,3 blocos/s, correndo ≈ 5,6 blocos/s.

### Modelo de dados

```rust
struct TimeEstimate {
    ticks: u32,
    confidence: EstimateConfidence, // FromBaritonePath (alta) | Fallback (aproximada)
}

fn estimate_mine(block: &Block, tool_tier: ToolTier) -> TimeEstimate { /* fórmula acima */ }
fn estimate_travel(from: Pos, to: Pos, baritone_path_cost: Option<u32>) -> TimeEstimate { /* Baritone ou fallback */ }
fn estimate_task(task: &Instruction) -> TimeEstimate { /* soma de sub-ações */ }
```

### Exemplo resolvido: buscar 3 madeiras enquanto a fornalha cozinha

Continuando o exemplo anterior (8 cobblestone, 80 segundos de fundição numa fornalha só):

- Ida até a árvore mais próxima conhecida (Baritone estima, ex: 18 blocos de caminho real) → ~4s correndo
- Quebrar 3 troncos, sem machado (mão): 3 × 3s = 9s
- Volta até a fornalha (mesmo caminho): ~4s
- **Total estimado: ~17s**, contra uma janela de 80s disponível — sobra folga confortável mesmo com uma margem de segurança

### O algoritmo de decisão

```rust
fn pick_fill_task(remaining_ticks: u32, candidates: &[Instruction]) -> Option<&Instruction> {
    let safety_margin = 0.8; // usa só 80% da janela disponível, sobra folga pra imprevisto
    candidates.iter()
        .filter(|t| estimate_task(t).ticks as f32 <= remaining_ticks as f32 * safety_margin)
        .max_by_key(|t| estimate_task(t).ticks) // pega a maior tarefa que ainda cabe — aproveita melhor a janela
}
```

O orquestrador roda isso toda vez que um processo de espera (fundição, por exemplo) começa: olha o `cook_time_ticks` restante, escolhe entre as instruções da fila **a que melhor preenche essa janela sem estourar**, e despacha o bot pra ela. Se nenhuma instrução da fila couber, o bot só espera mesmo (ou puxa a próxima instrução independente, que não precisa voltar a tempo de nada).

### Lidando com estimativa errada

Estimativa não é garantia — pode aparecer um mob no caminho, um obstáculo que o Baritone não previu, etc. Por isso:
- **Margem de segurança** (80% da janela, não 100%) já absorve pequenos desvios
- O app **reavalia em tempo real**: se o Baritone reportar que o caminho de volta ficou mais longo que o previsto (replanejamento por obstáculo) e o tempo restante da fornalha cair abaixo do necessário pra voltar, a instrução de "buscar madeira" é **abortada na hora** — o bot larga o que está fazendo e volta direto, mesmo sem completar as 3 madeiras
- Isso é coordenado pelo mesmo `SurvivalProcess`/orquestrador central, nunca pelo `BuilderProcess` nativo — ele não tem esse conceito de "tenho um prazo pra voltar"

### Água e lava — tratados como obstáculo, nunca como rota

Na prática (confirmado em uso real, não só na teoria dos custos): o suporte de natação do Baritone trava com frequência — mesmo o custo teórico em ticks sugerindo que nadar seria mais barato que pontear, a execução real engasga ou trava completamente, e isso acontece mesmo em travessias curtas (nem sempre precisa de 10+ blocos pra travar, às vezes trava antes disso). Por isso a política do app **inverte a preferência natural do Baritone**, com uma ordem de prioridade em 3 níveis:

1. **Parkour (pulo correndo), se o vão for pequeno o suficiente** — o Baritone já tem um tipo de movimento nativo pra isso (`MovementParkour`, ligado pela setting `allowParkour`), que calcula salto correndo sem precisar tocar na água. Um vão de até ~3-4 blocos é coberto por um pulo com corrida (o alcance real de salto correndo no jogo). Esse é o modo **preferencial**: não toca em água (elimina o risco do estado de natação travar) e não gasta bloco de material como a ponte gastaria
2. **Ponte, se o vão for grande demais pro parkour** — coloca bloco descartável e segue por cima, igual já desenhamos
3. **Nadar nunca é opção** — mesmo que tecnicamente disponível na configuração do Baritone, fica fora da política por causa da instabilidade já observada

```rust
fn crossing_strategy(gap_width_blocks: u32) -> CrossingStrategy {
    const MAX_SPRINT_JUMP_BLOCKS: u32 = 3; // vão coberto por pulo correndo, sem tocar a água
    if gap_width_blocks <= MAX_SPRINT_JUMP_BLOCKS {
        CrossingStrategy::Parkour
    } else {
        CrossingStrategy::Bridge
    }
    // Swim nunca é retornado — fora da política
}
```

Isso exige medir a **largura real do vão de água** (não só "tem água ali"), consultando o `WorldCache` pra achar onde termina o líquido na direção do trajeto — se o outro lado é alcançável num salto corrido, o app pede parkour ao Baritone (setting `allowParkour` ligada, e a instrução de movimento já favorece isso na função de custo); senão, cai pra ponte.

- **Água e lava são tratadas como bloco a evitar**, no mesmo nível de prioridade — nunca como caminho válido de travessia a nado. Isso é configurado forçando um custo de travessia bem acima do padrão pra qualquer bloco líquido, suficiente pra que o planejador **nunca prefira nadar**, restando só parkour (quando cabe) ou ponte
- **Watchdog de travamento**, como rede de segurança adicional mesmo com a política acima: o orquestrador monitora a posição do bot a cada poucos ticks perto de qualquer líquido; sem progresso por um limiar curto (calibrado abaixo de 10 blocos de travessia, já que travamentos foram observados mesmo em distâncias menores que essa), a instrução atual é abortada e vira automaticamente uma instrução de ponte manual
- **Aprendizado por trecho**: todo trecho onde isso acontece fica marcado no `WorldCache` como "requer ponte" (ou "parkour confirmado", se um pulo já funcionou ali antes) — da próxima vez que uma rota passar por ali, o app já sabe a estratégia certa, sem reavaliar do zero

## Identidade visual

Tom: ferramenta técnica de desenvolvedor, não "gamer" — escura, precisa, sem enfeite.

### Cores

| Token | Hex | Uso |
|---|---|---|
| Fundo base | `#0a0c0f` | Viewer, fundo geral |
| Painel | `#101317` / `#14181d` | Sidebars, cards |
| Borda | `#1f242b` / `#262c34` | Divisórias, contornos de card |
| Texto primário | `#e7eaee` | Títulos, valores |
| Texto secundário | `#7c8592` / `#9aa2ad` | Labels, metadados |
| Accent — âmbar (tocha) | `#f2b155` | Ações primárias, itens "planejados/fantasma", instrução ativa de build |
| Accent — teal (bot/explorado) | `#5eead4` | Posição do bot, área explorada, progresso |
| Status — sucesso | `#4ade80` | Conectado, concluído |
| Status — perigo | `#f2555f` | Ameaça (mob hostil no viewer), vida crítica no HUD |

### Tipografia

- **IBM Plex Sans** — UI geral, títulos, botões
- **IBM Plex Mono** — coordenadas, contadores, IDs, qualquer dado técnico (ex: `412, 64, -88`, `63% · 1 106 / 1 764 chunks`)

### Padrões de layout

- **Rail de ícones** (56px) à esquerda: alterna entre modo Viewer / Editor de schematic / Fila / Armazém
- **Viewer central**: grid de chunks (`stroke #1c222b`) com gradiente radial simulando fog-of-war — área nunca explorada fica escura, sem grid visível de destaque
- **Ghost de instrução pendente**: contorno tracejado âmbar sobre onde a build ainda vai acontecer (schematic ainda não construída)
- **Marcador do bot**: círculo teal com glow (`box-shadow`), label mono com coordenadas ao lado
- **Chip de progresso flutuante**: canto superior direito do viewer, barra fina + percentual mono
- **Cards de fila** (painel direito, 340px): borda esquerda colorida por status — teal = ativo, cinza = na fila, verde = concluído; barra de progresso fina dentro do card
- **Rodapé do painel direito**: totais agregados por item, formato `label` / `valor mono` alinhados nas pontas

### Princípios

- Sem gradientes decorativos, sem emoji, sem ícone genérico de "IA"
- Cor com função: âmbar = ação/planejado, teal = estado atual/progresso, verde = concluído — nunca decorativo
- Dados numéricos sempre em monoespaçada, texto de UI sempre em sans
- Cards e paineis com bordas finas de 1px, nunca sombra pesada — hierarquia por contraste de fundo (`#0a0c0f` → `#101317` → `#14181d`)
