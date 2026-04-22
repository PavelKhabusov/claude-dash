#!/usr/bin/env python3
"""Claude Code hook → Claude Dash (GNOME extension) via DBus.

Dispatches on hook_event_name from stdin JSON:
- PreToolUse               → (optional) block waiting for tray approve/deny
- Notification             → set urgent in tray
- Stop / SubagentStop      → keep session visible as idle, with dialog title
- UserPromptSubmit         → set busy with dialog title
- SessionEnd               → clear pending

PreToolUse runs synchronously. Others detach so Claude never waits on us.
"""

import json
import os
import re
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime


DBUS_DEST = "org.gnome.Shell"
DBUS_PATH_INDICATOR = "/org/gnome/Shell/Extensions/ClaudeDash"
DBUS_IFACE_INDICATOR = "org.gnome.Shell.Extensions.ClaudeDash"

DBUS_PATH_WINDOWS = "/org/gnome/Shell/Extensions/WindowsExt"
DBUS_IFACE_WINDOWS = "org.gnome.Shell.Extensions.WindowsExt"

APPROVAL_TIMEOUT_SEC = 30

LOG_PATH = os.path.expanduser("~/.claude/hooks/claude-dash.log")

SETTINGS_PATH = os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"),
    "claude-dash", "settings.json",
)


def _log(msg):
    try:
        with open(LOG_PATH, "a") as f:
            f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}\n")
    except Exception:
        pass


def _read_settings():
    try:
        with open(SETTINGS_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def tray_approvals_enabled():
    """Read the extension's toggle state — default on if file missing."""
    return bool(_read_settings().get("approvals_enabled", True))


def auto_approve_enabled():
    """If on, hook returns 'allow' for every PreToolUse without blocking."""
    return bool(_read_settings().get("auto_approve", False))


def gv_str(s):
    if s is None:
        s = ""
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def dbus_call(path, iface, method, *str_args, timeout=5):
    cmd = [
        "gdbus", "call", "--session",
        "--dest", DBUS_DEST,
        "--object-path", path,
        "--method", f"{iface}.{method}",
    ]
    cmd.extend(gv_str(a) for a in str_args)
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except Exception:
        return None


def set_pending(session_id, project, cwd, tool_name, tool_input, message, state):
    """Compat: try 7-arg (state aware), fall back to 6-arg for old extensions."""
    r = dbus_call(DBUS_PATH_INDICATOR, DBUS_IFACE_INDICATOR, "SetPending",
                  session_id, project, cwd, tool_name, tool_input, message, state)
    if r is None or r.returncode != 0:
        dbus_call(DBUS_PATH_INDICATOR, DBUS_IFACE_INDICATOR, "SetPending",
                  session_id, project, cwd, tool_name, tool_input, message)


def summarize_tool_input(tool_input):
    if not isinstance(tool_input, dict):
        return ""
    for k in ("command", "file_path", "path", "pattern", "url", "description"):
        v = tool_input.get(k)
        if isinstance(v, str) and v:
            return v[:400]
    return ""


def extract_title(transcript_path):
    """First non-empty user text line from transcript — used as dialog title."""
    if not transcript_path or not os.path.exists(transcript_path):
        return ""
    try:
        with open(transcript_path, "r", errors="replace") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                if entry.get("type") != "user":
                    continue
                msg = entry.get("message") or {}
                content = msg.get("content")
                text = ""
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and c.get("type") == "text":
                            text = c.get("text") or ""
                            if text:
                                break
                if not text:
                    continue
                # Strip XML-like tag blocks (ide_selection, system-reminder, etc.)
                text = re.sub(r"<([a-zA-Z][\w-]*)>.*?</\1>", "", text, flags=re.DOTALL)
                text = re.sub(r"<[^>]+/?>", "", text)
                for ln in text.splitlines():
                    s = ln.strip()
                    if s and not s.startswith("[") and len(s) > 2:
                        return s[:80]
    except Exception:
        pass
    return ""


def vscode_focused():
    """True/False if we can tell, None if the Window Calls Extended ext isn't installed."""
    try:
        r = subprocess.run(
            ["gdbus", "call", "--session",
             "--dest", DBUS_DEST,
             "--object-path", DBUS_PATH_WINDOWS,
             "--method", f"{DBUS_IFACE_WINDOWS}.FocusClass"],
            capture_output=True, text=True, timeout=2,
        )
    except Exception:
        return None
    if r.returncode != 0:
        return None
    m = re.match(r"^\('(.*)',\)\s*$", r.stdout.strip(), re.DOTALL)
    if not m:
        return None
    return "code" in m.group(1).lower()


def last_pending_tool(transcript_path):
    if not transcript_path or not os.path.exists(transcript_path):
        return ("", "")
    pending = {}
    try:
        with open(transcript_path, "r", errors="replace") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                content = (entry.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                for c in content:
                    t = c.get("type")
                    if t == "tool_use":
                        inp = c.get("input") or {}
                        summary = summarize_tool_input(inp)
                        pending[c.get("id")] = (c.get("name") or "?", summary)
                    elif t == "tool_result":
                        pending.pop(c.get("tool_use_id"), None)
    except Exception:
        return ("", "")
    if not pending:
        return ("", "")
    return list(pending.values())[-1]


def _approval_socket_path(request_id):
    runtime = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
    base = os.path.join(runtime, "claude-dash")
    os.makedirs(base, mode=0o700, exist_ok=True)
    return os.path.join(base, f"approve-{os.getpid()}-{request_id}.sock")


def _request_tray_approval(session_id, project, cwd, tool_name, tool_input):
    """Block waiting for user decision in tray. Returns 'allow', 'deny', or '' (timeout/error)."""
    request_id = uuid.uuid4().hex[:16]
    socket_path = _approval_socket_path(request_id)
    try:
        os.unlink(socket_path)
    except OSError:
        pass

    sock = None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(socket_path)
        os.chmod(socket_path, 0o600)
        sock.listen(1)
    except Exception as e:
        _log(f"socket bind failed: {e!r}")
        if sock:
            sock.close()
        try:
            os.unlink(socket_path)
        except OSError:
            pass
        return ""

    r = dbus_call(DBUS_PATH_INDICATOR, DBUS_IFACE_INDICATOR, "RequestApproval",
                  request_id, session_id, project, cwd, tool_name, tool_input, socket_path)
    if r is None or r.returncode != 0:
        _log(f"RequestApproval dbus call failed: rc={r.returncode if r else None} stderr={r.stderr if r else ''}")
        sock.close()
        try:
            os.unlink(socket_path)
        except OSError:
            pass
        return ""

    decision = ""
    sock.settimeout(APPROVAL_TIMEOUT_SEC)
    try:
        conn, _addr = sock.accept()
        try:
            conn.settimeout(2)
            payload = conn.recv(64)
            decision = payload.decode("utf-8", "replace").strip().lower()
            _log(f"approval decision received: {decision!r}")
        except Exception as e:
            _log(f"approval recv error: {e!r}")
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except socket.timeout:
        _log(f"approval timed out after {APPROVAL_TIMEOUT_SEC}s")
    except Exception as e:
        _log(f"approval accept error: {e!r}")
    try:
        sock.close()
    except Exception:
        pass
    try:
        os.unlink(socket_path)
    except OSError:
        pass
    dbus_call(DBUS_PATH_INDICATOR, DBUS_IFACE_INDICATOR, "CancelApproval", request_id)

    if decision not in ("allow", "deny"):
        return ""
    return decision


def handle_pretooluse(data):
    session_id = data.get("session_id") or ""
    cwd = data.get("cwd") or ""
    project = os.path.basename(cwd) if cwd else ""
    tool_name = data.get("tool_name") or ""
    tool_input_dict = data.get("tool_input") or {}
    tool_input = summarize_tool_input(tool_input_dict)

    if auto_approve_enabled():
        # Tell the indicator we're doing something, then allow without asking.
        set_pending(session_id, project, cwd, tool_name, tool_input, "", "busy")
        sys.stdout.write(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
            },
        }))
        sys.stdout.flush()
        return

    if not tray_approvals_enabled():
        set_pending(session_id, project, cwd, tool_name, tool_input, "", "busy")
        return

    # The approval entry already shows tool + command, so we skip a separate
    # "busy" pending entry here to avoid duplicates.
    decision = _request_tray_approval(session_id, project, cwd, tool_name, tool_input)

    if not decision:
        # No tray decision (timeout) — fall through to Claude Code's inline UI,
        # but keep a busy entry so the user sees Claude is still working.
        set_pending(session_id, project, cwd, tool_name, tool_input, "", "busy")
    if decision in ("allow", "deny"):
        out = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": decision,
            },
        }
        if decision == "deny":
            out["hookSpecificOutput"]["permissionDecisionReason"] = "Denied via Claude Dash tray"
        sys.stdout.write(json.dumps(out))
        sys.stdout.flush()


def handle_notification(data):
    session_id = data.get("session_id") or ""
    cwd = data.get("cwd") or ""
    project = os.path.basename(cwd) if cwd else ""
    message = data.get("message") or "Claude is waiting"
    transcript = data.get("transcript_path") or ""
    tool_name, tool_input = last_pending_tool(transcript)

    set_pending(session_id, project, cwd, tool_name, tool_input, message, "urgent")


def handle_idle(data):
    """Claude finished a response — keep session visible with its title."""
    session_id = data.get("session_id") or ""
    cwd = data.get("cwd") or ""
    project = os.path.basename(cwd) if cwd else ""
    title = extract_title(data.get("transcript_path") or "")
    # tool_name field carries the dialog title when state=idle (no real tool).
    set_pending(session_id, project, cwd, title, "", "", "idle")


def handle_user_prompt(data):
    """User just submitted a prompt — Claude is about to work. Busy state + title."""
    session_id = data.get("session_id") or ""
    cwd = data.get("cwd") or ""
    project = os.path.basename(cwd) if cwd else ""
    title = extract_title(data.get("transcript_path") or "")
    set_pending(session_id, project, cwd, title, "", "", "busy")


def handle_clear(data):
    session_id = data.get("session_id") or ""
    dbus_call(DBUS_PATH_INDICATOR, DBUS_IFACE_INDICATOR, "ClearPending", session_id)


def dispatch_async(data):
    event = data.get("hook_event_name") or ""
    if event == "Notification":
        handle_notification(data)
    elif event in ("Stop", "SubagentStop"):
        handle_idle(data)
    elif event == "UserPromptSubmit":
        handle_user_prompt(data)
    elif event == "SessionEnd":
        handle_clear(data)


def spawn_detached(payload):
    env = os.environ.copy()
    env["_CLAUDE_DASH_DETACHED"] = "1"
    try:
        p = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__)],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            env=env,
        )
        p.stdin.write(payload.encode())
        p.stdin.close()
    except Exception as e:
        _log(f"spawn_detached error: {e!r}")


def main():
    if os.environ.get("_CLAUDE_DASH_DETACHED") == "1":
        try:
            data = json.loads(sys.stdin.read())
        except Exception:
            data = {}
        event = data.get("hook_event_name") or ""
        _log(f"child event={event} session={data.get('session_id','')[:8]}")
        try:
            dispatch_async(data)
        except Exception as e:
            _log(f"child dispatch error: {e!r}")
        return

    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except Exception:
        data = {}
    event = data.get("hook_event_name") or ""
    _log(f"parent event={event} session={data.get('session_id','')[:8]}")

    if event == "PreToolUse":
        try:
            handle_pretooluse(data)
        except Exception as e:
            _log(f"pretooluse error: {e!r}")
        return

    spawn_detached(raw)


if __name__ == "__main__":
    main()
