# Protocolo do socket local — app ↔ addon

Referência canônica do canal entre o app Rust/Tauri e o addon Java. O código continua sendo a fonte
da verdade (`src-tauri/src/addon_socket.rs` do lado Rust,
`mod-addon/src/main/java/dev/baritone/orchestrator/addon/BaritoneOrchestratorAddonClient.java` do lado
Java); este documento existe pra não precisar caçar mensagem por mensagem no código.

## Transporte

- TCP em `127.0.0.1:31173` — loopback, nunca exposto na rede.
- Uma mensagem JSON por linha (`\n`), **nos dois sentidos**, sem framing binário: dá pra testar com
  `nc localhost 31173` digitando JSON na mão.
- O addon reconecta sozinho (backoff de 5s) se o app ainda não estiver rodando, e reenvia o handshake
  + os chunks já carregados no client.
- O app limita o payload descomprimido de um chunk a 8 MiB (defesa contra mensagem corrompida).

## Duas versões diferentes (não confundir)

| Versão | O quê | Onde |
| --- | --- | --- |
| **protocolo v0** | transporte, framing e o conjunto de mensagens — deliberadamente mínimo | este documento, `addon_socket.rs` |
| **payload (formato 3; a 2 continua aceita)** | só o binário dentro de `chunk_voxels` | `world_cache.rs`, `decode_voxels` |

São números independentes: uma mensagem nova não muda o payload do chunk, e um campo novo no payload
não muda o protocolo. O decoder recusa versão de payload desconhecida com erro claro em vez de tentar
adivinhar (`decode_voxels`), então app e addon precisam estar de acordo nesse número.

O formato 3 acrescentou as **cores de bioma por coluna** (grama/folhagem/água) no fim do payload. O
formato 2 continua sendo aceito — um `world.cache` gravado antes da mudança abre normalmente, só sem
tints, e um jar do addon antigo segue funcionando (o app avisa no console).

## Addon → app

- `{"type":"hello","addon_version":"...","baritone_version":"...","mc_version":"..."}` — primeira
  mensagem da conexão; marca `connection_status` como conectado e é de onde o app tira a versão do
  Minecraft (usada pra achar o client jar local do atlas).
- `{"type":"vitals","health":20.0,"max_health":20.0,"hunger":20,"saturation":5.0,"armor_points":0}`
  — ~1x/s. `armor_pieces`/`active_effects` ainda não são enviados (ver `docs/SPEC.md`).
- `{"type":"position","x":123,"y":64,"z":45,"yaw":90.0,"pitch":12.5}` — ~4x/s; pés do jogador +
  rotação real do corpo/cabeça (o viewer usa pra orientar o modelo). `yaw`/`pitch` são opcionais pra
  addon antigo.
- `{"type":"world_time","day_time":6000}` — hora do clock do overworld em ticks (0..23999), ~1x/s;
  o viewer usa pro ciclo de dia/noite (1 dia = 20 min reais, como no jogo) e congela na última hora
  conhecida sem o jogo.
- `{"type":"player_skin","name":"Steve","model":"wide","png_base64":"..."}` — quando a skin muda;
  `model` é `slim` ou `wide`. O PNG é lido do cache de texturas/resource pack do client, nunca
  baixado pela Mojang.
- `{"type":"entities","radius":32.0,"entities":[{"id":42,"kind":"zombie","name":"Zumbi",
  "category":"hostile","x":1.5,"y":64.0,"z":-3.25,"health":20.0,"max_health":20.0,"distance":6.2,
  "height":1.95}, ...]}` — snapshot (~4x/s, teto de 64) das criaturas vivas no raio `radius` ao
  redor do jogador, ordenadas por distância. `kind` é o path do registry, `name` já vem localizado
  pelo client e `category` ∈ `hostile`/`neutral`/`passive`/`other`; `distance`/`height` são medidos
  no jogo. Jogadores ficam de fora e a lista é o estado atual, não um delta — mob que saiu do raio
  simplesmente não aparece mais.
- `{"type":"chunk_voxels","x":3,"z":-7,"data":"<base64>"}` — um por chunk carregado
  (`ChunkEvent.Load`) mais o backfill de reconexão (2 chunks por tick). `data` é o payload binário
  descrito abaixo (com as cores de bioma do formato 3), comprimido com zlib.
- `{"type":"instruction_status","id":"i1","status":"active","progress":0.42}` — estado da instrução
  ativa (`active`/`done`/`failed`; `progress` só quando existe, ex: `travel_to`; `explore` é contínuo
  e não manda progresso).

## App → addon

- `{"type":"instruction","id":"i1","kind":"travel_to","x":100,"z":-200}` —
  `ICustomGoalProcess.setGoalAndPath(new GoalXZ(x, z))`.
- `{"type":"instruction","id":"i2","kind":"explore"}` (x/z opcionais) —
  `IExploreProcess.explore(origemX, origemZ)`; sem coordenadas usa os pés do bot.
- `{"type":"instruction","id":"i3","kind":"explore","x":0,"z":0,"radius":256,"style":"circles"}`
  (`style`: `circles` ou `zigzag`) — exploração com área definida; o addon gera e percorre os
  waypoints, reportando progresso real e pulando waypoint inalcançável.
- `{"type":"instruction","id":"i4","kind":"build","blocks":[{"x":10,"y":64,"z":-3,"block":"stone"}, …]}`
  — posicionar blocos com o `IBuilderProcess.build(nome, schematic, origem)`, onde o schematic é
  esparso e cobre exatamente as posições da lista (`OrchestratorSchematic`). `mine` é o mesmo payload
  com `"block":"air"` em cada posição: o builder quebra o que estiver lá — o mesmo caminho que o
  `clearArea` usa. O nome do bloco é o path do registry sem namespace (`stone`, `oak_planks`); nome
  desconhecido é ignorado (e se nenhum sobrar, a instrução falha em vez de mentir sucesso). Essas duas
  não têm progresso medível — o `BuilderProcess` não expõe contagem — então reportam `active` sem
  `progress` e fecham em `done` quando o processo para (ou `failed` se ele nunca começar).
- `{"type":"cancel","id":"i1"}` — cancela a instrução no jogo: `cancelEverything` no pathing e
  `onLostControl` no builder (ele não para só com o cancelamento do pathing).

A leitura roda numa thread dedicada que só enfileira as linhas; a execução acontece na thread do
client (`onClientTick`), onde a API do Baritone é segura.

## Payload do chunk (`chunk_voxels`, formato 3)

```
u8  versão (3; 2 = formato antigo, sem tints)
u8  nº de seções não-vazias
por seção:
  i8  Y da seção (Y do mundo / 16; pode ser negativo)
  u16 tamanho da paleta
  por entrada da paleta:
    u16 tamanho do nome (bytes UTF-8)
    bytes do nome       (path do registry, ex: "stone")
    u8  flags           (1 = renderizável, 2 = oclusor, 4 = fluido)
    u8  nível do fluido (0 = fonte, 1..7 = fluindo, 8+ = caindo; 0 fora de fluido)
  u16[4096] índices      (ordem x + z*16 + y*256, igual ao PalettedContainer do jogo)
u8  tem_tints (só na v3; 0 = sem tints)
se tem_tints:
  256 × (u8 r, u8 g, u8 b)  grama    — coluna x + z*16
  256 × (u8 r, u8 g, u8 b)  folhagem — coluna x + z*16
  256 × (u8 r, u8 g, u8 b)  água     — coluna x + z*16
```

- O payload inteiro é comprimido com **zlib** (header incluso) e codificado em **base64** no campo
  `data`.
- Seção ausente = ar; só seções com pelo menos um bloco não-ar são enviadas.
- Os flags de oclusão são calculados no addon (`isSolidRender`/fluido) e evitam que o viewer precise
  de uma lista de nomes de bloco pra fazer face culling.
- Os **tints** são resolvidos pelo addon com o `BiomeColors` do próprio client, amostrados no bloco
  do topo de cada coluna (bloco subterrâneo usa o bioma da superfície). São opcionais: sem eles o
  viewer cai nas cores fixas aproximadas — ver `GRASS_TINT` em `viewer3d.ts`.
- O mesmo formato é reusado pelo cache em disco (`world.cache`, ver `world_store.rs`), então o
  `encode_voxels`/`decode_voxels` é um só pra socket, IPC e disco.
