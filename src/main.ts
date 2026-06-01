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

function nthWeekdayOccurrence(start: MomentInstance, weekdays: number[], n: number): MomentInstance {
	let count = 0;
	const current = start.clone();
	while (count < n) {
		if (weekdays.includes(current.day())) count++;
		if (count < n) current.add(1, 'days');
	}
	return current;
}

const FMT_CATS: Record<string, string> = {
	'YYYY-MM-DD':      'ISO',
	'YYYY/MM/DD':      'Folder',
	'MMMM Do, YYYY':   'Long',
	'ddd, MMM D':      'Short',
	'ddd, MMM D YYYY': 'Short+yr',
	'MM/DD/YYYY':      'US',
	'DD/MM/YYYY':      'EU',
};

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
	subtexts?: string[],
): Promise<T | typeof BACK> {
	return new Promise((resolve) =>
		new SuggesterModal(app, title, instructions, options, values, state, previewMapper, resolve, defaultValue, subtexts).open(),
	);
}

interface StartMethodResult {
	startInput: string;
	startMoment: MomentInstance;
	method: 'specific-date' | 'duration';
	endInput: string;
	endMoment: MomentInstance;
	nStr: string;
	stepUnit: string;
}

function promptStartMethod(
	app: App,
	defaultStartInput: string,
	defaultMethod: 'specific-date' | 'duration',
	defaultEndInput: string,
	defaultN: string,
	defaultUnit: string,
	state: WizardState,
): Promise<StartMethodResult | typeof BACK> {
	return new Promise((resolve) =>
		new StartMethodModal(app, defaultStartInput, defaultMethod, defaultEndInput, defaultN, defaultUnit, state, resolve).open(),
	);
}

interface DurationResult { nStr: string; stepUnit: string }

function promptDuration(
	app: App,
	title: string,
	instructions: string,
	defaultN: string,
	defaultUnit: string,
	state: WizardState,
	previewMapper: (nStr: string, stepUnit: string, state: WizardState) => WizardState,
): Promise<DurationResult | typeof BACK> {
	return new Promise((resolve) =>
		new DurationModal(app, title, instructions, defaultN, defaultUnit, state, previewMapper, resolve).open(),
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
							{ label: today.format('YYYY/MM/DD'),      value: 'folder',  fmt: 'YYYY/MM/DD' },
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
							[today.format(fmt), ...presets.map(p => p.label), 'Custom…'],
							['current', ...presets.map(p => p.value), 'custom'],
							state(),
							(value, s) => {
								if (value === 'current') return { ...s, fmt };
								const preset = presets.find(p => p.value === value);
								if (preset) return { ...s, fmt: preset.fmt };
								return s;
							},
							undefined,
							[(FMT_CATS[fmt] ? FMT_CATS[fmt] + ' · ' : '') + 'current', ...presets.map(p => FMT_CATS[p.fmt] ?? ''), ''],
						);
						if (r === BACK) return;
						if (r === 'current') { step++; }
						else if (r !== 'custom') { fmt = presets.find(p => p.value === r)!.fmt; step++; }
						else {
							const c = await prompt(this.app, 'Custom Format', 'Enter a format string template (e.g. YYYY-MM-DD)', fmt, state(), (value, s) => ({ ...s, fmt: value }));
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
							const c = await prompt(this.app, 'Custom Alias', 'Enter a format string for the alias', alias || 'ddd, MMM D', { ...state(), wikiLinks: true }, (value, s) => ({ ...s, alias: value }));
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
				let nStr     = this.settings.defaultQuantity || '1';
				let stepUnit = this.settings.defaultStepUnit || 'days';
				let fmt        = this.settings.defaultFormat   || 'YYYY-MM-DD';
				let wikiLinks  = this.settings.defaultWikiLinks;
				let alias      = this.settings.defaultAlias;
				let prefix     = this.settings.defaultPrefix;
				let postfix    = this.settings.defaultPostfix;

				const parsedStart = parseDate(startInput);
				let startMoment = parsedStart.isValid() ? parsedStart : moment();
				let endMoment   = startMoment.clone().add(1, 'days');

				const now = moment();
				const rangePresets: { name: string; label: string; value: string; start: MomentInstance; end: MomentInstance }[] = [
					{
						name: 'This week',
						label: `${now.clone().startOf('isoWeek').format('MMM D')} – ${now.clone().endOf('isoWeek').startOf('day').format('MMM D')}`,
						value: 'this-week',
						start: now.clone().startOf('isoWeek'),
						end: now.clone().endOf('isoWeek').startOf('day'),
					},
					{
						name: 'Next week',
						label: `${now.clone().add(1,'weeks').startOf('isoWeek').format('MMM D')} – ${now.clone().add(1,'weeks').endOf('isoWeek').startOf('day').format('MMM D')}`,
						value: 'next-week',
						start: now.clone().add(1,'weeks').startOf('isoWeek'),
						end: now.clone().add(1,'weeks').endOf('isoWeek').startOf('day'),
					},
					{
						name: 'This month',
						label: `${now.clone().startOf('month').format('MMM D')} – ${now.clone().endOf('month').startOf('day').format('MMM D')}`,
						value: 'this-month',
						start: now.clone().startOf('month'),
						end: now.clone().endOf('month').startOf('day'),
					},
					{
						name: 'Next month',
						label: `${now.clone().add(1,'months').startOf('month').format('MMM D')} – ${now.clone().add(1,'months').endOf('month').startOf('day').format('MMM D')}`,
						value: 'next-month',
						start: now.clone().add(1,'months').startOf('month'),
						end: now.clone().add(1,'months').endOf('month').startOf('day'),
					},
					{
						name: 'Next 7 days',
						label: `${now.format('MMM D')} – ${now.clone().add(6,'days').format('MMM D')}`,
						value: 'next-7',
						start: now.clone(),
						end: now.clone().add(6,'days'),
					},
					{
						name: 'Next 30 days',
						label: `${now.format('MMM D')} – ${now.clone().add(29,'days').format('MMM D')}`,
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
							undefined,
							[...rangePresets.map(p => p.name), ''],
						);
						if (r === BACK) return;
						if (r === 'custom') { fromPreset = false; step++; continue; }
						const p = rangePresets.find(p => p.value === r)!;
						startMoment = p.start.clone();
						endMoment   = p.end.clone();
						method      = 'specific-date';
						fromPreset  = true;
						step = 2;

					// step 1 — start date + range method + end date or duration
					} else if (step === 1) {
						const r = await promptStartMethod(
							this.app,
							startInput,
							method,
							endInput || startMoment.clone().add(1, 'days').format('YYYY-MM-DD'),
							nStr,
							stepUnit,
							state(),
						);
						if (r === BACK) { step--; continue; }
						startInput  = r.startInput;
						startMoment = r.startMoment;
						method      = r.method;
						endInput    = r.endInput;
						endMoment   = r.endMoment;
						nStr        = r.nStr;
						stepUnit    = r.stepUnit;
						step++;

					// step 2 — use defaults or configure
					} else if (step === 2) {
						const mode = await suggest<string>(
							this.app,
							'Format',
							'Use your saved format defaults, or configure how dates are formatted.',
							['Use saved format', 'Configure format…'],
							['defaults', 'configure'],
							state(),
							(_value, s) => s,
						);
						if (mode === BACK) { step = fromPreset ? 0 : 1; continue; }
						if (mode === 'defaults') break outer;
						step++;

					// step 3 — date format
					} else if (step === 3) {
						const effectiveDefault = this.settings.defaultFormat || 'YYYY-MM-DD';
						const fmtPresets: { label: string; value: string; fmt: string }[] = [
							{ label: startMoment.format('YYYY-MM-DD'),      value: 'iso',     fmt: 'YYYY-MM-DD' },
							{ label: startMoment.format('YYYY/MM/DD'),      value: 'folder',  fmt: 'YYYY/MM/DD' },
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
							[startMoment.format(effectiveDefault), ...fmtPresets.map(p => p.label), 'Custom…'],
							['default', ...fmtPresets.map(p => p.value), 'custom'],
							state(),
							(value, s) => {
								if (value === 'default') return { ...s, fmt: effectiveDefault };
								const preset = fmtPresets.find(p => p.value === value);
								if (preset) return { ...s, fmt: preset.fmt };
								return s;
							},
							undefined,
							[(FMT_CATS[effectiveDefault] ? FMT_CATS[effectiveDefault] + ' · ' : '') + 'default', ...fmtPresets.map(p => FMT_CATS[p.fmt] ?? ''), ''],
						);
						if (r === BACK) { step--; continue; }
						if (r === 'default') { fmt = effectiveDefault; step++; }
						else if (r !== 'custom') { fmt = fmtPresets.find(p => p.value === r)!.fmt; step++; }
						else {
							const c = await prompt(this.app, 'Custom Format', 'Enter a format string (e.g. YYYY-MM-DD)', 'MMMM Do, YYYY', state(), (value, s) => ({ ...s, fmt: value }));
							if (c === BACK) continue;
							fmt = c; step++;
						}

					// step 4 — wiki links + alias
					} else if (step === 4) {
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

					// step 5 — prefix
					} else if (step === 5) {
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

					// step 6 — postfix
					} else if (step === 6) {
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
				let rangeMethod: 'between' | 'in-the-next' | 'in-the-past' | 'next-n' = 'between';
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
					if (rangeMethod === 'next-n') {
						const count = Math.max(1, parseInt(nStr) || 1);
						const end = nthWeekdayOccurrence(startMoment, selectedWeekdays, count);
						return {
							startMoment: startMoment.clone(),
							nStr: String(end.diff(startMoment, 'days') + 1),
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
							{ label: 'Mondays',    days: [1] },
							{ label: 'Tuesdays',   days: [2] },
							{ label: 'Wednesdays', days: [3] },
							{ label: 'Thursdays',  days: [4] },
							{ label: 'Fridays',    days: [5] },
							{ label: 'Saturdays',  days: [6] },
							{ label: 'Sundays',    days: [0] },
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
							['Between…', 'In the next…', 'In the past…', 'Next N occurrences…'],
							['between', 'in-the-next', 'in-the-past', 'next-n'],
							{ ...state(), nStr: '14', stepUnit: 'days' },
							(value, s) => {
								if (value === 'between') return { ...s, startMoment: startMoment.clone(), nStr: String(Math.max(1, endMoment.diff(startMoment, 'days') + 1)), stepUnit: 'days' };
								if (value === 'in-the-past') {
									const pastStart = startMoment.clone().subtract(14, 'days');
									return { ...s, startMoment: pastStart, nStr: String(startMoment.diff(pastStart, 'days') + 1), stepUnit: 'days' };
								}
								if (value === 'next-n') {
									const end = nthWeekdayOccurrence(startMoment, selectedWeekdays, 7);
									return { ...s, startMoment: startMoment.clone(), nStr: String(end.diff(startMoment, 'days') + 1), stepUnit: 'days' };
								}
								return { ...s, startMoment: startMoment.clone(), nStr, stepUnit };
							},
						);
						if (r === BACK) { step--; continue; }
						rangeMethod = r as 'between' | 'in-the-next' | 'in-the-past' | 'next-n';
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
						} else if (rangeMethod === 'next-n') {
							const r = await prompt(
								this.app,
								'Count',
								'How many occurrences? (e.g. 7)',
								nStr,
								state(),
								(value, s) => {
									const count = Math.max(1, parseInt(value) || 1);
									const end = nthWeekdayOccurrence(startMoment, selectedWeekdays, count);
									return { ...s, startMoment: startMoment.clone(), nStr: String(end.diff(startMoment, 'days') + 1), stepUnit: 'days' };
								},
							);
							if (r === BACK) { step--; continue; }
							nStr = String(Math.max(1, parseInt(r) || 1));
							step = 4;
							continue;
						} else {
							const r = await promptDuration(
								this.app,
								'Duration',
								'Enter the quantity and select the unit.',
								nStr,
								stepUnit,
								state(),
								(n, u, s) => {
									if (rangeMethod === 'in-the-past') {
										const nInt = parseInt(n) || 1;
										const ps = startMoment.clone().subtract(nInt, u as DurationUnit);
										return { ...s, startMoment: ps, nStr: String(Math.max(1, startMoment.diff(ps, 'days') + 1)), stepUnit: 'days' };
									}
									return { ...s, nStr: n, stepUnit: u };
								},
							);
							if (r === BACK) { step--; continue; }
							nStr = r.nStr;
							stepUnit = r.stepUnit;
							step = 4; // skip step 3 (end date, between only)
							continue;
						}
						step++;

					// step 3 — end date (between only)
					} else if (step === 3) {
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
						if (mode === BACK) { step = rangeMethod === 'between' ? 3 : 2; continue; }
						if (mode === 'defaults') break outer;
						step++;

					// step 5 — date format
					} else if (step === 5) {
						const effectiveDefault = this.settings.defaultFormat || 'YYYY-MM-DD';
						const refMoment = rangeMethod === 'between' ? startMoment : moment();
						const presets: { label: string; value: string; fmt: string }[] = [
							{ label: refMoment.format('YYYY-MM-DD'),      value: 'iso',     fmt: 'YYYY-MM-DD' },
							{ label: refMoment.format('YYYY/MM/DD'),      value: 'folder',  fmt: 'YYYY/MM/DD' },
							{ label: refMoment.format('MMMM Do, YYYY'),   value: 'long',    fmt: 'MMMM Do, YYYY' },
							{ label: refMoment.format('ddd, MMM D'),      value: 'short',   fmt: 'ddd, MMM D' },
							{ label: refMoment.format('ddd, MMM D YYYY'), value: 'shortyr', fmt: 'ddd, MMM D YYYY' },
							{ label: refMoment.format('MM/DD/YYYY'),      value: 'us',      fmt: 'MM/DD/YYYY' },
							{ label: refMoment.format('DD/MM/YYYY'),      value: 'eu',      fmt: 'DD/MM/YYYY' },
						].filter(p => p.fmt !== effectiveDefault);
						const r = await suggest<string>(
							this.app, 'Date Format', 'Choose how each date appears.',
							[refMoment.format(effectiveDefault), ...presets.map(p => p.label), 'Custom…'],
							['default', ...presets.map(p => p.value), 'custom'],
							state(),
							(value, s) => {
								if (value === 'default') return { ...s, fmt: effectiveDefault };
								const preset = presets.find(p => p.value === value);
								if (preset) return { ...s, fmt: preset.fmt };
								return s;
							},
							undefined,
							[(FMT_CATS[effectiveDefault] ? FMT_CATS[effectiveDefault] + ' · ' : '') + 'default', ...presets.map(p => FMT_CATS[p.fmt] ?? ''), ''],
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
	private subtexts?: string[];
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
		subtexts?: string[],
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
		this.subtexts = subtexts;
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
			const sub = this.subtexts?.[i];
			const btn = left.createEl('button', { cls: 'date-list-option-btn' });
			if (sub) btn.addClass('has-subtext');
			btn.createEl('span', { text: String(i + 1), cls: 'date-list-option-num' });
			if (sub) btn.createEl('span', { text: sub, cls: 'date-list-option-subtext' });
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

// -------------------------------------------------------------------
// DurationModal
// -------------------------------------------------------------------
class DurationModal extends Modal {
	private title: string;
	private instructions: string;
	private defaultN: string;
	private defaultUnit: string;
	private state: WizardState;
	private previewMapper: (nStr: string, stepUnit: string, state: WizardState) => WizardState;
	private resolve: (value: DurationResult | typeof BACK) => void;
	private confirmed = false;

	constructor(
		app: App,
		title: string,
		instructions: string,
		defaultN: string,
		defaultUnit: string,
		state: WizardState,
		previewMapper: (nStr: string, stepUnit: string, state: WizardState) => WizardState,
		resolve: (value: DurationResult | typeof BACK) => void,
	) {
		super(app);
		this.title         = title;
		this.instructions  = instructions;
		this.defaultN      = defaultN;
		this.defaultUnit   = defaultUnit;
		this.state         = state;
		this.previewMapper = previewMapper;
		this.resolve       = resolve;
	}

	onOpen() {
		this.modalEl.addClass('date-list-modal');
		this.modalEl.addClass('date-list-duration-modal');
		const { contentEl } = this;

		this.titleEl.empty();
		const backBtn = this.titleEl.createEl('button', { text: '←', cls: 'date-list-back-btn' });
		backBtn.addEventListener('click', () => this.close());
		this.titleEl.createSpan({ text: this.title });

		const body = contentEl.createEl('div', { cls: 'date-list-modal-body' });
		const left = body.createEl('div', { cls: 'date-list-modal-left' });
		const right = body.createEl('div', { cls: 'date-list-modal-right' });

		left.createEl('p', { text: this.instructions, cls: 'date-list-instructions' });

		const row = left.createEl('div', { cls: 'date-list-duration-row' });
		const input = row.createEl('input', { type: 'text', cls: 'date-list-duration-input' });
		input.value = this.defaultN;

		const units: { label: string; value: string }[] = [
			{ label: 'Days',   value: 'days' },
			{ label: 'Weeks',  value: 'weeks' },
			{ label: 'Months', value: 'months' },
			{ label: 'Years',  value: 'years' },
		];

		let selectedUnit = this.defaultUnit;

		right.createEl('div', { text: 'Preview', cls: 'date-list-preview-label' });
		const previewEl = right.createEl('div', { cls: 'date-list-preview-sidebar' });

		const updatePreview = () =>
			renderPreview(previewEl, this.previewMapper(input.value, selectedUnit, this.state));

		updatePreview();

		const unitBtns = units.map((unit, i) => {
			const btn = row.createEl('button', { cls: 'date-list-duration-unit-btn' });
			btn.createEl('span', { text: String(i + 1), cls: 'date-list-option-num' });
			btn.createEl('span', { text: unit.label, cls: 'date-list-option-text' });
			if (unit.value === selectedUnit) btn.addClass('is-active');
			btn.addEventListener('click', () => {
				selectedUnit = unit.value;
				unitBtns.forEach(b => b.removeClass('is-active'));
				btn.addClass('is-active');
				updatePreview();
			});
			btn.addEventListener('focus', () => {
				selectedUnit = unit.value;
				unitBtns.forEach(b => b.removeClass('is-active'));
				btn.addClass('is-active');
				updatePreview();
			});
			return btn;
		});

		input.addEventListener('input', updatePreview);

		const submit = () => {
			const n = parseInt(input.value);
			if (isNaN(n) || n < 1) { new Notice('Enter a positive number.'); return; }
			this.confirmed = true;
			this.resolve({ nStr: String(n), stepUnit: selectedUnit });
			this.close();
		};

		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); submit(); }
		});

		this.containerEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (activeDocument.activeElement === input) return;
			const focused = unitBtns.findIndex(b => b === activeDocument.activeElement);
			if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
				e.preventDefault();
				unitBtns[(focused + 1) % unitBtns.length]?.focus();
			} else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
				e.preventDefault();
				unitBtns[(focused - 1 + unitBtns.length) % unitBtns.length]?.focus();
			} else if (e.key === 'Enter') {
				e.preventDefault();
				submit();
			} else {
				const idx = parseInt(e.key) - 1;
				if (!isNaN(idx) && idx >= 0 && idx < units.length) {
					e.preventDefault();
					unitBtns[idx]!.focus();
				}
			}
		});

		window.setTimeout(() => { input.focus(); input.select(); }, 50);
	}

	onClose() {
		if (!this.confirmed) this.resolve(BACK);
		this.contentEl.empty();
	}
}

// -------------------------------------------------------------------
// StartMethodModal
// -------------------------------------------------------------------
class StartMethodModal extends Modal {
	private defaultStartInput: string;
	private defaultMethod: 'specific-date' | 'duration';
	private defaultEndInput: string;
	private defaultN: string;
	private defaultUnit: string;
	private state: WizardState;
	private resolve: (value: StartMethodResult | typeof BACK) => void;
	private confirmed = false;

	constructor(
		app: App,
		defaultStartInput: string,
		defaultMethod: 'specific-date' | 'duration',
		defaultEndInput: string,
		defaultN: string,
		defaultUnit: string,
		state: WizardState,
		resolve: (value: StartMethodResult | typeof BACK) => void,
	) {
		super(app);
		this.defaultStartInput = defaultStartInput;
		this.defaultMethod     = defaultMethod;
		this.defaultEndInput   = defaultEndInput;
		this.defaultN          = defaultN;
		this.defaultUnit       = defaultUnit;
		this.state             = state;
		this.resolve           = resolve;
	}

	onOpen() {
		this.modalEl.addClass('date-list-modal');
		this.modalEl.addClass('date-list-start-method-modal');
		const { contentEl } = this;

		this.titleEl.empty();
		const backBtn = this.titleEl.createEl('button', { text: '←', cls: 'date-list-back-btn' });
		backBtn.addEventListener('click', () => this.close());
		this.titleEl.createSpan({ text: 'Date Range' });

		const body = contentEl.createEl('div', { cls: 'date-list-modal-body' });
		const left = body.createEl('div', { cls: 'date-list-modal-left' });
		const right = body.createEl('div', { cls: 'date-list-modal-right' });

		// — Start date —
		left.createEl('p', { text: 'Start date', cls: 'date-list-instructions' });
		const startInput = left.createEl('input', { type: 'text', cls: 'date-list-input' });
		startInput.value = this.defaultStartInput;
		startInput.placeholder = 'e.g. today, +7, next monday, 2026-01-15…';

		// — Method buttons —
		const methodRow = left.createEl('div', { cls: 'date-list-duration-row' });
		const methods: { label: string; value: 'specific-date' | 'duration' }[] = [
			{ label: 'Specific date', value: 'specific-date' },
			{ label: 'Duration',      value: 'duration' },
		];
		let selectedMethod = this.defaultMethod;

		// — Specific date section —
		const specificSection = left.createEl('div');
		specificSection.createEl('p', { text: 'End date', cls: 'date-list-instructions' });
		const endInput = specificSection.createEl('input', { type: 'text', cls: 'date-list-input' });
		endInput.value = this.defaultEndInput;
		endInput.placeholder = 'e.g. tomorrow, +7, next friday, 2026-12-31…';

		// — Duration section —
		const durationSection = left.createEl('div');
		durationSection.createEl('p', { text: 'Duration', cls: 'date-list-instructions' });
		const durationRow = durationSection.createEl('div', { cls: 'date-list-duration-row' });
		const nInput = durationRow.createEl('input', { type: 'text', cls: 'date-list-duration-input' });
		nInput.value = this.defaultN;
		const units: { label: string; value: string }[] = [
			{ label: 'Days',   value: 'days' },
			{ label: 'Weeks',  value: 'weeks' },
			{ label: 'Months', value: 'months' },
			{ label: 'Years',  value: 'years' },
		];
		let selectedUnit = this.defaultUnit;

		// — Preview —
		right.createEl('div', { text: 'Preview', cls: 'date-list-preview-label' });
		const previewEl = right.createEl('div', { cls: 'date-list-preview-sidebar' });

		const updatePreview = () => {
			const sm = parseDate(startInput.value);
			if (!sm.isValid()) { renderPreview(previewEl, this.state); return; }
			if (selectedMethod === 'specific-date') {
				const em = parseDate(endInput.value);
				if (!em.isValid() || !em.isAfter(sm, 'day')) {
					renderPreview(previewEl, { ...this.state, startMoment: sm, nStr: '1', stepUnit: 'days' });
				} else {
					renderPreview(previewEl, { ...this.state, startMoment: sm, nStr: String(em.diff(sm, 'days') + 1), stepUnit: 'days' });
				}
			} else {
				const n = parseInt(nInput.value);
				renderPreview(previewEl, { ...this.state, startMoment: sm, nStr: n > 0 ? String(n) : '1', stepUnit: selectedUnit });
			}
		};

		// — Unit buttons —
		const unitBtns = units.map((unit, i) => {
			const btn = durationRow.createEl('button', { cls: 'date-list-duration-unit-btn' });
			btn.createEl('span', { text: String(i + 1), cls: 'date-list-option-num' });
			btn.createEl('span', { text: unit.label, cls: 'date-list-option-text' });
			if (unit.value === selectedUnit) btn.addClass('is-active');
			btn.addEventListener('click', () => {
				selectedUnit = unit.value;
				unitBtns.forEach(b => b.removeClass('is-active'));
				btn.addClass('is-active');
				updatePreview();
			});
			btn.addEventListener('focus', () => {
				selectedUnit = unit.value;
				unitBtns.forEach(b => b.removeClass('is-active'));
				btn.addClass('is-active');
				updatePreview();
			});
			return btn;
		});

		const showMethod = (m: 'specific-date' | 'duration') => {
			selectedMethod = m;
			specificSection.style.display = m === 'specific-date' ? '' : 'none';
			durationSection.style.display = m === 'duration'      ? '' : 'none';
			updatePreview();
		};
		showMethod(selectedMethod);

		// — Method buttons —
		const methodBtns = methods.map((method, i) => {
			const btn = methodRow.createEl('button', { cls: 'date-list-duration-unit-btn' });
			btn.createEl('span', { text: String(i + 1), cls: 'date-list-option-num' });
			btn.createEl('span', { text: method.label, cls: 'date-list-option-text' });
			if (method.value === selectedMethod) btn.addClass('is-active');
			btn.addEventListener('click', () => {
				methodBtns.forEach(b => b.removeClass('is-active'));
				btn.addClass('is-active');
				showMethod(method.value);
				window.setTimeout(() => (method.value === 'specific-date' ? endInput : nInput).focus(), 30);
			});
			btn.addEventListener('focus', () => {
				methodBtns.forEach(b => b.removeClass('is-active'));
				btn.addClass('is-active');
				showMethod(method.value);
			});
			return btn;
		});

		const submit = () => {
			const sm = parseDate(startInput.value);
			if (!sm.isValid()) { new Notice('Invalid start date.'); startInput.focus(); return; }
			if (selectedMethod === 'specific-date') {
				const em = parseDate(endInput.value);
				if (!em.isValid()) { new Notice('Invalid end date.'); endInput.focus(); return; }
				if (!em.isSameOrAfter(sm, 'day')) { new Notice('End date must be on or after start date.'); endInput.focus(); return; }
				this.confirmed = true;
				this.resolve({
					startInput: startInput.value, startMoment: sm,
					method: 'specific-date',
					endInput: endInput.value, endMoment: em,
					nStr: String(Math.max(1, em.diff(sm, 'days') + 1)), stepUnit: 'days',
				});
			} else {
				const n = parseInt(nInput.value);
				if (isNaN(n) || n < 1) { new Notice('Enter a positive number.'); nInput.focus(); return; }
				this.confirmed = true;
				this.resolve({
					startInput: startInput.value, startMoment: sm,
					method: 'duration',
					endInput: '', endMoment: sm.clone().add(n, selectedUnit as DurationUnit),
					nStr: String(n), stepUnit: selectedUnit,
				});
			}
			this.close();
		};

		startInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
		endInput.addEventListener('keydown',   (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
		nInput.addEventListener('keydown',     (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
		startInput.addEventListener('input', updatePreview);
		endInput.addEventListener('input',   updatePreview);
		nInput.addEventListener('input',     updatePreview);

		this.containerEl.addEventListener('keydown', (e: KeyboardEvent) => {
			const active = activeDocument.activeElement;
			if (active === startInput || active === endInput || active === nInput) return;
			const mIdx = methodBtns.findIndex(b => b === active);
			const uIdx = unitBtns.findIndex(b => b === active);
			if (mIdx >= 0) {
				if (e.key === 'ArrowRight') { e.preventDefault(); methodBtns[(mIdx + 1) % methodBtns.length]?.focus(); }
				else if (e.key === 'ArrowLeft') { e.preventDefault(); methodBtns[(mIdx - 1 + methodBtns.length) % methodBtns.length]?.focus(); }
				else if (e.key === 'ArrowDown') { e.preventDefault(); (selectedMethod === 'specific-date' ? endInput : nInput).focus(); }
				else if (e.key === 'Enter') { e.preventDefault(); submit(); }
				else { const idx = parseInt(e.key) - 1; if (!isNaN(idx) && idx >= 0 && idx < methodBtns.length) { e.preventDefault(); methodBtns[idx]!.focus(); } }
			} else if (uIdx >= 0) {
				if (e.key === 'ArrowRight') { e.preventDefault(); unitBtns[(uIdx + 1) % unitBtns.length]?.focus(); }
				else if (e.key === 'ArrowLeft') { e.preventDefault(); unitBtns[(uIdx - 1 + unitBtns.length) % unitBtns.length]?.focus(); }
				else if (e.key === 'ArrowUp') { e.preventDefault(); (methodBtns.find(b => b.hasClass('is-active')) ?? methodBtns[0])?.focus(); }
				else if (e.key === 'Enter') { e.preventDefault(); submit(); }
				else { const idx = parseInt(e.key) - 1; if (!isNaN(idx) && idx >= 0 && idx < unitBtns.length) { e.preventDefault(); unitBtns[idx]!.focus(); } }
			}
		});

		window.setTimeout(() => { startInput.focus(); startInput.select(); }, 50);
	}

	onClose() {
		if (!this.confirmed) this.resolve(BACK);
		this.contentEl.empty();
	}
}
