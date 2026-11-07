// Light Style
// part of Window List NG, based on the GNOME official extension by @fmuellner
// @fthx 2026
//
// SPDX-FileCopyrightText: 2023 Florian Müllner <fmuellner@gnome.org>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Switch default to light style: the dark style chosen in the system
// settings still wins, see Main.getStyleVariant()
export class LightStyle {
    constructor() {
        this._savedColorScheme = Main.sessionMode.colorScheme;
        this._updateColorScheme('prefer-light');
    }

    _updateColorScheme(scheme) {
        Main.sessionMode.colorScheme = scheme;
        // reloads the shell and extension stylesheets
        St.Settings.get().notify('color-scheme');
    }

    destroy() {
        this._updateColorScheme(this._savedColorScheme);
    }
}
