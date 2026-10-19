# Task board

The task board ships inside the same plugin as the Pomodoro timer. Open it from the board button on
the timer pill/card or with **`B`**; it renders as a modal over the app and closes with `×`, `Esc`
(when focus is not in a text field) or a click on the backdrop.

## Using the board

| Area | What it does |
|---|---|
| Header | Editable board title, search, ordering, new task, label manager, board menu (export/import), close |
| Rail | Smart sections with live counts plus the board's labels as filters |
| Stats bar | Estimated time, To complete, Elapsed time, Completed for the active filter; estimate-scope toggle |
| Columns | The board's lists; each header has an inline-editable title, card count, a `⋯` menu and a drag handle |
| Cards | Title, labels, priority flag, due chip, subtask progress, estimate/time, and quick actions (focus, complete, menu) |
| Composer | New task with every field, including subtask rows before creation |
| Drawer | Full task editing after creation |

### Lists and completion
- Lists are free-form columns. A list can be marked as a **completion list**: cards entering it
  become completed (timestamped) and leaving it clears completion.
- The default board ships `To Do / Doing / Done`, with `Done` marked as the completion list.
- Deleting a list requires choosing a destination list for its cards. The last completion list cannot
  be deleted while it is the only one.

### Sections
| Section | Filter |
|---|---|
| All tasks | every card |
| Today | due date is today |
| Overdue | due date before today and not completed |
| Tomorrow | due date is tomorrow |
| This week | due date between today and Sunday of the current ISO week |
| Next 7 days | due date between today and today+6 (rolling; overlaps “This week” on purpose) |
| High / Medium / Low priority | matching priority |
| No due date | no due date |
| Completed | has a completion timestamp |

Search and label filters apply on top of the active section.

### Labels
- Labels are board-wide: create, recolor and delete them from the **label manager** (header `#`
  button, or *Manage labels* inside the picker).
- In the drawer, **+ Label** expands an inline panel with every label as a checkbox. The panel is
  part of the drawer layout (not a floating popover), so it always stays inside the drawer and
  spans its width; assigned labels appear as removable chips above it.
- Deleting a label removes it from every card; the label manager asks for confirmation.

### Metrics
For the filtered set `S`:

| Metric | Rule |
|---|---|
| Estimated time | Σ estimates of `S`; with the *open only* toggle, only tasks that are not completed |
| To complete | count of not-completed tasks in `S` |
| Elapsed time | Σ tracked focus time of `S` |
| Completed | count of completed tasks in `S` |

### Focus time
- **Focus** links a task to the timer (card action, drawer button, or the same action again to
  resume). The timer measures real running focus time.
- Pausing, resetting, skipping, switching tasks and completing a focus phase settle the segment and
  send `task.addTime` with a stable `creditId`; a completed focus phase also adds one pomodoro.
- If the host is unreachable the credit stays in a local queue and is retried when the board opens or
  loads. Replayed phases after a reload are credited once, at their nominal duration.
- Breaks are never credited to a task.

## Board menu

- **Export JSON** downloads the host export envelope (`pomodoro-board-YYYY-MM-DD.json`).
- **Import JSON** reads a file, validates it, shows a summary (`N lists, N tasks, N labels`) and
  replaces the board after confirmation. The host validates the snapshot again before touching data.

## Data model (SQLite)

Database: `$DSH_HOME/pomodoro/board.sqlite` (override with `config.dbPath`). WAL mode, foreign keys
on, a daily rotating backup at `board.sqlite.bak` (previous copies keep `.bak.1` … `.bak.7`).

| Table | Columns |
|---|---|
| `meta` | `key`, `value` — board id/title/timestamps, `revision`, `backup_at` |
| `lists` | `id`, `title`, `position`, `is_done`, `created_at`, `updated_at` |
| `labels` | `id`, `name` (unique, case-insensitive), `color`, `created_at` |
| `tasks` | `id`, `list_id`, `title`, `notes`, `priority`, `due_date` (civil `YYYY-MM-DD`), `estimate_min`, `time_spent_ms`, `pomodoros`, `completed_at`, `position`, `created_at`, `updated_at` |
| `subtasks` | `id`, `task_id`, `title`, `done`, `position`, `created_at` |
| `task_labels` | `task_id`, `label_id` |
| `time_credits` | `id` (the credit id), `task_id`, `delta_ms`, `pomodoros`, `created_at` — idempotency ledger |

`meta.revision` advances once per mutation and drives cross-window refresh.

## HTTP routes

Exact, authenticated routes registered through `ctx.connection.fetch.register`:

| Route | Method | Purpose |
|---|---|---|
| `/api/pomodoro-board/state` | GET | `{ revision, board }` |
| `/api/pomodoro-board/revision` | GET | `{ revision }` for cheap polling |
| `/api/pomodoro-board/command` | POST | `{ op, payload }` → `{ changed, revision, board }` |
| `/api/pomodoro-board/export` | GET | JSON attachment (`dsh-pomodoro-board` envelope) |
| `/api/pomodoro-board/import` | POST | `{ mode: 'replace', board }` → `{ revision, board }` |

Commands: `board.rename`, `list.create/rename/reorder/setDone/delete`, `task.create/update/move/
delete/addTime`, `subtask.create/update/delete`, `label.create/update/delete`.
`task.addTime` requires `taskId`, `creditId`, `deltaMs` (0–24 h) and optional `pomodoros` (0/1); a
repeated `creditId` is a no-op.

Requests are limited to 1 MB for commands and 5 MB for imports; the host validates fields, enums,
dates and limits before writing. Errors answer `{ error: { code, message, details? } }`.

## Limits

| Limit | Value |
|---|---|
| Tasks per board | 500 |
| Lists | 20 |
| Labels | 50 |
| Subtasks per task | 100 |
| Time credits per task | 5000 |
| Title / notes | 500 / 20 000 characters |
| Estimate | 0–10 080 minutes |

## Out of scope (v1)

Multiple boards, sharing/collaboration, attachments, comments/activity, recurring tasks, due-date
reminders, calendar view, custom fields, templates, archiving and WIP limits.
