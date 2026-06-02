# Date List

An Obsidian plugin for inserting formatted date lists and single dates, with a live-preview wizard and inline autocomplete.

## Features

In the plugin settings, you can customize your default preferences. For example, if you use Daily Notes, you may have a dating convention like YYYY-MM-DD, but prefer a more readable format in the alias. 

![[settings.png]]

### Insert Date List

Quickly add a list of dates according to your search criteria. The most common options are provided first: this week, next week, this month, etc.

![[this-week.png]]

Alternately, you can just return the next *n* number of days, say for example if you are going on a ten day vacation and you want to plan your itinerary.

![[range-duration.png]]

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

The **Date List: Filter Dates** command allows you to find all instances of a specific day given the search parameters. For example, you can easily find the weekends for the next three months, or the dates of a recurring meeting you have.
![[day-select.png]]
![[range-select.png]]

---

### Quick Insert

**Date List: Quick insert** drops a single formatted date at the cursor. Pick from common presets (today, tomorrow, yesterday, next Monday, next week, next month) or type any custom date expression.

![[quick-insert.png]]

Even faster, type `@` (or your configured trigger) anywhere in a note to open a date suggestion popup. Arrow through the presets or keep typing any date expression — the suggestion updates live as you type.

![[inline-insert.png]]

### Date Inputs

You are able to write dates in a number of natural ways, including: 

| Input example                          | Resolves to                          |
| -------------------------------------- | ------------------------------------ |
| `today`, `tomorrow`, `yesterday`       | Relative to now                      |
| `+7`, `-3`                             | Days from today                      |
| `next monday` / `last friday`          | Next or last occurrence of a weekday |
| `next week`, `next month`, `next year` | Start of that period                 |
| `in 3 weeks`, `2 months ago`           | Relative offset                      |
| `june 1`, `Jun 1st`                    | That date in the current year        |
| `june 1, 2027`                         | A specific date                      |
| `6/1`, `6/1/2027`                      | Month/day shorthand                  |
| `2027-06-01`                           | ISO 8601                             |

You can also use a calendar popup: 

![[calendar.png]]

The inserted date uses your configured default format, wiki links, and alias settings.

---

### Configure Date List

In the plugin settings, you can customize your default date format preferences. For example, if you use Daily Notes, you may have a dating convention like YYYY-MM-DD, but prefer a more readable format in the alias. 

![[settings.png]]

**Date List: Configure Date List** runs a wizard to set your format defaults without inserting anything — useful for changing defaults without having to insert a list first.

---

## Keyboard navigation

All screens support full keyboard control:

- **↑ / ↓** — move between options
- **1, 2, 3…** — jump to option by number
- **Enter** — confirm the focused option
- **Escape / ←** — go back
- **OK button** — available on every screen for mouse-only users

## Feedback and contributions

Let me know if you have any feedback or suggestions! 