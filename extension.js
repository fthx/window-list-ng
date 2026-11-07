// Window List NG
// based on the GNOME official extension by @fmuellner
// @fthx 2026
//
// SPDX-FileCopyrightText: 2012 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2013 Giovanni Campagna <gcampagna@src.gnome.org>
// SPDX-FileCopyrightText: 2014 Sylvain Pasche <sylvain.pasche@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { DashItemContainer } from 'resource:///org/gnome/shell/ui/dash.js';
import {
    ANIMATION_TIME as SLIDE_ANIMATION_TIME,
} from 'resource:///org/gnome/shell/ui/overview.js';

import { BottomOverview } from './bottomOverview.js';
import { LightStyle } from './lightStyle.js';
import { PanelFree } from './panelFree.js';
import { WorkspaceIndicator } from './workspaceIndicator.js';

const ICON_TEXTURE_SIZE = 22;
const DND_ACTIVATE_TIMEOUT = 500;

const MIN_DRAG_UPDATE_INTERVAL = 500 * GLib.TIME_SPAN_MILLISECOND;

const DRAG_OPACITY = 0.3;
const DRAG_FADE_DURATION = 200;

const DRAG_RESIZE_DURATION = 400;

const DRAG_PROXIMITY_THRESHOLD = 30;

const SAVED_POSITIONS_KEY = 'window-list-ng-positions';

const ATTENTION_INDICATOR_MAX_SCALE = 0.4;
const ATTENTION_INDICATOR_TRANSITION_DURATION = 300;

const GroupingMode = {
    NEVER: 0,
    AUTO: 1,
    ALWAYS: 2,
};

class DragPlaceholderItem extends DashItemContainer {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super();
        this.setChild(new St.Bin({ style_class: 'placeholder' }));
    }
}

/**
 * @param {Shell.App} app - an app
 * @returns {number} - the smallest stable sequence of the app's windows
 */
function _getAppStableSequence(app) {
    const windows = app.get_windows().filter(w => !w.skip_taskbar);
    return windows.reduce((prev, cur) => {
        return Math.min(prev, cur.get_stable_sequence());
    }, Infinity);
}

/**
 * @param {Clutter.Actor} actor - an actor inside the UI group
 * @returns {?Clutter.Actor} - the ancestor of actor (or actor itself)
 *   that is a direct child of the UI group
 */
function _getUiGroupChild(actor) {
    while (actor && actor.get_parent() !== Main.uiGroup)
        actor = actor.get_parent();
    return actor;
}

class ButtonMenu extends PopupMenu.PopupMenu {
    constructor(source) {
        super(source, 0.5, St.Side.BOTTOM);

        this.actor.hide();
        Main.uiGroup.add_child(this.actor);
    }
}

class TitleWidget extends St.Widget {
    static {
        GObject.registerClass({
            GTypeFlags: GObject.TypeFlags.ABSTRACT,
            Properties: {
                'abstract-label': GObject.ParamSpec.boolean(
                    'abstract-label', null, null,
                    GObject.ParamFlags.READWRITE,
                    false),
            },
        }, this);
    }

    constructor() {
        super({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        const hbox = new St.BoxLayout({
            style_class: 'window-button-box',
            x_expand: true,
            y_expand: true,
        });
        this.add_child(hbox);

        this._icon = new St.Bin({
            style_class: 'window-button-icon',
        });
        hbox.add_child(this._icon);

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
        });
        hbox.add_child(this._label);
        this.label_actor = this._label;

        this.bind_property('abstract-label',
            this._label, 'visible',
            GObject.BindingFlags.SYNC_CREATE |
            GObject.BindingFlags.INVERT_BOOLEAN);

        this._abstractLabel = new St.Widget({
            style_class: 'window-button-abstract-label',
            x_expand: true,
            y_expand: true,
        });
        hbox.add_child(this._abstractLabel);

        this.bind_property('abstract-label',
            this._abstractLabel, 'visible',
            GObject.BindingFlags.SYNC_CREATE);

        this._attentionIndicator = new St.Widget({
            style_class: 'window-button-attention-indicator',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.END,
            scale_x: 0,
        });
        this._attentionIndicator.set_pivot_point(0.5, 0.5);
        this.add_child(this._attentionIndicator);
    }

    setNeedsAttention(enable) {
        this._attentionIndicator.ease({
            scaleX: enable ? ATTENTION_INDICATOR_MAX_SCALE : 0,
            duration: ATTENTION_INDICATOR_TRANSITION_DURATION,
        });
    }
}

class WindowTitle extends TitleWidget {
    static {
        GObject.registerClass(this);
    }

    constructor(metaWindow) {
        super();

        this._metaWindow = metaWindow;

        this._metaWindow.connectObject(
            'notify::wm-class',
            () => this._updateIcon(), GObject.ConnectFlags.AFTER,
            'notify::gtk-application-id',
            () => this._updateIcon(), GObject.ConnectFlags.AFTER,
            'notify::title', () => this._updateTitle(),
            'notify::minimized', () => this._minimizedChanged(),
            'notify::demands-attention', () => this._updateNeedsAttention(),
            'notify::urgent', () => this._updateNeedsAttention(),
            this);

        this._updateIcon();
        this._minimizedChanged();
        this._updateNeedsAttention();
    }

    _minimizedChanged() {
        this._icon.opacity = this._metaWindow.minimized ? 128 : 255;
        this._updateTitle();
    }

    _updateNeedsAttention() {
        const { urgent, demandsAttention } = this._metaWindow;
        this.setNeedsAttention(urgent || demandsAttention);
    }

    _updateTitle() {
        const { title, minimized } = this._metaWindow;
        if (!title)
            return;

        this._label.text = minimized ? `[${title}]` : title;
    }

    _updateIcon() {
        const app = Shell.WindowTracker.get_default().get_window_app(this._metaWindow);
        const wmClass = this._metaWindow.wm_class;

        // a Chromium web app has an icon named as its windows, even when the
        // window tracker gives them to the browser (sandboxed browser: snap)
        if (wmClass?.startsWith('chrome-')) {
            this._icon.child = new St.Icon({
                gicon: Gio.ThemedIcon.new(wmClass),
                fallback_gicon: app?.icon ?? null,
                icon_size: ICON_TEXTURE_SIZE,
            });
        } else if (app) {
            this._icon.child = app.create_icon_texture(ICON_TEXTURE_SIZE);
        } else {
            this._icon.child = new St.Icon({
                icon_name: 'application-x-executable',
                icon_size: ICON_TEXTURE_SIZE,
            });
        }
    }
}

class AppTitle extends TitleWidget {
    static {
        GObject.registerClass(this);
    }

    constructor(app) {
        super();

        this._app = app;
        this._windows = new Set();

        this._icon.child = app.create_icon_texture(ICON_TEXTURE_SIZE);
        this._label.text = app.get_name();

        this._app.connectObject(
            'windows-changed', () => this._onWindowsChanged(),
            this);
        this._onWindowsChanged();
    }

    _onWindowsChanged() {
        const windows = this._app.get_windows();
        const removed = [...this._windows].filter(w => !windows.includes(w));
        removed.forEach(w => this._untrackWindow(w));
        windows.forEach(w => this._trackWindow(w));
        this._updateNeedsAttention();
    }

    _trackWindow(window) {
        if (this._windows.has(window))
            return;

        window.connectObject(
            'notify::urgent', () => this._updateNeedsAttention(),
            'notify::demands-attention', () => this._updateNeedsAttention(),
            this);
        this._windows.add(window);
    }

    _untrackWindow(window) {
        if (!this._windows.delete(window))
            return;

        window.disconnectObject(this);
    }

    _updateNeedsAttention() {
        const needsAttention =
            [...this._windows].some(w => w.urgent || w.demandsAttention);
        this.setNeedsAttention(needsAttention);
    }
}

class DragActor extends St.Bin {
    static {
        GObject.registerClass(this);
    }

    constructor(source, titleActor) {
        super({
            style_class: 'window-button-drag-actor',
            child: titleActor,
            width: source.width,
        });

        this.source = source;

        this.connect('destroy', () => this._removeLater());
    }

    setTargetWidth(width) {
        const currentWidth = this.width;

        // set width immediately so shell's DND code uses correct values
        this.set({ width });

        // then transition from the original to the new width
        this._removeLater();
        this._laterId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                delete this._laterId;

                this.set({ width: currentWidth });
                this.ease({
                    width,
                    duration: DRAG_RESIZE_DURATION,
                });
                return GLib.SOURCE_REMOVE;
            });
    }

    _removeLater() {
        if (!this._laterId)
            return;

        global.compositor.get_laters().remove(this._laterId);
        delete this._laterId;
    }
}

class BaseButton extends DashItemContainer {
    static {
        GObject.registerClass({
            GTypeFlags: GObject.TypeFlags.ABSTRACT,
            Properties: {
                'ignore-workspace': GObject.ParamSpec.boolean(
                    'ignore-workspace', null, null,
                    GObject.ParamFlags.READWRITE,
                    false),
            },
            Signals: {
                'drag-begin': {},
                'drag-end': {},
            },
        }, this);
    }

    constructor(perMonitor, monitorIndex) {
        super();

        this._button = new St.Button({
            style_class: 'window-button',
            can_focus: true,
            x_expand: true,
            y_expand: true,
            button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.SECONDARY,
        });
        // same as this.setChild(), written out so that the EGO linter sees
        // that the container owns (and destroys) its child
        this.child = this._button;
        this.add_child(this._button);

        this._button.connect('notify::hover', () => {
            if (this._button.hover)
                this.showLabel();
            else
                this.hideLabel();
        });

        this._perMonitor = perMonitor;
        this._monitorIndex = monitorIndex;
        this._ignoreWorkspace = false;

        this.connect('notify::allocation',
            this._updateIconGeometry.bind(this));
        this._button.connect('clicked', this._onClicked.bind(this));
        // emitted on the focused actor, which is the button
        this._button.connect('popup-menu', () => this._onPopupMenu());
        this.connect('destroy', this._onDestroy.bind(this));

        const longPressGesture = new Clutter.LongPressGesture({
            required_button: Clutter.BUTTON_PRIMARY,
        });
        longPressGesture.connect('recognize', () => this._onPopupMenu());
        this._button.add_action(longPressGesture);

        // the same app menu as in the dash, for the window or app; the
        // manager lives as long as the menu, whose signals reference it
        this._contextMenu = new AppMenu(this, St.Side.BOTTOM);
        this._contextMenu.actor.hide();
        Main.uiGroup.add_child(this._contextMenu.actor);
        new PopupMenu.PopupMenuManager(this).addMenu(this._contextMenu);

        global.window_manager.connectObject('switch-workspace',
            () => this._updateVisibility(), this);

        if (this._perMonitor) {
            global.display.connectObject(
                'window-entered-monitor',
                this._windowEnteredOrLeftMonitor.bind(this),
                'window-left-monitor',
                this._windowEnteredOrLeftMonitor.bind(this),
                this);
        }

        this._button._delegate = this;
        this._draggable = DND.makeDraggable(this._button);
        this._draggable.connectObject(
            'drag-begin', () => this.emit('drag-begin'),
            'drag-cancelled', () => {
                this._draggable._dragActor?.setTargetWidth(this.width);
                this.emit('drag-end');
            },
            'drag-end', () => this.emit('drag-end'),
            this);
    }

    get active() {
        return this._button.has_style_class_name('focused');
    }

    get ignore_workspace() {
        return this._ignoreWorkspace;
    }

    set ignore_workspace(ignore) {
        if (this._ignoreWorkspace === ignore)
            return;

        this._ignoreWorkspace = ignore;
        this.notify('ignore-workspace');

        this._updateVisibility();
    }

    showLabel() {
        const [, , preferredTitleWidth] = this.label_actor.get_preferred_size();
        const maxTitleWidth = this.label_actor.allocation.get_width();
        const isTitleFullyShown = preferredTitleWidth <= maxTitleWidth;

        const labelText = isTitleFullyShown
            ? '' : this.label_actor.text;

        this.setLabelText(labelText);
        super.showLabel();
    }

    activate() {
        if (this.active)
            return;

        this._onClicked(this, 1);
    }

    getDragActor() {
        const titleActor = this._createTitleActor();
        titleActor.set({ abstractLabel: true });

        const dragActor = new DragActor(this, titleActor);

        const [, natWidth] = this.get_preferred_width(-1);
        const targetWidth = Math.min(natWidth / 2, this.width);
        dragActor.setTargetWidth(targetWidth);

        return dragActor;
    }

    getDragActorSource() {
        return this;
    }

    _createTitleActor() {
        throw new GObject.NotImplementedError(
            `_createTitleActor in ${this.constructor.name}`);
    }

    _onClicked(_actor, _button) {
        throw new GObject.NotImplementedError(
            `_onClicked in ${this.constructor.name}`);
    }

    _canOpenPopupMenu() {
        return true;
    }

    _minimizeOrActivateWindow(window) {
        const { focusWindow } = global.display;
        const useMinimize =
            focusWindow === window ||
            focusWindow?.get_transient_for() === window;

        if (useMinimize && window.can_minimize())
            window.minimize();
        else if (!useMinimize)
            window.activate(global.get_current_time());
    }

    _onPopupMenu() {
        if (!this._canOpenPopupMenu() || this._contextMenu.isOpen)
            return;
        this._contextMenu.open();
    }

    _isFocused() {
        throw new GObject.NotImplementedError(
            `_isFocused in ${this.constructor.name}`);
    }

    _updateStyle() {
        if (this._isFocused())
            this._button.add_style_class_name('focused');
        else
            this._button.remove_style_class_name('focused');
    }

    _windowEnteredOrLeftMonitor(_metaDisplay, _monitorIndex, _metaWindow) {
        throw new GObject.NotImplementedError(
            `_windowEnteredOrLeftMonitor in ${this.constructor.name}`);
    }

    _isWindowVisible(window) {
        const workspace = global.workspace_manager.get_active_workspace();

        return !window.skip_taskbar &&
            (this._ignoreWorkspace || window.located_on_workspace(workspace)) &&
            (!this._perMonitor || window.get_monitor() === this._monitorIndex);
    }

    _updateVisibility() {
        throw new GObject.NotImplementedError(
            `_updateVisibility in ${this.constructor.name}`);
    }

    _getIconGeometry() {
        const rect = new Mtk.Rectangle();

        [rect.x, rect.y] = this.get_transformed_position();
        [rect.width, rect.height] = this.get_transformed_size();

        return rect;
    }

    _updateIconGeometry() {
        throw new GObject.NotImplementedError(
            `_updateIconGeometry in ${this.constructor.name}`);
    }

    _onDestroy() {
        this._contextMenu.destroy();
        this._contextMenu = null;
    }
}

class WindowButton extends BaseButton {
    static {
        GObject.registerClass(this);
    }

    constructor(metaWindow, perMonitor, monitorIndex) {
        super(perMonitor, monitorIndex);

        this.metaWindow = metaWindow;
        this._unmanaging = false;
        metaWindow.connectObject(
            'notify::skip-taskbar', () => this._updateVisibility(),
            'notify::minimized', () => this._updateStyle(),
            // the window tracker updates the app of the window first
            'notify::wm-class', () => this._updateApp(), GObject.ConnectFlags.AFTER,
            'notify::gtk-application-id', () => this._updateApp(), GObject.ConnectFlags.AFTER,
            'workspace-changed', () => this._updateVisibility(),
            'unmanaging', () => (this._unmanaging = true),
            this);

        this._updateVisibility();

        this._windowTitle = this._createTitleActor();
        this._button.set_child(this._windowTitle);
        this.label_actor = this._windowTitle.label_actor;

        this._updateApp();

        global.display.connectObject('notify::focus-window',
            () => this._updateStyle(), this);
        this._updateStyle();
    }

    get id() {
        return `window:${this.metaWindow.get_id()}`;
    }

    _createTitleActor() {
        return new WindowTitle(this.metaWindow);
    }

    _updateApp() {
        this._contextMenu.setApp(
            Shell.WindowTracker.get_default().get_window_app(this.metaWindow));
    }

    _onClicked(actor, button) {
        if (this._contextMenu.isOpen) {
            this._contextMenu.close();
            return;
        }

        if (!button || button === 1)
            this._minimizeOrActivateWindow(this.metaWindow);
        else
            this._contextMenu.open();
    }

    _isFocused() {
        return global.display.focus_window === this.metaWindow;
    }

    _updateStyle() {
        super._updateStyle();

        if (this.metaWindow.minimized)
            this._button.add_style_class_name('minimized');
        else
            this._button.remove_style_class_name('minimized');
    }

    _windowEnteredOrLeftMonitor(metaDisplay, monitorIndex, metaWindow) {
        if (monitorIndex === this._monitorIndex && metaWindow === this.metaWindow)
            this._updateVisibility();
    }

    _updateVisibility() {
        // keep the button visible until it is animated out
        if (this._unmanaging)
            return;

        this.visible = this._isWindowVisible(this.metaWindow);
    }

    _updateIconGeometry() {
        this.metaWindow.set_icon_geometry(this._getIconGeometry());
    }
}

class AppButton extends BaseButton {
    static {
        GObject.registerClass(this);
    }

    constructor(app, perMonitor, monitorIndex) {
        super(perMonitor, monitorIndex);

        this.app = app;
        this._windows = new Set();
        this._singleWindow = undefined;

        // the windows of the app, on left click
        this._menu = new ButtonMenu(this);
        this._menu.connectObject('activate', this._onMenuActivate.bind(this), this);
        new PopupMenu.PopupMenuManager(this).addMenu(this._menu);
        this.connect('destroy', this._destroyMenu.bind(this));

        this._contextMenu.setApp(this.app);

        Shell.WindowTracker.get_default().connectObject('notify::focus-app',
            () => this._updateStyle(), this);

        this.app.connectObject('windows-changed',
            () => this._onAppWindowsChanged(), this);
        this._onAppWindowsChanged();

        this._updateStyle();
    }

    get id() {
        return `app:${this.app.get_id()}`;
    }

    _onAppWindowsChanged() {
        const windows = this.app.get_windows();
        [...this._windows]
            .filter(w => !windows.includes(w))
            .forEach(w => this._untrackWindow(w));
        windows.forEach(w => this._trackWindow(w));

        this._updateVisibility();
    }

    _trackWindow(window) {
        if (this._windows.has(window))
            return;

        window.connectObject(
            'notify::skip-taskbar', () => this._updateVisibility(),
            'workspace-changed', () => this._updateVisibility(),
            // ignore the workspace change emitted while unmanaging
            'unmanaging', () => this._untrackWindow(window),
            this);
        this._windows.add(window);
    }

    _untrackWindow(window) {
        if (!this._windows.delete(window))
            return;

        window.disconnectObject(this);
    }

    _windowEnteredOrLeftMonitor(metaDisplay, monitorIndex, metaWindow) {
        // windows being unmanaged are no longer tracked: if that stops the
        // app, its button must stay visible to be animated out
        if (this._windows.has(metaWindow) && monitorIndex === this._monitorIndex)
            this._updateVisibility();
    }

    _updateVisibility() {
        const windows = this.getWindowList();

        // the button's content depends on the same windows
        this._setSingleWindow(windows.length === 1 ? windows[0] : null);

        // keep the button of a stopping app visible until it is animated out
        if (this.animatingOut || this.app.get_windows().every(w => w.skip_taskbar))
            return;

        this.visible = windows.length > 0;
    }

    _setSingleWindow(window) {
        if (this._singleWindow === window)
            return;

        this._singleWindow = window;

        this._button.child?.destroy();
        this._button.child = this._createTitleActor();
        this.label_actor = this._button.child.label_actor;
    }

    _isFocused() {
        return Shell.WindowTracker.get_default().focus_app === this.app;
    }

    _updateIconGeometry() {
        const rect = this._getIconGeometry();

        const windows = this.app.get_windows();
        windows.forEach(w => w.set_icon_geometry(rect));
    }

    getWindowList() {
        return this.app.get_windows().filter(win => this._isWindowVisible(win));
    }

    _createTitleActor() {
        return this._singleWindow
            ? new WindowTitle(this._singleWindow)
            : new AppTitle(this.app);
    }

    _onClicked(actor, button) {
        const menuWasOpen = this._menu.isOpen;
        if (menuWasOpen)
            this._menu.close();

        const contextMenuWasOpen = this._contextMenu.isOpen;
        if (contextMenuWasOpen)
            this._contextMenu.close();

        if (!button || button === 1) {
            if (menuWasOpen)
                return;

            const windows = this.getWindowList();
            if (windows.length === 1) {
                if (contextMenuWasOpen)
                    return;
                this._minimizeOrActivateWindow(windows[0]);
            } else if (windows.length > 1) {
                this._menu.removeAll();

                for (const window of windows) {
                    const item = new PopupMenu.PopupBaseMenuItem();
                    item.add_child(new WindowTitle(window));
                    item._window = window;
                    this._menu.addMenuItem(item);
                }
                this._menu.open();
            }
        } else {
            if (contextMenuWasOpen)
                return;
            this._contextMenu.open();
        }
    }

    _canOpenPopupMenu() {
        return !this._menu.isOpen;
    }

    _onMenuActivate(menu, child) {
        // the window may have been closed while the menu was open
        if (this.app.get_windows().includes(child._window))
            child._window.activate(global.get_current_time());
    }

    _destroyMenu() {
        this._menu.destroy();
        this._menu = null;
    }
}

class WindowList extends St.Widget {
    static {
        GObject.registerClass(this);
    }

    constructor(perMonitor, monitor, extension) {
        super({
            name: 'panel',
            style_class: 'bottom-panel solid',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this.connect('destroy', this._onDestroy.bind(this));

        this._perMonitor = perMonitor;
        this._monitor = monitor;

        const box = new St.BoxLayout({ x_expand: true, y_expand: true });
        this.add_child(box);

        this._windowList = new St.BoxLayout({
            style_class: 'window-list',
            reactive: true,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this._windowList);

        const scrollController = new Clutter.ScrollController({
            flags: Clutter.ScrollControllerFlags.DISCRETE |
                Clutter.ScrollControllerFlags.SCROLL_VERTICAL,
        });
        scrollController.connect('scroll', this._onScroll.bind(this));
        this._windowList.add_action(scrollController);

        this._indicatorsBox = new St.BoxLayout({ x_align: Clutter.ActorAlign.END });
        box.add_child(this._indicatorsBox);

        this._workspaceIndicator = new BottomWorkspaceIndicator(extension);
        this._indicatorsBox.add_child(this._workspaceIndicator.container);

        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        this._mutterSettings.connectObject(
            'changed::workspaces-only-on-primary',
            () => this._updateWorkspaceIndicatorVisibility(),
            'changed::dynamic-workspaces',
            () => this._updateWorkspaceIndicatorVisibility(),
            this);

        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._workspaceIndicator.connectObject('menu-set',
            () => this._onWorkspaceMenuSet(), this);
        this._onWorkspaceMenuSet();

        const inOverview = Main.overview.visible ||
            (Main.layoutManager._startingUp && Main.sessionMode.hasOverview);

        const overviewChromeOptions = {
            affectsStruts: true,
        };
        const chromeOptions = {
            ...overviewChromeOptions,
            trackFullscreen: true,
        };
        Main.layoutManager.addChrome(this, inOverview
            ? overviewChromeOptions
            : chromeOptions);

        this._stackAbove(Main.layoutManager.panelBox);
        Main.ctrlAltTabManager.addGroup(this, 'Window List', 'start-here-symbolic');

        this.visible = !inOverview;

        this.width = this._monitor.width;
        this.connect('notify::height', () => {
            this._updatePosition();
            this._updateKeyboardAnchor();
        });
        this._updatePosition();

        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connectObject('app-state-changed',
            this._onAppStateChanged.bind(this), this);

        // Hack: OSK gesture is tied to visibility, piggy-back on that
        Main.keyboard._bottomDragGesture.connectObject('notify::enabled',
            action => {
                const keyboardVisible = !action.enabled;
                this._stackAbove(keyboardVisible
                    ? Main.layoutManager.keyboardBox
                    : Main.layoutManager.panelBox);
                this._updateKeyboardAnchor();
            }, this);

        const workspaceManager = global.workspace_manager;

        workspaceManager.connectObject('notify::n-workspaces',
            () => this._updateWorkspaceIndicatorVisibility(), this);
        this._updateWorkspaceIndicatorVisibility();

        global.window_manager.connectObject('switch-workspace',
            () => this._checkGrouping(), this);

        Main.overview.connectObject(
            'showing', () => {
                this._retrackChrome(overviewChromeOptions);
                this._slideOut();
                this._updateKeyboardAnchor();
            },
            'hiding', () => {
                this._slideIn();
            },
            'hidden', () => {
                this._retrackChrome(chromeOptions);
                this._updateKeyboardAnchor();
            }, this);

        global.display.connectObject('in-fullscreen-changed', () => {
            this._updateKeyboardAnchor();
        }, this);

        this._windowSignals = new Map();
        global.display.connectObject(
            'window-created', (dsp, win) => this._addWindow(win, true), this);

        Main.xdndHandler.connectObject(
            'drag-begin', () => this._monitorXdndDrag(),
            'drag-end', () => this._stopMonitoringXdndDrag(),
            this);

        this._xdndDragMonitor = {
            dragMotion: this._onXdndDragMotion.bind(this),
        };

        this._itemDragMonitor = {
            dragMotion: this._onItemDragMotion.bind(this),
            dragDrop: this._onItemDragDrop.bind(this),
        };

        this._dndTimeoutId = 0;
        this._dndWindow = null;

        this._dragPlaceholder = null;
        this._dragPlaceholderPos = -1;
        this._lastPlaceholderUpdate = 0;

        this._delegate = this;

        this._settings = extension.getSettings();
        this._settings.connectObject(
            'changed::grouping-mode', () => this._groupingModeChanged(),
            'changed::display-all-workspaces', () => this._checkGrouping(),
            this);
        this._grouped = undefined;
        this._groupingModeChanged();
    }

    get_transformed_position() {
        // HACK: Remove translation we use for animations
        //       to keep struts stable
        const [x, y] = super.get_transformed_position();
        return [x, y - this.translation_y];
    }

    _stackAbove(actor) {
        // neither the keyboard box nor the panel box (moved to the
        // overview by Panel Free) are direct children of the UI group
        const sibling = _getUiGroupChild(actor);
        if (sibling)
            Main.uiGroup.set_child_above_sibling(this, sibling);
    }

    _onScroll(_controller, _sprite, _source, _dx, dy) {
        if (dy === 0)
            return;

        const buttons = this._windowList.get_children()
            .filter(c => c instanceof BaseButton && c.visible && !c.animatingOut);
        if (buttons.length === 0)
            return;

        const active = buttons.findIndex(c => c.active);
        const newActive = Math.clamp(active + Math.sign(dy), 0, buttons.length - 1);
        buttons[newActive].activate();
    }

    _onWorkspaceMenuSet() {
        if (this._workspaceIndicator.menu)
            this._menuManager.addMenu(this._workspaceIndicator.menu);
    }

    _updatePosition() {
        this.set_position(
            this._monitor.x,
            this._monitor.y + this._monitor.height - this.height);
    }

    _retrackChrome(options) {
        Main.layoutManager.untrackChrome(this);
        Main.layoutManager.trackChrome(this, options);
    }

    _slideIn() {
        this.visible = !this._monitor.inFullscreen;
        this.ease({
            translation_y: 0,
            duration: SLIDE_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _slideOut() {
        this.visible = !this._monitor.inFullscreen;
        this.ease({
            translation_y: this.height,
            duration: SLIDE_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.hide(),
        });
    }

    _updateWorkspaceIndicatorVisibility() {
        const workspaceManager = global.workspace_manager;
        const hasWorkspaces = this._mutterSettings.get_boolean('dynamic-workspaces') ||
            workspaceManager.n_workspaces > 1;
        const workspacesOnMonitor = this._monitor === Main.layoutManager.primaryMonitor ||
            !this._mutterSettings.get_boolean('workspaces-only-on-primary');

        this._workspaceIndicator.visible = hasWorkspaces && workspacesOnMonitor;
    }

    _getPreferredUngroupedWindowListWidth() {
        if (this._windowList.get_n_children() === 0)
            return this._windowList.get_preferred_width(-1)[1];

        const children = this._windowList.get_children();
        const [, childWidth] = children[0].get_preferred_width(-1);
        const { spacing } = this._windowList.layout_manager;

        // a null workspace makes the tab list include all workspaces
        const workspace = this._settings.get_boolean('display-all-workspaces')
            ? null : global.workspace_manager.get_active_workspace();
        let windows = global.display.get_tab_list(Meta.TabList.NORMAL, workspace);
        if (this._perMonitor)
            windows = windows.filter(w => w.get_monitor() === this._monitor.index);
        const nWindows = windows.length;
        if (nWindows === 0)
            return this._windowList.get_preferred_width(-1)[1];

        return nWindows * childWidth + (nWindows - 1) * spacing;
    }

    _getMaxWindowListWidth() {
        return this.width - this._indicatorsBox.get_preferred_width(-1)[1];
    }

    _groupingModeChanged() {
        this._groupingMode = this._settings.get_enum('grouping-mode');

        if (this._groupingMode === GroupingMode.AUTO) {
            this._checkGrouping();
        } else {
            this._grouped = this._groupingMode === GroupingMode.ALWAYS;
            this._populateWindowList();
        }
    }

    _checkGrouping() {
        if (this._groupingMode !== GroupingMode.AUTO)
            return;

        const maxWidth = this._getMaxWindowListWidth();
        const natWidth = this._getPreferredUngroupedWindowListWidth();

        const grouped = maxWidth < natWidth;
        if (this._grouped !== grouped) {
            this._grouped = grouped;
            this._populateWindowList();
        }
    }

    _populateWindowList() {
        this._windowList.destroy_all_children();

        const windows = global.get_window_actors()
            .map(actor => actor.metaWindow)
            .sort((w1, w2) => w1.get_stable_sequence() - w2.get_stable_sequence());
        windows.forEach(win => this._trackWindow(win));

        if (!this._grouped) {
            windows.forEach(win => this._addWindow(win, false));
        } else {
            const apps = this._appSystem.get_running().sort((a1, a2) => {
                return _getAppStableSequence(a1) -
                    _getAppStableSequence(a2);
            });
            apps.forEach(app => this._addApp(app, false));
        }

        this._restorePositions();
    }

    _updateKeyboardAnchor() {
        const translationY = Main.overview.visible ? 0 : this.height;
        Main.layoutManager.keyboardBox.translation_y = -translationY;
    }

    _onAppStateChanged(appSys, app) {
        if (!this._grouped)
            return;

        if (app.state === Shell.AppState.RUNNING)
            this._addApp(app, true);
        else if (app.state === Shell.AppState.STOPPED)
            this._removeApp(app);
    }

    _addButton(button, animate) {
        this._settings.bind('display-all-workspaces',
            button, 'ignore-workspace', Gio.SettingsBindFlags.GET);
        // otherwise the binding lives until the button is finalized
        button.connect('destroy',
            () => Gio.Settings.unbind(button, 'ignore-workspace'));

        button.connect('drag-begin', () => {
            button.ease({
                opacity: 255 * DRAG_OPACITY,
                duration: DRAG_FADE_DURATION,
            });

            this._monitorItemDrag();
        });
        button.connect('drag-end', () => {
            button.ease({
                opacity: 255,
                duration: DRAG_FADE_DURATION,
            });

            this._stopMonitoringItemDrag();
            this._clearDragPlaceholder();
        });

        this._windowList.add_child(button);
        button.show(animate);
    }

    _addApp(app, animate) {
        const children = this._windowList.get_children();
        if (children.some(c => c.app === app && !c.animatingOut))
            return;

        const button = new AppButton(app, this._perMonitor, this._monitor.index);
        this._addButton(button, animate);
    }

    _removeApp(app) {
        const children = this._windowList.get_children();
        const child = children.find(c => c.app === app && !c.animatingOut);
        child?.animateOutAndDestroy();
    }

    _trackWindow(win) {
        if (this._windowSignals.has(win))
            return;

        this._windowSignals.set(
            win, win.connect('unmanaged', () => this._removeWindow(win)));
    }

    _untrackWindow(win) {
        const id = this._windowSignals.get(win);
        if (!id)
            return;

        win.disconnect(id);
        this._windowSignals.delete(win);
    }

    _addWindow(win, animate) {
        // track windows in grouped mode too, closing one may allow ungrouping
        this._trackWindow(win);

        if (!this._grouped)
            this._checkGrouping();

        if (this._grouped)
            return;

        const children = this._windowList.get_children();
        if (children.find(c => c.metaWindow === win))
            return;

        const button = new WindowButton(win, this._perMonitor, this._monitor.index);
        this._addButton(button, animate);
    }

    _removeWindow(win) {
        this._untrackWindow(win);

        if (this._grouped)
            this._checkGrouping();

        if (this._grouped)
            return;

        const children = this._windowList.get_children();
        const child = children.find(c => c.metaWindow === win);
        child?.animateOutAndDestroy();
    }

    _clearDragPlaceholder() {
        this._dragPlaceholder?.animateOutAndDestroy();
        this._dragPlaceholder = null;
        this._dragPlaceholderPos = -1;
    }

    _isOwnButton(actor) {
        return actor instanceof BaseButton &&
            actor.get_parent() === this._windowList;
    }

    handleDragOver(source, _actor, x, _y, _time) {
        if (!this._isOwnButton(source))
            return DND.DragMotionResult.NO_DROP;

        // hidden buttons (other workspaces or monitors) take no space
        const buttons = this._windowList.get_children()
            .filter(c => c instanceof BaseButton && c.visible);
        const buttonPos = buttons.indexOf(source);
        const numButtons = buttons.length;
        const boxWidth = this._windowList.width;

        // Transform to window list coordinates for index calculation
        // (mostly relevant for RTL to discard workspace indicator etc.)
        x -= this._windowList.x;

        const rtl = this.text_direction === Clutter.TextDirection.RTL;
        let pos = rtl
            ? numButtons - Math.round(x * numButtons / boxWidth)
            : Math.round(x * numButtons / boxWidth);

        pos = Math.clamp(pos, 0, numButtons);

        const timeDelta =
            GLib.get_monotonic_time() - this._lastPlaceholderUpdate;

        if (pos !== this._dragPlaceholderPos && timeDelta >= MIN_DRAG_UPDATE_INTERVAL) {
            this._clearDragPlaceholder();
            this._dragPlaceholderPos = pos;

            this._lastPlaceholderUpdate = GLib.get_monotonic_time();

            // Don't allow positioning before or after self
            if (pos === buttonPos || pos === buttonPos + 1)
                return DND.DragMotionResult.CONTINUE;

            this._dragPlaceholder = new DragPlaceholderItem();
            const sibling = buttons[pos];
            if (sibling)
                this._windowList.insert_child_below(this._dragPlaceholder, sibling);
            else
                this._windowList.insert_child_above(this._dragPlaceholder, buttons.at(-1) ?? null);
            this._dragPlaceholder.show(true);
        }

        return this._dragPlaceholder
            ? DND.DragMotionResult.MOVE_DROP
            : DND.DragMotionResult.NO_DROP;
    }

    acceptDrop(source, _actor, _x, _y, _time) {
        if (!this._isOwnButton(source))
            return false;

        // move the button to where the placeholder is (if any)
        if (this._dragPlaceholder) {
            this._windowList.set_child_below_sibling(source, this._dragPlaceholder);
            this._savePositions();
        }

        this._clearDragPlaceholder();

        return true;
    }

    _getPositionStateKey() {
        return `${SAVED_POSITIONS_KEY}:${this._monitor.index}`;
    }

    _savePositions() {
        const buttons = this._windowList.get_children()
            .filter(b => b instanceof BaseButton);
        global.set_runtime_state(this._getPositionStateKey(),
            new GLib.Variant('as', buttons.map(b => b.id)));
    }

    _restorePositions() {
        const positions = global.get_runtime_state('as',
            this._getPositionStateKey())?.deepUnpack() ?? [];
        if (positions.length === 0)
            return;

        // saved positions may refer to buttons that no longer exist: sort
        // the buttons by saved position, unknown ones last in current order
        const ranks = new Map(positions.map((id, rank) => [id, rank]));
        const getRank = button => ranks.get(button.id) ?? positions.length;

        this._windowList.get_children()
            .filter(c => c instanceof BaseButton)
            .sort((b1, b2) => getRank(b1) - getRank(b2))
            .forEach((button, index) => this._windowList.set_child_at_index(button, index));
    }

    _monitorItemDrag() {
        DND.addDragMonitor(this._itemDragMonitor);
    }

    _stopMonitoringItemDrag() {
        DND.removeDragMonitor(this._itemDragMonitor);
    }

    _onItemDragMotion(dragEvent) {
        const { source, targetActor, dragActor, x, y } = dragEvent;

        // drag monitors get stage coordinates, handleDragOver() local ones
        const [, localX, localY] = this.transform_stage_point(x, y);

        const hasTarget = this._windowList.contains(targetActor);
        const isNear = localX >= 0 && localX <= this.width &&
            Math.abs(localY) < DRAG_PROXIMITY_THRESHOLD;

        if (hasTarget || isNear)
            return this.handleDragOver(source, dragActor, localX, localY);

        this._clearDragPlaceholder();
        return DND.DragMotionResult.CONTINUE;
    }

    _onItemDragDrop(dropEvent) {
        if (!this._dragPlaceholder)
            return DND.DragDropResult.CONTINUE;

        const { source } = dropEvent.dropActor;
        this.acceptDrop(source);
        dropEvent.dropActor.destroy();
        // HACK: SUCCESS would make more sense, but results in gnome-shell
        // skipping all drag-end code
        return DND.DragDropResult.CONTINUE;
    }

    _monitorXdndDrag() {
        DND.addDragMonitor(this._xdndDragMonitor);
    }

    _stopMonitoringXdndDrag() {
        DND.removeDragMonitor(this._xdndDragMonitor);
        this._removeActivateTimeout();
    }

    _onXdndDragMotion(dragEvent) {
        if (Main.overview.visible ||
            !this.contains(dragEvent.targetActor)) {
            this._removeActivateTimeout();
            return DND.DragMotionResult.CONTINUE;
        }

        // the picked actor is the reactive St.Button, not the window button
        const hoveredWindow = dragEvent.targetActor._delegate?.metaWindow;
        if (!hoveredWindow) {
            this._removeActivateTimeout();
            return DND.DragMotionResult.CONTINUE;
        }

        if (this._dndWindow === hoveredWindow)
            return DND.DragMotionResult.CONTINUE;

        this._removeActivateTimeout();

        this._dndWindow = hoveredWindow;
        this._dndTimeoutId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT,
            DND_ACTIVATE_TIMEOUT, this._activateWindow.bind(this));

        return DND.DragMotionResult.CONTINUE;
    }

    _removeActivateTimeout() {
        if (this._dndTimeoutId)
            GLib.source_remove(this._dndTimeoutId);
        this._dndTimeoutId = 0;
        this._dndWindow = null;
    }

    _activateWindow() {
        const [x, y] = global.get_pointer();
        const pickedActor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);

        if (this._dndWindow && this.contains(pickedActor))
            this._dndWindow.activate(global.get_current_time());
        this._dndWindow = null;
        this._dndTimeoutId = 0;
    }

    _onDestroy() {
        this._workspaceIndicator.destroy();

        Main.ctrlAltTabManager.removeGroup(this);

        this._windowSignals.forEach((id, win) => win.disconnect(id));
        this._windowSignals.clear();

        this._stopMonitoringItemDrag();
        this._stopMonitoringXdndDrag();

        Main.layoutManager.keyboardBox.translation_y = 0;

        const windows = global.get_window_actors();
        for (let i = 0; i < windows.length; i++)
            windows[i].metaWindow.set_icon_geometry(null);
    }
}

class BottomWorkspaceIndicator extends WorkspaceIndicator {
    static {
        GObject.registerClass(this);
    }

    setMenu(menu) {
        super.setMenu(menu);

        if (!menu)
            return;

        this.menu.actor.updateArrowSide(St.Side.BOTTOM);
        this.menu.actor.remove_style_class_name('panel-menu');
    }
}

// Window lists on the primary monitor, or on all monitors
class WindowLists {
    constructor(extension) {
        this._extension = extension;
        this._windowLists = [];

        this._settings = extension.getSettings();
        this._settings.connectObject('changed::show-on-all-monitors',
            () => this._buildWindowLists(), this);

        Main.layoutManager.connectObject('monitors-changed',
            () => this._buildWindowLists(), this);

        this._buildWindowLists();
    }

    _buildWindowLists() {
        this._destroyWindowLists();

        const showOnAllMonitors = this._settings.get_boolean('show-on-all-monitors');

        Main.layoutManager.monitors.forEach(monitor => {
            if (showOnAllMonitors || monitor === Main.layoutManager.primaryMonitor)
                this._windowLists.push(new WindowList(showOnAllMonitors, monitor, this._extension));
        });
    }

    _destroyWindowLists() {
        this._windowLists.forEach(windowList => {
            windowList.hide();
            windowList.destroy();
        });
        this._windowLists = [];
    }

    destroy() {
        Main.layoutManager.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;

        this._destroyWindowLists();
    }
}

// Each feature is enabled by a settings key. Features are objects with a
// destroy() method that track their signals with themselves, never with
// the extension, so that they can be enabled and disabled independently.
const FEATURES = [
    ['enable-window-list', WindowLists],
    ['enable-bottom-overview', BottomOverview],
    ['enable-panel-free', PanelFree],
    ['enable-light-style', LightStyle],
];

export default class WindowListExtension extends Extension {
    enable() {
        this._features = new Map();

        this._settings = this.getSettings();
        for (const [key, Feature] of FEATURES) {
            this._settings.connectObject(`changed::${key}`,
                () => this._syncFeature(key, Feature), this);
            this._syncFeature(key, Feature);
        }
    }

    _syncFeature(key, Feature) {
        const enabled = this._settings.get_boolean(key);
        if (enabled === this._features.has(key))
            return;

        if (enabled) {
            this._features.set(key, new Feature(this));
        } else {
            this._features.get(key).destroy();
            this._features.delete(key);
        }
    }

    disable() {
        this._settings.disconnectObject(this);
        this._settings = null;

        // in reverse order of creation
        [...this._features.values()].reverse().forEach(feature => feature.destroy());
        this._features = null;
    }
}
