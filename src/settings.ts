import { App, PluginSettingTab, Setting, moment as _m } from 'obsidian';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moment = _m as any;
import DateListPlugin from './main';

export interface LastUsed {
	quantity: string;
	stepUnit: string;
	fmt: string;
	wikiLinks: boolean;
	alias: string;
	prefix: string;
	postfix: string;
}

export const DEFAULT_LAST_USED: LastUsed = {
	quantity: '1',
	stepUnit: 'days',
	fmt: 'YYYY-MM-DD',
	wikiLinks: false,
	alias: '',
	prefix: '',
	postfix: '',
};

export interface DateListSettings {
	defaultFormat: string;
	defaultQuantity: string;
	defaultStepUnit: string;
	defaultWikiLinks: boolean;
	defaultAlias: string;
	defaultPrefix: string;
	defaultPostfix: string;
}

export const DEFAULT_SETTINGS: DateListSettings = {
	defaultFormat: 'YYYY-MM-DD',
	defaultQuantity: '1',
	defaultStepUnit: 'days',
	defaultWikiLinks: false,
	defaultAlias: '',
	defaultPrefix: '',
	defaultPostfix: '',
};

export class DateListSettingTab extends PluginSettingTab {
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
			.setDesc('Format string shown as the first option in the format picker (e.g. MMMM Do, YYYY)')
			.addText((text) => {
				text.inputEl.parentElement!.addClass('date-list-settings-has-preview');
				const fmtPreview = text.inputEl.parentElement!.createEl('div', {
					cls: 'date-list-settings-preview',
					text: this.plugin.settings.defaultFormat ? moment().format(this.plugin.settings.defaultFormat) : '',
				});
				fmtPreview.toggle(!!this.plugin.settings.defaultFormat);
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					.setPlaceholder('YYYY-MM-DD')
					.setValue(this.plugin.settings.defaultFormat)
					.onChange(async (value) => {
						this.plugin.settings.defaultFormat = value;
						fmtPreview.toggle(!!value);
						fmtPreview.setText(value ? moment().format(value) : '');
						await this.plugin.saveSettings();
					});
			});

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
			.setDesc('Format for the wiki link alias (e.g. ddd, MMM D). Leave blank for no alias.')
			.addText((text) => {
				text.inputEl.parentElement!.addClass('date-list-settings-has-preview');
				const aliasPreview = text.inputEl.parentElement!.createEl('div', {
					cls: 'date-list-settings-preview',
					text: this.plugin.settings.defaultAlias ? moment().format(this.plugin.settings.defaultAlias) : '',
				});
				text
					.setPlaceholder('None')
					.setValue(this.plugin.settings.defaultAlias)
					.onChange(async (value) => {
						this.plugin.settings.defaultAlias = value;
						aliasPreview.setText(value ? moment().format(value) : '');
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Default prefix')
			.setDesc('Text to prepend to each date by default (e.g. - or - [ ] )')
			.addText((text) =>
				text
					.setPlaceholder('None')
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
					.setPlaceholder('None')
					.setValue(this.plugin.settings.defaultPostfix)
					.onChange(async (value) => {
						this.plugin.settings.defaultPostfix = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
