#!/usr/bin/env bash
# Claude Dash installer.
#
# Installs the GNOME Shell extension + Claude Code hook script and wires the
# hook into ~/.claude/settings.json. Does NOT overwrite unrelated hook entries.
#
# After running:
#   1. Log out and log back in (Wayland can't load new shell extensions without)
#   2. gnome-extensions enable claude-dash@local
#   3. Use Claude Code as normal — the panel indicator reflects activity.

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXT_UUID="claude-dash@local"
EXT_SRC="$REPO_DIR/$EXT_UUID"
EXT_DST="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
HOOK_SRC="$REPO_DIR/hook/claude-hook.py"
HOOK_DST="$HOME/.claude/hooks/claude-hook.py"
SETTINGS_FILE="$HOME/.claude/settings.json"

command -v gdbus >/dev/null || { echo "error: gdbus required (glib2)"; exit 1; }
command -v gnome-extensions >/dev/null || { echo "error: gnome-extensions required"; exit 1; }
command -v python3 >/dev/null || { echo "error: python3 required"; exit 1; }

echo "==> Installing extension to $EXT_DST"
mkdir -p "$EXT_DST"
cp -r "$EXT_SRC/"* "$EXT_DST/"

echo "==> Installing hook to $HOOK_DST"
mkdir -p "$(dirname "$HOOK_DST")"
cp "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_DST"

echo "==> Wiring hooks into $SETTINGS_FILE"
if [ ! -f "$SETTINGS_FILE" ]; then
    echo "{}" > "$SETTINGS_FILE"
fi

python3 - "$SETTINGS_FILE" "$HOOK_DST" <<'PY'
import json, sys
settings_path, hook_path = sys.argv[1], sys.argv[2]
with open(settings_path) as f:
    s = json.load(f)
s.setdefault("hooks", {})
entry = {"matcher": "", "hooks": [{"type": "command", "command": f"python3 {hook_path}"}]}
for event in ("Notification", "PreToolUse", "Stop", "SubagentStop", "UserPromptSubmit", "SessionEnd"):
    existing = s["hooks"].get(event) or []
    # avoid duplicate registration
    if any(any(h.get("command","").endswith("claude-hook.py") for h in (e.get("hooks") or [])) for e in existing):
        continue
    existing.append(entry)
    s["hooks"][event] = existing
with open(settings_path, "w") as f:
    json.dump(s, f, indent=2)
    f.write("\n")
print(f"  patched {settings_path}")
PY

echo
echo "==> Optional dependencies"
echo "  For focus-aware behavior and Open-VSCode activation, install the"
echo "  'Window Calls Extended' GNOME extension:"
echo "    https://extensions.gnome.org/extension/4974/window-calls-extended/"
echo
echo "==> Done. Next steps:"
echo "  1. Log out and log back in (Wayland needs a fresh shell to load new JS)."
echo "  2. gnome-extensions enable $EXT_UUID"
echo "  3. Launch Claude Code in VSCode — the panel icon should light up."
