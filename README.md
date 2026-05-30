# Date List

An Obsidian plugin that inserts a formatted list of dates at your cursor through a step-by-step wizard.

## Usage

Run **Insert date list** from the command palette. The wizard walks you through five steps:

| Step | What you choose |
|------|----------------|
| Start date | Any date in natural language |
| Quantity | How many days / weeks / months to span |
| Time unit | Days, Weeks, or Months |
| Date format | Your default, ISO, short, or a custom Moment.js string |
| Wiki links | Wrap dates in `[[...]]` or leave as plain text |
| Prefix | None, `- `, `- [ ] `, or a custom prefix |

### Date input formats

The start date field accepts a wide range of inputs:

| Input | Resolves to |
|-------|-------------|
| `today`, `tomorrow`, `yesterday` | Relative to now |
| `+7`, `-3` | Days from today |
| `next monday` | Next occurrence of that weekday |
| `june 1`, `Jun 1st` | That date in the current year |
| `june 1, 2027` | A specific date |
| `6/1`, `6/1/2027` | Month/day shorthand |
| `2027-06-01` | ISO 8601 |

### Keyboard navigation

All picker screens support full keyboard control:

- **↑ / ↓** — move between options
- **1, 2, 3…** — select by number
- **Enter** — confirm focused option
- **Escape / ←** — go back to the previous step

## Settings

**Default date format** — the Moment.js format string used as the first option in the format picker (e.g. `YYYY-MM-DD`, `MMMM Do, YYYY`). Configure it under Settings → Date List.

## Manual installation

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/lumargh/obsidian-date-list/releases/latest).
2. Copy all three files into `<your vault>/.obsidian/plugins/date-list/`.
3. Reload Obsidian and enable the plugin under Settings → Community Plugins.

## Development

```bash
git clone https://github.com/lumargh/obsidian-date-list.git
cd obsidian-date-list
npm install
npm run dev
```

Copy the folder into your vault's `.obsidian/plugins/` directory and enable it in Obsidian.
