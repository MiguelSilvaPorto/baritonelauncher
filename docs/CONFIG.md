# Config — preferências do app

A aba **Config** (quinta view da rail) ajusta o viewer 3D e as cadências do app. O backend é a fonte
da verdade: os valores ficam em `settings.json`, fora da UI, e a tela só mostra o que o backend
devolveu — se um valor estiver fora da faixa, ele é preso lá e a UI exibe o valor **efetivo**.

## Onde ficam

- Linux: `~/.local/share/dev.baritone.orchestrator/settings.json` (mesmo diretório do `world.cache`).
- JSON legível, gravado de forma atômica (`tmp` + rename) a cada mudança.
- Campo novo cai no padrão (`#[serde(default)]`); arquivo corrompido é logado e o app segue com os
  padrões. "Restaurar padrões" volta tudo ao comportamento original.

## Campos

| Campo | Padrão | Faixa aceita | Efeito |
| --- | --- | --- | --- |
| `fog_far` | 260 | 100–800 | Distância do horizonte (fog) do viewer, em blocos |
| `mesh_budget_ms` | 8 | 2–20 | Teto de tempo por frame montando malha de chunk (ms) |
| `max_pixel_ratio` | 2 | 1–2 | Teto do device pixel ratio do canvas 3D (nitidez × GPU) |
| `fps_cap` | 0 | 0–240 | Teto de FPS do viewer; `0` = sem limite (vsync) |
| `state_interval_ms` | 1000 | 250–10000 | Intervalo do polling de estado (fila/vitais/mundo) |
| `pose_interval_ms` | 250 | 100–5000 | Intervalo do polling da pose do jogador |
| `chunks_per_refresh` | 16 | 1–64 | Chunks pedidos por atualização de estado |

Os padrões são exatamente as constantes que o app usava antes da aba existir — não mexer em nada é o
mesmo que o comportamento antigo.

## Comandos Tauri

- `settings_get` — lê o arquivo (ou os padrões) e devolve o valor efetivo.
- `settings_set` — valida, prende na faixa, persiste e devolve o valor efetivo.
- `settings_reset` — volta tudo pro padrão.

Implementação e testes (round-trip, arquivo ausente/corrompido, clamp, JSON parcial):
`src-tauri/src/settings.rs`.
