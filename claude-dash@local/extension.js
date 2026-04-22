import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export const DBUS_IFACE_NAME = 'org.gnome.Shell.Extensions.ClaudeDash';
export const DBUS_OBJECT_PATH = '/org/gnome/Shell/Extensions/ClaudeDash';

const DBUS_IFACE = `
<node>
  <interface name="${DBUS_IFACE_NAME}">
    <method name="SetPending">
      <arg type="s" direction="in" name="session_id"/>
      <arg type="s" direction="in" name="project"/>
      <arg type="s" direction="in" name="cwd"/>
      <arg type="s" direction="in" name="tool_name"/>
      <arg type="s" direction="in" name="tool_input"/>
      <arg type="s" direction="in" name="message"/>
      <arg type="s" direction="in" name="state"/>
    </method>
    <method name="ClearPending">
      <arg type="s" direction="in" name="session_id"/>
    </method>
    <method name="RequestApproval">
      <arg type="s" direction="in" name="request_id"/>
      <arg type="s" direction="in" name="session_id"/>
      <arg type="s" direction="in" name="project"/>
      <arg type="s" direction="in" name="cwd"/>
      <arg type="s" direction="in" name="tool_name"/>
      <arg type="s" direction="in" name="tool_input"/>
      <arg type="s" direction="in" name="socket_path"/>
    </method>
    <method name="CancelApproval">
      <arg type="s" direction="in" name="request_id"/>
    </method>
    <method name="Clear"/>
    <method name="List">
      <arg type="s" direction="out" name="json"/>
    </method>
  </interface>
</node>`;

const SETTINGS_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'claude-dash', 'settings.json']);

function loadSettings() {
    try {
        const [ok, contents] = GLib.file_get_contents(SETTINGS_PATH);
        if (!ok) return {};
        return JSON.parse(new TextDecoder().decode(contents));
    } catch (_e) {
        return {};
    }
}

function saveSettings(obj) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(SETTINGS_PATH), 0o700);
        GLib.file_set_contents(SETTINGS_PATH, JSON.stringify(obj, null, 2));
    } catch (e) {
        console.error('claude-dash: save settings failed:', e.message);
    }
}

// Approach adapted from Haletran/claude-usage-extension: read Claude Code's
// OAuth token and hit Anthropic's (undocumented, beta) usage endpoint.
function readOAuthToken() {
    const base = GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
    const path = GLib.build_filenamev([base, '.credentials.json']);
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok) return null;
        const data = JSON.parse(new TextDecoder().decode(contents));
        return data?.claudeAiOauth?.accessToken || null;
    } catch (_e) {
        return null;
    }
}

function normalizePercent(v) {
    if (typeof v !== 'number') return null;
    return v <= 1.01 ? Math.round(v * 100) : Math.round(v);
}

// Every load uses a fresh GTypeName so the extension can be reloaded in
// place without triggering "type already registered" errors.
const _GTYPE_SUFFIX = Date.now().toString(36);

const ClaudeDashButton = GObject.registerClass({
    GTypeName: 'ClaudeDashButton_' + _GTYPE_SUFFIX,
}, class ClaudeDashButton extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.5, 'Claude Dash');

        this._pending = new Map();
        this._approvals = new Map();
        this._history = [];
        this._settings = loadSettings();
        if (typeof this._settings.approvals_enabled !== 'boolean')
            this._settings.approvals_enabled = true;
        if (typeof this._settings.auto_approve !== 'boolean')
            this._settings.auto_approve = false;
        if (typeof this._settings.sound_enabled !== 'boolean')
            this._settings.sound_enabled = true;
        if (typeof this._settings.usage_enabled !== 'boolean')
            this._settings.usage_enabled = true;

        this._overallState = 'empty';
        this._usage = null;
        this._usageTimerId = 0;
        this._soupSession = null;

        this._iconIdle = Gio.icon_new_for_string(extensionPath + '/icons/claude-idle.svg');
        this._iconBusy = Gio.icon_new_for_string(extensionPath + '/icons/claude-busy.svg');
        this._iconActive = Gio.icon_new_for_string(extensionPath + '/icons/claude-active.svg');
        this._iconDone = Gio.icon_new_for_string(extensionPath + '/icons/claude-done.svg');

        const box = new St.BoxLayout({ style_class: 'claude-indicator-box' });
        this._icon = new St.Icon({
            gicon: this._iconIdle,
            style_class: 'system-status-icon',
        });
        this._badge = new St.Label({
            text: '',
            style_class: 'claude-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._badge.hide();
        box.add_child(this._icon);
        box.add_child(this._badge);
        this.add_child(box);

        this._rebuildMenu();
    }

    setPending(sessionId, project, cwd, toolName, toolInput, message, state) {
        if (!sessionId) sessionId = 'default';
        const normState = (state === 'busy' || state === 'urgent' || state === 'idle') ? state : 'urgent';
        this._pending.set(sessionId, {
            project: project || (cwd ? cwd.split('/').pop() : 'claude'),
            cwd: cwd || '',
            tool: toolName || '',
            input: toolInput || '',
            message: message || '',
            state: normState,
            ts: Date.now(),
        });
        this._rebuildMenu();
        this._updateIcon();
    }

    clearPending(sessionId) {
        if (!sessionId) sessionId = 'default';
        if (this._pending.delete(sessionId)) {
            this._rebuildMenu();
            this._updateIcon();
        }
    }

    requestApproval(requestId, sessionId, project, cwd, toolName, toolInput, socketPath) {
        if (!requestId) return;
        const projName = project || (cwd ? cwd.split('/').pop() : 'claude');
        this._approvals.set(requestId, {
            sessionId: sessionId || '',
            project: projName,
            cwd: cwd || '',
            tool: toolName || '',
            input: toolInput || '',
            socketPath: socketPath || '',
            ts: Date.now(),
        });
        this._pushHistory('request', projName, toolName, toolInput);
        if (this._settings.sound_enabled && !this._settings.auto_approve)
            this._playSound('message');
        this._rebuildMenu();
        this._updateIcon();
    }

    cancelApproval(requestId) {
        if (this._approvals.delete(requestId)) {
            this._rebuildMenu();
            this._updateIcon();
        }
    }

    clearAll() {
        this._pending.clear();
        this._approvals.clear();
        this._rebuildMenu();
        this._updateIcon();
    }

    listJson() {
        const pending = [];
        for (const [k, v] of this._pending.entries())
            pending.push(Object.assign({ session_id: k }, v));
        const approvals = [];
        for (const [k, v] of this._approvals.entries())
            approvals.push(Object.assign({ request_id: k }, v));
        return JSON.stringify({ pending, approvals });
    }

    _respondApproval(requestId, decision) {
        const info = this._approvals.get(requestId);
        if (!info) return;
        try {
            const addr = Gio.UnixSocketAddress.new(info.socketPath);
            const client = new Gio.SocketClient();
            const conn = client.connect(addr, null);
            const stream = conn.get_output_stream();
            const payload = new TextEncoder().encode(decision + '\n');
            stream.write(payload, null);
            stream.close(null);
            conn.close(null);
        } catch (e) {
            console.error('claude-dash: approval respond failed:', e.message);
        }
        this._pushHistory(decision, info.project, info.tool, info.input);
        this._approvals.delete(requestId);
        this._rebuildMenu();
        this._updateIcon();
    }

    _pushHistory(kind, project, tool, input) {
        this._history.push({
            ts: Date.now(),
            kind, project: project || '', tool: tool || '', input: input || '',
        });
        while (this._history.length > 50)
            this._history.shift();
    }

    _historyIcon(kind) {
        if (kind === 'allow') return '✅';
        if (kind === 'deny') return '❌';
        if (kind === 'request') return '🔔';
        return '·';
    }

    _formatTime(ts) {
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    }

    _computeState() {
        if (this._approvals.size > 0) return 'urgent';
        let hasBusy = false, hasIdle = false;
        for (const v of this._pending.values()) {
            if (v.state === 'urgent') return 'urgent';
            if (v.state === 'busy') hasBusy = true;
            else if (v.state === 'idle') hasIdle = true;
        }
        if (hasBusy) return 'busy';
        if (hasIdle) return 'done';
        return 'empty';
    }

    _playSound(name) {
        try {
            GLib.spawn_command_line_async(`canberra-gtk-play -i ${name}`);
        } catch (_e) {}
    }

    startUsagePolling() {
        if (!this._settings.usage_enabled) return;
        this._fetchUsage();
        if (this._usageTimerId) return;
        this._usageTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 600, () => {
            this._fetchUsage();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopUsagePolling() {
        if (this._usageTimerId) {
            GLib.Source.remove(this._usageTimerId);
            this._usageTimerId = 0;
        }
    }

    _fetchUsage() {
        if (!this._settings.usage_enabled) return;
        const token = readOAuthToken();
        if (!token) {
            this._usage = null;
            this._rebuildMenu();
            return;
        }
        if (!this._soupSession)
            this._soupSession = new Soup.Session();
        const msg = Soup.Message.new('GET', 'https://api.anthropic.com/api/oauth/usage');
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        this._soupSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const text = new TextDecoder().decode(bytes.get_data());
                const json = JSON.parse(text);
                this._usage = {
                    fiveHour: normalizePercent(json?.five_hour?.utilization),
                    sevenDay: normalizePercent(json?.seven_day?.utilization),
                    fetchedAt: Date.now(),
                };
            } catch (e) {
                console.error('claude-dash: usage fetch failed:', e.message);
            }
            this._rebuildMenu();
        });
    }

    _maybePlayTransitionSound(oldState, newState) {
        if (!this._settings.sound_enabled) return;
        // Attention sound lives in requestApproval (per-approval granularity);
        // here we only cover the "Claude just finished" completion cue.
        if (newState === 'done' && (oldState === 'busy' || oldState === 'urgent')) {
            this._playSound('complete');
        }
    }

    _updateIcon() {
        const newState = this._computeState();
        if (newState !== this._overallState) {
            this._maybePlayTransitionSound(this._overallState, newState);
            this._overallState = newState;
        }

        const urgentCount = this._approvals.size +
            [...this._pending.values()].filter(v => v.state === 'urgent').length;

        if (newState === 'urgent') {
            this._icon.set_gicon(this._iconActive);
            this._badge.set_text(String(urgentCount));
            this._badge.show();
        } else if (newState === 'busy') {
            this._icon.set_gicon(this._iconBusy);
            this._badge.hide();
        } else if (newState === 'done') {
            this._icon.set_gicon(this._iconDone);
            this._badge.hide();
        } else {
            this._icon.set_gicon(this._iconIdle);
            this._badge.hide();
        }
    }

    _makeLabelItem(text, styleClass) {
        const item = new PopupMenu.PopupMenuItem(text, { reactive: false });
        item.label.clutter_text.set_line_wrap(true);
        item.label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        if (styleClass)
            item.label.add_style_class_name(styleClass);
        return item;
    }

    _makeHeaderRow(text, styleClass, actionEmoji, actionHandler) {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const box = new St.BoxLayout({ x_expand: true, style_class: 'claude-header-row' });
        const label = new St.Label({
            text,
            style_class: styleClass,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        box.add_child(label);
        if (actionEmoji && actionHandler) {
            const btn = new St.Button({
                style_class: 'claude-header-action',
                label: actionEmoji,
                can_focus: true,
            });
            btn.connect('clicked', actionHandler);
            box.add_child(btn);
        }
        item.add_child(box);
        return item;
    }

    _stateIcon(state) {
        if (state === 'urgent') return '⚠️';
        if (state === 'busy') return '⚡';
        return '💭';
    }

    _rebuildMenu() {
        this.menu.removeAll();

        const projects = new Map();
        const ensureProject = (name, cwd) => {
            const key = name || 'claude';
            if (!projects.has(key))
                projects.set(key, { cwd: cwd || '', approvals: [], sessions: [] });
            const p = projects.get(key);
            if (!p.cwd && cwd) p.cwd = cwd;
            return p;
        };

        for (const [rid, info] of this._approvals.entries())
            ensureProject(info.project, info.cwd).approvals.push([rid, info]);

        const approvedSessions = new Set();
        for (const info of this._approvals.values())
            if (info.sessionId) approvedSessions.add(info.sessionId);

        for (const [sid, info] of this._pending.entries()) {
            if (approvedSessions.has(sid)) continue;
            ensureProject(info.project, info.cwd).sessions.push([sid, info]);
        }

        if (projects.size === 0) {
            const idle = new PopupMenu.PopupMenuItem('Claude Code · idle', { reactive: false });
            idle.label.add_style_class_name('claude-menu-idle');
            this.menu.addMenuItem(idle);
        } else {
            const projectList = [...projects.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            projectList.forEach(([name, data], pIdx) => {
                if (pIdx > 0)
                    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                this.menu.addMenuItem(this._makeHeaderRow(
                    name,
                    'claude-section-header',
                    '⤴',
                    () => this._focusWindow(data.cwd, name)
                ));

                const approvals = data.approvals.sort((a, b) => a[1].ts - b[1].ts);
                for (const [rid, info] of approvals) {
                    const line = info.input
                        ? `🔔  ${info.tool}: ${info.input}`
                        : `🔔  ${info.tool || 'request'}`;
                    this.menu.addMenuItem(this._makeLabelItem(line, 'claude-menu-tool'));

                    const allow = new PopupMenu.PopupMenuItem('  ✅ Allow');
                    allow.connect('activate', () => this._respondApproval(rid, 'allow'));
                    this.menu.addMenuItem(allow);

                    const deny = new PopupMenu.PopupMenuItem('  ❌ Deny');
                    deny.connect('activate', () => this._respondApproval(rid, 'deny'));
                    this.menu.addMenuItem(deny);
                }

                const sessions = data.sessions.sort((a, b) => {
                    const order = { urgent: 0, busy: 1, idle: 2 };
                    const oa = order[a[1].state] ?? 1;
                    const ob = order[b[1].state] ?? 1;
                    if (oa !== ob) return oa - ob;
                    return b[1].ts - a[1].ts;
                });
                for (const [sid, info] of sessions) {
                    const icon = this._stateIcon(info.state);
                    let line = `${icon}  `;
                    if (info.tool)
                        line += info.input ? `${info.tool}: ${info.input}` : info.tool;
                    else if (info.message)
                        line += info.message;
                    else
                        line += '…';
                    const item = this._makeLabelItem(line, 'claude-menu-tool');
                    item.reactive = true;
                    item.can_focus = true;
                    item.connect('activate', () => this.clearPending(sid));
                    this.menu.addMenuItem(item);
                }
            });
        }

        if (this._settings.usage_enabled && this._usage && (this._usage.fiveHour != null || this._usage.sevenDay != null)) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const fh = this._usage.fiveHour != null ? `5h ${this._usage.fiveHour}%` : '';
            const sd = this._usage.sevenDay != null ? `7d ${this._usage.sevenDay}%` : '';
            const line = ['Usage · ' + [fh, sd].filter(Boolean).join('  ·  ')].join('');
            const item = this._makeLabelItem(line, 'claude-menu-usage');
            item.reactive = true;
            item.can_focus = true;
            item.connect('activate', () => this._fetchUsage());
            this.menu.addMenuItem(item);
        }

        if (this._history.length > 0)
            this._appendHistorySection();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settings = new PopupMenu.PopupSubMenuMenuItem('⚙  Settings');

        const toggleApprovals = new PopupMenu.PopupSwitchMenuItem(
            'Intercept tool approvals',
            this._settings.approvals_enabled
        );
        toggleApprovals.connect('toggled', (_item, state) => {
            this._settings.approvals_enabled = state;
            saveSettings(this._settings);
        });
        settings.menu.addMenuItem(toggleApprovals);

        const toggleAuto = new PopupMenu.PopupSwitchMenuItem(
            'Auto-approve every tool',
            this._settings.auto_approve
        );
        toggleAuto.connect('toggled', (_item, state) => {
            this._settings.auto_approve = state;
            saveSettings(this._settings);
            if (state) {
                // Unblock every currently pending approval request right away.
                for (const rid of [...this._approvals.keys()])
                    this._respondApproval(rid, 'allow');
            }
        });
        settings.menu.addMenuItem(toggleAuto);

        const toggleSound = new PopupMenu.PopupSwitchMenuItem(
            'Play sounds',
            this._settings.sound_enabled
        );
        toggleSound.connect('toggled', (_item, state) => {
            this._settings.sound_enabled = state;
            saveSettings(this._settings);
        });
        settings.menu.addMenuItem(toggleSound);

        const toggleUsage = new PopupMenu.PopupSwitchMenuItem(
            'Show Anthropic usage %',
            this._settings.usage_enabled
        );
        toggleUsage.connect('toggled', (_item, state) => {
            this._settings.usage_enabled = state;
            saveSettings(this._settings);
            if (state) {
                this.startUsagePolling();
            } else {
                this.stopUsagePolling();
                this._usage = null;
                this._rebuildMenu();
            }
        });
        settings.menu.addMenuItem(toggleUsage);

        if (this._pending.size > 0 || this._approvals.size > 0) {
            settings.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const clearAll = new PopupMenu.PopupMenuItem('Clear all sessions');
            clearAll.connect('activate', () => this.clearAll());
            settings.menu.addMenuItem(clearAll);
        }

        this.menu.addMenuItem(settings);
    }

    _appendHistorySection() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._makeHeaderRow(
            'History',
            'claude-section-header',
            '🗑',
            () => { this._history = []; this._rebuildMenu(); }
        ));

        const container = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const scroll = new St.ScrollView({
            style_class: 'claude-history-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
        });
        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'claude-history-box',
        });
        const reversed = [...this._history].reverse();
        for (const h of reversed) {
            const icon = this._historyIcon(h.kind);
            const time = this._formatTime(h.ts);
            const tool = h.tool ? `${h.tool}${h.input ? ': ' + h.input : ''}` : '';
            const text = `${icon}  ${time}  ${h.project}${tool ? '  ·  ' + tool : ''}`;
            const label = new St.Label({ text, style_class: 'claude-history-entry' });
            label.clutter_text.set_line_wrap(true);
            label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            box.add_child(label);
        }
        scroll.add_child(box);
        container.add_child(scroll);
        this.menu.addMenuItem(container);
    }

    _focusWindow(cwd, project) {
        const name = (project || (cwd ? cwd.split('/').pop() : '') || '').toLowerCase();
        const windows = global.display.list_all_windows();
        if (!name) {
            for (const w of windows) {
                if ((w.get_wm_class() || '').toLowerCase() === 'code') {
                    Main.activateWindow(w);
                    return;
                }
            }
            return;
        }
        let match = null;
        let fallback = null;
        for (const w of windows) {
            const wmClass = (w.get_wm_class() || '').toLowerCase();
            if (wmClass !== 'code') continue;
            const title = (w.get_title() || '').toLowerCase();
            if (title.includes(name)) { match = w; break; }
            if (!fallback) fallback = w;
        }
        const target = match || fallback;
        if (target) Main.activateWindow(target);
    }
});

export default class ClaudeDashExtension extends Extension {
    enable() {
        this._button = new ClaudeDashButton(this.path);
        // position=0, side='right' → leftmost slot of the right panel group
        Main.panel.addToStatusArea('claude-dash', this._button, 0, 'right');

        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_IFACE, this);
        this._dbus.export(Gio.DBus.session, DBUS_OBJECT_PATH);

        this._button.startUsagePolling();

        // On shell startup other extensions may enable after us and insert at
        // position=0 too, pushing us right. Re-snap a couple of times after
        // startup settles so we end up leftmost.
        this._repositionIds = [];
        for (const delay of [500, 1500, 3000]) {
            const id = GLib.timeout_add(GLib.PRIORITY_LOW, delay, () => {
                this._snapLeftmost();
                return GLib.SOURCE_REMOVE;
            });
            this._repositionIds.push(id);
        }
    }

    disable() {
        if (this._repositionIds) {
            for (const id of this._repositionIds) GLib.Source.remove(id);
            this._repositionIds = null;
        }
        if (this._button) {
            this._button.stopUsagePolling();
        }
        if (this._dbus) {
            this._dbus.unexport();
            this._dbus = null;
        }
        if (this._button) {
            this._button.destroy();
            this._button = null;
        }
    }

    _snapLeftmost() {
        const container = this._button?.container;
        const parent = container?.get_parent();
        if (parent && typeof parent.set_child_at_index === 'function') {
            parent.set_child_at_index(container, 0);
        }
    }

    SetPending(sessionId, project, cwd, toolName, toolInput, message, state) {
        this._button?.setPending(sessionId, project, cwd, toolName, toolInput, message, state);
    }

    ClearPending(sessionId) {
        this._button?.clearPending(sessionId);
    }

    RequestApproval(requestId, sessionId, project, cwd, toolName, toolInput, socketPath) {
        this._button?.requestApproval(requestId, sessionId, project, cwd, toolName, toolInput, socketPath);
    }

    CancelApproval(requestId) {
        this._button?.cancelApproval(requestId);
    }

    Clear() {
        this._button?.clearAll();
    }

    List() {
        return this._button ? this._button.listJson() : '{}';
    }
}
