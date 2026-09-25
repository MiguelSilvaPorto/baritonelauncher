# Addon Java — Baritone Orchestrator Addon

Projeto NeoForge real (scaffold do [MDK oficial `NeoForgeMDKs/MDK-26.3-ModDevGradle`](https://github.com/NeoForgeMDKs/MDK-26.3-ModDevGradle))
que faz a ponte entre o Baritone (rodando dentro do Minecraft) e o app Rust/Tauri
deste repositório. Ver `docs/SPEC.md`, seção "Arquitetura", pro desenho completo
— este README documenta o que **existe de verdade** hoje vs. o que ainda falta.

## O que já funciona

- Compila contra `baritone.api` (jar oficial, ver seção abaixo) e roda junto do
  Baritone de verdade no client — testado manualmente em NeoForge `26.3.0.22-beta`.
- A cada tick do cliente, lê vida/fome/saturação/armadura do jogador via
  `BaritoneAPI.getProvider().getPrimaryBaritone().getPlayerContext().player()`
  (prova que a dependência do Baritone resolve e funciona em runtime, não só
  em tempo de compilação) e manda pro app Rust por um socket TCP local, uma
  vez por segundo.
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

- Streaming de chunk pro `WorldCache` (posição do bot já dá pra pegar via
  `getPlayerContext().playerFeet()`, só não está sendo mandada ainda).
- Índice de baús (`StorageIndex`).
- Recebimento de instruções da fila (hoje o socket só manda dados, não recebe
  comandos do lado Rust).
- `SurvivalProcess`/detecção de ameaça, simulação de `ContainerScreen` pra
  crafting/fundição — tudo isso ainda é só o que está descrito em `docs/SPEC.md`.
- `armor_pieces` (durabilidade por peça) e `active_effects` — o protocolo já
  reserva os campos do lado Rust, o addon só não manda ainda.

## Protocolo do socket (v0)

Documentado por completo em `src-tauri/src/addon_socket.rs` (lado Rust) — resumo:

- TCP, `127.0.0.1:31173`, só loopback.
- Uma mensagem JSON por linha (`\n`-delimited), sem framing binário — dá pra
  testar até com `nc localhost 31173` digitando JSON na mão.
- `{"type":"hello","addon_version":"...","baritone_version":"...","mc_version":"..."}`
  — primeira mensagem, marca `connection_status` como conectado no app.
- `{"type":"vitals","health":20.0,"max_health":20.0,"hunger":20,"saturation":5.0,"armor_points":0}`
  — a cada ~20 ticks.

É a v0 deliberadamente mínima — não é o protocolo final do spec (que também
cobre chunks, baús e instruções), é o menor recorte ponta a ponta que prova
que a ponte funciona de verdade.

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
