import { App, PluginSettingTab, Setting } from 'obsidian';
import DateListPlugin from './main';

export interface MyPluginSettings {
	defaultStartDate: string;
	defaultFormat: string;
	defaultQuantity: string;
	defaultStepUnit: string;
	defaultWikiLinks: boolean;
	defaultAlias: string;
	defaultPrefix: string;
	defaultPostfix: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	defaultStartDate: 'today',
	defaultFormat: 'YYYY-MM-DD',
	defaultQuantity: '1',
	defaultStepUnit: 'days',
	defaultWikiLinks: false,
	defaultAlias: '',
	defaultPrefix: '',
	defaultPostfix: '',
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
			.setName('Default start date')
			.setDesc('Pre-filled start date. Supports the same natural language as the wizard (e.g. today, +7, next monday)')
			.addText((text) =>
				text
					.setPlaceholder('today')
					.setValue(this.plugin.settings.defaultStartDate)
					.onChange(async (value) => {
						this.plugin.settings.defaultStartDate = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Default date format')
			.setDesc('Moment.js format string shown as the first option in the format picker (e.g. MMMM Do, YYYY)')
			.addText((text) =>
				text
					.setPlaceholder('YYYY-MM-DD')
					.setValue(this.plugin.settings.defaultFormat)
					.onChange(async (value) => {
						this.plugin.settings.defaultFormat = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Default quantity')
			.setDesc('Pre-filled value for the quantity step')
			.addText((text) =>
				text
					.setPlaceholder('1')
					.setValue(this.plugin.settings.defaultQuantity)
					.onChange(async (value) => {
						this.plugin.settings.defaultQuantity = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Default time unit')
			.setDesc('Pre-selected unit for the time unit step')
			.addDropdown((drop) =>
				drop
					.addOption('days', 'Days')
					.addOption('weeks', 'Weeks')
					.addOption('months', 'Months')
					.setValue(this.plugin.settings.defaultStepUnit)
					.onChange(async (value) => {
						this.plugin.settings.defaultStepUnit = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Default wiki links')
			.setDesc('Wrap dates in [[ ]] by default')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.defaultWikiLinks)
					.onChange(async (value) => {
						this.plugin.settings.defaultWikiLinks = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Default alias format')
			.setDesc('Moment.js format for the wiki link alias, e.g. ddd, MMM D → [[2026-01-15|Thu, Jan 15]]. Leave blank for no alias.')
			.addText((text) =>
				text
					.setPlaceholder('none')
					.setValue(this.plugin.settings.defaultAlias)
					.onChange(async (value) => {
						this.plugin.settings.defaultAlias = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Default prefix')
			.setDesc('Text to prepend to each date by default (e.g. - or - [ ] )')
			.addText((text) =>
				text
					.setPlaceholder('none')
					.setValue(this.plugin.settings.defaultPrefix)
					.onChange(async (value) => {
						this.plugin.settings.defaultPrefix = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Default postfix')
			.setDesc('Text to append after each date by default (e.g. - or —)')
			.addText((text) =>
				text
					.setPlaceholder('none')
					.setValue(this.plugin.settings.defaultPostfix)
					.onChange(async (value) => {
						this.plugin.settings.defaultPostfix = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
