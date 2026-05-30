import {
	App,
	Editor,
	MarkdownView,
	MarkdownFileInfo,
	Modal,
	Notice,
	Plugin,
	moment as _m,
} from 'obsidian';
import { DEFAULT_SETTINGS, MyPluginSettings, SampleSettingTab } from './settings';

// Obsidian exposes moment globally; the type export lacks call signatures, so we cast
const moment = _m as unknown as typeof import('moment');

// Sentinel returned by any modal that is dismissed without a confirmed selection.
// Escape, the ← button, and clicking outside all resolve to BACK.
const BACK = Symbol('back');

function parseDate(input: string) {
	const s = input.trim().toLowerCase();
	if (s === 'today') return moment();
	if (s === 'tomorrow') return moment().add(1, 'days');
	if (s === 'yesterday') return moment().subtract(1, 'days');

	const relative = s.match(/^([+-]\d+)$/);
	if (relative) return moment().add(parseInt(relative[1]!), 'days');

	const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
	const nextDay = s.match(/^next (\w+)$/);
	if (nextDay) {
		const idx = weekdays.indexOf(nextDay[1]!);
		if (idx !== -1) {
			const d = moment().day(idx);
			return d.isSameOrBefore(moment(), 'day') ? d.add(7, 'days') : d;
		}
	}

	return moment(input, [
		'YYYY-MM-DD',
		'MMMM D, YYYY', 'MMMM Do, YYYY', 'MMMM D YYYY', 'MMMM Do YYYY',
		'MMM D, YYYY',  'MMM Do, YYYY',  'MMM D YYYY',  'MMM Do YYYY',
		'MMMM D',       'MMMM Do',
		'MMM D',        'MMM Do',
		'M/D/YYYY',     'M/D',
	]);
}

function prompt(app: App, title: string, instructions: string, defaultValue = ''): Promise<string | typeof BACK> {
	return new Promise((resolve) => new PromptModal(app, title, instructions, defaultValue, resolve).open());
}

function suggest<T>(app: App, title: string, instructions: string, options: string[], values: T[]): Promise<T | typeof BACK> {
	return new Promise((resolve) => new SuggesterModal(app, title, instructions, options, values, resolve).open());
}

export default class DateListPlugin extends Plugin {
	settings!: MyPluginSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.addCommand({
			id: 'insert-date-list',
			name: 'Insert date list',
			editorCallback: async (editor: Editor, _ctx: MarkdownView | MarkdownFileInfo) => {
				let step = 0;
				let startInput = moment().format('YYYY-MM-DD');
				let nStr = '1';
				let stepUnit = 'days';
				let fmt = this.settings.defaultFormat;
				let wikiLinks = true;
				let prefix = '';
				let startMoment = moment();

				outer: while (true) {
					if (step === 0) {
						const r = await prompt(
							this.app,
							'Start Date',
							'Add a start date: use natural language, or do math (for example Jan 1, tomorrow, next week, +7, -3, etc.)',
							startInput,
						);
						if (r === BACK) return; // first step — back cancels
						startInput = r;
						const m = parseDate(startInput);
						if (!m.isValid()) { new Notice('Invalid date.'); continue; }
						startMoment = m;
						step++;

					} else if (step === 1) {
						const r = await prompt(
							this.app,
							'Quantity',
							'How many days, weeks, or months should the list span? Select the unit on the next screen.',
							nStr,
						);
						if (r === BACK) { step--; continue; }
						const n = parseInt(r);
						if (isNaN(n) || n < 1) { new Notice('Invalid number.'); continue; }
						nStr = r;
						step++;

					} else if (step === 2) {
						const r = await suggest<string>(
							this.app,
							'Time Unit',
							'Select the unit that defines the total span of the list.',
							['Days', 'Weeks', 'Months'],
							['days', 'weeks', 'months'],
						);
						if (r === BACK) { step--; continue; }
						stepUnit = r;
						step++;

					} else if (step === 3) {
						const r = await suggest(
							this.app,
							'Date Format',
							'Choose how each date will appear. Previews use your start date.',
							[
								startMoment.format(this.settings.defaultFormat),
								startMoment.format('YYYY-MM-DD'),
								startMoment.format('ddd, MMM D'),
								'Custom…',
							],
							['default', 'iso', 'short', 'custom'],
						);
						if (r === BACK) { step--; continue; }
						if (r === 'default') {
							fmt = this.settings.defaultFormat;
							step++;
						} else if (r === 'iso') {
							fmt = 'YYYY-MM-DD';
							step++;
						} else if (r === 'short') {
							fmt = 'ddd, MMM D';
							step++;
						} else {
							const c = await prompt(
								this.app,
								'Custom Format',
								'Enter a Moment.js format string, e.g. MMMM Do, YYYY',
								'',
							);
							if (c === BACK) continue; // back from custom → re-show format picker
							fmt = c;
							step++;
						}

					} else if (step === 4) {
						const r = await suggest<boolean>(
							this.app,
							'Wiki Links',
							'Wrap each date in [[ ]] to create Obsidian note links, or output as plain text.',
							['Wrap in [[wikilinks]]', 'Plain text'],
							[true, false],
						);
						if (r === BACK) { step--; continue; }
						wikiLinks = r;
						step++;

					} else if (step === 5) {
						const r = await suggest(
							this.app,
							'Prefix',
							'Optionally prefix each date with a list marker.',
							['None', '- ', '- [ ] ', 'Custom…'],
							['none', 'dash', 'task', 'custom'],
						);
						if (r === BACK) { step--; continue; }
						if (r === 'none') {
							prefix = '';
							break outer;
						} else if (r === 'dash') {
							prefix = '- ';
							break outer;
						} else if (r === 'task') {
							prefix = '- [ ] ';
							break outer;
						} else {
							const c = await prompt(
								this.app,
								'Custom Prefix',
								'Enter a prefix to prepend to each date, e.g. * or >',
								'',
							);
							if (c === BACK) continue; // back → re-show prefix picker
							prefix = c;
							break outer;
						}
					}
				}

				const n = parseInt(nStr);
				const end = startMoment.clone().add(n, stepUnit as moment.unitOfTime.DurationConstructor);
				const dates: string[] = [];
				const current = startMoment.clone();
				while (current.isBefore(end)) {
					const formatted = current.format(fmt);
					dates.push(`${prefix}${wikiLinks ? `[[${formatted}]]` : formatted}`);
					current.add(1, 'days');
				}

				editor.replaceSelection(dates.join('\n'));
			},
		});
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MyPluginSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class PromptModal extends Modal {
	private title: string;
	private instructions: string;
	private defaultValue: string;
	private resolve: (value: string | typeof BACK) => void;
	private confirmed = false;

	constructor(app: App, title: string, instructions: string, defaultValue: string, resolve: (value: string | typeof BACK) => void) {
		super(app);
		this.title = title;
		this.instructions = instructions;
		this.defaultValue = defaultValue;
		this.resolve = resolve;
	}

	onOpen() {
		const { contentEl } = this;

		this.titleEl.empty();
		const backBtn = this.titleEl.createEl('button', { text: '←', cls: 'date-list-back-btn' });
		backBtn.addEventListener('click', () => this.close());
		this.titleEl.createSpan({ text: this.title });

		contentEl.createEl('p', { text: this.instructions, cls: 'date-list-instructions' });
		const input = contentEl.createEl('input', { type: 'text', cls: 'date-list-input' });
		input.value = this.defaultValue;

		const submit = () => {
			this.confirmed = true;
			this.resolve(input.value);
			this.close();
		};

		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
		contentEl.createEl('button', { text: 'OK' }).addEventListener('click', submit);
		setTimeout(() => { input.focus(); input.select(); }, 50);
	}

	onClose() {
		if (!this.confirmed) this.resolve(BACK);
		this.contentEl.empty();
	}
}

class SuggesterModal<T> extends Modal {
	private title: string;
	private instructions: string;
	private options: string[];
	private values: T[];
	private resolve: (value: T | typeof BACK) => void;
	private confirmed = false;

	constructor(app: App, title: string, instructions: string, options: string[], values: T[], resolve: (value: T | typeof BACK) => void) {
		super(app);
		this.title = title;
		this.instructions = instructions;
		this.options = options;
		this.values = values;
		this.resolve = resolve;
	}

	onOpen() {
		const { contentEl } = this;

		this.titleEl.empty();
		const backBtn = this.titleEl.createEl('button', { text: '←', cls: 'date-list-back-btn' });
		backBtn.addEventListener('click', () => this.close());
		this.titleEl.createSpan({ text: this.title });

		const select = (i: number) => {
			this.confirmed = true;
			this.resolve(this.values[i]!);
			this.close();
		};

		contentEl.createEl('p', { text: this.instructions, cls: 'date-list-instructions' });

		const btns = this.options.map((opt, i) => {
			const btn = contentEl.createEl('button', { cls: 'date-list-option-btn' });
			btn.createEl('span', { text: String(i + 1), cls: 'date-list-option-num' });
			btn.createEl('span', { text: opt, cls: 'date-list-option-text' });
			btn.addEventListener('click', () => select(i));
			return btn;
		});

		this.containerEl.addEventListener('keydown', (e: KeyboardEvent) => {
			const focused = btns.findIndex((b) => b === document.activeElement);
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				btns[(focused + 1) % btns.length]?.focus();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				btns[(focused - 1 + btns.length) % btns.length]?.focus();
			} else if (e.key === 'Enter' && focused >= 0) {
				e.preventDefault();
				select(focused);
			} else {
				const idx = parseInt(e.key) - 1;
				if (!isNaN(idx) && idx >= 0 && idx < this.options.length) {
					e.preventDefault();
					select(idx);
				}
			}
		});

		setTimeout(() => btns[0]?.focus(), 50);
	}

	onClose() {
		if (!this.confirmed) this.resolve(BACK);
		this.contentEl.empty();
	}
}
