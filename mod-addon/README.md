# Addon Java — Baritone Orchestrator Addon

Projeto NeoForge real (scaffold do [MDK oficial `NeoForgeMDKs/MDK-26.3-ModDevGradle`](https://github.com/NeoForgeMDKs/MDK-26.3-ModDevGradle))
que faz a ponte entre o Baritone (rodando dentro do Minecraft) e o app Rust/Tauri
deste repositório. Ver `docs/SPEC.md`, seção "Arquitetura", pro desenho completo
— este README documenta o que **existe de verdade** hoje vs. o que ainda falta.

## O que já funciona

- Compila contra `baritone.api` (jar oficial, ver seção abaixo) e roda junto do
  Baritone de verdade no client — testado manualmente em NeoForge `26.3.0.22-beta`.
- A cada tick do cliente, lê vida/fome/saturação/armadura (1x/s) e posição +
  rotação (`getPlayerContext().playerFeet()`, `getYRot()`/`getXRot()`, 4x/s) do jogador via
  `BaritoneAPI.getProvider().getPrimaryBaritone()` (prova que a dependência do
  Baritone resolve e funciona em runtime, não só em tempo de compilação) e
  manda pro app Rust por um socket TCP local.
- Manda a skin do próprio jogador (`player_skin`, PNG em base64 + variante
  `slim`/`wide`) sempre que a textura muda — lida do que o client já tem
  carregado (cache de texturas pra skin baixada/customizada, resource pack/jar
  pra padrão), sem baixar nada da Mojang. É o que deixa o viewer desenhar o
  modelo de verdade do jogador em vez de um marcador genérico.
- Assina `ChunkEvent.Load` (client-side) e enfileira o chunk pro envio de
  `chunk_voxels`: cada seção 16×16×16 vira paleta + índices (deflate + base64),
  com flags de renderização/oclusão/fluido e o nível de cada fluido — é daí
  que o viewer monta o terreno com face culling de verdade, inclusive água e
  lava. Junto vai o bloco de **tints de bioma por coluna** (grama, folhagem e
  água), resolvido pelo `BiomeColors` do próprio client — o mesmo colormap e
  modificador de bioma que o jogo usa no render, então cada bioma aparece com
  a cor real. A fila drena poucos chunks por tick pra um backfill de reconexão
  não travar o jogo.
- Recebe instruções do app pelo mesmo socket (`instruction`/`cancel`, ver
  "canal reverso" abaixo) e devolve `instruction_status` com status/progresso —
  hoje `travel_to` (`GoalXZ` via `ICustomGoalProcess`) e `explore` (nativo via
  `IExploreProcess`, ou com raio/estilo percorrendo waypoints próprios); a
  leitura roda numa thread própria e a execução acontece na thread do cliente.
- Reconecta sozinho (a cada 5s) se o app Rust não estiver rodando ainda — não
  trava nem falha o carregamento do mod.
- `neoforge.mods.toml` declara Baritone (`modId="baritoe"` — não é
  `"baritone"`, conferido no jar oficial) como dependência obrigatória, então
  falta o Baritone vira uma tela de erro clara do próprio NeoForge, não um
  crash confuso.

Código: `src/main/java/dev/baritone/orchestrator/addon/`
(`BaritoneOrchestratorAddon.java` = classe comum; `BaritoneOrchestratorAddonClient.java`
= a ponte, client-only).

## O que ainda não existe

- **Atualização de blocos depois do load** — `chunk_voxels` é um snapshot do momento em que o chunk
  carregou. O bot minerando/colocando bloco não reenvia nada, então o viewer fica desatualizado
  naquele pedaço até o chunk ser recarregado.
- **Propriedades de blockstate** — o payload manda só o nome do bloco (`oak_stairs`), não o estado
  (`oak_stairs[facing=north,half=bottom]`); escada, laje e cerca aparecem como cubo cheio no viewer.
- Índice de baús (`StorageIndex`).
- `SurvivalProcess`/detecção de ameaça, simulação de `ContainerScreen` pra
  crafting/fundição — tudo isso ainda é só o que está descrito em `docs/SPEC.md`.
- `armor_pieces` (durabilidade por peça) e `active_effects` — o protocolo já
  reserva os campos do lado Rust, o addon só não manda ainda.
- Instruções além de `travel_to`/`explore` — o canal reverso existe (ver
  protocolo abaixo), mas `Mine`/`Build`/baú/craft ainda não têm executor aqui.

## Protocolo do socket (v0)

Documentado por completo em `src-tauri/src/addon_socket.rs` (lado Rust) — resumo:

**Duas versões diferentes, não confundir:** "v0" é o **protocolo** (transporte, framing e o conjunto
de mensagens, ainda o recorte mínimo deliberado do spec); "formato 3" é só o **payload binário** do
`chunk_voxels` (paleta + flags + nível de fluido + tints de bioma). São números independentes e
evoluem separados — referência completa em [`docs/PROTOCOL.md`](../docs/PROTOCOL.md).

- TCP, `127.0.0.1:31173`, só loopback.
- Uma mensagem JSON por linha (`\n`-delimited), sem framing binário — dá pra
  testar até com `nc localhost 31173` digitando JSON na mão.

**Addon → app (telemetria):**

- `{"type":"hello","addon_version":"...","baritone_version":"...","mc_version":"..."}`
  — primeira mensagem, marca `connection_status` como conectado no app.
- `{"type":"vitals","health":20.0,"max_health":20.0,"hunger":20,"saturation":5.0,"armor_points":0}`
  — a cada ~20 ticks.
- `{"type":"position","x":123,"y":64,"z":45,"yaw":90.0,"pitch":12.5}` — a
  cada ~5 ticks (yaw/pitch = rotação real do jogador, usada pra orientar o
  modelo no viewer).
- `{"type":"world_time","day_time":6000}` — hora do clock do overworld em
  ticks (0 = nascer do sol, 6000 = meio-dia, 12000 = pôr do sol, 18000 =
  meia-noite), a cada ~20 ticks, junto dos vitais. O app interpola a 20
  ticks/s pro ciclo de dia/noite do viewer; sem jogo conectado, ele congela na
  última hora real.
- `{"type":"player_skin","name":"Steve","model":"wide","png_base64":"..."}` —
  quando a skin muda (inclui a padrão, se o perfil ainda não carregou a
  real). `model` é `slim` ou `wide`; o PNG é lido do cache de texturas do
  client ou do resource pack/jar instalado, nunca baixado pela Mojang.
- `{"type":"chunk_voxels","x":3,"z":-7,"data":"..."}` — um por chunk carregado
  (paleta + índices + luz por seção, **mais os tints de bioma por coluna**, deflate + base64). Por
  entrada da paleta: `u8` flags (`1` renderizável, `2` oclusor, `4` fluido) + `u8` nível do fluido
  (blockstate vanilla: `0` fonte, `1..7` fluindo, `8+` caindo). Depois dos índices de cada seção vêm
  `u8[4096]` de **luz** do motor do jogo, um byte por posição (nibble baixo = luz de bloco, alto =
  luz de céu; mesma ordem dos índices). Depois das seções: `u8` tem_tints e, se `1`, `256×3` bytes de
  grama + `256×3` de folhagem + `256×3` de água (colunas `x + z*16`, cor RGB). Os tints saem do
  `BiomeColors` do client — colormap, override e modificador de bioma já aplicados, igual ao render
  do jogo — amostrados no bloco mais alto de cada coluna; `null`/`0` = sem dados (o viewer cai nas
  cores fixas). Layout completo em `world_cache.rs`, `decode_voxels` (formato 4; **formatos 3 e 2,
  sem luz, ainda são aceitos na leitura** pro `world.cache` antigo e pra addon desatualizado).
- `{"type":"instruction_status","id":"i1","status":"active","progress":0.42}` —
  estado da instrução ativa (`active`/`done`/`failed`; `progress` só no `active`
  do `travel_to` — `explore` é contínuo e não tem progresso).

**App → addon (canal reverso):**

- `{"type":"instruction","id":"i1","kind":"travel_to","x":100,"z":-200}` —
  `ICustomGoalProcess.setGoalAndPath(new GoalXZ(x, z))`.
- `{"type":"instruction","id":"i2","kind":"explore"}` (com `x`/`z` opcionais) —
  `IExploreProcess.explore(origemX, origemZ)`; sem coordenadas, usa os pés do bot.
- `{"type":"instruction","id":"i3","kind":"explore","x":0,"z":0,"radius":256,"style":"circles"}`
  (`style` = `circles` ou `zigzag`) — exploração com área definida: o addon gera os waypoints
  (passo entre faixas/anéis = render distance efetiva) e os percorre com `GoalXZ`, reportando
  progresso real; waypoint inalcançável é pulado. Sem `radius`/`style`, é o `explore` nativo acima.
- `{"type":"cancel","id":"i1"}` — `IPathingBehavior.cancelEverything()`.

O recebimento roda numa thread leitora que só enfileira as linhas; a execução
acontece na thread do cliente (`onClientTick`), onde a API do Baritone é segura.

É a v0 deliberadamente mínima — não é o protocolo final do spec (que também
cobre baús e propriedades de blockstate), é o menor recorte ponta a ponta que
prova que a ponte funciona de verdade: telemetria, terreno em voxels, água e
lava com nível e instruções básicas.

## O jar do Baritone — qual usar e como pegar

Direto do `SETUP.md` oficial do Baritone:

> "If another one of your other mods has a Baritone integration, you want `baritone-api-*-VERSION.jar`"
> — **API**: só os pacotes fora de `baritone.api` são ofuscados, é o único que
> outro mod consegue compilar/rodar contra ele. **Standalone**: tudo ofuscado,
> inclusive `baritone.api` — é o que a maioria dos reuploads de terceiros na
> CurseForge distribui, e **não serve** pra addon.

Rode `scripts/fetch-baritone.sh` uma vez antes de compilar — baixa
`baritone-api-neoforge-1.20.0.jar` da [release oficial](https://github.com/cabaletta/baritone/releases/tag/v1.20.0)
pra `libs/` e confere o SHA-1 contra o `checksums.txt` publicado pela própria
release. O jar **não é commitado no git** (ver `.gitignore`) — é o mesmo
binário que também vai pra pasta `mods/` em runtime, só que baixado sob
demanda em vez de vendorizado.

**Javadocs oficiais** (só cobre `baritone.api`, nada fora disso é suportado):
https://baritone.leijurv.com/

## Build

```bash
./scripts/fetch-baritone.sh   # baixa e confere libs/baritone-api-neoforge-1.20.0.jar
./gradlew build               # gera build/libs/baritoneorchestrator-0.1.0.jar
./gradlew runClient           # sobe um client de dev (precisa de conta Microsoft/Xbox)
```

Requer Java 25 (é o que o manifesto oficial da Mojang exige pra Minecraft
`26.3`) e ~alguns GB de download na primeira vez (mappings/bibliotecas via
ModDevGradle — não reaproveita o cache do launcher).

Pra instalar de verdade num client: copie `build/libs/baritoneorchestrator-0.1.0.jar`
junto com `libs/baritone-api-neoforge-1.20.0.jar` pra pasta `mods/` da sua
instância NeoForge `26.3.0.22-beta`.

## Por que não usamos JitPack

O README oficial do Baritone cita `com.github.cabaletta:baritone` via
JitPack — testado e confirmado **quebrado** pra tag `v1.20.0` (falha de
provisionamento de toolchain Java no ambiente de build deles). Por isso o
jar é baixado direto da release do GitHub, não via dependência remota.

## Referência

`docs/SPEC.md` inteiro — em especial "Arquitetura", "Mapeamento completo de
receitas", "Vida, fome e armadura" e "Combate e ameaças" — pro comportamento
final esperado de cada processo que ainda falta implementar aqui.
