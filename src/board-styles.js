/**
 * Stylesheet for the task-board overlay.
 *
 * Only `--dsw-*` design tokens are used, so the board follows the active
 * light/dark theme. Injected once per page by the plugin's `apply` (the factory
 * can re-run under HMR, hence the idempotence guard).
 *
 * @module dsh-plugin-pomodoro/board-styles
 */

/** Stylesheet text. */
export const BOARD_CSS = `
.tb-backdrop {
  position: fixed; inset: 0; z-index: 50;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, .45);
  backdrop-filter: blur(2px);
  pointer-events: auto;
  animation: tb-fade .12s ease-out;
}
@keyframes tb-fade { from { opacity: 0; } to { opacity: 1; } }
.tb-panel {
  display: flex; flex-direction: column;
  width: min(1240px, 100%); height: min(860px, 100%);
  min-height: 0;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  box-shadow: var(--dsw-shadow-lv3, 0 24px 64px rgba(0,0,0,.28));
  overflow: hidden;
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  animation: tb-rise .16s ease-out;
}
@keyframes tb-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.tb-header {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.tb-titleInput {
  min-width: 140px; max-width: 320px; flex: 0 1 240px;
  padding: 5px 8px; border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 14px; font-weight: 600;
}
.tb-titleInput:hover { border-color: var(--dsw-alias-border-l2); }
.tb-titleInput:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-layer-2); }
.tb-spacer { flex: 1; }
.tb-search {
  display: flex; align-items: center; gap: 6px;
  flex: 0 1 260px; min-width: 160px;
  padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary);
}
.tb-search input {
  flex: 1; min-width: 0; border: 0; background: transparent; outline: none;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px;
}
.tb-search:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.tb-iconBtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; flex: none;
  border: 1px solid transparent; border-radius: 7px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 13px; line-height: 1; cursor: pointer;
}
.tb-iconBtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary); }
.tb-iconBtn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.tb-iconBtn[data-active='true'] { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-border-l2); }
.tb-select {
  padding: 4px 8px; border-radius: 8px; font: inherit; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
}
.tb-errorBar {
  display: flex; align-items: center; gap: 8px;
  margin: 8px 14px 0; padding: 6px 10px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2); font-size: 12px;
}
.tb-errorBar button { margin-left: auto; }
.tb-labelFilters { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 14px 0; }
.tb-labelFilter {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px;
}
.tb-labelFilter[data-active='true'] { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.tb-body { flex: 1; display: flex; min-height: 0; }
.tb-rail {
  width: 214px; flex: none; display: flex; flex-direction: column; gap: 2px;
  padding: 10px; overflow: auto;
  border-right: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}
.tb-railHeading {
  margin: 6px 8px 4px; font-size: 10.5px; font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}
.tb-railItem {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 8px; border: 0; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12.5px;
  text-align: left; cursor: pointer;
}
.tb-railItem:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary); }
.tb-railItem[data-active='true'] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-shadow-lv1, 0 1px 2px rgba(0,0,0,.08)); font-weight: 600; }
.tb-railItem:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -1px; }
.tb-railLabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-railCount { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.tb-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.tb-stats {
  display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap;
  padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.tb-stat {
  flex: 1 1 140px; min-width: 120px;
  display: flex; flex-direction: column; gap: 2px;
  padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.tb-statLabel { font-size: 10.5px; letter-spacing: .03em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.tb-statValue { font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
.tb-modeToggle { display: inline-flex; margin-left: auto; align-self: center; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; overflow: hidden; }
.tb-modeToggle button {
  padding: 4px 8px; border: 0; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 11px;
}
.tb-modeToggle button[data-active='true'] { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-foreground, #fff); }
.tb-columns { flex: 1; display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; overflow: auto; min-height: 0; }
.tb-column {
  display: flex; flex-direction: column; flex: none;
  width: 286px; max-height: 100%; min-height: 96px;
  padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}
.tb-column[data-done='true'] { background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-2)); }
.tb-columnHeader { display: flex; align-items: center; gap: 6px; padding: 2px 2px 8px; }
.tb-columnTitle {
  flex: 1; min-width: 0; padding: 3px 6px; border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12.5px; font-weight: 650;
}
.tb-columnTitle:hover { border-color: var(--dsw-alias-border-l2); }
.tb-columnTitle:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-layer-1); }
.tb-columnCount { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.tb-columnTasks { display: flex; flex-direction: column; gap: 6px; overflow: auto; padding: 0 1px; min-height: 8px; }
.tb-card {
  position: relative;
  display: flex; flex-direction: column; gap: 5px;
  padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  cursor: pointer;
  transition: border-color .12s ease, box-shadow .12s ease;
}
.tb-card:hover { border-color: var(--dsw-alias-border-l3); box-shadow: var(--dsw-shadow-lv1, 0 2px 4px rgba(0,0,0,.08)); }
.tb-card:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.tb-cardTop { display: flex; align-items: flex-start; gap: 6px; }
.tb-cardTitle { flex: 1; min-width: 0; font-size: 12.5px; line-height: 18px; word-break: break-word; }
.tb-card[data-completed='true'] .tb-cardTitle { text-decoration: line-through; color: var(--dsw-alias-label-tertiary); }
.tb-card[data-active='true'] { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary) inset; }
.tb-cardMeta { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.tb-chip {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 0 6px; border-radius: 5px; font-size: 10.5px; line-height: 17px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
}
.tb-chip[data-tone='overdue'] { color: var(--dsw-alias-state-error-primary); }
.tb-chip[data-tone='today'] { color: var(--dsw-alias-state-warn-primary); }
.tb-chip[data-tone='soon'] { color: var(--dsw-alias-state-business-primary); }
.tb-chip[data-tone='high'] { color: var(--dsw-alias-state-error-primary); }
.tb-chip[data-tone='medium'] { color: var(--dsw-alias-state-warn-primary); }
.tb-chip[data-tone='low'] { color: var(--dsw-alias-state-success-primary); }
.tb-chipMeta { color: var(--dsw-alias-label-tertiary); }
.tb-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; display: inline-block; }
.tb-labelChip { gap: 4px; background: color-mix(in srgb, var(--tb-label-color) 16%, transparent); color: var(--dsw-alias-label-primary); }
.tb-priority { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; }
.tb-priority[data-priority='high'] { color: var(--dsw-alias-state-error-primary); }
.tb-priority[data-priority='medium'] { color: var(--dsw-alias-state-warn-primary); }
.tb-priority[data-priority='low'] { color: var(--dsw-alias-state-success-primary); }
.tb-priority[data-priority='none'] { color: var(--dsw-alias-label-tertiary); }
.tb-cardActions { display: flex; align-items: center; gap: 2px; opacity: 0; transition: opacity .12s ease; }
.tb-card:hover .tb-cardActions, .tb-card:focus-within .tb-cardActions { opacity: 1; }
.tb-menuWrap { position: relative; display: inline-flex; }
.tb-menu {
  position: absolute; z-index: 80; top: calc(100% + 4px); right: 0;
  min-width: 168px; max-height: 260px; overflow: auto;
  padding: 4px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1));
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.18));
  backdrop-filter: blur(40px) saturate(1.5);
}
.tb-menuItem {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 8px; border: 0; border-radius: 7px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; text-align: left; cursor: pointer;
}
.tb-menuItem:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary); }
.tb-menuItem:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -1px; }
.tb-menuItem[data-danger='true'] { color: var(--dsw-alias-state-error-primary); }
.tb-menuHeading { padding: 4px 8px; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--dsw-alias-label-tertiary); }
.tb-menuSeparator { height: 1px; margin: 4px 0; background: var(--dsw-alias-border-l2); }
.tb-addTask {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 6px 8px; margin-top: 6px;
  border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 12px; text-align: left; cursor: pointer;
}
.tb-addTask:hover { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.tb-composer { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.tb-composer input {
  flex: 1; min-width: 0; padding: 6px 8px;
  border: 1px solid var(--dsw-alias-state-business-primary); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; outline: none;
}
.tb-newColumn { flex: none; width: 240px; }
.tb-newColumn input {
  width: 100%; padding: 8px 10px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12.5px; outline: none;
}
.tb-addColumn {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 10px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 12.5px; cursor: pointer;
}
.tb-addColumn:hover { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
.tb-empty { padding: 18px 10px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.tb-loading { display: flex; flex: 1; align-items: center; justify-content: center; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.tb-confirm {
  display: flex; flex-direction: column; gap: 8px;
  margin-top: 6px; padding: 8px; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
}
.tb-confirmText { font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.tb-confirmRow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tb-btn {
  padding: 5px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 11.5px; cursor: pointer;
}
.tb-btn:hover { border-color: var(--dsw-alias-border-l3); }
.tb-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.tb-btn[data-variant='primary'] { background: var(--dsw-alias-state-business-primary); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.tb-btn[data-variant='danger'] { color: var(--dsw-alias-state-error-primary); }
.tb-color-gray { --tb-label-color: #8b8f98; }
.tb-color-blue { --tb-label-color: #4d8df6; }
.tb-color-green { --tb-label-color: #2fa36b; }
.tb-color-teal { --tb-label-color: #1f9d9d; }
.tb-color-yellow { --tb-label-color: #c9a227; }
.tb-color-orange { --tb-label-color: #e07a24; }
.tb-color-red { --tb-label-color: #d9534f; }
.tb-color-pink { --tb-label-color: #d95c9a; }
.tb-color-purple { --tb-label-color: #8b5cf6; }
.tb-color-brown { --tb-label-color: #8a6a4f; }
.tb-colorTarget { background: var(--tb-label-color, #8b8f98); }
/* ── task drawer, composer dialog and label manager ── */
.tb-panel { position: relative; }
.tb-newTaskBtn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 5px 10px; border-radius: 8px; border: 0;
  background: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
.tb-newTaskBtn:hover { filter: brightness(1.06); }
.tb-newTaskBtn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.tb-drawer {
  position: absolute; top: 0; right: 0; bottom: 0; z-index: 70;
  width: 384px; max-width: 100%;
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1);
  border-left: 1px solid var(--dsw-alias-border-l2);
  box-shadow: -10px 0 28px rgba(0,0,0,.14);
  animation: tb-slide .14s ease-out;
}
@keyframes tb-slide { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: none; } }
.tb-drawerHeader {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.tb-drawerHeading { flex: 1; font-size: 12px; font-weight: 650; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); }
.tb-drawerBody { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.tb-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.tb-fieldLabel { font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.tb-fieldInput, .tb-fieldSelect, .tb-fieldTextarea {
  box-sizing: border-box; width: 100%;
  padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12.5px;
}
.tb-fieldInput:focus, .tb-fieldSelect:focus, .tb-fieldTextarea:focus {
  outline: none; border-color: var(--dsw-alias-state-business-primary);
}
.tb-fieldTextarea { min-height: 92px; resize: vertical; line-height: 18px; }
.tb-fieldRow { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.tb-quickRow { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.tb-quickBtn {
  padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 10.5px; cursor: pointer;
}
.tb-quickBtn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l3); }
.tb-quickBtn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.tb-labelTokens { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.tb-labelToken {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 7px; border-radius: 999px; font-size: 11px;
  background: color-mix(in srgb, var(--tb-label-color) 16%, transparent);
  color: var(--dsw-alias-label-primary);
}
.tb-labelToken button {
  width: 14px; height: 14px; padding: 0; border: 0; border-radius: 50%;
  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; font-size: 11px; line-height: 1;
}
.tb-labelToken button:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.tb-subtasks { display: flex; flex-direction: column; gap: 3px; }
.tb-subtask { display: flex; align-items: center; gap: 7px; padding: 2px 0; }
.tb-subtaskCheck {
  display: inline-flex; align-items: center; justify-content: center;
  width: 17px; height: 17px; flex: none; padding: 0;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px;
  background: transparent; color: transparent; font-size: 11px; cursor: pointer;
}
.tb-subtaskCheck[data-done='true'] {
  background: var(--dsw-alias-state-business-primary); border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.tb-subtaskCheck:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.tb-subtaskTitle { flex: 1; min-width: 0; font-size: 12.5px; line-height: 18px; word-break: break-word; }
.tb-subtask[data-done='true'] .tb-subtaskTitle { color: var(--dsw-alias-label-tertiary); text-decoration: line-through; }
.tb-subtaskAdd { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.tb-subtaskAdd input {
  flex: 1; min-width: 0; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; outline: none;
}
.tb-subtaskAdd input:focus { border-color: var(--dsw-alias-state-business-primary); }
.tb-meta { display: grid; gap: 2px; font-size: 10.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.tb-drawerFooter { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--dsw-alias-border-l2); }
.tb-drawerFooter .tb-errorInline { margin-right: auto; }
.tb-errorInline { font-size: 11px; color: var(--dsw-alias-state-error-primary); }
.tb-modalBackdrop {
  position: absolute; inset: 0; z-index: 90;
  display: flex; align-items: center; justify-content: center; padding: 20px;
  background: rgba(0, 0, 0, .35);
}
.tb-modal {
  display: flex; flex-direction: column; width: min(660px, 100%); max-height: 100%;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px;
  box-shadow: var(--dsw-shadow-lv3, 0 24px 64px rgba(0,0,0,.28));
}
.tb-modalHeader { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.tb-modalTitle { flex: 1; font-size: 13px; font-weight: 650; }
.tb-modalBody { overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 11px; }
.tb-modalFooter { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l2); }
.tb-modalFooter .tb-spacer { flex: 1; }
.tb-subtaskDraftRow { display: flex; align-items: center; gap: 6px; }
.tb-subtaskDraftRow input {
  flex: 1; min-width: 0; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; outline: none;
}
.tb-subtaskDraftRow input:focus { border-color: var(--dsw-alias-state-business-primary); }
.tb-labelManageRow { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.tb-labelManageRow .tb-fieldInput { flex: 1; }
.tb-labelName { flex: 1; min-width: 0; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-colorSelect { flex: none; width: 92px; }
.tb-checkList { display: flex; flex-wrap: wrap; gap: 6px; }
.tb-checkItem {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px; cursor: pointer;
}
.tb-checkItem[data-checked='true'] { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.tb-checkItem:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }

.tb-dragHandle {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 22px; flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px; line-height: 1; cursor: grab; user-select: none;
  border-radius: 4px;
}
.tb-dragHandle:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.tb-dragHandle:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.tb-column[data-drop='true'] { border-color: var(--dsw-alias-state-business-primary); }
.tb-column[data-drop='true'] .tb-columnTasks { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, transparent); border-radius: 8px; }
.tb-dropLine {
  height: 2px; margin: 2px 0; border-radius: 2px;
  background: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, transparent);
}
.tb-card[data-dragging='true'] { opacity: .45; }
.tb-srOnly {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
@media (max-width: 900px) {
  .tb-backdrop { padding: 8px; }
  .tb-header { gap: 6px; }
  .tb-header .tb-search { flex: 1 1 100%; order: 2; }
  .tb-rail { width: 168px; }
  .tb-column { width: 250px; }
  .tb-drawer { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .tb-backdrop, .tb-panel, .tb-card, .tb-cardActions { animation: none !important; transition: none !important; }
}
`

/** Inject the board stylesheet once per page. */
export function injectBoardStyles() {
  if (typeof document === 'undefined') return
  const tagId = 'dsh-plugin-pomodoro/board.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-pomodoro'
  tag.dataset.pluginCss = tagId
  tag.textContent = BOARD_CSS
  document.head.appendChild(tag)
}
