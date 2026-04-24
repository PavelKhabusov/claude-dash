# claude-dash

GNOME Shell extension + Claude Code hook. Two independently installed files live outside the repo — edits to the repo copies do not take effect until mirrored.

## After editing, mirror to installed locations

| Repo path | Installed path |
| --- | --- |
| `claude-dash@local/extension.js` (and other files in that dir) | `~/.local/share/gnome-shell/extensions/claude-dash@local/` |
| `hook/claude-hook.py` | `~/.claude/hooks/claude-hook.py` |

After any change under `claude-dash@local/` or `hook/`, copy the updated file(s) to the installed path above. The hook is re-read per invocation, so new hook code is live immediately. Extension changes require a GNOME Shell reload (Wayland: logout/login; X11: Alt+F2 → `r`).

`install.sh` does the full mirror — safe to rerun, but a single `cp` is enough for incremental changes.

## Settings

User toggles are written to `~/.config/claude-dash/settings.json` by the extension and read by both the extension and the hook. Keep the two in sync when adding new keys.
