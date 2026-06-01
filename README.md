# Date List

An Obsidian plugin for inserting formatted date lists and single dates, with a live-preview wizard and inline autocomplete.

## Commands

### Insert Date List

Open the command palette and run **Date List: Insert Date List**. The first screen shows six common range presets (this week, next week, this month, etc.) — click or press the matching number to insert immediately.

For a custom range, choose **Custom…** (option 7) to expand an inline date picker with four methods:

| Method | What it generates |
|--------|------------------|
| **Between** | All dates from a specific start date to a specific end date |
| **In the next** | N days / weeks / months / years forward from today |
| **In the past** | N days / weeks / months / years back to today |
| **Duration** | N days / weeks / months / years forward from a chosen start date |

All date fields accept natural language — see [Date input formats](#date-input-formats) below.

A **⚙ Configure format…** button is available on every screen to set the date format, wiki links, prefix, and postfix before inserting.

---

### Filter Dates

**Date List: Filter Dates** inserts dates filtered to specific days of the week. Choose which days to include, then define the range using one of four methods: Between two dates, In the next N, In the past N, or the Next N occurrences of the selected weekday(s).

---

### Quick Insert

**Date List: Quick insert** drops a single formatted date at the cursor. Pick from common presets (today, tomorrow, yesterday, next Monday, next week, next month) or type any custom date expression.

---

### Inline Autocomplete

Type `@` (or your configured trigger) anywhere in a note to open a date suggestion popup. Arrow through the presets or keep typing any date expression — the suggestion updates live as you type.

| Input | Resolves to |
|-------|-------------|
| *(trigger alone)* | Shows preset options |
| `today`, `tomorrow`, `yesterday` | Relative to now |
| `+7`, `-3` | Days from today |
| `next monday` | Next occurrence of that weekday |
| `next week`, `next month` | Start of next week / month |
| `june 1`, `Jun 1st` | That date in the current year |
| `june 1, 2027` | A specific date |
| `2027-06-01` | ISO 8601 |

The inserted date uses your configured default format, wiki links, and alias settings.

---

### Configure Date List

**Date List: Configure Date List** runs a wizard to set your format defaults without inserting anything — useful for changing defaults without having to insert a list first.

---

## Date input formats

All date input fields across the plugin accept the same natural language expressions:

| Input | Resolves to |
|-------|-------------|
| `today`, `tomorrow`, `yesterday` | Relative to now |
| `+7`, `-3` | Days from today |
| `next monday` / `last friday` | Next or last occurrence of a weekday |
| `next week`, `next month`, `next year` | Start of that period |
| `in 3 weeks`, `2 months ago` | Relative offset |
| `june 1`, `Jun 1st` | That date in the current year |
| `june 1, 2027` | A specific date |
| `6/1`, `6/1/2027` | Month/day shorthand |
| `2027-06-01` | ISO 8601 |

A **📅** calendar icon on each date field opens a visual date picker.

---

## Keyboard navigation

All screens support full keyboard control:

- **↑ / ↓** — move between options
- **1, 2, 3…** — jump to option by number
- **Enter** — confirm the focused option
- **Escape / ←** — go back
- **OK button** — available on every screen for mouse-only users

---

## Settings

**Settings → Date List**

| Setting | Description |
|---------|-------------|
| Inline date trigger | Character(s) that activate the autocomplete (default: `@`). Avoid `/` if Slash Commands is enabled. |
| Default date format | Moment.js format string used as the first option in the format picker |
| Default wiki links | Whether to wrap dates in `[[...]]` by default |
| Default alias format | Moment.js format for the wiki link display alias (blank for none) |
| Default prefix | Text prepended to each date (e.g. `- `, `- [ ] `) |
| Default postfix | Text appended to each date (e.g. ` :: `, ` — `) |
