// Bottom Overview
// part of Window List NG
// @fthx 2026

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PRESSURE_THRESHOLD = 150; // px
const HOT_EDGE_PRESSURE_TIMEOUT = 1000; // ms

// Overview appears when pushing the pointer against the bottom of any monitor
export class BottomOverview {
    constructor() {
        this._initPressureBarrier();

        Main.layoutManager.connectObject('monitors-changed', () => this._setHotEdges(), this);

        // monitors are only set up once the startup is complete
        if (Main.layoutManager._startingUp)
            Main.layoutManager.connectObject('startup-complete', () => this._setHotEdges(), this);
        else
            this._setHotEdges();
    }

    _initPressureBarrier() {
        this._pressureBarrier = new Layout.PressureBarrier(
            PRESSURE_THRESHOLD,
            HOT_EDGE_PRESSURE_TIMEOUT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);

        this._pressureBarrier.connectObject('trigger', () => this._toggleOverview(), this);
    }

    _toggleOverview() {
        // barriers are on every monitor: check the one with the pointer,
        // and like the hot corner, always allow closing the overview
        if (Main.layoutManager.currentMonitor?.inFullscreen && !Main.overview.visible)
            return;

        if (Main.overview.shouldToggleByCornerOrButton()
            && (Main.overview._inXdndDrag
                || !(global.get_pointer()[2] & Clutter.ModifierType.BUTTON1_MASK)))
            Main.overview.toggle();
    }

    _setHotEdges() {
        this._destroyBarriers();

        if (!this._barriersTimeout)
            this._barriersTimeout = GLib.idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._setBarriers();

                this._barriersTimeout = null;
            });
    }

    _setBarriers() {
        if (!this._pressureBarrier)
            return;

        const monitors = Main.layoutManager.monitors;
        if (!monitors)
            return;

        for (const monitor of monitors) {
            const { width, height, x, y } = monitor;

            const hasBottom = !monitors.some(other =>
                other !== monitor
                && other.y >= y + height
                && other.x < x + width
                && other.x + other.width > x);

            if (hasBottom) {
                const barrier = new Meta.Barrier({
                    backend: global.backend,
                    x1: x,
                    y1: y + height,
                    x2: x + width,
                    y2: y + height,
                    directions: Meta.BarrierDirection.NEGATIVE_Y
                });

                this._pressureBarrier.addBarrier(barrier);
            }
        }
    }

    _destroyBarriers() {
        if (!this._pressureBarrier)
            return;

        while (this._pressureBarrier._barriers.length > 0) {
            const barrier = this._pressureBarrier._barriers[0];
            this._pressureBarrier.removeBarrier(barrier);
            barrier.destroy();
        }
    }

    _destroyPressureBarrier() {
        this._pressureBarrier?.disconnectObject(this);
        this._pressureBarrier?.destroy();
        this._pressureBarrier = null;
    }

    destroy() {
        if (this._barriersTimeout)
            GLib.source_remove(this._barriersTimeout);
        this._barriersTimeout = null;

        Main.layoutManager.disconnectObject(this);

        this._destroyBarriers();
        this._destroyPressureBarrier();
    }
}
