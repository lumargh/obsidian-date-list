import { App, PluginSettingTab, Setting } from 'obsidian';
import DateListPlugin from './main';

export interface MyPluginSettings {
	defaultFormat: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	defaultFormat: 'YYYY-MM-DD',
};

export class SampleSettingTab extends PluginSettingTab {
	plugin: DateListPlugin;

	constructor(app: App, plugin: DateListPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Default date format')
			.setDesc('Moment.js format string used when "Custom…" is selected (e.g. MMMM Do, YYYY)')
			.addText((text) =>
				text
					.setPlaceholder('YYYY-MM-DD')
					.setValue(this.plugin.settings.defaultFormat)
					.onChange(async (value) => {
						this.plugin.settings.defaultFormat = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
