# Addon Java (planejado — não implementado)

Este diretório é o lugar reservado para o **addon Java** descrito em
[`docs/SPEC.md`](../docs/SPEC.md), seção "Arquitetura". Ele ainda não existe como
projeto Gradle — só a descrição abaixo, para não fingir um scaffold Forge/Fabric
funcional sem o toolchain (MDK, dependência do Baritone, client do jogo) para
validar que compila.

## O que ele precisa ser

Um **segundo mod**, instalado ao lado do Baritone no client (Forge ou Fabric,
como o Impact/Meteor Client já fazem), que:

- Consome a interface pronta `IBaritone` via `BaritoneAPI.getProvider()` para
  acionar os processos nativos do Baritone (`ICustomGoalProcess`,
  `IExploreProcess`, `IMineProcess`, `IBuilderProcess`).
- Implementa por cima a lógica que o Baritone **não** cobre: `SurvivalProcess`
  (vida/fome/armadura/ameaças), gestão de baú, simulação de `ContainerScreen`
  para crafting/fundição/serra de pedra/mesa de ferraria.
- Fala com o app Rust por um socket local (TCP/WebSocket, mensagens
  binárias/JSON): manda deltas de chunk, posição, vitais, conteúdo de baú;
  recebe instruções da fila.

## Por que não está aqui ainda

Um scaffold Gradle "vazio" sem a dependência real do Baritone e sem um client
Minecraft para testar não compila nem prova nada — seria só teatro. Construir
isso de verdade exige, nessa ordem:

1. Escolher Forge ou Fabric (e a versão do Minecraft/Baritone a alvejar).
2. Baixar o MDK correspondente e a build do Baritone como dependência.
3. Definir o protocolo do socket (formato das mensagens) em conjunto com o
   lado Rust (`src-tauri/src/`), hoje só com as structs (`Vitals`,
   `Instruction`, `ChestEntry`, ...) esperando dados reais.
4. Implementar primeiro o caminho mais simples ponta a ponta (ex: `#explore`
   nativo do Baritone + streaming de chunk pro `WorldCache`) antes de partir
   pro resto (crafting, fundição, combate).

## Referência

Ver `docs/SPEC.md` inteiro — em especial as seções "Arquitetura", "Mapeamento
completo de receitas", "Vida, fome e armadura" e "Combate e ameaças" — para o
comportamento exato esperado de cada processo.
