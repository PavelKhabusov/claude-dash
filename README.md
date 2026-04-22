# Claude Dash

[![GNOME Shell](https://img.shields.io/badge/GNOME_Shell-45%E2%80%9349-4A86CF?style=flat-square&logo=gnome&logoColor=white)](https://www.gnome.org/)
[![Wayland](https://img.shields.io/badge/Wayland-ready-success?style=flat-square)](https://wayland.freedesktop.org)
[![Claude Code](https://img.shields.io/badge/Claude_Code-companion-CC785C?style=flat-square)](https://claude.com/claude-code)
[![Platform](https://img.shields.io/badge/platform-Linux-blue?style=flat-square&logo=linux&logoColor=white)](https://www.linuxfoundation.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](LICENSE)
[![VSCode](https://img.shields.io/badge/VSCode-extension%20companion-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)

A GNOME Shell panel indicator for [Claude Code](https://claude.com/claude-code)
running in VSCode. Surfaces activity and permission prompts from every
active Claude Code session across projects — approve or deny tools right from
the top bar without switching windows.

## Features

- **Panel icon with state** — idle (grey), busy (dim amber), needs-you (bright
  amber + badge count).
- **Grouped menu** — one header per project, sessions listed under with dialog
  title and current tool.
- **Tray approvals** — on `PreToolUse` the hook blocks and asks you in the
  panel; ✅ Allow / ❌ Deny are sent back to Claude Code over a Unix socket.
  Falls back to Claude Code's inline UI on timeout.
- **Jump to window** — click "Open VSCode window" on any project to raise the
  matching VSCode window (matched by workspace name).
- **Toggle off** — "Intercept tool approvals" switch in the menu disables the
  blocking approval flow and lets the extension show busy-state only.
- **No desktop-notification duplicates** — a single source of truth in the
  panel, not notify-send popups overlapping.

## Requirements

- Linux with **GNOME Shell 45–49** (tested on 49 under Wayland).
- [**Window Calls Extended**](https://extensions.gnome.org/extension/4974/window-calls-extended/)
  GNOME extension — used for "Open VSCode window" to find the right window and
  for optional focus checks.
- **Claude Code** installed and working in VSCode (or terminal).
- **Python 3** (for the hook script).
- **gdbus** (part of `glib2`) and **gnome-extensions** CLI.

## Install

```bash
git clone https://github.com/pavelkhabusov/claude-dash.git
cd claude-dash
./install.sh
```

The installer:
1. Copies the extension to `~/.local/share/gnome-shell/extensions/claude-dash@local/`.
2. Copies `hook/claude-hook.py` to `~/.claude/hooks/claude-hook.py`.
3. Merges hook registrations into `~/.claude/settings.json` (non-destructive —
   won't duplicate if already present).

Then **log out and log back in** (Wayland requires a fresh shell to load new
JS code), and enable the extension:

```bash
gnome-extensions enable claude-dash@local
```

### Manual install

If you prefer not to run the script:

```bash
cp -r claude-dash@local ~/.local/share/gnome-shell/extensions/
cp hook/claude-hook.py ~/.claude/hooks/
chmod +x ~/.claude/hooks/claude-hook.py
```

Then merge the `"hooks"` block from [docs/settings.example.json](docs/settings.example.json)
into your `~/.claude/settings.json`.

## Usage

Once enabled, the Claude sparkle icon sits in the top panel:

- **Grey** — no active Claude sessions.
- **Dim amber** — at least one session is actively running a tool.
- **Bright amber with a count badge** — one or more sessions need your input
  (permission prompt or idle wait).

Click the icon to see the grouped menu. For each project:

- `🔔 Tool: args` — a blocking permission request with ✅ Allow / ❌ Deny.
- `⚡ Tool: args` — Claude is currently running this tool.
- `💭 Dialog title` — session is idle, last turn's first user message shown.
- `Open VSCode window` — activates the matching VSCode window on Wayland.

Click any session line to dismiss it from the menu (useful for cleaning up
stale entries).

### The toggle

"Intercept tool approvals" at the bottom of the menu controls whether
`PreToolUse` blocks waiting for a tray decision. With it off, the extension
still shows activity but permission prompts go straight to Claude Code's
inline UI (the VSCode panel).

State is persisted to `~/.config/claude-dash/settings.json` and read by the
hook on every invocation, so toggling takes effect immediately.

## Architecture

```
                  ┌───────────────────────────────┐
                  │  GNOME Shell (claude-dash ext)│
                  │  - panel button               │
                  │  - approvals + pending state  │
                  │  - DBus server                │
                  └──────────▲──────────┬─────────┘
                   DBus      │          │ DBus (RequestApproval)
                   (SetPending, etc.)   │         + Unix socket (decision)
                             │          │
                  ┌──────────┴──────────▼─────────┐
                  │  ~/.claude/hooks/claude-hook.py│
                  │  (one process per hook event) │
                  └──────────────▲────────────────┘
                                 │ stdin JSON
                     ┌───────────┴─────────────┐
                     │  Claude Code in VSCode  │
                     └─────────────────────────┘
```

- The extension exposes `org.gnome.Shell.Extensions.ClaudeDash` at
  `/org/gnome/Shell/Extensions/ClaudeDash` (methods: `SetPending`,
  `ClearPending`, `RequestApproval`, `CancelApproval`, `Clear`, `List`).
- For approvals, the hook creates a Unix socket in `$XDG_RUNTIME_DIR/claude-dash/`,
  passes the path to `RequestApproval`, and blocks on `accept()` for up to 30s.
  When you click Allow/Deny, the extension connects to that socket and writes
  the decision; the hook reads it, returns the appropriate
  `permissionDecision` to Claude Code, and cleans up.

## Hook events

| Claude Code event | Tray effect                                             |
|-------------------|---------------------------------------------------------|
| `PreToolUse`      | Block until Allow/Deny from tray, or timeout (30s).     |
| `Notification`    | Set session to `urgent` (bright amber, counted).        |
| `Stop`, `SubagentStop` | Mark session `idle`, show dialog title.             |
| `UserPromptSubmit` | Mark session `busy`, show dialog title.                |
| `SessionEnd`      | Remove the session from the indicator.                  |

## Troubleshooting

**The icon doesn't appear after install.**
Log out and log back in — Wayland only scans the extension directory at shell
startup. If you're on X11, `Alt+F2 → r → Enter` also works.

**"Open VSCode window" opens a new window or the wrong one.**
Make sure the *Window Calls Extended* extension is enabled — without it the
indicator falls back to heuristics. Window matching uses the project folder
name against the window title.

**Approval never arrives from the tray.**
Check `~/.claude/hooks/claude-dash.log` for errors. If `RequestApproval dbus
call failed` appears, the extension isn't loaded or its GType got invalidated.
Toggle the extension off/on or log out.

**Claude Code edits still show an inline diff after I approve in the tray.**
The inline diff is a separate UX in the Claude Code VSCode extension, not a
permission gate. Set `"claudeCode.initialPermissionMode": "acceptEdits"` in
VSCode settings to auto-apply edits after the permission step. Or leave it
as-is if you prefer to review diffs.

**Shell crashed / panel disappeared after editing the extension.**
Likely a JS error in `extension.js`. Check
`journalctl --user -b 0 -u gnome-shell | grep claude`. Disable the extension
with `gnome-extensions disable claude-dash@local` and fix the source.

## Development

Wayland can't hot-reload extension JS. For dev iteration:

- Edit files in the installed extension dir (`~/.local/share/gnome-shell/extensions/claude-dash@local/`).
- CSS changes apply after `gnome-extensions disable … && gnome-extensions enable …`.
- JS changes require a full logout/login. The `GTypeName: 'ClaudeDashButton_' + Date.now().toString(36)`
  trick in `extension.js` makes the class registrable anew after each shell
  restart — don't remove it.

## License

MIT. See [LICENSE](LICENSE).