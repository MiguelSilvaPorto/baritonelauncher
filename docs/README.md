# Documentação

Índice do que existe no repositório — e das referências externas que ele usa.

## Por onde começar

- [`../README.md`](../README.md) — visão geral, como rodar e o "que falta" (honesto, sem maquiar).
- [`SPEC.md`](SPEC.md) — especificação completa do produto/arquitetura; fonte de verdade do
  comportamento que ainda não existe (itens/receitas, editor de schematic, vitais, combate,
  agendamento por estimativa, identidade visual).

## Referência

- [`PROTOCOL.md`](PROTOCOL.md) — socket app ↔ addon: transporte, mensagens nos dois sentidos e o
  formato binário do `chunk_voxels`.
- [`CONFIG.md`](CONFIG.md) — aba Config: campos, faixas, padrões e onde ficam.
- [`../mod-addon/README.md`](../mod-addon/README.md) — o addon Java: o que funciona/falta, qual jar do
  Baritone usar, como buildar.
- [`CHANGELOG.md`](CHANGELOG.md) — histórico de mudanças voltado ao usuário (Keep a Changelog/SemVer).

## Histórico

- [`mockup-visao-principal.html`](mockup-visao-principal.html) — mockup original da UI (referência
  visual; não é documentação técnica).

## Documentação oficial das dependências

- **Baritone** — javadocs da API: <https://baritone.leijurv.com/> · repositório:
  <https://github.com/cabaletta/baritone> (o addon compila contra o jar `baritone-api-*`, **nunca**
  `baritone-standalone-*`).
- **NeoForge** — <https://neoforged.net/> · docs: <https://docs.neoforged.net/> (o scaffold veio do MDK
  oficial `NeoForgeMDKs/MDK-26.3-ModDevGradle`).
- **ModDevGradle** — <https://github.com/neoforged/ModDevGradle>
- **Tauri 2** — <https://v2.tauri.app/>
- **Three.js** — <https://threejs.org/docs/>
- **minecraft-data** — <https://github.com/PrismarineJS/minecraft-data> (ingestão ainda não
  implementada; ver "O que falta" no README).
