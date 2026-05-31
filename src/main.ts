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
type DurationUnit = 'days' | 'weeks' | 'months' | 'years';

// Sentinel returned by any modal dismissed without a confirmed selection.
const BACK = Symbol('back');

// -------------------------------------------------------------------
// Wizard state — snapshot passed into every modal for live preview
// -------------------------------------------------------------------
interface WizardState {
	startMoment: MomentInstance;
	nStr: string;
	stepUnit: string;
	weekdays: number[] | null; // null = every day; [0..6] filters to those days (0=Sun)
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
		if (!state.weekdays || state.weekdays.includes(current.day())) {
			const formatted = current.format(state.fmt);
			const linked = state.wikiLinks
				? state.alias
					? `[[${formatted}|${current.format(state.alias)}]]`
					: `[[${formatted}]]`
				: formatted;
			all.push(`${state.prefix}${linked}${state.postfix}`);
		}
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
// Duration parser — accepts "2 weeks", "30 days", "3 months", "1 year"
// -------------------------------------------------------------------
function parseDuration(input: string): { n: number; unit: DurationUnit } | null {
	const match = input.trim().match(/^(\d+)\s*(day|days|week|weeks|month|months|year|years)$/i);
	if (!match) return null;
	const n = parseInt(match[1]!);
	if (n < 1) return null;
	const u = match[2]!.toLowerCase();
	const unit: DurationUnit = u.startsWith('y') ? 'years' : u.startsWith('mo') ? 'months' : u.startsWith('w') ? 'weeks' : 'days';
	return { n, unit };
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
	defaultValue?: T,
): Promise<T | typeof BACK> {
	return new Promise((resolve) =>
		new SuggesterModal(app, title, instructions, options, values, state, previewMapper, resolve, defaultValue).open(),
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

		// ---------------------------------------------------------------
		// Configure Date List — settings wizard (no editor needed)
		// ---------------------------------------------------------------
		this.addCommand({
			id: 'configure',
			name: 'Configure Date List',
			callback: async () => {
				let step = 0;

				let fmt      = this.settings.defaultFormat || 'YYYY-MM-DD';
				let wikiLinks = this.settings.defaultWikiLinks;
				let alias    = this.settings.defaultAlias;
				let prefix   = this.settings.defaultPrefix;
				let postfix  = this.settings.defaultPostfix;

				const today = moment();
				const state = (): WizardState => ({
					startMoment: today.clone(),
					nStr: this.settings.defaultQuantity || '1',
					stepUnit: this.settings.defaultStepUnit || 'days',
					weekdays: null,
					fmt,
					wikiLinks,
					alias,
					prefix,
					postfix,
				});

				outer: while (true) {
					// step 0 — default date format
					if (step === 0) {
						const presets: { label: string; value: string; fmt: string }[] = [
							{ label: today.format('YYYY-MM-DD'),      value: 'iso',     fmt: 'YYYY-MM-DD' },
							{ label: today.format('MMMM Do, YYYY'),   value: 'long',    fmt: 'MMMM Do, YYYY' },
							{ label: today.format('ddd, MMM D'),      value: 'short',   fmt: 'ddd, MMM D' },
							{ label: today.format('ddd, MMM D YYYY'), value: 'shortyr', fmt: 'ddd, MMM D YYYY' },
							{ label: today.format('MM/DD/YYYY'),      value: 'us',      fmt: 'MM/DD/YYYY' },
							{ label: today.format('DD/MM/YYYY'),      value: 'eu',      fmt: 'DD/MM/YYYY' },
						].filter(p => p.fmt !== fmt);
						const r = await suggest<string>(
							this.app,
							'Default Date Format',
							'Choose the default format for dates.',
							[`${today.format(fmt)} (current)`, ...presets.map(p => p.label), 'Custom…'],
							['current', ...presets.map(p => p.value), 'custom'],
							state(),
							(value, s) => {
								if (value === 'current') return { ...s, fmt };
								const preset = presets.find(p => p.value === value);
								if (preset) return { ...s, fmt: preset.fmt };
								return s;
							},
						);
						if (r === BACK) return;
						if (r === 'current') { step++; }
						else if (r !== 'custom') { fmt = presets.find(p => p.value === r)!.fmt; step++; }
						else {
							const c = await prompt(this.app, 'Custom Format', 'Enter a Moment.js format string', fmt, state(), (value, s) => ({ ...s, fmt: value }));
							if (c === BACK) continue;
							fmt = c; step++;
						}

					// step 1 — default wiki links
					} else if (step === 1) {
						const r = await suggest<boolean>(
							this.app,
							'Default Wiki Links',
							'Wrap dates in [[ ]] by default?',
							wikiLinks ? ['Yes (current)', 'No'] : ['No (current)', 'Yes'],
							wikiLinks ? [true, false] : [false, true],
							state(),
							(value, s) => ({ ...s, wikiLinks: value, alias: value ? s.alias : '' }),
						);
						if (r === BACK) { step--; continue; }
						wikiLinks = r;
						if (!wikiLinks) { alias = ''; }
						step++;

					// step 2 — default alias (only if wiki links on)
					} else if (step === 2) {
						if (!wikiLinks) { step++; continue; }
						const defaultAliasLabel = alias ? `${today.format(alias)} (current)` : 'None (current)';
						const aliasPresets: { label: string; value: string; fmt: string }[] = [
							{ label: today.format('ddd, MMM D'),    value: 'short',   fmt: 'ddd, MMM D' },
							{ label: today.format('MMMM Do'),       value: 'long',    fmt: 'MMMM Do' },
							{ label: today.format('MMMM D, YYYY'),  value: 'full',    fmt: 'MMMM D, YYYY' },
							{ label: today.format('dddd'),           value: 'weekday', fmt: 'dddd' },
							{ label: today.format('dddd, MMMM Do'), value: 'daylong', fmt: 'dddd, MMMM Do' },
						].filter(p => p.fmt !== alias);
						const aliasR = await suggest<string>(
							this.app,
							'Default Alias',
							'Add a display alias to each link, e.g. [[2026-01-15|Thu, Jan 15]]. Leave as "None" to skip.',
							[defaultAliasLabel, ...aliasPresets.map(p => p.label), 'Custom…'],
							['current', ...aliasPresets.map(p => p.value), 'custom'],
							{ ...state(), wikiLinks: true },
							(value, s) => {
								if (value === 'current') return { ...s, alias };
								const preset = aliasPresets.find(p => p.value === value);
								if (preset) return { ...s, alias: preset.fmt };
								return s;
							},
						);
						if (aliasR === BACK) { step--; continue; }
						if (aliasR !== 'current' && aliasR !== 'custom') {
							alias = aliasPresets.find(p => p.value === aliasR)!.fmt;
						} else if (aliasR === 'custom') {
							const c = await prompt(this.app, 'Custom Alias', 'Enter a Moment.js format string for the alias', alias || 'ddd, MMM D', { ...state(), wikiLinks: true }, (value, s) => ({ ...s, alias: value }));
							if (c === BACK) continue;
							alias = c;
						}
						step++;

					// step 3 — default prefix
					} else if (step === 3) {
						const defaultPrefixLabel = prefix ? `${JSON.stringify(prefix)} (current)` : 'None (current)';
						const prefixPresets: { label: string; value: string; str: string }[] = [
							{ label: 'None',    value: 'none',  str: '' },
							{ label: '- ',     value: 'dash',  str: '- ' },
							{ label: '* ',     value: 'star',  str: '* ' },
							{ label: '+ ',     value: 'plus',  str: '+ ' },
							{ label: '> ',     value: 'quote', str: '> ' },
							{ label: '- [ ] ', value: 'task',  str: '- [ ] ' },
							{ label: '- [x] ', value: 'done',  str: '- [x] ' },
						].filter(p => p.str !== prefix);
						const r = await suggest<string>(
							this.app,
							'Default Prefix',
							'Optionally prefix each date with a list marker.',
							[defaultPrefixLabel, ...prefixPresets.map(p => p.label), 'Custom…'],
							['current', ...prefixPresets.map(p => p.value), 'custom'],
							state(),
							(value, s) => {
								if (value === 'current') return { ...s, prefix };
								const preset = prefixPresets.find(p => p.value === value);
								if (preset) return { ...s, prefix: preset.str };
								return s;
							},
						);
						if (r === BACK) { step = wikiLinks ? 2 : 1; continue; }
						if (r === 'current') { step++; }
						else if (r !== 'custom') { prefix = prefixPresets.find(p => p.value === r)!.str; step++; }
						else {
							const c = await prompt(this.app, 'Custom Prefix', 'Enter a prefix to prepend to each date', '', state(), (value, s) => ({ ...s, prefix: value }));
							if (c === BACK) continue;
							prefix = c; step++;
						}

					// step 4 — default postfix
					} else if (step === 4) {
						const defaultPostfixLabel = postfix ? `${JSON.stringify(postfix)} (current)` : 'None (current)';
						const postfixPresets: { label: string; value: string; str: string }[] = [
							{ label: 'None',  value: 'none',   str: '' },
							{ label: ' - ',  value: 'dash',   str: ' - ' },
							{ label: ' — ',  value: 'emdash', str: ' — ' },
							{ label: ' :: ', value: 'dv',     str: ' :: ' },
							{ label: ':',    value: 'colon',  str: ':' },
							{ label: ' | ',  value: 'pipe',   str: ' | ' },
						].filter(p => p.str !== postfix);
						const r = await suggest<string>(
							this.app,
							'Default Postfix',
							'Optionally append text after each date.',
							[defaultPostfixLabel, ...postfixPresets.map(p => p.label), 'Custom…'],
							['current', ...postfixPresets.map(p => p.value), 'custom'],
							state(),
							(value, s) => {
								if (value === 'current') return { ...s, postfix };
								const preset = postfixPresets.find(p => p.value === value);
								if (preset) return { ...s, postfix: preset.str };
								return s;
							},
						);
						if (r === BACK) { step--; continue; }
						if (r !== 'current' && r !== 'custom') { postfix = postfixPresets.find(p => p.value === r)!.str; }
						else if (r === 'custom') {
							const c = await prompt(this.app, 'Custom Postfix', 'Enter text to append after each date', '', state(), (value, s) => ({ ...s, postfix: value }));
							if (c === BACK) continue;
							postfix = c;
						}
						break outer;
					}
				}

				this.settings.defaultFormat    = fmt;
				this.settings.defaultWikiLinks = wikiLinks;
				this.settings.defaultAlias     = alias;
				this.settings.defaultPrefix    = prefix;
				this.settings.defaultPostfix   = postfix;
				await this.saveSettings();
				new Notice('Default settings saved.');
			},
		});

		// ---------------------------------------------------------------
		// Insert Date List — unified inserter (end-date or duration)
		// ---------------------------------------------------------------
		this.addCommand({
			id: 'date-list',
			name: 'Insert Date List',
			editorCallback: async (editor: Editor, _ctx: MarkdownView | MarkdownFileInfo) => {
				let step = 0;
				let fromPreset = false;
				let method: 'specific-date' | 'duration' = 'specific-date';
				let startInput = moment().format('YYYY-MM-DD');
				let endInput   = '';
				let nStr          = this.settings.defaultQuantity || '1';
				let stepUnit      = this.settings.defaultStepUnit || 'days';
				let durationInput = nStr;
				let fmt        = this.settings.defaultFormat   || 'YYYY-MM-DD';
				let wikiLinks  = this.settings.defaultWikiLinks;
				let alias      = this.settings.defaultAlias;
				let prefix     = this.settings.defaultPrefix;
				let postfix    = this.settings.defaultPostfix;

				const parsedStart = parseDate(startInput);
				let startMoment = parsedStart.isValid() ? parsedStart : moment();
				let endMoment   = startMoment.clone().add(1, 'days');

				const now = moment();
				const rangePresets: { label: string; value: string; start: MomentInstance; end: MomentInstance }[] = [
					{
						label: `This week  (${now.clone().startOf('isoWeek').format('MMM D')} – ${now.clone().endOf('isoWeek').startOf('day').format('MMM D')})`,
						value: 'this-week',
						start: now.clone().startOf('isoWeek'),
						end: now.clone().endOf('isoWeek').startOf('day'),
					},
					{
						label: `Next week  (${now.clone().add(1,'weeks').startOf('isoWeek').format('MMM D')} – ${now.clone().add(1,'weeks').endOf('isoWeek').startOf('day').format('MMM D')})`,
						value: 'next-week',
						start: now.clone().add(1,'weeks').startOf('isoWeek'),
						end: now.clone().add(1,'weeks').endOf('isoWeek').startOf('day'),
					},
					{
						label: `This month  (${now.clone().startOf('month').format('MMM D')} – ${now.clone().endOf('month').startOf('day').format('MMM D')})`,
						value: 'this-month',
						start: now.clone().startOf('month'),
						end: now.clone().endOf('month').startOf('day'),
					},
					{
						label: `Next month  (${now.clone().add(1,'months').startOf('month').format('MMM D')} – ${now.clone().add(1,'months').endOf('month').startOf('day').format('MMM D')})`,
						value: 'next-month',
						start: now.clone().add(1,'months').startOf('month'),
						end: now.clone().add(1,'months').endOf('month').startOf('day'),
					},
					{
						label: `Next 7 days  (${now.format('MMM D')} – ${now.clone().add(6,'days').format('MMM D')})`,
						value: 'next-7',
						start: now.clone(),
						end: now.clone().add(6,'days'),
					},
					{
						label: `Next 30 days  (${now.format('MMM D')} – ${now.clone().add(29,'days').format('MMM D')})`,
						value: 'next-30',
						start: now.clone(),
						end: now.clone().add(29,'days'),
					},
				];

				const state = (): WizardState => {
					if (method === 'specific-date') {
						return {
							startMoment: startMoment.clone(),
							nStr: String(Math.max(1, endMoment.diff(startMoment, 'days') + 1)),
							stepUnit: 'days', weekdays: null,
							fmt, wikiLinks, alias, prefix, postfix,
						};
					}
					return { startMoment: startMoment.clone(), nStr, stepUnit, weekdays: null, fmt, wikiLinks, alias, prefix, postfix };
				};

				outer: while (true) {
					// step 0 — quick presets
					if (step === 0) {
						const r = await suggest<string>(
							this.app,
							'Date Range',
							'Pick a common range, or choose Custom to set your own dates.',
							[...rangePresets.map(p => p.label), 'Custom…'],
							[...rangePresets.map(p => p.value), 'custom'],
							{ ...state(), nStr: '1' },
							(value, s) => {
								const p = rangePresets.find(p => p.value === value);
								if (!p) return { ...s, nStr: '1' };
								return { ...s, startMoment: p.start.clone(), nStr: String(Math.max(1, p.end.diff(p.start, 'days') + 1)), stepUnit: 'days' };
							},
						);
						if (r === BACK) return;
						if (r === 'custom') { fromPreset = false; step++; continue; }
						const p = rangePresets.find(p => p.value === r)!;
						startMoment = p.start.clone();
						endMoment   = p.end.clone();
						method      = 'specific-date';
						fromPreset  = true;
						step = 5;

					// step 1 — start date
					} else if (step === 1) {
						const r = await prompt(
							this.app,
							'Start Date',
							'Natural language or date math (e.g. today, +7, next monday, June 1, 2026-01-15…)',
							startInput,
							{ ...state(), nStr: '1' },
							(value, s) => { const m = parseDate(value); return m.isValid() ? { ...s, startMoment: m } : s; },
						);
						if (r === BACK) { step--; continue; }
						startInput = r;
						const m = parseDate(startInput);
						if (!m.isValid()) { new Notice('Invalid date.'); continue; }
						startMoment = m;
						if (!endMoment.isAfter(startMoment, 'day')) endMoment = startMoment.clone().add(1, 'days');
						step++;

					// step 2 — method: specific date or duration
					} else if (step === 2) {
						const r = await suggest<string>(
							this.app,
							'Date Range Method',
							'How would you like to define the date range?',
							['Specific date', 'Duration'],
							['specific-date', 'duration'],
							{ ...state(), nStr: '1' },
							(value, s) => {
								if (value === 'specific-date') return { ...s, nStr: String(Math.max(1, endMoment.diff(startMoment, 'days') + 1)), stepUnit: 'days' };
								return { ...s, nStr, stepUnit };
							},
						);
						if (r === BACK) { step--; continue; }
						method = r as 'specific-date' | 'duration';
						step++;

					// step 3 — end date (specific-date) or quantity (duration)
					} else if (step === 3) {
						if (method === 'specific-date') {
							const defaultEnd = endInput || startMoment.clone().add(1, 'days').format('YYYY-MM-DD');
							const r = await prompt(
								this.app,
								'End Date',
								'Use natural language or date math (e.g. tomorrow, +7, next monday, June 1, 2026-01-15). Every day from start up to and including this date will be listed.',
								defaultEnd,
								state(),
								(value, s) => {
									const m = parseDate(value);
									if (!m.isValid() || !m.isAfter(startMoment, 'day')) return s;
									return { ...s, nStr: String(m.diff(startMoment, 'days') + 1), stepUnit: 'days' };
								},
							);
							if (r === BACK) { step--; continue; }
							const m = parseDate(r);
							if (!m.isValid()) { new Notice('Invalid date.'); continue; }
							if (!m.isSameOrAfter(startMoment, 'day')) { new Notice('End date must be on or after start date.'); continue; }
							endInput  = r;
							endMoment = m;
						} else {
							const r = await prompt(
								this.app,
								'Duration',
								'Enter a number to pick the unit next (e.g. 7), or type the full duration (e.g. 2 weeks, 30 days, 3 months).',
								durationInput,
								state(),
								(value, s) => {
									const d = parseDuration(value);
									if (d) return { ...s, nStr: String(d.n), stepUnit: d.unit };
									const n = parseInt(value);
									return n > 0 ? { ...s, nStr: value } : s;
								},
							);
							if (r === BACK) { step--; continue; }
							durationInput = r;
							const d = parseDuration(r);
							if (d) { nStr = String(d.n); stepUnit = d.unit; step = 5; continue; }
							const n = parseInt(r);
							if (isNaN(n) || n < 1) { new Notice('Enter a number (e.g. 7) or a duration (e.g. 2 weeks).'); continue; }
							nStr = r;
							step++;
						}

					// step 4 — time unit (duration only)
					} else if (step === 4) {
						if (method === 'specific-date') { step++; continue; }
						const r = await suggest<string>(
							this.app,
							'Time Unit',
							'Select the unit that defines the total span of the list.',
							['Days', 'Weeks', 'Months'],
							['days', 'weeks', 'months'],
							state(),
							(value, s) => ({ ...s, stepUnit: value }),
							stepUnit,
						);
						if (r === BACK) { step--; continue; }
						stepUnit = r;
						step++;

					// step 5 — use defaults or configure
					} else if (step === 5) {
						const mode = await suggest<string>(
							this.app,
							'Format',
							'Use your saved format defaults, or configure how dates are formatted.',
							['Use saved format', 'Configure format…'],
							['defaults', 'configure'],
							state(),
							(_value, s) => s,
						);
						if (mode === BACK) { step = fromPreset ? 0 : (method === 'specific-date' ? 3 : 4); continue; }
						if (mode === 'defaults') break outer;
						step++;

					// step 6 — date format
					} else if (step === 6) {
						const effectiveDefault = this.settings.defaultFormat || 'YYYY-MM-DD';
						const fmtPresets: { label: string; value: string; fmt: string }[] = [
							{ label: startMoment.format('YYYY-MM-DD'),      value: 'iso',     fmt: 'YYYY-MM-DD' },
							{ label: startMoment.format('MMMM Do, YYYY'),   value: 'long',    fmt: 'MMMM Do, YYYY' },
							{ label: startMoment.format('ddd, MMM D'),      value: 'short',   fmt: 'ddd, MMM D' },
							{ label: startMoment.format('ddd, MMM D YYYY'), value: 'shortyr', fmt: 'ddd, MMM D YYYY' },
							{ label: startMoment.format('MM/DD/YYYY'),      value: 'us',      fmt: 'MM/DD/YYYY' },
							{ label: startMoment.format('DD/MM/YYYY'),      value: 'eu',      fmt: 'DD/MM/YYYY' },
						].filter(p => p.fmt !== effectiveDefault);
						const r = await suggest<string>(
							this.app,
							'Date Format',
							'Choose how each date appears. Previews use your start date.',
							[`${startMoment.format(effectiveDefault)} (default)`, ...fmtPresets.map(p => p.label), 'Custom…'],
							['default', ...fmtPresets.map(p => p.value), 'custom'],
							state(),
							(value, s) => {
								if (value === 'default') return { ...s, fmt: effectiveDefault };
								const preset = fmtPresets.find(p => p.value === value);
								if (preset) return { ...s, fmt: preset.fmt };
								return s;
							},
						);
						if (r === BACK) { step--; continue; }
						if (r === 'default') { fmt = effectiveDefault; step++; }
						else if (r !== 'custom') { fmt = fmtPresets.find(p => p.value === r)!.fmt; step++; }
						else {
							const c = await prompt(this.app, 'Custom Format', 'Enter a Moment.js format string', 'MMMM Do, YYYY', state(), (value, s) => ({ ...s, fmt: value }));
							if (c === BACK) continue;
							fmt = c; step++;
						}

					// step 7 — wiki links + alias
					} else if (step === 7) {
						const wikiDefault = this.settings.defaultWikiLinks;
						const r = await suggest<boolean>(
							this.app,
							'Wiki Links',
							'Wrap each date in [[ ]] to create Obsidian note links, or output as plain text.',
							wikiDefault ? ['Wrap in [[wikilinks]] (default)', 'Plain text'] : ['Plain text (default)', 'Wrap in [[wikilinks]]'],
							wikiDefault ? [true, false] : [false, true],
							state(),
							(value, s) => ({ ...s, wikiLinks: value, alias: value ? s.alias : '' }),
						);
						if (r === BACK) { step--; continue; }
						wikiLinks = r;
						if (!wikiLinks) { alias = ''; step++; continue; }

						const defaultAliasLabel = this.settings.defaultAlias ? `${startMoment.format(this.settings.defaultAlias)} (default)` : 'None (default)';
						const aliasPresets: { label: string; value: string; fmt: string }[] = [
							{ label: startMoment.format('ddd, MMM D'),    value: 'short',   fmt: 'ddd, MMM D' },
							{ label: startMoment.format('MMMM Do'),       value: 'long',    fmt: 'MMMM Do' },
							{ label: startMoment.format('MMMM D, YYYY'),  value: 'full',    fmt: 'MMMM D, YYYY' },
							{ label: startMoment.format('dddd'),           value: 'weekday', fmt: 'dddd' },
							{ label: startMoment.format('dddd, MMMM Do'), value: 'daylong', fmt: 'dddd, MMMM Do' },
						].filter(p => p.fmt !== this.settings.defaultAlias);
						const aliasR = await suggest<string>(
							this.app, 'Alias', 'Add a display alias to each link, e.g. [[2026-01-15|Thu, Jan 15]]. Leave as "None" to skip.',
							[defaultAliasLabel, ...aliasPresets.map(p => p.label), 'Custom…'],
							['default', ...aliasPresets.map(p => p.value), 'custom'],
							{ ...state(), wikiLinks: true },
							(value, s) => {
								if (value === 'default') return { ...s, alias: this.settings.defaultAlias };
								const preset = aliasPresets.find(p => p.value === value);
								if (preset) return { ...s, alias: preset.fmt };
								return s;
							},
						);
						if (aliasR === BACK) continue;
						if (aliasR === 'default') { alias = this.settings.defaultAlias; }
						else if (aliasR !== 'custom') { alias = aliasPresets.find(p => p.value === aliasR)!.fmt; }
						else {
							const c = await prompt(this.app, 'Custom Alias', 'Enter a Moment.js format string for the alias, e.g. ddd, MMM D', '', { ...state(), wikiLinks: true }, (value, s) => ({ ...s, alias: value }));
							if (c === BACK) continue;
							alias = c;
						}
						step++;

					// step 8 — prefix
					} else if (step === 8) {
						const defaultPrefixLabel = this.settings.defaultPrefix ? `${JSON.stringify(this.settings.defaultPrefix)} (default)` : 'None (default)';
						const prefixPresets: { label: string; value: string; str: string }[] = [
							{ label: 'None',    value: 'none',  str: '' },
							{ label: '- ',     value: 'dash',  str: '- ' },
							{ label: '* ',     value: 'star',  str: '* ' },
							{ label: '+ ',     value: 'plus',  str: '+ ' },
							{ label: '> ',     value: 'quote', str: '> ' },
							{ label: '- [ ] ', value: 'task',  str: '- [ ] ' },
							{ label: '- [x] ', value: 'done',  str: '- [x] ' },
						].filter(p => p.str !== this.settings.defaultPrefix);
						const r = await suggest<string>(
							this.app, 'Prefix', 'Optionally prefix each date with a list marker.',
							[defaultPrefixLabel, ...prefixPresets.map(p => p.label), 'Custom…'],
							['default', ...prefixPresets.map(p => p.value), 'custom'],
							state(),
							(value, s) => {
								if (value === 'default') return { ...s, prefix: this.settings.defaultPrefix };
								const preset = prefixPresets.find(p => p.value === value);
								if (preset) return { ...s, prefix: preset.str };
								return s;
							},
						);
						if (r === BACK) { step--; continue; }
						if (r === 'default') { prefix = this.settings.defaultPrefix; step++; }
						else if (r !== 'custom') { prefix = prefixPresets.find(p => p.value === r)!.str; step++; }
						else {
							const c = await prompt(this.app, 'Custom Prefix', 'Enter a prefix to prepend to each date', '> ', state(), (value, s) => ({ ...s, prefix: value }));
							if (c === BACK) continue;
							prefix = c; step++;
						}

					// step 9 — postfix
					} else if (step === 9) {
						const defaultPostfixLabel = this.settings.defaultPostfix ? `${JSON.stringify(this.settings.defaultPostfix)} (default)` : 'None (default)';
						const postfixPresets: { label: string; value: string; str: string }[] = [
							{ label: 'None',  value: 'none',   str: '' },
							{ label: ' - ',  value: 'dash',   str: ' - ' },
							{ label: ' — ',  value: 'emdash', str: ' — ' },
							{ label: ' :: ', value: 'dv',     str: ' :: ' },
							{ label: ':',    value: 'colon',  str: ':' },
							{ label: ' | ',  value: 'pipe',   str: ' | ' },
						].filter(p => p.str !== this.settings.defaultPostfix);
						const r = await suggest<string>(
							this.app, 'Postfix', 'Optionally append text after each date.',
							[defaultPostfixLabel, ...postfixPresets.map(p => p.label), 'Custom…'],
							['default', ...postfixPresets.map(p => p.value), 'custom'],
							state(),
							(value, s) => {
								if (value === 'default') return { ...s, postfix: this.settings.defaultPostfix };
								const preset = postfixPresets.find(p => p.value === value);
								if (preset) return { ...s, postfix: preset.str };
								return s;
							},
						);
						if (r === BACK) { step--; continue; }
						if (r === 'default') { postfix = this.settings.defaultPostfix; }
						else if (r !== 'custom') { postfix = postfixPresets.find(p => p.value === r)!.str; }
						else {
							const c = await prompt(this.app, 'Custom Postfix', 'Enter text to append after each date', ':: ', state(), (value, s) => ({ ...s, postfix: value }));
							if (c === BACK) continue;
							postfix = c;
						}
						break outer;
					}
				}

				editor.replaceSelection(buildDates(state()).join('\n'));
			},
		});

		// ---------------------------------------------------------------
		// Filter Dates — recurring day-of-week pattern
		// ---------------------------------------------------------------
		this.addCommand({
			id: 'filter-dates',
			name: 'Filter Dates',
			editorCallback: async (editor: Editor, _ctx: MarkdownView | MarkdownFileInfo) => {
				let step = 0;
				let selectedWeekdays: number[] = [1, 2, 3, 4, 5];
				let rangeMethod: 'between' | 'in-the-next' | 'in-the-past' = 'between';
				let startInput = moment().format('YYYY-MM-DD');
				let endInput   = '';
				let nStr       = '1';
				let stepUnit   = 'days';
				let fmt        = this.settings.defaultFormat   || 'YYYY-MM-DD';
				let wikiLinks  = this.settings.defaultWikiLinks;
				let alias      = this.settings.defaultAlias;
				let prefix     = this.settings.defaultPrefix;
				let postfix    = this.settings.defaultPostfix;

				let startMoment = moment();
				let endMoment   = startMoment.clone().add(1, 'months');

				const state = (): WizardState => {
					if (rangeMethod === 'between') {
						return {
							startMoment: startMoment.clone(),
							nStr: String(Math.max(1, endMoment.diff(startMoment, 'days') + 1)),
							stepUnit: 'days',
							weekdays: selectedWeekdays,
							fmt, wikiLinks, alias, prefix, postfix,
						};
					}
					if (rangeMethod === 'in-the-past') {
						const n = parseInt(nStr) || 1;
						const pastStart = startMoment.clone().subtract(n, stepUnit as DurationUnit);
						return {
							startMoment: pastStart,
							nStr: String(Math.max(1, startMoment.diff(pastStart, 'days') + 1)),
							stepUnit: 'days',
							weekdays: selectedWeekdays,
							fmt, wikiLinks, alias, prefix, postfix,
						};
					}
					return {
						startMoment: startMoment.clone(),
						nStr,
						stepUnit,
						weekdays: selectedWeekdays,
						fmt, wikiLinks, alias, prefix, postfix,
					};
				};

				outer: while (true) {
					// step 0 — day type
					if (step === 0) {
						const dayOptions: { label: string; days: number[] }[] = [
							{ label: 'Weekdays (Mon–Fri)', days: [1, 2, 3, 4, 5] },
							{ label: 'Weekends (Sat–Sun)', days: [6, 0] },
							{ label: 'Monday',    days: [1] },
							{ label: 'Tuesday',   days: [2] },
							{ label: 'Wednesday', days: [3] },
							{ label: 'Thursday',  days: [4] },
							{ label: 'Friday',    days: [5] },
							{ label: 'Saturday',  days: [6] },
							{ label: 'Sunday',    days: [0] },
						];
						const r = await suggest<number[]>(
							this.app,
							'Day of Week',
							'Which days should be included in the list?',
							dayOptions.map(d => d.label),
							dayOptions.map(d => d.days),
							{ ...state(), nStr: '14', stepUnit: 'days' },
							(value, s) => ({ ...s, weekdays: value }),
						);
						if (r === BACK) return;
						selectedWeekdays = r;
						step++;

					// step 1 — range method
					} else if (step === 1) {
						const r = await suggest<string>(
							this.app,
							'Date Range',
							'How would you like to define the date range?',
							['Between…', 'In the next…', 'In the past…'],
							['between', 'in-the-next', 'in-the-past'],
							{ ...state(), nStr: '14', stepUnit: 'days' },
							(value, s) => {
								if (value === 'between') return { ...s, startMoment: startMoment.clone(), nStr: String(Math.max(1, endMoment.diff(startMoment, 'days') + 1)), stepUnit: 'days' };
								if (value === 'in-the-past') {
									const pastStart = startMoment.clone().subtract(14, 'days');
									return { ...s, startMoment: pastStart, nStr: String(startMoment.diff(pastStart, 'days') + 1), stepUnit: 'days' };
								}
								return { ...s, startMoment: startMoment.clone(), nStr, stepUnit };
							},
						);
						if (r === BACK) { step--; continue; }
						rangeMethod = r as 'between' | 'in-the-next' | 'in-the-past';
						step++;

					// step 2 — start date (between) or quantity (in the next)
					} else if (step === 2) {
						if (rangeMethod === 'between') {
							const r = await prompt(
								this.app,
								'Start Date',
								'Natural language or date math (e.g. today, +7, next monday, June 1, 2026-01-15…)',
								startInput,
								{ ...state(), nStr: '1', stepUnit: 'days' },
								(value, s) => { const m = parseDate(value); return m.isValid() ? { ...s, startMoment: m } : s; },
							);
							if (r === BACK) { step--; continue; }
							const m = parseDate(r);
							if (!m.isValid()) { new Notice('Invalid date.'); continue; }
							startInput  = r;
							startMoment = m;
							if (!endMoment.isAfter(startMoment, 'day')) endMoment = startMoment.clone().add(1, 'months');
						} else {
							const r = await prompt(
								this.app,
								'Quantity',
								'How many days / weeks / months / years?',
								nStr,
								state(),
								(value, s) => {
									const n = parseInt(value);
									if (n <= 0) return s;
									if (rangeMethod === 'in-the-past') {
										const ps = startMoment.clone().subtract(n, stepUnit as DurationUnit);
										return { ...s, startMoment: ps, nStr: String(Math.max(1, startMoment.diff(ps, 'days') + 1)), stepUnit: 'days' };
									}
									return { ...s, nStr: value };
								},
							);
							if (r === BACK) { step--; continue; }
							const n = parseInt(r);
							if (isNaN(n) || n < 1) { new Notice('Invalid number.'); continue; }
							nStr = r;
						}
						step++;

					// step 3 — end date (between) or unit (in the next)
					} else if (step === 3) {
						if (rangeMethod === 'between') {
							const defaultEnd = endInput || startMoment.clone().add(1, 'months').format('YYYY-MM-DD');
							const r = await prompt(
								this.app,
								'End Date',
								'Every matching day from start up to and including this date will be listed.',
								defaultEnd,
								state(),
								(value, s) => {
									const m = parseDate(value);
									if (!m.isValid() || !m.isAfter(startMoment, 'day')) return s;
									return { ...s, nStr: String(m.diff(startMoment, 'days') + 1) };
								},
							);
							if (r === BACK) { step--; continue; }
							const m = parseDate(r);
							if (!m.isValid()) { new Notice('Invalid date.'); continue; }
							if (!m.isSameOrAfter(startMoment, 'day')) { new Notice('End date must be on or after start date.'); continue; }
							endInput  = r;
							endMoment = m;
						} else {
							const r = await suggest<string>(
								this.app,
								'Unit',
								'Select the time unit for the quantity above.',
								['Days', 'Weeks', 'Months', 'Years'],
								['days', 'weeks', 'months', 'years'],
								state(),
								(value, s) => {
									if (rangeMethod === 'in-the-past') {
										const n = parseInt(nStr) || 1;
										const ps = startMoment.clone().subtract(n, value as DurationUnit);
										return { ...s, startMoment: ps, nStr: String(Math.max(1, startMoment.diff(ps, 'days') + 1)), stepUnit: 'days' };
									}
									return { ...s, stepUnit: value };
								},
								stepUnit,
							);
							if (r === BACK) { step--; continue; }
							stepUnit = r;
						}
						step++;

					// step 4 — use defaults or configure
					} else if (step === 4) {
						const mode = await suggest<string>(
							this.app,
							'Format',
							'Use your saved format defaults, or configure how dates are formatted.',
							['Use saved format', 'Configure format…'],
							['defaults', 'configure'],
							state(),
							(_value, s) => s,
						);
						if (mode === BACK) { step--; continue; }
						if (mode === 'defaults') break outer;
						step++;

					// step 5 — date format
					} else if (step === 5) {
						const effectiveDefault = this.settings.defaultFormat || 'YYYY-MM-DD';
						const refMoment = rangeMethod === 'between' ? startMoment : moment();
						const presets: { label: string; value: string; fmt: string }[] = [
							{ label: refMoment.format('YYYY-MM-DD'),      value: 'iso',     fmt: 'YYYY-MM-DD' },
							{ label: refMoment.format('MMMM Do, YYYY'),   value: 'long',    fmt: 'MMMM Do, YYYY' },
							{ label: refMoment.format('ddd, MMM D'),      value: 'short',   fmt: 'ddd, MMM D' },
							{ label: refMoment.format('ddd, MMM D YYYY'), value: 'shortyr', fmt: 'ddd, MMM D YYYY' },
							{ label: refMoment.format('MM/DD/YYYY'),      value: 'us',      fmt: 'MM/DD/YYYY' },
							{ label: refMoment.format('DD/MM/YYYY'),      value: 'eu',      fmt: 'DD/MM/YYYY' },
						].filter(p => p.fmt !== effectiveDefault);
						const r = await suggest<string>(
							this.app, 'Date Format', 'Choose how each date appears.',
							[`${refMoment.format(effectiveDefault)} (default)`, ...presets.map(p => p.label), 'Custom…'],
							['default', ...presets.map(p => p.value), 'custom'],
							state(),
							(value, s) => {
								if (value === 'default') return { ...s, fmt: effectiveDefault };
								const preset = presets.find(p => p.value === value);
								if (preset) return { ...s, fmt: preset.fmt };
								return s;
							},
						);
						if (r === BACK) { step--; continue; }
						if (r === 'default') { fmt = effectiveDefault; step++; }
						else if (r !== 'custom') { fmt = presets.find(p => p.value === r)!.fmt; step++; }
						else {
							const c = await prompt(this.app, 'Custom Format', 'Enter a Moment.js format string', 'MMMM Do, YYYY', state(), (value, s) => ({ ...s, fmt: value }));
							if (c === BACK) continue;
							fmt = c; step++;
						}

					// step 6 — wiki links + alias
					} else if (step === 6) {
						const wikiDefault = this.settings.defaultWikiLinks;
						const refMoment = rangeMethod === 'between' ? startMoment : moment();
						const r = await suggest<boolean>(
							this.app, 'Wiki Links', 'Wrap each date in [[ ]] to create Obsidian note links, or output as plain text.',
							wikiDefault ? ['Wrap in [[wikilinks]] (default)', 'Plain text'] : ['Plain text (default)', 'Wrap in [[wikilinks]]'],
							wikiDefault ? [true, false] : [false, true],
							state(),
							(value, s) => ({ ...s, wikiLinks: value, alias: value ? s.alias : '' }),
						);
						if (r === BACK) { step--; continue; }
						wikiLinks = r;
						if (!wikiLinks) { alias = ''; step++; continue; }

						const defaultAliasLabel = this.settings.defaultAlias ? `${refMoment.format(this.settings.defaultAlias)} (default)` : 'None (default)';
						const aliasPresets: { label: string; value: string; fmt: string }[] = [
							{ label: refMoment.format('ddd, MMM D'),    value: 'short',   fmt: 'ddd, MMM D' },
							{ label: refMoment.format('MMMM Do'),       value: 'long',    fmt: 'MMMM Do' },
							{ label: refMoment.format('MMMM D, YYYY'),  value: 'full',    fmt: 'MMMM D, YYYY' },
							{ label: refMoment.format('dddd'),           value: 'weekday', fmt: 'dddd' },
							{ label: refMoment.format('dddd, MMMM Do'), value: 'daylong', fmt: 'dddd, MMMM Do' },
						].filter(p => p.fmt !== this.settings.defaultAlias);
						const aliasR = await suggest<string>(
							this.app, 'Alias', 'Add a display alias to each link.',
							[defaultAliasLabel, ...aliasPresets.map(p => p.label), 'Custom…'],
							['default', ...aliasPresets.map(p => p.value), 'custom'],
							{ ...state(), wikiLinks: true },
							(value, s) => {
								if (value === 'default') return { ...s, alias: this.settings.defaultAlias };
								const preset = aliasPresets.find(p => p.value === value);
								if (preset) return { ...s, alias: preset.fmt };
								return s;
							},
						);
						if (aliasR === BACK) continue;
						if (aliasR === 'default') { alias = this.settings.defaultAlias; }
						else if (aliasR !== 'custom') { alias = aliasPresets.find(p => p.value === aliasR)!.fmt; }
						else {
							const c = await prompt(this.app, 'Custom Alias', 'Enter a Moment.js format string for the alias', '', { ...state(), wikiLinks: true }, (value, s) => ({ ...s, alias: value }));
							if (c === BACK) continue;
							alias = c;
						}
						step++;

					// step 7 — prefix
					} else if (step === 7) {
						const defaultPrefixLabel = this.settings.defaultPrefix ? `${JSON.stringify(this.settings.defaultPrefix)} (default)` : 'None (default)';
						const prefixPresets: { label: string; value: string; str: string }[] = [
							{ label: 'None',    value: 'none',  str: '' },
							{ label: '- ',     value: 'dash',  str: '- ' },
							{ label: '* ',     value: 'star',  str: '* ' },
							{ label: '+ ',     value: 'plus',  str: '+ ' },
							{ label: '> ',     value: 'quote', str: '> ' },
							{ label: '- [ ] ', value: 'task',  str: '- [ ] ' },
							{ label: '- [x] ', value: 'done',  str: '- [x] ' },
						].filter(p => p.str !== this.settings.defaultPrefix);
						const r = await suggest<string>(
							this.app, 'Prefix', 'Optionally prefix each date with a list marker.',
							[defaultPrefixLabel, ...prefixPresets.map(p => p.label), 'Custom…'],
							['default', ...prefixPresets.map(p => p.value), 'custom'],
							state(),
							(value, s) => {
								if (value === 'default') return { ...s, prefix: this.settings.defaultPrefix };
								const preset = prefixPresets.find(p => p.value === value);
								if (preset) return { ...s, prefix: preset.str };
								return s;
							},
						);
						if (r === BACK) { step--; continue; }
						if (r === 'default') { prefix = this.settings.defaultPrefix; step++; }
						else if (r !== 'custom') { prefix = prefixPresets.find(p => p.value === r)!.str; step++; }
						else {
							const c = await prompt(this.app, 'Custom Prefix', 'Enter a prefix to prepend to each date', '', state(), (value, s) => ({ ...s, prefix: value }));
							if (c === BACK) continue;
							prefix = c; step++;
						}

					// step 8 — postfix
					} else if (step === 8) {
						const defaultPostfixLabel = this.settings.defaultPostfix ? `${JSON.stringify(this.settings.defaultPostfix)} (default)` : 'None (default)';
						const postfixPresets: { label: string; value: string; str: string }[] = [
							{ label: 'None',  value: 'none',   str: '' },
							{ label: ' - ',  value: 'dash',   str: ' - ' },
							{ label: ' — ',  value: 'emdash', str: ' — ' },
							{ label: ' :: ', value: 'dv',     str: ' :: ' },
							{ label: ':',    value: 'colon',  str: ':' },
							{ label: ' | ',  value: 'pipe',   str: ' | ' },
						].filter(p => p.str !== this.settings.defaultPostfix);
						const r = await suggest<string>(
							this.app, 'Postfix', 'Optionally append text after each date.',
							[defaultPostfixLabel, ...postfixPresets.map(p => p.label), 'Custom…'],
							['default', ...postfixPresets.map(p => p.value), 'custom'],
							state(),
							(value, s) => {
								if (value === 'default') return { ...s, postfix: this.settings.defaultPostfix };
								const preset = postfixPresets.find(p => p.value === value);
								if (preset) return { ...s, postfix: preset.str };
								return s;
							},
						);
						if (r === BACK) { step--; continue; }
						if (r === 'default') { postfix = this.settings.defaultPostfix; }
						else if (r !== 'custom') { postfix = postfixPresets.find(p => p.value === r)!.str; }
						else {
							const c = await prompt(this.app, 'Custom Postfix', 'Enter text to append after each date', '', state(), (value, s) => ({ ...s, postfix: value }));
							if (c === BACK) continue;
							postfix = c;
						}
						break outer;
					}
				}

				editor.replaceSelection(buildDates(state()).join('\n'));
			},
		});

		this.addCommand({
			id: 'quick-insert',
			name: 'Quick insert',
			editorCallback: async (editor: Editor, _ctx: MarkdownView | MarkdownFileInfo) => {
				const s = this.settings;
				const defaultState: WizardState = {
					startMoment: moment(),
					nStr: s.defaultQuantity,
					stepUnit: s.defaultStepUnit,
					weekdays: null,
					fmt: s.defaultFormat || 'YYYY-MM-DD',
					wikiLinks: s.defaultWikiLinks,
					alias: s.defaultAlias,
					prefix: s.defaultPrefix,
					postfix: s.defaultPostfix,
				};

				const r = await prompt(
					this.app,
					'Quick insert',
					'Enter a start date. All other options use your saved defaults.',
					moment().format('YYYY-MM-DD'),
					defaultState,
					(value, state) => {
						const m = parseDate(value);
						return m.isValid() ? { ...state, startMoment: m } : state;
					},
				);
				if (r === BACK) return;
				const m = parseDate(r);
				if (!m.isValid()) { new Notice('Invalid date.'); return; }
				const dates = buildDates({ ...defaultState, startMoment: m });
				await this.saveSettings();
				editor.replaceSelection(dates.join('\n'));
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
	private defaultValue?: T;
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
		defaultValue?: T,
	) {
		super(app);
		this.title = title;
		this.instructions = instructions;
		this.options = options;
		this.values = values;
		this.state = state;
		this.previewMapper = previewMapper;
		this.resolve = resolve;
		this.defaultValue = defaultValue;
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

		const defaultIdx = this.defaultValue !== undefined ? this.values.indexOf(this.defaultValue) : -1;
		window.setTimeout(() => btns[defaultIdx >= 0 ? defaultIdx : 0]?.focus(), 50);
	}

	onClose() {
		if (!this.confirmed) this.resolve(BACK);
		this.contentEl.empty();
	}
}
