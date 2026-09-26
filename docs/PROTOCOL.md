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
| **payload (formato 2)** | só o binário dentro de `chunk_voxels` | `world_cache.rs`, `decode_voxels` |

São números independentes: uma mensagem nova não muda o payload do chunk, e um campo novo no payload
não muda o protocolo. O decoder recusa versão de payload desconhecida com erro claro em vez de tentar
adivinhar (`decode_voxels`), então app e addon precisam estar de acordo nesse número.

## Addon → app

- `{"type":"hello","addon_version":"...","baritone_version":"...","mc_version":"..."}` — primeira
  mensagem da conexão; marca `connection_status` como conectado e é de onde o app tira a versão do
  Minecraft (usada pra achar o client jar local do atlas).
- `{"type":"vitals","health":20.0,"max_health":20.0,"hunger":20,"saturation":5.0,"armor_points":0}`
  — ~1x/s. `armor_pieces`/`active_effects` ainda não são enviados (ver `docs/SPEC.md`).
- `{"type":"position","x":123,"y":64,"z":45,"yaw":90.0,"pitch":12.5}` — ~4x/s; pés do jogador +
  rotação real do corpo/cabeça (o viewer usa pra orientar o modelo). `yaw`/`pitch` são opcionais pra
  addon antigo.
- `{"type":"player_skin","name":"Steve","model":"wide","png_base64":"..."}` — quando a skin muda;
  `model` é `slim` ou `wide`. O PNG é lido do cache de texturas/resource pack do client, nunca
  baixado pela Mojang.
- `{"type":"chunk_voxels","x":3,"z":-7,"data":"<base64>"}` — um por chunk carregado
  (`ChunkEvent.Load`) mais o backfill de reconexão (2 chunks por tick). `data` é o payload binário
  descrito abaixo, comprimido com zlib.
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
- `{"type":"cancel","id":"i1"}` — cancela a instrução no jogo (`cancelEverything`).

A leitura roda numa thread dedicada que só enfileira as linhas; a execução acontece na thread do
client (`onClientTick`), onde a API do Baritone é segura.

## Payload do chunk (`chunk_voxels`, formato 2)

```
u8  versão (2)
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
```

- O payload inteiro é comprimido com **zlib** (header incluso) e codificado em **base64** no campo
  `data`.
- Seção ausente = ar; só seções com pelo menos um bloco não-ar são enviadas.
- Os flags de oclusão são calculados no addon (`isSolidRender`/fluido) e evitam que o viewer precise
  de uma lista de nomes de bloco pra fazer face culling.
- O mesmo formato é reusado pelo cache em disco (`world.cache`, ver `world_store.rs`), então o
  `encode_voxels`/`decode_voxels` é um só pra socket, IPC e disco.
