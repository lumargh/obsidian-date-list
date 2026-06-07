import { App, PluginSettingTab, Setting, moment } from 'obsidian';
import DateListPlugin from './main';

export interface DateListSettings {
	defaultFormat: string;
	defaultWikiLinks: boolean;
	defaultAlias: string;
	defaultPrefix: string;
	defaultPostfix: string;
	suggestTrigger: string;
	listSuggestTrigger: string;
	firstDayOfWeek: number;
}

export const DEFAULT_SETTINGS: DateListSettings = {
	defaultFormat: 'YYYY-MM-DD',
	defaultWikiLinks: false,
	defaultAlias: '',
	defaultPrefix: '',
	defaultPostfix: '',
	suggestTrigger: '@',
	listSuggestTrigger: '@@',
	firstDayOfWeek: 1,
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
			.setName('Inline date trigger')
			.setDesc("Character(s) that activate the date autocomplete while typing. Don't use \"/\" if you have the slash commands plugin enabled.")
			.addText((text) =>
				text
					.setPlaceholder('@')
					.setValue(this.plugin.settings.suggestTrigger)
					.onChange(async (value) => {
						if (value.length === 0) return;
						this.plugin.settings.suggestTrigger = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Inline date list trigger')
			.setDesc("Character(s) that activate the date list autocomplete while typing.")
			.addText((text) =>
				text
					.setPlaceholder('@@')
					.setValue(this.plugin.settings.listSuggestTrigger)
					.onChange(async (value) => {
						if (value.length === 0) return;
						this.plugin.settings.listSuggestTrigger = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('First day of week')
			.setDesc("Determines the bounds of the 'this week' and 'next week' ranges.")
			.addDropdown(dropdown => dropdown
				.addOptions({ '0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday', '4': 'Thursday', '5': 'Friday', '6': 'Saturday' })
				.setValue(String(this.plugin.settings.firstDayOfWeek))
				.onChange(async (value) => {
					this.plugin.settings.firstDayOfWeek = Number(value);
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Date format')
			.setDesc('Format string shown as the first option in the format picker. To add normal text, wrap the word in [ ].')
			.addText((text) => {
				text.inputEl.parentElement!.addClass('date-list-settings-has-preview');
				const fmtPreview = text.inputEl.parentElement!.createEl('div', {
					cls: 'date-list-settings-preview',
					text: this.plugin.settings.defaultFormat ? moment().format(this.plugin.settings.defaultFormat) : '',
				});
				fmtPreview.toggle(!!this.plugin.settings.defaultFormat);
				text
					.setValue(this.plugin.settings.defaultFormat)
					.onChange(async (value) => {
						this.plugin.settings.defaultFormat = value;
						fmtPreview.toggle(!!value);
						fmtPreview.setText(value ? moment().format(value) : '');
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Wikilinks')
			.setDesc('Wrap dates in [[ ]].')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.defaultWikiLinks)
					.onChange(async (value) => {
						this.plugin.settings.defaultWikiLinks = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Alias format')
			.setDesc('Format for the wikilink alias.')
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
			.setName('Prefix')
			.setDesc('Text to prepend to each date by default.')
			.addText((text) =>
				text
					.setPlaceholder('E.g. - or - [ ]')
					.setValue(this.plugin.settings.defaultPrefix)
					.onChange(async (value) => {
						this.plugin.settings.defaultPrefix = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Postfix')
			.setDesc('Text to append after each date by default.')
			.addText((text) =>
				text
					.setPlaceholder('E.g. - or —')
					.setValue(this.plugin.settings.defaultPostfix)
					.onChange(async (value) => {
						this.plugin.settings.defaultPostfix = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Date guide').setHeading();

		const tokenGroups: { label: string; tokens: [string, string, string][] }[] = [
			{
				label: 'Year',
				tokens: [
					['YYYY', 'Full year', '2026'],
					['YY', 'Short year', '26'],
				],
			},
			{
				label: 'Month',
				tokens: [
					['MMMM', 'Full name', 'January'],
					['MMM', 'Short name', 'Jan'],
					['MM', 'Padded number', '01'],
					['M', 'Number', '1'],
				],
			},
			{
				label: 'Day',
				tokens: [
					['DD', 'Padded', '01'],
					['D', 'Number', '1'],
					['Do', 'Ordinal', '1st'],
				],
			},
			{
				label: 'Weekday',
				tokens: [
					['dddd', 'Full name', 'Monday'],
					['ddd', 'Short name', 'Mon'],
					['dd', 'Min name', 'Mo'],
					['d', 'Number (0=Sun)', '1'],
					['E', 'Number (1=Mon)', '1'],
				],
			},
			{
				label: 'Literal',
				tokens: [
					['[text]', 'Literal text', 'text'],
				],
			},
		];

		const grid = containerEl.createEl('div', { cls: 'date-list-settings-token-grid' });
		for (const group of tokenGroups) {
			const wrap = grid.createEl('div', { cls: 'date-list-settings-token-group' });
			wrap.createEl('div', { cls: 'date-list-settings-token-label', text: group.label });
			const table = wrap.createEl('table', { cls: 'date-list-settings-tokens' });
			const tbody = table.createEl('tbody');
			for (const [token, desc, example] of group.tokens) {
				const tr = tbody.createEl('tr');
				tr.createEl('td').createEl('code', { text: token });
				tr.createEl('td', { text: desc });
				tr.createEl('td', { text: example });
			}
		}
	}
}
