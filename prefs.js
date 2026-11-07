// Window List NG
// based on the GNOME official extension by @fmuellner
// @fthx 2026
//
// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2014 Sylvain Pasche <sylvain.pasche@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { WorkspacesPage } from './workspacePrefs.js';

class FeaturesPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    constructor(settings) {
        super({
            title: 'Features',
            icon_name: 'application-x-addon-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            description: 'Choose the enabled parts of the extension.',
        });
        this.add(group);

        const features = [{
            key: 'enable-window-list',
            title: 'Window List',
            subtitle: 'Show a window list at the bottom of the screen',
        }, {
            key: 'enable-bottom-overview',
            title: 'Bottom Overview',
            subtitle: 'Toggle the overview by pushing the pointer against the bottom of a monitor',
        }, {
            key: 'enable-panel-free',
            title: 'Panel Free',
            subtitle: 'Hide the top panel except in the overview',
        }, {
            key: 'enable-light-style',
            title: 'Light Style',
            subtitle: 'Use the light style for the shell when the system style is Default',
        }];

        for (const { key, title, subtitle } of features) {
            const row = new Adw.SwitchRow({ title, subtitle });
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }
    }
}

class WindowListPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    constructor(settings) {
        super({
            title: 'Window List',
            icon_name: 'focus-windows-symbolic',
        });

        this._actionGroup = new Gio.SimpleActionGroup();
        this.insert_action_group('window-list', this._actionGroup);

        this._settings = settings;
        this._actionGroup.add_action(
            this._settings.create_action('grouping-mode'));
        this._actionGroup.add_action(
            this._settings.create_action('show-on-all-monitors'));
        this._actionGroup.add_action(
            this._settings.create_action('display-all-workspaces'));

        const groupingGroup = new Adw.PreferencesGroup({
            title: 'Window Grouping',
        });
        this.add(groupingGroup);

        const modes = [
            { mode: 'never', title: 'Never group windows' },
            { mode: 'auto', title: 'Group windows when space is limited' },
            { mode: 'always', title: 'Always group windows' },
        ];

        for (const { mode, title } of modes) {
            const check = new Gtk.CheckButton({
                action_name: 'window-list.grouping-mode',
                action_target: new GLib.Variant('s', mode),
            });
            const row = new Adw.ActionRow({
                activatable_widget: check,
                title,
            });
            row.add_prefix(check);
            groupingGroup.add(row);
        }

        const miscGroup = new Adw.PreferencesGroup({
            title: 'Visibility',
        });
        this.add(miscGroup);

        let row = new Adw.SwitchRow({
            title: 'Show on all monitors',
            action_name: 'window-list.show-on-all-monitors',
        });
        miscGroup.add(row);

        row = new Adw.SwitchRow({
            title: 'Show windows from all workspaces',
            action_name: 'window-list.display-all-workspaces',
        });
        miscGroup.add(row);

        for (const group of [groupingGroup, miscGroup]) {
            settings.bind('enable-window-list', group, 'sensitive',
                Gio.SettingsBindFlags.GET);
        }
    }
}

export default class WindowListPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.add(new FeaturesPage(settings));
        window.add(new WindowListPage(settings));
        window.add(new WorkspacesPage(settings));
    }
}
