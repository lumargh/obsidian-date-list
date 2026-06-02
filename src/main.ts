// todo
// - feature upgrade: allow tab to complete @ autosuggest. Enter should accept and newline
// - new feature: autosuggest: populate the next 10 dates that match what the user has already entered. e.g. if today is june 1: @jun shows june 1-10. @next shows @next next mon-sun & next week, next month, etc.
// - new featuer: add pre-sets in settings. user can define three presets with names. e.g. month list with format: - [ISO|ddd, MMM D]: 

import {
	App,
	Editor,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	MarkdownView,
	MarkdownFileInfo,
	Modal,
	Notice,
	Plugin,
	setIcon,
	TFile,
	moment as _m,
} from 'obsidian';
import { DEFAULT_SETTINGS, DateListSettings, DateListSettingTab } from './settings';
import flatpickr from 'flatpickr';
import type { Instance as FpInstance } from 'flatpickr/dist/types/instance';
import 'flatpickr/dist/flatpickr.min.css';

// _m is typed as a non-callable namespace; build a callable type from its own members.
type MomentInstance = ReturnType<typeof _m.utc>;
type MomentFactory = { (): MomentInstance; (inp: string, fmt?: string | string[]): MomentInstance } & typeof _m;
const moment = _m as unknown as MomentFactory;
type DurationUnit = 'days' | 'weeks' | 'months' | 'years';

// Sentinel returned by any modal dismissed without a confirmed selection.
const BACK = Symbol('back');
const CONFIGURE = Symbol('configure');

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

function createDateInputRow(
	container: HTMLElement,
	defaultValue: string,
	placeholder: string,
): { input: HTMLInputElement; fp: FpInstance } {
	const row = container.createEl('div', { cls: 'date-list-date-row' });
	const input = row.createEl('input', { type: 'text', cls: 'date-list-input' });
	input.value = defaultValue;
	input.placeholder = placeholder;

	const calBtn = row.createEl('button', { cls: 'date-list-calendar-btn', attr: { type: 'button' } });
	setIcon(calBtn, 'calendar');

	// Init flatpickr inline on a throwaway anchor, then move the calendar to body
	// so it floats above the modal rather than pushing it open.
	const fpAnchor = row.createEl('div');
	const fp = flatpickr(fpAnchor, {
		inline: true,
		dateFormat: 'Y-m-d',
		disableMobile: true,
		onChange: (_dates: Date[], dateStr: string) => {
			if (dateStr) {
				input.value = dateStr;
				input.dispatchEvent(new Event('input'));
				hideCal();
			}
		},
	});

	const cal = fp.calendarContainer;
	cal.classList.add('date-list-cal-floating', 'date-list-cal-hidden');
	activeDocument.body.appendChild(cal);
	fpAnchor.remove();

	const hideCal = () => {
		cal.classList.add('date-list-cal-hidden');
		calBtn.classList.remove('is-active');
		activeDocument.removeEventListener('mousedown', handleOutside, true);
	};

	const handleOutside = (e: MouseEvent) => {
		if (!activeDocument.body.contains(cal)) {
			activeDocument.removeEventListener('mousedown', handleOutside, true);
			return;
		}
		if (!cal.contains(e.target as Node) && !calBtn.contains(e.target as Node)) {
			hideCal();
		}
	};

	calBtn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (!cal.classList.contains('date-list-cal-hidden')) {
			hideCal();
		} else {
			const m = parseDate(input.value);
			if (m.isValid()) fp.setDate(m.toDate(), false);
			const rect = calBtn.getBoundingClientRect();
			cal.style.top = `${rect.bottom + 4}px`;
			cal.style.left = `${rect.left}px`;
			cal.classList.remove('date-list-cal-hidden');
			calBtn.classList.add('is-active');
			window.setTimeout(() => activeDocument.addEventListener('mousedown', handleOutside, true), 0);
		}
	});

	return { input, fp };
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

	// +N or -N relative day offsets
	const relative = s.match(/^([+-]\d+)$/);
	if (relative) return moment().add(parseInt(relative[1]!), 'days');

	const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

	// next <weekday|week|month|year>
	const nextWord = s.match(/^next (\w+)$/);
	if (nextWord) {
		const word = nextWord[1]!;
		const idx = weekdays.indexOf(word);
		if (idx !== -1) {
			const d = moment().day(idx);
			return d.isSameOrBefore(moment(), 'day') ? d.add(7, 'days') : d;
		}
		if (word === 'week')  return moment().add(1, 'weeks').startOf('isoWeek');
		if (word === 'month') return moment().add(1, 'months').startOf('month');
		if (word === 'year')  return moment().add(1, 'years').startOf('year');
	}

	// last <weekday|week|month|year>
	const lastWord = s.match(/^last (\w+)$/);
	if (lastWord) {
		const word = lastWord[1]!;
		const idx = weekdays.indexOf(word);
		if (idx !== -1) {
			const d = moment().day(idx);
			return d.isSameOrAfter(moment(), 'day') ? d.subtract(7, 'days') : d;
		}
		if (word === 'week')  return moment().subtract(1, 'weeks').startOf('isoWeek');
		if (word === 'month') return moment().subtract(1, 'months').startOf('month');
		if (word === 'year')  return moment().subtract(1, 'years').startOf('year');
	}

	// this week/month/year
	const thisWord = s.match(/^this (week|month|year)$/);
	if (thisWord) {
		if (thisWord[1] === 'week')  return moment().startOf('isoWeek');
		if (thisWord[1] === 'month') return moment().startOf('month');
		if (thisWord[1] === 'year')  return moment().startOf('year');
	}

	// in N days/weeks/months/years
	const inN = s.match(/^in (\d+) (days|weeks|months|years)$/);
	if (inN) return moment().add(parseInt(inN[1]!), inN[2]! as DurationUnit);

	// N days/weeks/months/years ago
	const nAgo = s.match(/^(\d+) (days|weeks|months|years) ago$/);
	if (nAgo) return moment().subtract(parseInt(nAgo[1]!), nAgo[2]! as DurationUnit);

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
	showConfigureBtn = false,
): Promise<T | typeof BACK | typeof CONFIGURE> {
	return new Promise((resolve) =>
		new SuggesterModal(app, title, instructions, options, values, state, previewMapper, resolve, defaultValue, subtexts, showConfigureBtn).open(),
	);
}

function promptQuickInsert(
	app: App,
	presets: { label: string; formatted: string; m: MomentInstance }[],
	blankState: WizardState,
	buildState: (m: MomentInstance) => WizardState,
): Promise<MomentInstance | typeof BACK | typeof CONFIGURE> {
	return new Promise((resolve) =>
		new QuickInsertModal(app, presets, blankState, buildState, resolve).open(),
	);
}

// Runs the format → wiki links → prefix → postfix wizard and returns the updated
// config, or BACK if the user dismissed from the very first screen.
async function runFormatWizard(
	app: App,
	previewMoment: MomentInstance,
	initial: { fmt: string; wikiLinks: boolean; alias: string; prefix: string; postfix: string },
	settings: DateListSettings,
): Promise<{ fmt: string; wikiLinks: boolean; alias: string; prefix: string; postfix: string } | typeof BACK> {
	let { fmt, wikiLinks, alias, prefix, postfix } = initial;

	const makeState = (): WizardState => ({
		startMoment: previewMoment.clone(),
		nStr: '7', stepUnit: 'days', weekdays: null,
		fmt, wikiLinks, alias, prefix, postfix,
	});

	let step = 0;
	while (true) {
		// step 0 — date format
		if (step === 0) {
			const effectiveDefault = settings.defaultFormat || 'YYYY-MM-DD';
			const fmtPresets: { label: string; value: string; fmt: string }[] = [
				{ label: previewMoment.format('YYYY-MM-DD'),      value: 'iso',     fmt: 'YYYY-MM-DD' },
				{ label: previewMoment.format('YYYY/MM/DD'),      value: 'folder',  fmt: 'YYYY/MM/DD' },
				{ label: previewMoment.format('MMMM Do, YYYY'),   value: 'long',    fmt: 'MMMM Do, YYYY' },
				{ label: previewMoment.format('ddd, MMM D'),      value: 'short',   fmt: 'ddd, MMM D' },
				{ label: previewMoment.format('ddd, MMM D YYYY'), value: 'shortyr', fmt: 'ddd, MMM D YYYY' },
				{ label: previewMoment.format('MM/DD/YYYY'),      value: 'us',      fmt: 'MM/DD/YYYY' },
				{ label: previewMoment.format('DD/MM/YYYY'),      value: 'eu',      fmt: 'DD/MM/YYYY' },
			].filter(p => p.fmt !== effectiveDefault);
			const r = await suggest<string>(
				app, 'Date Format', 'Choose how each date appears.',
				[previewMoment.format(effectiveDefault), ...fmtPresets.map(p => p.label), 'Custom…'],
				['default', ...fmtPresets.map(p => p.value), 'custom'],
				makeState(),
				(value, s) => {
					if (value === 'default') return { ...s, fmt: effectiveDefault };
					const preset = fmtPresets.find(p => p.value === value);
					if (preset) return { ...s, fmt: preset.fmt };
					return s;
				},
				undefined,
				[(FMT_CATS[effectiveDefault] ? FMT_CATS[effectiveDefault] + ' · ' : '') + 'default', ...fmtPresets.map(p => FMT_CATS[p.fmt] ?? ''), ''],
			);
			if (r === BACK) return BACK;
			if (r === 'default') { fmt = effectiveDefault; step++; }
			else if (r !== 'custom') { fmt = fmtPresets.find(p => p.value === r)!.fmt; step++; }
			else {
				const c = await prompt(app, 'Custom Format', 'Enter a format string (e.g. YYYY-MM-DD)', 'MMMM Do, YYYY', makeState(), (value, s) => ({ ...s, fmt: value }));
				if (c === BACK) continue;
				fmt = c; step++;
			}
		// step 1 — wiki links + alias
		} else if (step === 1) {
			const wikiDefault = settings.defaultWikiLinks;
			const r = await suggest<boolean>(
				app, 'Wiki Links', 'Wrap each date in [[ ]] to create Obsidian note links, or output as plain text.',
				wikiDefault ? ['Wrap in [[wikilinks]] (default)', 'Plain text'] : ['Plain text (default)', 'Wrap in [[wikilinks]]'],
				wikiDefault ? [true, false] : [false, true],
				makeState(),
				(value, s) => ({ ...s, wikiLinks: value, alias: value ? s.alias : '' }),
			);
			if (r === BACK || r === CONFIGURE) { step--; continue; }
			wikiLinks = r;
			if (!wikiLinks) { alias = ''; step++; continue; }
			const defaultAliasLabel = settings.defaultAlias ? `${previewMoment.format(settings.defaultAlias)} (default)` : 'None (default)';
			const aliasPresets: { label: string; value: string; fmt: string }[] = [
				{ label: previewMoment.format('ddd, MMM D'),    value: 'short',   fmt: 'ddd, MMM D' },
				{ label: previewMoment.format('MMMM Do'),       value: 'long',    fmt: 'MMMM Do' },
				{ label: previewMoment.format('MMMM D, YYYY'),  value: 'full',    fmt: 'MMMM D, YYYY' },
				{ label: previewMoment.format('dddd'),           value: 'weekday', fmt: 'dddd' },
				{ label: previewMoment.format('dddd, MMMM Do'), value: 'daylong', fmt: 'dddd, MMMM Do' },
			].filter(p => p.fmt !== settings.defaultAlias);
			const aliasR = await suggest<string>(
				app, 'Alias', 'Add a display alias to each link, e.g. [[2026-01-15|Thu, Jan 15]]. Leave as "None" to skip.',
				[defaultAliasLabel, ...aliasPresets.map(p => p.label), 'Custom…'],
				['default', ...aliasPresets.map(p => p.value), 'custom'],
				{ ...makeState(), wikiLinks: true },
				(value, s) => {
					if (value === 'default') return { ...s, alias: settings.defaultAlias };
					const preset = aliasPresets.find(p => p.value === value);
					if (preset) return { ...s, alias: preset.fmt };
					return s;
				},
			);
			if (aliasR === BACK) continue;
			if (aliasR === 'default') { alias = settings.defaultAlias; }
			else if (aliasR !== 'custom') { alias = aliasPresets.find(p => p.value === aliasR)!.fmt; }
			else {
				const c = await prompt(app, 'Custom Alias', 'Enter a format string for the alias, e.g. ddd, MMM D', '', { ...makeState(), wikiLinks: true }, (value, s) => ({ ...s, alias: value }));
				if (c === BACK) continue;
				alias = c;
			}
			step++;
		// step 2 — prefix
		} else if (step === 2) {
			const defaultPrefixLabel = settings.defaultPrefix ? `${JSON.stringify(settings.defaultPrefix)} (default)` : 'None (default)';
			const prefixPresets: { label: string; value: string; str: string }[] = [
				{ label: 'None',    value: 'none',  str: '' },
				{ label: '- ',     value: 'dash',  str: '- ' },
				{ label: '* ',     value: 'star',  str: '* ' },
				{ label: '+ ',     value: 'plus',  str: '+ ' },
				{ label: '> ',     value: 'quote', str: '> ' },
				{ label: '- [ ] ', value: 'task',  str: '- [ ] ' },
				{ label: '- [x] ', value: 'done',  str: '- [x] ' },
			].filter(p => p.str !== settings.defaultPrefix);
			const r = await suggest<string>(
				app, 'Prefix', 'Optionally prefix each date with a list marker.',
				[defaultPrefixLabel, ...prefixPresets.map(p => p.label), 'Custom…'],
				['default', ...prefixPresets.map(p => p.value), 'custom'],
				makeState(),
				(value, s) => {
					if (value === 'default') return { ...s, prefix: settings.defaultPrefix };
					const preset = prefixPresets.find(p => p.value === value);
					if (preset) return { ...s, prefix: preset.str };
					return s;
				},
			);
			if (r === BACK) { step--; continue; }
			if (r === 'default') { prefix = settings.defaultPrefix; step++; }
			else if (r !== 'custom') { prefix = prefixPresets.find(p => p.value === r)!.str; step++; }
			else {
				const c = await prompt(app, 'Custom Prefix', 'Enter a prefix to prepend to each date', '> ', makeState(), (value, s) => ({ ...s, prefix: value }));
				if (c === BACK) continue;
				prefix = c; step++;
			}
		// step 3 — postfix
		} else {
			const defaultPostfixLabel = settings.defaultPostfix ? `${JSON.stringify(settings.defaultPostfix)} (default)` : 'None (default)';
			const postfixPresets: { label: string; value: string; str: string }[] = [
				{ label: 'None',  value: 'none',   str: '' },
				{ label: ' - ',  value: 'dash',   str: ' - ' },
				{ label: ' — ',  value: 'emdash', str: ' — ' },
				{ label: ' :: ', value: 'dv',     str: ' :: ' },
				{ label: ':',    value: 'colon',  str: ':' },
				{ label: ' | ',  value: 'pipe',   str: ' | ' },
			].filter(p => p.str !== settings.defaultPostfix);
			const r = await suggest<string>(
				app, 'Postfix', 'Optionally append text after each date.',
				[defaultPostfixLabel, ...postfixPresets.map(p => p.label), 'Custom…'],
				['default', ...postfixPresets.map(p => p.value), 'custom'],
				makeState(),
				(value, s) => {
					if (value === 'default') return { ...s, postfix: settings.defaultPostfix };
					const preset = postfixPresets.find(p => p.value === value);
					if (preset) return { ...s, postfix: preset.str };
					return s;
				},
			);
			if (r === BACK) { step--; continue; }
			if (r === 'default') { postfix = settings.defaultPostfix; }
			else if (r !== 'custom') { postfix = postfixPresets.find(p => p.value === r)!.str; }
			else {
				const c = await prompt(app, 'Custom Postfix', 'Enter text to append after each date', ':: ', makeState(), (value, s) => ({ ...s, postfix: value }));
				if (c === BACK) continue;
				postfix = c;
			}
			return { fmt, wikiLinks, alias, prefix, postfix };
		}
	}
}

interface InsertDateResult {
	startInput: string;
	startMoment: MomentInstance;
	endInput: string;
	endMoment: MomentInstance;
}

function promptInsertDate(
	app: App,
	rangePresets: { name: string; label: string; start: MomentInstance; end: MomentInstance }[],
	defaultStartInput: string,
	defaultEndInput: string,
	state: WizardState,
): Promise<InsertDateResult | typeof BACK | typeof CONFIGURE> {
	return new Promise((resolve) =>
		new InsertDateModal(app, rangePresets, defaultStartInput, defaultEndInput, state, resolve).open(),
	);
}

interface FilterRangeResult {
	method: 'between' | 'in-the-next' | 'in-the-past' | 'next-n';
	startInput: string;
	startMoment: MomentInstance;
	endInput: string;
	endMoment: MomentInstance;
	nStr: string;
	stepUnit: string;
}

function promptFilterRange(
	app: App,
	defaultMethod: 'between' | 'in-the-next' | 'in-the-past' | 'next-n',
	defaultStartInput: string,
	defaultEndInput: string,
	defaultN: string,
	defaultUnit: string,
	selectedWeekdays: number[],
	state: WizardState,
): Promise<FilterRangeResult | typeof BACK | typeof CONFIGURE> {
	return new Promise((resolve) =>
		new FilterRangeModal(app, defaultMethod, defaultStartInput, defaultEndInput, defaultN, defaultUnit, selectedWeekdays, state, resolve).open(),
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
			name: 'Configure date list',
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
					nStr: '7',
					stepUnit: 'days',
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
						if (r === BACK || r === CONFIGURE) { step--; continue; }
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
			id: 'insert',
			name: 'Insert list',
			editorCallback: async (editor: Editor, _ctx: MarkdownView | MarkdownFileInfo) => {
				let startInput = moment().format('YYYY-MM-DD');
				let endInput   = '';
				let fmt        = this.settings.defaultFormat   || 'YYYY-MM-DD';
				let wikiLinks  = this.settings.defaultWikiLinks;
				let alias      = this.settings.defaultAlias;
				let prefix     = this.settings.defaultPrefix;
				let postfix    = this.settings.defaultPostfix;
				let startMoment = moment();
				let endMoment   = startMoment.clone().add(1, 'days');

				const now = moment();
				const rangePresets = [
					{ name: 'This week',   label: `${now.clone().startOf('isoWeek').format('MMM D')} – ${now.clone().endOf('isoWeek').startOf('day').format('MMM D')}`,                                 start: now.clone().startOf('isoWeek'),             end: now.clone().endOf('isoWeek').startOf('day') },
					{ name: 'Next week',   label: `${now.clone().add(1,'weeks').startOf('isoWeek').format('MMM D')} – ${now.clone().add(1,'weeks').endOf('isoWeek').startOf('day').format('MMM D')}`,   start: now.clone().add(1,'weeks').startOf('isoWeek'), end: now.clone().add(1,'weeks').endOf('isoWeek').startOf('day') },
					{ name: 'This month',  label: `${now.clone().startOf('month').format('MMM D')} – ${now.clone().endOf('month').startOf('day').format('MMM D')}`,                                     start: now.clone().startOf('month'),               end: now.clone().endOf('month').startOf('day') },
					{ name: 'Next month',  label: `${now.clone().add(1,'months').startOf('month').format('MMM D')} – ${now.clone().add(1,'months').endOf('month').startOf('day').format('MMM D')}`,     start: now.clone().add(1,'months').startOf('month'), end: now.clone().add(1,'months').endOf('month').startOf('day') },
					{ name: 'Next 7 days', label: `${now.format('MMM D')} – ${now.clone().add(6,'days').format('MMM D')}`,                                                                             start: now.clone(),                                end: now.clone().add(6,'days') },
					{ name: 'Next 30 days',label: `${now.format('MMM D')} – ${now.clone().add(29,'days').format('MMM D')}`,                                                                            start: now.clone(),                                end: now.clone().add(29,'days') },
				];

				const state = (): WizardState => ({
					startMoment: startMoment.clone(),
					nStr: String(Math.max(1, endMoment.diff(startMoment, 'days') + 1)),
					stepUnit: 'days', weekdays: null,
					fmt, wikiLinks, alias, prefix, postfix,
				});

				while (true) {
					const r = await promptInsertDate(this.app, rangePresets, startInput, endInput, state());
					if (r === BACK) return;
					if (r === CONFIGURE) {
						const res = await runFormatWizard(this.app, startMoment, { fmt, wikiLinks, alias, prefix, postfix }, this.settings);
						if (res !== BACK) ({ fmt, wikiLinks, alias, prefix, postfix } = res);
						continue;
					}
					startInput  = r.startInput;
					startMoment = r.startMoment;
					endInput    = r.endInput;
					endMoment   = r.endMoment;
					break;
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
							{ label: 'Mondays',            days: [1] },
							{ label: 'Tuesdays',           days: [2] },
							{ label: 'Wednesdays',         days: [3] },
							{ label: 'Thursdays',          days: [4] },
							{ label: 'Fridays',            days: [5] },
							{ label: 'Saturdays',          days: [6] },
							{ label: 'Sundays',            days: [0] },
							{ label: 'Weekdays (Mon–Fri)', days: [1, 2, 3, 4, 5] },
							{ label: 'Weekends (Sat–Sun)', days: [6, 0] },
						];
						const next5State = (days: number[], s: WizardState): WizardState => {
							const end = nthWeekdayOccurrence(s.startMoment, days, 5);
							return { ...s, stepUnit: 'days', weekdays: days, nStr: String(end.diff(s.startMoment, 'days') + 1) };
						};
						const dayBase = { ...state(), stepUnit: 'days' };
						const r = await suggest<number[]>(
							this.app,
							'Day of Week',
							'Which days should be included in the list?',
							dayOptions.map(d => d.label),
							dayOptions.map(d => d.days),
							next5State(dayOptions[0]!.days, dayBase),
							(value, s) => next5State(value, s),
							undefined,
							undefined,
							true,
						);
						if (r === BACK) return;
						if (r === CONFIGURE) {
							const res = await runFormatWizard(this.app, startMoment, { fmt, wikiLinks, alias, prefix, postfix }, this.settings);
							if (res !== BACK) ({ fmt, wikiLinks, alias, prefix, postfix } = res);
							continue;
						}
						selectedWeekdays = r;
						step++;

					// step 1 — range method + inputs
					} else if (step === 1) {
						const r = await promptFilterRange(
							this.app,
							rangeMethod,
							startInput,
							endInput || startMoment.clone().add(1, 'months').format('YYYY-MM-DD'),
							nStr,
							stepUnit,
							selectedWeekdays,
							state(),
						);
						if (r === BACK) { step--; continue; }
						if (r === CONFIGURE) {
							const res = await runFormatWizard(this.app, startMoment, { fmt, wikiLinks, alias, prefix, postfix }, this.settings);
							if (res !== BACK) ({ fmt, wikiLinks, alias, prefix, postfix } = res);
							continue;
						}
						rangeMethod   = r.method;
						startInput    = r.startInput;
						startMoment   = r.startMoment;
						endInput      = r.endInput;
						endMoment     = r.endMoment;
						nStr          = r.nStr;
						stepUnit      = r.stepUnit;
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
				while (true) {
					const s = this.settings;
					const fmt = s.defaultFormat || 'YYYY-MM-DD';

					const buildState = (m: MomentInstance): WizardState => ({
						startMoment: m.clone(),
						nStr: '1',
						stepUnit: 'days',
						weekdays: null,
						fmt,
						wikiLinks: s.defaultWikiLinks,
						alias: s.defaultAlias,
						prefix: s.defaultPrefix,
						postfix: s.defaultPostfix,
					});

					const formatMoment = (m: MomentInstance): string => {
						const formatted = m.format(fmt);
						if (s.defaultWikiLinks) {
							return s.defaultAlias ? `[[${formatted}|${m.format(s.defaultAlias)}]]` : `[[${formatted}]]`;
						}
						return formatted;
					};

					const presetDefs: { label: string; m: MomentInstance }[] = [
						{ label: 'today',       m: moment() },
						{ label: 'tomorrow',    m: moment().add(1, 'days') },
						{ label: 'yesterday',   m: moment().subtract(1, 'days') },
						{ label: 'next monday', m: parseDate('next monday') },
						{ label: 'next week',   m: parseDate('next week') },
						{ label: 'next month',  m: parseDate('next month') },
					];
					const seen = new Set<string>();
					const presets = presetDefs
						.filter(p => { const k = p.m.format('YYYY-MM-DD'); return seen.has(k) ? false : (seen.add(k), true); })
						.map(p => ({ label: p.label, formatted: formatMoment(p.m), m: p.m }));

					const r = await promptQuickInsert(this.app, presets, buildState(moment()), buildState);
					if (r === BACK) return;
					if (r === CONFIGURE) {
						const res = await runFormatWizard(this.app, moment(), { fmt, wikiLinks: s.defaultWikiLinks, alias: s.defaultAlias, prefix: s.defaultPrefix, postfix: s.defaultPostfix }, this.settings);
						if (res !== BACK) {
							this.settings.defaultFormat    = res.fmt;
							this.settings.defaultWikiLinks = res.wikiLinks;
							this.settings.defaultAlias     = res.alias;
							this.settings.defaultPrefix    = res.prefix;
							this.settings.defaultPostfix   = res.postfix;
							await this.saveSettings();
						}
						continue;
					}
					editor.replaceSelection(buildDates(buildState(r))[0] ?? '');
					return;
				}
			},
		});

		this.registerEditorSuggest(new DateSuggest(this.app, this));
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
		const promptActions = left.createEl('div', { cls: 'date-list-modal-actions' });
		promptActions.createEl('button', { cls: 'date-list-ok-btn', text: 'OK' }).addEventListener('click', submit);

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
	private resolve: (value: T | typeof BACK | typeof CONFIGURE) => void;
	private defaultValue?: T;
	private subtexts?: string[];
	private showConfigureBtn: boolean;
	private confirmed = false;

	constructor(
		app: App,
		title: string,
		instructions: string,
		options: string[],
		values: T[],
		state: WizardState,
		previewMapper: (value: T, state: WizardState) => WizardState,
		resolve: (value: T | typeof BACK | typeof CONFIGURE) => void,
		defaultValue?: T,
		subtexts?: string[],
		showConfigureBtn = false,
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
		this.showConfigureBtn = showConfigureBtn;
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

		const suggActions = left.createEl('div', { cls: 'date-list-modal-actions' });
		const suggOkBtn = suggActions.createEl('button', { cls: 'date-list-ok-btn', text: 'OK' });
		suggOkBtn.addEventListener('click', () => {
			const focused = btns.findIndex(b => b === activeDocument.activeElement);
			select(focused >= 0 ? focused : 0);
		});

		if (this.showConfigureBtn) {
			const configBtn = suggActions.createEl('button', { cls: 'date-list-configure-btn' });
			setIcon(configBtn, 'settings');
			configBtn.createEl('span', { text: 'Configure format…' });
			configBtn.addEventListener('click', () => {
				this.confirmed = true;
				this.resolve(CONFIGURE);
				this.close();
			});
		}

		const defaultIdx = this.defaultValue !== undefined ? this.values.indexOf(this.defaultValue) : -1;
		window.setTimeout(() => btns[defaultIdx >= 0 ? defaultIdx : 0]?.focus(), 50);
	}

	onClose() {
		if (!this.confirmed) this.resolve(BACK);
		this.contentEl.empty();
	}
}

// -------------------------------------------------------------------
// QuickInsertModal
// -------------------------------------------------------------------
class QuickInsertModal extends Modal {
	private presets: { label: string; formatted: string; m: MomentInstance }[];
	private blankState: WizardState;
	private buildState: (m: MomentInstance) => WizardState;
	private resolve: (value: MomentInstance | typeof BACK | typeof CONFIGURE) => void;
	private confirmed = false;
	private fpInstances: FpInstance[] = [];

	constructor(
		app: App,
		presets: { label: string; formatted: string; m: MomentInstance }[],
		blankState: WizardState,
		buildState: (m: MomentInstance) => WizardState,
		resolve: (value: MomentInstance | typeof BACK | typeof CONFIGURE) => void,
	) {
		super(app);
		this.presets = presets;
		this.blankState = blankState;
		this.buildState = buildState;
		this.resolve = resolve;
	}

	onOpen() {
		this.modalEl.addClass('date-list-modal');
		const { contentEl } = this;

		this.titleEl.empty();
		const backBtn = this.titleEl.createEl('button', { text: '←', cls: 'date-list-back-btn' });
		backBtn.addEventListener('click', () => this.close());
		this.titleEl.createSpan({ text: 'Quick insert' });

		const body = contentEl.createEl('div', { cls: 'date-list-modal-body' });
		const left = body.createEl('div', { cls: 'date-list-modal-left' });
		const right = body.createEl('div', { cls: 'date-list-modal-right' });

		left.createEl('p', { text: 'Pick a date or type a custom one.', cls: 'date-list-instructions' });

		right.createEl('div', { text: 'Preview', cls: 'date-list-preview-label' });
		const previewEl = right.createEl('div', { cls: 'date-list-preview-sidebar' });
		renderPreview(previewEl, this.blankState);

		const select = (m: MomentInstance) => {
			this.confirmed = true;
			this.resolve(m);
			this.close();
		};

		const btns = this.presets.map((preset, i) => {
			const btn = left.createEl('button', { cls: 'date-list-option-btn has-subtext' });
			btn.createEl('span', { text: String(i + 1), cls: 'date-list-option-num' });
			btn.createEl('span', { text: preset.label, cls: 'date-list-option-subtext' });
			btn.createEl('span', { text: preset.formatted, cls: 'date-list-option-text' });
			btn.addEventListener('click', () => select(preset.m));
			btn.addEventListener('mouseenter', () => renderPreview(previewEl, this.buildState(preset.m)));
			btn.addEventListener('mouseleave', () => renderPreview(previewEl, this.blankState));
			btn.addEventListener('focus',      () => renderPreview(previewEl, this.buildState(preset.m)));
			btn.addEventListener('blur',       () => renderPreview(previewEl, this.blankState));
			return btn;
		});

		// Inline custom input as the last "option"
		const customRow = left.createEl('div', { cls: 'date-list-option-btn date-list-quick-custom-row' });
		customRow.createEl('span', { text: String(this.presets.length + 1), cls: 'date-list-option-num' });
		const customInput = customRow.createEl('input', {
			type: 'text',
			cls: 'date-list-quick-custom-input',
			placeholder: 'custom date…',
		});

		const calBtn = customRow.createEl('button', { cls: 'date-list-calendar-btn', attr: { type: 'button' } });
		setIcon(calBtn, 'calendar');
		const fpAnchor = customRow.createEl('div');
		const fp = flatpickr(fpAnchor, {
			inline: true,
			dateFormat: 'Y-m-d',
			disableMobile: true,
			onChange: (_dates: Date[], dateStr: string) => {
				if (dateStr) {
					customInput.value = dateStr;
					customInput.dispatchEvent(new Event('input'));
					hideCal();
				}
			},
		});
		this.fpInstances.push(fp);
		const cal = fp.calendarContainer;
		cal.classList.add('date-list-cal-floating', 'date-list-cal-hidden');
		activeDocument.body.appendChild(cal);
		fpAnchor.remove();
		const hideCal = () => {
			cal.classList.add('date-list-cal-hidden');
			calBtn.classList.remove('is-active');
			activeDocument.removeEventListener('mousedown', handleOutside, true);
		};
		const handleOutside = (e: MouseEvent) => {
			if (!activeDocument.body.contains(cal)) { activeDocument.removeEventListener('mousedown', handleOutside, true); return; }
			if (!cal.contains(e.target as Node) && !calBtn.contains(e.target as Node)) hideCal();
		};
		calBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (!cal.classList.contains('date-list-cal-hidden')) { hideCal(); return; }
			const m = parseDate(customInput.value);
			if (m.isValid()) fp.setDate(m.toDate(), false);
			const rect = calBtn.getBoundingClientRect();
			cal.style.top = `${rect.bottom + 4}px`;
			cal.style.left = `${rect.left}px`;
			cal.classList.remove('date-list-cal-hidden');
			calBtn.classList.add('is-active');
			window.setTimeout(() => activeDocument.addEventListener('mousedown', handleOutside, true), 0);
		});

		customRow.addEventListener('click', () => customInput.focus());

		const updateCustomPreview = () => {
			const m = parseDate(customInput.value);
			renderPreview(previewEl, m.isValid() ? this.buildState(m) : this.blankState);
		};
		customInput.addEventListener('input',  updateCustomPreview);
		customInput.addEventListener('focus',  updateCustomPreview);
		customInput.addEventListener('blur',   () => renderPreview(previewEl, this.blankState));
		customInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				const m = parseDate(customInput.value);
				if (!m.isValid()) { new Notice('Invalid date.'); return; }
				select(m);
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				btns[btns.length - 1]?.focus();
			}
		});

		this.containerEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (activeDocument.activeElement === customInput) return;
			const focused = btns.findIndex(b => b === activeDocument.activeElement);
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				if (focused === btns.length - 1) customInput.focus();
				else btns[(focused + 1) % btns.length]?.focus();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				btns[(focused - 1 + btns.length) % btns.length]?.focus();
			} else if (e.key === 'Enter' && focused >= 0) {
				e.preventDefault();
				select(this.presets[focused]!.m);
			} else {
				const idx = parseInt(e.key) - 1;
				if (isNaN(idx)) return;
				e.preventDefault();
				if (idx >= 0 && idx < this.presets.length) select(this.presets[idx]!.m);
				else if (idx === this.presets.length) customInput.focus();
			}
		});

		const qiActions = left.createEl('div', { cls: 'date-list-modal-actions' });
		const qiOkBtn = qiActions.createEl('button', { cls: 'date-list-ok-btn', text: 'OK' });
		qiOkBtn.addEventListener('click', () => {
			const customVal = customInput.value.trim();
			if (customVal) {
				const m = parseDate(customVal);
				if (!m.isValid()) { new Notice('Invalid date.'); return; }
				select(m);
				return;
			}
			const focused = btns.findIndex(b => b === activeDocument.activeElement);
			select(focused >= 0 ? this.presets[focused]!.m : this.presets[0]!.m);
		});
		const qiConfigBtn = qiActions.createEl('button', { cls: 'date-list-configure-btn' });
		setIcon(qiConfigBtn, 'settings');
		qiConfigBtn.createEl('span', { text: 'Configure format…' });
		qiConfigBtn.addEventListener('click', () => {
			this.confirmed = true;
			this.resolve(CONFIGURE);
			this.close();
		});

		window.setTimeout(() => btns[0]?.focus(), 50);
	}

	onClose() {
		this.fpInstances.forEach(fp => fp.destroy());
		if (!this.confirmed) this.resolve(BACK);
		this.contentEl.empty();
	}
}

// -------------------------------------------------------------------
// InsertDateModal — presets + inline custom date inputs
// -------------------------------------------------------------------
class InsertDateModal extends Modal {
	private rangePresets: { name: string; label: string; start: MomentInstance; end: MomentInstance }[];
	private defaultStartInput: string;
	private defaultEndInput: string;
	private state: WizardState;
	private resolve: (value: InsertDateResult | typeof BACK | typeof CONFIGURE) => void;
	private confirmed = false;
	private fpInstances: FpInstance[] = [];

	constructor(
		app: App,
		rangePresets: { name: string; label: string; start: MomentInstance; end: MomentInstance }[],
		defaultStartInput: string,
		defaultEndInput: string,
		state: WizardState,
		resolve: (value: InsertDateResult | typeof BACK | typeof CONFIGURE) => void,
	) {
		super(app);
		this.rangePresets     = rangePresets;
		this.defaultStartInput = defaultStartInput;
		this.defaultEndInput   = defaultEndInput;
		this.state             = state;
		this.resolve           = resolve;
	}

	onOpen() {
		this.modalEl.addClass('date-list-modal');
		const { contentEl } = this;

		this.titleEl.empty();
		const backBtn = this.titleEl.createEl('button', { text: '←', cls: 'date-list-back-btn' });
		backBtn.addEventListener('click', () => this.close());
		this.titleEl.createSpan({ text: 'Date Range' });

		const body = contentEl.createEl('div', { cls: 'date-list-modal-body' });
		const left  = body.createEl('div', { cls: 'date-list-modal-left' });
		const right = body.createEl('div', { cls: 'date-list-modal-right' });

		left.createEl('p', { text: 'Pick a common range, or choose "Custom" to set your own dates.', cls: 'date-list-instructions' });

		right.createEl('div', { text: 'Preview', cls: 'date-list-preview-label' });
		const previewEl = right.createEl('div', { cls: 'date-list-preview-sidebar' });
		renderPreview(previewEl, this.state);

		let customActive = false;

		const resolvePreset = (p: { start: MomentInstance; end: MomentInstance }) => {
			this.confirmed = true;
			this.resolve({
				startInput: p.start.format('YYYY-MM-DD'),
				startMoment: p.start.clone(),
				endInput: p.end.format('YYYY-MM-DD'),
				endMoment: p.end.clone(),
			});
			this.close();
		};

		// — Preset buttons —
		const presetBtns = this.rangePresets.map((p, i) => {
			const presetState: WizardState = {
				...this.state,
				startMoment: p.start.clone(),
				nStr: String(Math.max(1, p.end.diff(p.start, 'days') + 1)),
				stepUnit: 'days',
			};
			const btn = left.createEl('button', { cls: 'date-list-option-btn has-subtext' });
			btn.createEl('span', { text: String(i + 1), cls: 'date-list-option-num' });
			btn.createEl('span', { text: p.name,        cls: 'date-list-option-subtext' });
			btn.createEl('span', { text: p.label,       cls: 'date-list-option-text' });
			btn.addEventListener('click', () => resolvePreset(p));
			btn.addEventListener('mouseenter', () => renderPreview(previewEl, presetState));
			btn.addEventListener('mouseleave', () => renderPreview(previewEl, customActive ? buildCustomState() : this.state));
			btn.addEventListener('focus', () => {
				customActive = false;
				customSection.classList.add('date-list-hidden');
				renderPreview(previewEl, presetState);
			});
			btn.addEventListener('blur', () => renderPreview(previewEl, this.state));
			return btn;
		});

		// — Custom button (option N+1) —
		const customBtn = left.createEl('button', { cls: 'date-list-option-btn' });
		customBtn.createEl('span', { text: String(this.rangePresets.length + 1), cls: 'date-list-option-num' });
		customBtn.createEl('span', { text: 'Custom…', cls: 'date-list-option-text' });

		// — Custom section (hidden until activated) —
		const customSection = left.createEl('div', { cls: 'date-list-custom-section date-list-hidden' });

		type CustomMethod = 'between' | 'in-the-next' | 'in-the-past' | 'duration';
		let customMethod: CustomMethod = 'between';
		let customUnit = 'days';

		// Method selector
		const methodRow = customSection.createEl('div', { cls: 'date-list-duration-row date-list-method-row' });
		const customMethodDefs: { label: string; value: CustomMethod }[] = [
			{ label: 'Between',     value: 'between' },
			{ label: 'In the next', value: 'in-the-next' },
			{ label: 'In the past', value: 'in-the-past' },
			{ label: 'Duration',    value: 'duration' },
		];

		// — Between section —
		const betweenSection = customSection.createEl('div');
		betweenSection.createEl('p', { text: 'Start date', cls: 'date-list-instructions' });
		const { input: startInputEl, fp: fp1 } = createDateInputRow(betweenSection, this.defaultStartInput, 'e.g. today, 2026-06-01…');
		this.fpInstances.push(fp1);
		betweenSection.createEl('p', { text: 'End date', cls: 'date-list-instructions' });
		const defaultEnd = this.defaultEndInput || moment().add(6, 'days').format('YYYY-MM-DD');
		const { input: endInputEl, fp: fp2 } = createDateInputRow(betweenSection, defaultEnd, 'e.g. next friday, 2026-06-30…');
		this.fpInstances.push(fp2);

		// — N+Unit section (in-the-next / in-the-past / duration) —
		const nSection = customSection.createEl('div');

		// Duration start date (only for 'duration' method)
		const durStartPart = nSection.createEl('div');
		durStartPart.createEl('p', { text: 'Start date', cls: 'date-list-instructions' });
		const { input: durStartEl, fp: fp3 } = createDateInputRow(durStartPart, this.defaultStartInput, 'e.g. today, 2026-06-01…');
		this.fpInstances.push(fp3);

		const nLabel = nSection.createEl('p', { text: 'Duration', cls: 'date-list-instructions' });
		const nRow = nSection.createEl('div', { cls: 'date-list-duration-row' });
		const nInput = nRow.createEl('input', { type: 'text', cls: 'date-list-duration-input' });
		nInput.value = '7';
		const unitDefs = [
			{ label: 'Days', value: 'days' }, { label: 'Weeks', value: 'weeks' },
			{ label: 'Months', value: 'months' }, { label: 'Years', value: 'years' },
		];
		const unitBtns = unitDefs.map((u, i) => {
			const btn = nRow.createEl('button', { cls: 'date-list-duration-unit-btn' });
			btn.createEl('span', { text: String(i + 1), cls: 'date-list-option-num' });
			btn.createEl('span', { text: u.label, cls: 'date-list-option-text' });
			if (u.value === customUnit) btn.addClass('is-active');
			btn.addEventListener('click', () => {
				customUnit = u.value;
				unitBtns.forEach(b => b.removeClass('is-active'));
				btn.addClass('is-active');
				renderPreview(previewEl, buildCustomState());
			});
			return btn;
		});

		const buildCustomState = (): WizardState => {
			const n = Math.max(1, parseInt(nInput.value) || 7);
			const unit = customUnit as DurationUnit;
			if (customMethod === 'between') {
				const sm = parseDate(startInputEl.value);
				const em = parseDate(endInputEl.value);
				if (!sm.isValid()) return this.state;
				if (!em.isValid() || !em.isAfter(sm, 'day'))
					return { ...this.state, startMoment: sm, nStr: '1', stepUnit: 'days' };
				return { ...this.state, startMoment: sm, nStr: String(em.diff(sm, 'days') + 1), stepUnit: 'days' };
			}
			if (customMethod === 'in-the-next')
				return { ...this.state, startMoment: moment(), nStr: String(n), stepUnit: unit };
			if (customMethod === 'in-the-past') {
				const past = moment().subtract(n, unit);
				return { ...this.state, startMoment: past, nStr: String(Math.max(1, moment().diff(past, 'days') + 1)), stepUnit: 'days' };
			}
			// duration
			const sm = parseDate(durStartEl.value);
			if (!sm.isValid()) return this.state;
			return { ...this.state, startMoment: sm, nStr: String(n), stepUnit: unit };
		};

		const showCustomMethod = (m: CustomMethod) => {
			customMethod = m;
			betweenSection.classList.toggle('date-list-hidden', m !== 'between');
			nSection.classList.toggle('date-list-hidden', m === 'between');
			durStartPart.classList.toggle('date-list-hidden', m !== 'duration');
			nLabel.textContent = m === 'in-the-next' ? 'In the next'
				: m === 'in-the-past' ? 'In the past' : 'For';
			renderPreview(previewEl, buildCustomState());
		};
		showCustomMethod('between');

		// Method buttons (rendered after sections so showCustomMethod refs are valid)
		const methodBtns = customMethodDefs.map((method) => {
			const btn = methodRow.createEl('button', { cls: 'date-list-duration-unit-btn' });
			btn.createEl('span', { text: method.label, cls: 'date-list-option-text' });
			if (method.value === 'between') btn.addClass('is-active');
			btn.addEventListener('click', () => {
				methodBtns.forEach(b => b.removeClass('is-active'));
				btn.addClass('is-active');
				showCustomMethod(method.value);
			});
			return btn;
		});

		const showCustom = () => {
			customActive = true;
			customSection.classList.remove('date-list-hidden');
			renderPreview(previewEl, buildCustomState());
		};

		startInputEl.addEventListener('input', () => renderPreview(previewEl, buildCustomState()));
		endInputEl.addEventListener('input',   () => renderPreview(previewEl, buildCustomState()));
		durStartEl.addEventListener('input',   () => renderPreview(previewEl, buildCustomState()));
		nInput.addEventListener('input',       () => renderPreview(previewEl, buildCustomState()));

		customBtn.addEventListener('click', () => { showCustom(); startInputEl.focus(); });
		customBtn.addEventListener('focus', () => showCustom());

		const submitCustom = () => {
			const n = parseInt(nInput.value);
			if (customMethod === 'between') {
				const sm = parseDate(startInputEl.value);
				if (!sm.isValid()) { new Notice('Invalid start date.'); startInputEl.focus(); return; }
				const em = parseDate(endInputEl.value);
				if (!em.isValid()) { new Notice('Invalid end date.'); endInputEl.focus(); return; }
				if (!em.isSameOrAfter(sm, 'day')) { new Notice('End date must be on or after start date.'); endInputEl.focus(); return; }
				this.confirmed = true;
				this.resolve({ startInput: startInputEl.value, startMoment: sm, endInput: endInputEl.value, endMoment: em });
			} else if (customMethod === 'in-the-next') {
				if (isNaN(n) || n < 1) { new Notice('Enter a positive number.'); nInput.focus(); return; }
				const sm = moment();
				const em = sm.clone().add(n, customUnit as DurationUnit);
				this.confirmed = true;
				this.resolve({ startInput: sm.format('YYYY-MM-DD'), startMoment: sm, endInput: em.format('YYYY-MM-DD'), endMoment: em });
			} else if (customMethod === 'in-the-past') {
				if (isNaN(n) || n < 1) { new Notice('Enter a positive number.'); nInput.focus(); return; }
				const em = moment();
				const sm = em.clone().subtract(n, customUnit as DurationUnit);
				this.confirmed = true;
				this.resolve({ startInput: sm.format('YYYY-MM-DD'), startMoment: sm, endInput: em.format('YYYY-MM-DD'), endMoment: em });
			} else {
				const sm = parseDate(durStartEl.value);
				if (!sm.isValid()) { new Notice('Invalid start date.'); durStartEl.focus(); return; }
				if (isNaN(n) || n < 1) { new Notice('Enter a positive number.'); nInput.focus(); return; }
				const em = sm.clone().add(n, customUnit as DurationUnit);
				this.confirmed = true;
				this.resolve({ startInput: durStartEl.value, startMoment: sm, endInput: em.format('YYYY-MM-DD'), endMoment: em });
			}
			this.close();
		};

		[startInputEl, endInputEl, durStartEl, nInput].forEach(el =>
			el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitCustom(); } }),
		);

		// — Actions row —
		const actions = left.createEl('div', { cls: 'date-list-modal-actions' });
		const okBtn = actions.createEl('button', { cls: 'date-list-ok-btn', text: 'OK' });
		okBtn.addEventListener('click', () => {
			if (customActive) { submitCustom(); return; }
			const fi = presetBtns.findIndex(b => b === activeDocument.activeElement);
			resolvePreset(this.rangePresets[fi >= 0 ? fi : 0]!);
		});
		const configBtn = actions.createEl('button', { cls: 'date-list-configure-btn' });
		setIcon(configBtn, 'settings');
		configBtn.createEl('span', { text: 'Configure format…' });
		configBtn.addEventListener('click', () => { this.confirmed = true; this.resolve(CONFIGURE); this.close(); });

		// — Keyboard navigation —
		const allBtns = [...presetBtns, customBtn];
		const customInputs = [startInputEl, endInputEl, durStartEl, nInput];
		this.containerEl.addEventListener('keydown', (e: KeyboardEvent) => {
			const active = activeDocument.activeElement;
			if (customInputs.includes(active as HTMLInputElement)) return;
			const fi = allBtns.findIndex(b => b === active);
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				if (fi === allBtns.length - 1) {
					showCustom();
					(customMethod === 'between' ? startInputEl : customMethod === 'duration' ? durStartEl : nInput).focus();
				} else allBtns[(fi + 1) % allBtns.length]?.focus();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				allBtns[(fi - 1 + allBtns.length) % allBtns.length]?.focus();
			} else if (e.key === 'Enter' && fi >= 0 && fi < presetBtns.length) {
				e.preventDefault();
				resolvePreset(this.rangePresets[fi]!);
			} else {
				const idx = parseInt(e.key) - 1;
				if (isNaN(idx)) return;
				e.preventDefault();
				if (idx >= 0 && idx < presetBtns.length) resolvePreset(this.rangePresets[idx]!);
				else if (idx === presetBtns.length) { showCustom(); startInputEl.focus(); }
			}
		});

		window.setTimeout(() => presetBtns[0]?.focus(), 50);
	}

	onClose() {
		this.fpInstances.forEach(fp => fp.destroy());
		if (!this.confirmed) this.resolve(BACK);
		this.contentEl.empty();
	}
}

// -------------------------------------------------------------------
// FilterRangeModal
// -------------------------------------------------------------------
class FilterRangeModal extends Modal {
	private defaultMethod: 'between' | 'in-the-next' | 'in-the-past' | 'next-n';
	private defaultStartInput: string;
	private defaultEndInput: string;
	private defaultN: string;
	private defaultUnit: string;
	private selectedWeekdays: number[];
	private state: WizardState;
	private resolve: (value: FilterRangeResult | typeof BACK | typeof CONFIGURE) => void;
	private confirmed = false;
	private fpInstances: FpInstance[] = [];

	constructor(
		app: App,
		defaultMethod: 'between' | 'in-the-next' | 'in-the-past' | 'next-n',
		defaultStartInput: string,
		defaultEndInput: string,
		defaultN: string,
		defaultUnit: string,
		selectedWeekdays: number[],
		state: WizardState,
		resolve: (value: FilterRangeResult | typeof BACK | typeof CONFIGURE) => void,
	) {
		super(app);
		this.defaultMethod     = defaultMethod;
		this.defaultStartInput = defaultStartInput;
		this.defaultEndInput   = defaultEndInput;
		this.defaultN          = defaultN;
		this.defaultUnit       = defaultUnit;
		this.selectedWeekdays  = selectedWeekdays;
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
		const left  = body.createEl('div', { cls: 'date-list-modal-left' });
		const right = body.createEl('div', { cls: 'date-list-modal-right' });

		// — Method buttons —
		left.createEl('p', { text: 'Range method', cls: 'date-list-instructions' });
		const methodRow = left.createEl('div', { cls: 'date-list-duration-row' });
		const methods: { label: string; value: 'between' | 'in-the-next' | 'in-the-past' | 'next-n' }[] = [
			{ label: 'Between',     value: 'between' },
			{ label: 'In the next', value: 'in-the-next' },
			{ label: 'In the past', value: 'in-the-past' },
			{ label: 'Next N',      value: 'next-n' },
		];
		let selectedMethod = this.defaultMethod;

		// — Between section —
		const betweenSection = left.createEl('div');
		betweenSection.createEl('p', { text: 'Start date', cls: 'date-list-instructions' });
		const { input: startInput, fp: fp1 } = createDateInputRow(betweenSection, this.defaultStartInput, 'e.g. today, +7, next monday, 2026-01-15…');
		this.fpInstances.push(fp1);
		betweenSection.createEl('p', { text: 'End date', cls: 'date-list-instructions' });
		const { input: endInput, fp: fp2 } = createDateInputRow(betweenSection, this.defaultEndInput, 'e.g. tomorrow, +7, next friday, 2026-12-31…');
		this.fpInstances.push(fp2);

		// — Duration section (in-the-next / in-the-past) —
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

		// — Count section (next-n) —
		const countSection = left.createEl('div');
		countSection.createEl('p', { text: 'Count', cls: 'date-list-instructions' });
		const countInput = countSection.createEl('input', { type: 'text', cls: 'date-list-duration-input' });
		countInput.value = this.defaultN;
		countInput.placeholder = 'E.g. 7';

		// — Preview —
		right.createEl('div', { text: 'Preview', cls: 'date-list-preview-label' });
		const previewEl = right.createEl('div', { cls: 'date-list-preview-sidebar' });

		const buildState = (): WizardState => {
			if (selectedMethod === 'between') {
				const sm = parseDate(startInput.value);
				const em = parseDate(endInput.value);
				if (!sm.isValid()) return this.state;
				if (!em.isValid() || !em.isAfter(sm, 'day')) return { ...this.state, startMoment: sm, nStr: '1', stepUnit: 'days' };
				return { ...this.state, startMoment: sm, nStr: String(em.diff(sm, 'days') + 1), stepUnit: 'days' };
			}
			if (selectedMethod === 'in-the-next') {
				const n = Math.max(1, parseInt(nInput.value) || 1);
				return { ...this.state, startMoment: moment(), nStr: String(n), stepUnit: selectedUnit };
			}
			if (selectedMethod === 'in-the-past') {
				const n = Math.max(1, parseInt(nInput.value) || 1);
				const pastStart = moment().subtract(n, selectedUnit as DurationUnit);
				return { ...this.state, startMoment: pastStart, nStr: String(Math.max(1, moment().diff(pastStart, 'days') + 1)), stepUnit: 'days' };
			}
			const count = Math.max(1, parseInt(countInput.value) || 1);
			const end = nthWeekdayOccurrence(moment(), this.selectedWeekdays, count);
			return { ...this.state, startMoment: moment(), nStr: String(end.diff(moment(), 'days') + 1), stepUnit: 'days' };
		};

		const updatePreview = () => renderPreview(previewEl, buildState());

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

		const showMethod = (m: typeof selectedMethod) => {
			selectedMethod = m;
			betweenSection.classList.toggle('date-list-hidden', m !== 'between');
			durationSection.classList.toggle('date-list-hidden', m !== 'in-the-next' && m !== 'in-the-past');
			countSection.classList.toggle('date-list-hidden', m !== 'next-n');
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
				window.setTimeout(() => {
					if (method.value === 'between') startInput.focus();
					else if (method.value === 'next-n') countInput.focus();
					else nInput.focus();
				}, 30);
			});
			btn.addEventListener('focus', () => {
				methodBtns.forEach(b => b.removeClass('is-active'));
				btn.addClass('is-active');
				showMethod(method.value);
			});
			return btn;
		});

		const submit = () => {
			if (selectedMethod === 'between') {
				const sm = parseDate(startInput.value);
				if (!sm.isValid()) { new Notice('Invalid start date.'); startInput.focus(); return; }
				const em = parseDate(endInput.value);
				if (!em.isValid()) { new Notice('Invalid end date.'); endInput.focus(); return; }
				if (!em.isSameOrAfter(sm, 'day')) { new Notice('End date must be on or after start date.'); endInput.focus(); return; }
				this.confirmed = true;
				this.resolve({
					method: 'between',
					startInput: startInput.value, startMoment: sm,
					endInput: endInput.value, endMoment: em,
					nStr: String(Math.max(1, em.diff(sm, 'days') + 1)), stepUnit: 'days',
				});
			} else if (selectedMethod === 'in-the-next' || selectedMethod === 'in-the-past') {
				const n = parseInt(nInput.value);
				if (isNaN(n) || n < 1) { new Notice('Enter a positive number.'); nInput.focus(); return; }
				this.confirmed = true;
				this.resolve({
					method: selectedMethod,
					startInput: '', startMoment: moment(),
					endInput: '', endMoment: moment(),
					nStr: String(n), stepUnit: selectedUnit,
				});
			} else {
				const count = parseInt(countInput.value);
				if (isNaN(count) || count < 1) { new Notice('Enter a positive number.'); countInput.focus(); return; }
				this.confirmed = true;
				this.resolve({
					method: 'next-n',
					startInput: '', startMoment: moment(),
					endInput: '', endMoment: moment(),
					nStr: String(count), stepUnit: 'days',
				});
			}
			this.close();
		};

		startInput.addEventListener('input', updatePreview);
		endInput.addEventListener('input',   updatePreview);
		nInput.addEventListener('input',     updatePreview);
		countInput.addEventListener('input', updatePreview);

		startInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
		endInput.addEventListener('keydown',   (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
		nInput.addEventListener('keydown',     (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
		countInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

		this.containerEl.addEventListener('keydown', (e: KeyboardEvent) => {
			const active = activeDocument.activeElement;
			if (active === startInput || active === endInput || active === nInput || active === countInput) return;
			const mIdx = methodBtns.findIndex(b => b === active);
			const uIdx = unitBtns.findIndex(b => b === active);
			if (mIdx >= 0) {
				if (e.key === 'ArrowRight') { e.preventDefault(); methodBtns[(mIdx + 1) % methodBtns.length]?.focus(); }
				else if (e.key === 'ArrowLeft') { e.preventDefault(); methodBtns[(mIdx - 1 + methodBtns.length) % methodBtns.length]?.focus(); }
				else if (e.key === 'ArrowDown') {
					e.preventDefault();
					if (selectedMethod === 'between') startInput.focus();
					else if (selectedMethod === 'next-n') countInput.focus();
					else nInput.focus();
				}
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

		const frActions = left.createEl('div', { cls: 'date-list-modal-actions' });
		frActions.createEl('button', { cls: 'date-list-ok-btn', text: 'OK' }).addEventListener('click', submit);
		const frConfigBtn = frActions.createEl('button', { cls: 'date-list-configure-btn' });
		setIcon(frConfigBtn, 'settings');
		frConfigBtn.createEl('span', { text: 'Configure format…' });
		frConfigBtn.addEventListener('click', () => {
			this.confirmed = true;
			this.resolve(CONFIGURE);
			this.close();
		});

		updatePreview();
		window.setTimeout(() => {
			const defaultMethodIdx = methods.findIndex(m => m.value === this.defaultMethod);
			methodBtns[defaultMethodIdx >= 0 ? defaultMethodIdx : 0]?.focus();
		}, 50);
	}

	onClose() {
		this.fpInstances.forEach(fp => fp.destroy());
		if (!this.confirmed) this.resolve(BACK);
		this.contentEl.empty();
	}
}



// -------------------------------------------------------------------
// @ Date Suggest
// -------------------------------------------------------------------
interface DateSuggestion {
	insert: string;
	display: string;
	label?: string;
	placeholder?: true;
}

const SUGGEST_PRESETS: { label: string; fn: () => MomentInstance }[] = [
	{ label: 'today',       fn: () => moment() },
	{ label: 'tomorrow',    fn: () => moment().add(1, 'days') },
	{ label: 'yesterday',   fn: () => moment().subtract(1, 'days') },
	{ label: 'next monday', fn: () => parseDate('next monday') },
	{ label: 'next week',   fn: () => parseDate('next week') },
	{ label: 'next month',  fn: () => parseDate('next month') },
];

class DateSuggest extends EditorSuggest<DateSuggestion> {
	private plugin: DateListPlugin;

	constructor(app: App, plugin: DateListPlugin) {
		super(app);
		this.plugin = plugin;
		this.setInstructions([
			{ command: '↵', purpose: 'insert date' },
			{ command: 'type', purpose: 'enter any date expression' },
		]);
	}

	onTrigger(cursor: { line: number; ch: number }, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
		const trigger = this.plugin.settings.suggestTrigger || '@';
		const line = editor.getLine(cursor.line);
		const before = line.slice(0, cursor.ch);
		const triggerIdx = before.lastIndexOf(trigger);
		if (triggerIdx === -1) return null;
		if (triggerIdx > 0 && !/\s/.test(line[triggerIdx - 1]!)) return null;
		const query = before.slice(triggerIdx + trigger.length);
		if (query.length > 40) return null;
		return { start: { line: cursor.line, ch: triggerIdx }, end: cursor, query };
	}

	getSuggestions(context: EditorSuggestContext): DateSuggestion[] {
		const s = this.plugin.settings;
		const fmt = s.defaultFormat || 'YYYY-MM-DD';
		const query = context.query.trim();

		const toSuggestion = (m: MomentInstance, label?: string): DateSuggestion => {
			const formatted = m.format(fmt);
			const insert = s.defaultWikiLinks
				? (s.defaultAlias ? `[[${formatted}|${m.format(s.defaultAlias)}]]` : `[[${formatted}]]`)
				: formatted;
			return { insert, display: m.format('ddd, MMM D, YYYY'), label };
		};

		// Deduplicate presets by resolved date
		const seen = new Set<string>();
		const presets = SUGGEST_PRESETS
			.map(p => ({ label: p.label, m: p.fn() }))
			.filter(p => { const k = p.m.format('YYYY-MM-DD'); return seen.has(k) ? false : (seen.add(k), true); });

		if (!query) {
			return presets.map(p => toSuggestion(p.m, p.label));
		}

		const q = query.toLowerCase();
		const matchingPresets = presets.filter(p => p.label.startsWith(q));
		const parsed = parseDate(query);

		if (parsed.isValid()) {
			const parsedKey = parsed.format('YYYY-MM-DD');
			const extras = matchingPresets.filter(p => p.m.format('YYYY-MM-DD') !== parsedKey);
			return [toSuggestion(parsed), ...extras.map(p => toSuggestion(p.m, p.label))];
		}

		if (matchingPresets.length > 0) {
			return matchingPresets.map(p => toSuggestion(p.m, p.label));
		}

		// Nothing matched yet — keep the popup open by showing all presets so the
		// user can keep typing until their input resolves to a valid date.
		return presets.map(p => toSuggestion(p.m, p.label));
	}

	renderSuggestion(value: DateSuggestion, el: HTMLElement): void {
		if (value.placeholder) {
			el.createEl('span', { text: '…', cls: 'date-list-suggest-placeholder' });
			return;
		}
		if (value.label) {
			el.createEl('span', { text: value.label, cls: 'date-list-suggest-label' });
		}
		el.createEl('span', { text: value.insert, cls: 'date-list-suggest-insert' });
		el.createEl('span', { text: value.display, cls: 'date-list-suggest-display' });
	}

	selectSuggestion(value: DateSuggestion, _evt: MouseEvent | KeyboardEvent): void {
		if (value.placeholder) return;
		const context = this.context;
		if (!context) return;
		context.editor.replaceRange(value.insert, context.start, context.end);
	}
}
