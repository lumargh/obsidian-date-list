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
import { DEFAULT_SETTINGS, DateListSettings, DateListSettingTab } from './settings';

// _m is typed as a non-callable namespace; build a callable type from its own members.
type MomentInstance = ReturnType<typeof _m.utc>;
type MomentFactory = { (): MomentInstance; (inp: string, fmt?: string | string[]): MomentInstance } & typeof _m;
const moment = _m as unknown as MomentFactory;
type DurationUnit = 'days' | 'weeks' | 'months';

// Sentinel returned by any modal dismissed without a confirmed selection.
const BACK = Symbol('back');

// -------------------------------------------------------------------
// Wizard state — snapshot passed into every modal for live preview
// -------------------------------------------------------------------
interface WizardState {
	startMoment: MomentInstance;
	nStr: string;
	stepUnit: string;
	fmt: string;
	wikiLinks: boolean;
	alias: string;
	prefix: string;
	postfix: string;
}

function buildDates(state: WizardState): string[] {
	const n = parseInt(state.nStr);
	if (isNaN(n) || n < 1) return [];
	const end = state.startMoment.clone().add(n, state.stepUnit as DurationUnit);
	const all: string[] = [];
	const current = state.startMoment.clone();
	while (current.isBefore(end) && all.length < 1000) {
		const formatted = current.format(state.fmt);
		const linked = state.wikiLinks
			? state.alias
				? `[[${formatted}|${current.format(state.alias)}]]`
				: `[[${formatted}]]`
			: formatted;
		all.push(`${state.prefix}${linked}${state.postfix}`);
		current.add(1, 'days');
	}
	return all;
}

function renderPreview(el: HTMLElement, state: WizardState): void {
	el.empty();
	const all = buildDates(state);
	if (all.length === 0) {
		el.createEl('span', { text: '—', cls: 'date-list-preview-empty' });
		return;
	}
	if (all.length <= 5) {
		all.forEach((line) => el.createEl('div', { text: line, cls: 'date-list-preview-line' }));
		return;
	}
	all.slice(0, 3).forEach((line) => el.createEl('div', { text: line, cls: 'date-list-preview-line' }));
	el.createEl('div', { text: `  ⋮  (${all.length - 4} hidden)`, cls: 'date-list-preview-ellipsis' });
	el.createEl('div', { text: all[all.length - 1]!, cls: 'date-list-preview-line' });
	el.createEl('hr', { cls: 'date-list-preview-hr' });
	el.createEl('div', { text: `${all.length} dates total`, cls: 'date-list-preview-total' });
}

// -------------------------------------------------------------------
// Date parser
// -------------------------------------------------------------------
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

// -------------------------------------------------------------------
// Modal helpers
// -------------------------------------------------------------------
function prompt(
	app: App,
	title: string,
	instructions: string,
	defaultValue: string,
	state: WizardState,
	previewMapper: (value: string, state: WizardState) => WizardState,
): Promise<string | typeof BACK> {
	return new Promise((resolve) =>
		new PromptModal(app, title, instructions, defaultValue, state, previewMapper, resolve).open(),
	);
}

function suggest<T>(
	app: App,
	title: string,
	instructions: string,
	options: string[],
	values: T[],
	state: WizardState,
	previewMapper: (value: T, state: WizardState) => WizardState,
): Promise<T | typeof BACK> {
	return new Promise((resolve) =>
		new SuggesterModal(app, title, instructions, options, values, state, previewMapper, resolve).open(),
	);
}

// -------------------------------------------------------------------
// Plugin
// -------------------------------------------------------------------
export default class DateListPlugin extends Plugin {
	settings!: DateListSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new DateListSettingTab(this.app, this));

		this.addCommand({
			id: 'insert',
			name: 'Insert',
			editorCallback: async (editor: Editor, _ctx: MarkdownView | MarkdownFileInfo) => {
				let step = 0;
				let startInput = this.settings.defaultStartDate;
				let nStr = this.settings.defaultQuantity;
				let stepUnit = this.settings.defaultStepUnit;
				let fmt = this.settings.defaultFormat;
				let wikiLinks = this.settings.defaultWikiLinks;
				let alias = this.settings.defaultAlias;
				let prefix = this.settings.defaultPrefix;
				let postfix = this.settings.defaultPostfix;

				const parsed = parseDate(startInput);
				let startMoment = parsed.isValid() ? parsed : moment();

				// Snapshot of current state for passing to modals
				const state = (): WizardState => ({
					startMoment: startMoment.clone(),
					nStr, stepUnit, fmt, wikiLinks, alias, prefix, postfix,
				});

				outer: while (true) {
					if (step === 0) {
						const r = await prompt(
							this.app,
							'Start Date',
							'Natural language or date math: today, +7, next monday, June 1, 2026-01-15…',
							startInput,
							state(),
							(value, s) => {
								const m = parseDate(value);
								return m.isValid() ? { ...s, startMoment: m } : s;
							},
						);
						if (r === BACK) return;
						startInput = r;
						const m = parseDate(startInput);
						if (!m.isValid()) { new Notice('Invalid date.'); continue; }
						startMoment = m;
						step++;

					} else if (step === 1) {
						const r = await prompt(
							this.app,
							'Quantity',
							'How many days / weeks / months should the list span? Select the unit next.',
							nStr,
							state(),
							(value, s) => {
								const n = parseInt(value);
								return n > 0 ? { ...s, nStr: value } : s;
							},
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
							state(),
							(value, s) => ({ ...s, stepUnit: value }),
						);
						if (r === BACK) { step--; continue; }
						stepUnit = r;
						step++;

					} else if (step === 3) {
						const r = await suggest<string>(
							this.app,
							'Date Format',
							'Choose how each date appears. Previews use your start date.',
							[
								`${startMoment.format(this.settings.defaultFormat)} (default)`,
								startMoment.format('YYYY-MM-DD'),
								startMoment.format('ddd, MMM D'),
								'Custom…',
							],
							['default', 'iso', 'short', 'custom'],
							state(),
							(value, s) => {
								if (value === 'default') return { ...s, fmt: this.settings.defaultFormat };
								if (value === 'iso')     return { ...s, fmt: 'YYYY-MM-DD' };
								if (value === 'short')   return { ...s, fmt: 'ddd, MMM D' };
								return s; // custom — can't preview until typed
							},
						);
						if (r === BACK) { step--; continue; }
						if (r === 'default') { fmt = this.settings.defaultFormat; step++; }
						else if (r === 'iso')   { fmt = 'YYYY-MM-DD'; step++; }
						else if (r === 'short') { fmt = 'ddd, MMM D'; step++; }
						else {
							const c = await prompt(
								this.app,
								'Custom Format',
								'Enter a Moment.js format string, e.g. MMMM Do, YYYY',
								'',
								state(),
								(value, s) => ({ ...s, fmt: value }),
							);
							if (c === BACK) continue;
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
							state(),
							(value, s) => ({ ...s, wikiLinks: value, alias: value ? s.alias : '' }),
						);
						if (r === BACK) { step--; continue; }
						wikiLinks = r;
						if (!wikiLinks) { alias = ''; step++; continue; }

						// Alias sub-step (only when wiki links enabled)
						const aliasR = await suggest<string>(
							this.app,
							'Alias',
							'Add a display alias to each link, e.g. [[2026-01-15|Thu, Jan 15]]. Leave as "None" to skip.',
							[
								'None',
								startMoment.format('ddd, MMM D'),
								startMoment.format('MMMM Do'),
								'Custom…',
							],
							['none', 'short', 'long', 'custom'],
							{ ...state(), wikiLinks: true },
							(value, s) => {
								if (value === 'none')  return { ...s, alias: '' };
								if (value === 'short') return { ...s, alias: 'ddd, MMM D' };
								if (value === 'long')  return { ...s, alias: 'MMMM Do' };
								return s;
							},
						);
						if (aliasR === BACK) continue; // back → re-show wiki links picker
						if (aliasR === 'none')       { alias = ''; }
						else if (aliasR === 'short') { alias = 'ddd, MMM D'; }
						else if (aliasR === 'long')  { alias = 'MMMM Do'; }
						else {
							const c = await prompt(
								this.app,
								'Custom Alias',
								'Enter a Moment.js format string for the alias, e.g. ddd, MMM D',
								'',
								{ ...state(), wikiLinks: true },
								(value, s) => ({ ...s, alias: value }),
							);
							if (c === BACK) continue; // back → re-show alias picker
							alias = c;
						}
						step++;

					} else if (step === 5) {
						const r = await suggest<string>(
							this.app,
							'Prefix',
							'Optionally prefix each date with a list marker.',
							['None', '- ', '- [ ] ', 'Custom…'],
							['none', 'dash', 'task', 'custom'],
							state(),
							(value, s) => {
								const map: Record<string, string> = { none: '', dash: '- ', task: '- [ ] ', custom: s.prefix };
								return { ...s, prefix: map[value] ?? s.prefix };
							},
						);
						if (r === BACK) { step--; continue; }
						if (r === 'none')       { prefix = ''; step++; }
						else if (r === 'dash')  { prefix = '- '; step++; }
						else if (r === 'task')  { prefix = '- [ ] '; step++; }
						else {
							const c = await prompt(
								this.app,
								'Custom Prefix',
								'Enter a prefix to prepend to each date, e.g. * or >',
								'',
								state(),
								(value, s) => ({ ...s, prefix: value }),
							);
							if (c === BACK) continue;
							prefix = c;
							step++;
						}

					} else if (step === 6) {
						const r = await suggest<string>(
							this.app,
							'Postfix',
							'Optionally append text after each date.',
							['None', ' - ', ' — ', 'Custom…'],
							['none', 'dash', 'emdash', 'custom'],
							state(),
							(value, s) => {
								const map: Record<string, string> = { none: '', dash: ' - ', emdash: ' — ', custom: s.postfix };
								return { ...s, postfix: map[value] ?? s.postfix };
							},
						);
						if (r === BACK) { step--; continue; }
						if (r === 'none')         { postfix = ''; }
						else if (r === 'dash')    { postfix = ' - '; }
						else if (r === 'emdash')  { postfix = ' — '; }
						else {
							const c = await prompt(
								this.app,
								'Custom Postfix',
								'Enter text to append after each date, e.g. ::',
								'',
								state(),
								(value, s) => ({ ...s, postfix: value }),
							);
							if (c === BACK) continue;
							postfix = c;
						}
						break outer;
					}
				}

				this.settings.defaultStartDate = startInput;
				this.settings.defaultQuantity = nStr;
				this.settings.defaultStepUnit = stepUnit;
				this.settings.defaultFormat = fmt;
				this.settings.defaultWikiLinks = wikiLinks;
				this.settings.defaultAlias = alias;
				this.settings.defaultPrefix = prefix;
				this.settings.defaultPostfix = postfix;
				await this.saveSettings();
				editor.replaceSelection(buildDates(state()).join('\n'));
			},
		});
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<DateListSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// -------------------------------------------------------------------
// PromptModal
// -------------------------------------------------------------------
class PromptModal extends Modal {
	private title: string;
	private instructions: string;
	private defaultValue: string;
	private state: WizardState;
	private previewMapper: (value: string, state: WizardState) => WizardState;
	private resolve: (value: string | typeof BACK) => void;
	private confirmed = false;

	constructor(
		app: App,
		title: string,
		instructions: string,
		defaultValue: string,
		state: WizardState,
		previewMapper: (value: string, state: WizardState) => WizardState,
		resolve: (value: string | typeof BACK) => void,
	) {
		super(app);
		this.title = title;
		this.instructions = instructions;
		this.defaultValue = defaultValue;
		this.state = state;
		this.previewMapper = previewMapper;
		this.resolve = resolve;
	}

	onOpen() {
		this.modalEl.addClass('date-list-modal');
		const { contentEl } = this;

		this.titleEl.empty();
		const backBtn = this.titleEl.createEl('button', { text: '←', cls: 'date-list-back-btn' });
		backBtn.addEventListener('click', () => this.close());
		this.titleEl.createSpan({ text: this.title });

		const body = contentEl.createEl('div', { cls: 'date-list-modal-body' });
		const left = body.createEl('div', { cls: 'date-list-modal-left' });
		const right = body.createEl('div', { cls: 'date-list-modal-right' });

		left.createEl('p', { text: this.instructions, cls: 'date-list-instructions' });
		const input = left.createEl('input', { type: 'text', cls: 'date-list-input' });
		input.value = this.defaultValue;

		const submit = () => {
			this.confirmed = true;
			this.resolve(input.value);
			this.close();
		};

		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
		left.createEl('button', { text: 'OK' }).addEventListener('click', submit);

		right.createEl('div', { text: 'Preview', cls: 'date-list-preview-label' });
		const previewEl = right.createEl('div', { cls: 'date-list-preview-sidebar' });
		renderPreview(previewEl, this.previewMapper(this.defaultValue, this.state));

		input.addEventListener('input', () => {
			renderPreview(previewEl, this.previewMapper(input.value, this.state));
		});

		window.setTimeout(() => { input.focus(); input.select(); }, 50);
	}

	onClose() {
		if (!this.confirmed) this.resolve(BACK);
		this.contentEl.empty();
	}
}

// -------------------------------------------------------------------
// SuggesterModal
// -------------------------------------------------------------------
class SuggesterModal<T> extends Modal {
	private title: string;
	private instructions: string;
	private options: string[];
	private values: T[];
	private state: WizardState;
	private previewMapper: (value: T, state: WizardState) => WizardState;
	private resolve: (value: T | typeof BACK) => void;
	private confirmed = false;

	constructor(
		app: App,
		title: string,
		instructions: string,
		options: string[],
		values: T[],
		state: WizardState,
		previewMapper: (value: T, state: WizardState) => WizardState,
		resolve: (value: T | typeof BACK) => void,
	) {
		super(app);
		this.title = title;
		this.instructions = instructions;
		this.options = options;
		this.values = values;
		this.state = state;
		this.previewMapper = previewMapper;
		this.resolve = resolve;
	}

	onOpen() {
		this.modalEl.addClass('date-list-modal');
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

		const body = contentEl.createEl('div', { cls: 'date-list-modal-body' });
		const left = body.createEl('div', { cls: 'date-list-modal-left' });
		const right = body.createEl('div', { cls: 'date-list-modal-right' });

		left.createEl('p', { text: this.instructions, cls: 'date-list-instructions' });

		right.createEl('div', { text: 'Preview', cls: 'date-list-preview-label' });
		const previewEl = right.createEl('div', { cls: 'date-list-preview-sidebar' });
		renderPreview(previewEl, this.state);

		const btns = this.options.map((opt, i) => {
			const btn = left.createEl('button', { cls: 'date-list-option-btn' });
			btn.createEl('span', { text: String(i + 1), cls: 'date-list-option-num' });
			btn.createEl('span', { text: opt, cls: 'date-list-option-text' });
			btn.addEventListener('click', () => select(i));
			btn.addEventListener('mouseenter', () => renderPreview(previewEl, this.previewMapper(this.values[i]!, this.state)));
			btn.addEventListener('mouseleave', () => renderPreview(previewEl, this.state));
			btn.addEventListener('focus',      () => renderPreview(previewEl, this.previewMapper(this.values[i]!, this.state)));
			btn.addEventListener('blur',       () => renderPreview(previewEl, this.state));
			return btn;
		});

		this.containerEl.addEventListener('keydown', (e: KeyboardEvent) => {
			const focused = btns.findIndex((b) => b === activeDocument.activeElement);
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

		window.setTimeout(() => btns[0]?.focus(), 50);
	}

	onClose() {
		if (!this.confirmed) this.resolve(BACK);
		this.contentEl.empty();
	}
}

