// Panel Free
// part of Window List NG
// @fthx 2026

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ANIMATION_TIME } from 'resource:///org/gnome/shell/ui/overview.js';

// Hide top panel except in overview
export class PanelFree {
    constructor() {
        const { panelBox, overviewGroup } = Main.layoutManager;

        // leave the panel alone if something else already moved it,
        // e.g. the standalone Panel Free extension
        this._active = panelBox.get_parent() === Main.uiGroup;
        if (!this._active)
            return;

        Main.layoutManager.removeChrome(panelBox);
        panelBox.show();
        overviewGroup.add_child(panelBox);

        // scopes the stylesheet rules to this feature
        panelBox.add_style_class_name('panel-free');
        Main.overview.searchEntry.get_parent().add_style_class_name('panel-free-search-entry');

        Main.overview.connectObject(
            'showing', () => this._fadePanel(255),
            'hiding', () => this._fadePanel(0),
            this);
    }

    _fadePanel(opacity) {
        Main.layoutManager.panelBox.ease({
            opacity,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    destroy() {
        if (!this._active)
            return;

        const { panelBox, overviewGroup } = Main.layoutManager;

        Main.overview.disconnectObject(this);

        panelBox.remove_all_transitions();
        panelBox.opacity = 255;

        overviewGroup.remove_child(panelBox);
        Main.layoutManager.addChrome(panelBox, { affectsStruts: true, trackFullscreen: true });

        panelBox.remove_style_class_name('panel-free');
        Main.overview.searchEntry.get_parent().remove_style_class_name('panel-free-search-entry');
    }
}
