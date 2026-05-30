# Date List

An Obsidian plugin that inserts a formatted list of dates at your cursor through a step-by-step wizard with a live preview.

## Usage

Open the command palette and run **Date List: Insert**. The wizard walks you through each step, with a live preview panel on the right side of every screen updating as you make choices.

| Step | What you choose |
|------|----------------|
| Start date | Any date in natural language |
| Quantity | How many days / weeks / months to span |
| Time unit | Days, Weeks, or Months |
| Date format | Your default, ISO, short, or a custom Moment.js string |
| Wiki links | Wrap dates in `[[...]]` or leave as plain text |
| Alias *(optional)* | A display alias for each wiki link, e.g. `[[2026-01-15\|Thu, Jan 15]]` |
| Prefix | None, `- `, `- [ ] `, or a custom prefix |
| Postfix | None, ` - `, ` — `, or a custom postfix |

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

All wizard defaults are configurable under **Settings → Date List**. Your last-used choices are also saved automatically after each insert, so the wizard pre-fills with your previous selections.

| Setting | Description |
|---------|-------------|
| Default start date | Pre-filled start date (e.g. `today`, `+7`, `next monday`) |
| Default date format | Moment.js format string shown as the first format option |
| Default quantity | Pre-filled quantity |
| Default time unit | Pre-selected unit (Days, Weeks, or Months) |
| Default wiki links | Whether to wrap dates in `[[...]]` by default |
| Default alias format | Moment.js format for the wiki link alias (leave blank for none) |
| Default prefix | Text prepended to each date by default |
| Default postfix | Text appended to each date by default |

