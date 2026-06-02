import { App, PluginSettingTab, Setting, moment as _m } from 'obsidian';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moment = _m as any;
import DateListPlugin from './main';

export interface DateListSettings {
	defaultFormat: string;
	defaultWikiLinks: boolean;
	defaultAlias: string;
	defaultPrefix: string;
	defaultPostfix: string;
	suggestTrigger: string;
}

export const DEFAULT_SETTINGS: DateListSettings = {
	defaultFormat: 'YYYY-MM-DD',
	defaultWikiLinks: false,
	defaultAlias: '',
	defaultPrefix: '',
	defaultPostfix: '',
	suggestTrigger: '@',
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

		containerEl.createEl('h2', { text: 'Settings' });

		new Setting(containerEl)
			.setName('Inline date trigger')
			.setDesc("Character(s) that activate the date autocomplete while typing. Don't use \"/\" if you have the Slash Commands plugin enabled.")
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
			.setName('Default date format')
			.setDesc('Format string shown as the first option in the format picker. To add normal text, wrap the word in [ ]')
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
			.setDesc('Format for the wiki link alias. Leave blank for no alias.')
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

		containerEl.createEl('h2', { text: 'Date Guide' });

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
