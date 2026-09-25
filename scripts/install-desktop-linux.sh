#!/usr/bin/env bash
# Registra o Baritone Orchestrator no menu/barra de tarefas do Linux em modo dev.
#
# Builds empacotados (.deb/.rpm/AppImage via `tauri build`) já geram e instalam
# seu próprio .desktop automaticamente — este script é só para quem roda
# `npm run app` direto do repositório e quer o ícone certo na barra de tarefas
# em vez do genérico do WebKitGTK, porque GNOME/KDE no Wayland só resolvem o
# ícone de uma janela casando-a com um .desktop instalado (não existe um
# protocolo de "ícone por janela" no Wayland) — o app_id da janela (definido
# como "baritone-orchestrator" em tauri.conf.json > windowClassname) precisa
# bater com o nome do arquivo .desktop e com o StartupWMClass abaixo.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_PATH="$REPO_DIR/src-tauri/target/debug/baritone-orchestrator"
ICON_SRC="$REPO_DIR/src-tauri/icons/icon.png"
APP_ID="dev.baritone.orchestrator"

DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"

# Instala o ícone em todos os temas relevantes: "hicolor" é o fallback genérico
# que qualquer ambiente entende, "breeze"/"breeze-dark" é o tema padrão do KDE
# Plasma — alguns painéis do Plasma resolvem primeiro pelo tema ativo antes de
# cair pro hicolor, então sem isso o ícone pode não aparecer mesmo com o
# .desktop certo.
for theme in hicolor breeze breeze-dark; do
  dir="$HOME/.local/share/icons/$theme/512x512/apps"
  mkdir -p "$dir"
  cp "$ICON_SRC" "$dir/$APP_ID.png"
done

cat > "$DESKTOP_DIR/$APP_ID.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Baritone Orchestrator
Comment=Orquestrador externo para bots Baritone (viewer 3D, fila, editor de schematic)
Exec=$BIN_PATH
Icon=$APP_ID
Terminal=false
Categories=Development;Game;
StartupWMClass=baritone-orchestrator
DESKTOP

chmod +x "$DESKTOP_DIR/$APP_ID.desktop"

command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

for theme in hicolor breeze breeze-dark; do
  command -v gtk-update-icon-cache >/dev/null 2>&1 && \
    gtk-update-icon-cache -f "$HOME/.local/share/icons/$theme" 2>/dev/null || true
done

# O Plasma usa o próprio cache do KDE (sycoca), não só o do freedesktop — sem
# reconstruir isso o painel pode continuar mostrando o ícone antigo até relogar.
command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
command -v kbuildsycoca5 >/dev/null 2>&1 && kbuildsycoca5 --noincremental >/dev/null 2>&1 || true

echo "Instalado em $DESKTOP_DIR/$APP_ID.desktop"
echo "Rode 'npm run app' de novo. Se o ícone ainda não aparecer no painel/taskbar,"
echo "reinicie o plasmashell (ou relogue na sessão)."
