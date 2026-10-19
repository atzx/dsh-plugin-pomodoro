/**
 * Locale dictionaries for the Pomodoro plugin.
 *
 * Flat key -> template strings with `{name}` placeholders, exactly what the
 * client locale registry consumes: zh is the source of truth every shipped
 * namespace keeps, en is the translation, and the lookup chain falls back from
 * the active locale to zh. Keys are stable strings rather than typed, because
 * this bundle is plain JavaScript (the registry's TypeScript typing is a
 * build-time convenience for package authors, not a runtime requirement).
 *
 * @module dsh-plugin-pomodoro/locales
 */

/** Registry namespace owned by this plugin. */
export const NS = 'pomodoro'

/** English copy. */
export const en = {
  'widget.label': 'Pomodoro timer',
  'widget.open': 'Open Pomodoro timer',
  'widget.collapse': 'Collapse Pomodoro timer',
  'widget.expand': 'Expand Pomodoro timer',

  'phase.focus': 'Focus',
  'phase.shortBreak': 'Short break',
  'phase.longBreak': 'Long break',

  'status.idle': 'ready',
  'status.running': 'running',
  'status.paused': 'paused',

  'action.start': 'Start',
  'action.resume': 'Resume',
  'action.pause': 'Pause',
  'action.skip': 'Skip phase',
  'action.reset': 'Reset phase',
  'action.settings': 'Timer settings',
  'action.back': 'Back to timer',
  'action.close': 'Close',

  'timer.aria': 'Pomodoro timer: {phase}, {time} remaining, {status}',
  'timer.remaining': '{time} remaining',
  'timer.cycle': '{done} of {total} focus blocks in this cycle',
  'timer.sessionCount': '{count} focus blocks completed',

  'done.focus': 'Focus block complete. Time for a break.',
  'done.shortBreak': 'Break over. Ready for the next focus block?',
  'done.longBreak': 'Long break over. A fresh cycle is ready.',

  'settings.title': 'Timer settings',
  'settings.focus': 'Focus length',
  'settings.shortBreak': 'Short break length',
  'settings.longBreak': 'Long break length',
  'settings.every': 'Long break every',
  'settings.minutes': '{minutes} min',
  'settings.blocks': '{count} blocks',
  'settings.autoBreaks': 'Auto-start breaks',
  'settings.autoBreaksHint': 'Begin each break as soon as focus ends.',
  'settings.autoFocus': 'Auto-start focus',
  'settings.autoFocusHint': 'Begin the next focus block as soon as a break ends.',
  'settings.sound': 'Chime',
  'settings.soundHint': 'Play a short chime when a phase ends.',
  'settings.notify': 'Desktop notifications',
  'settings.notifyHint': 'Ask the browser to announce finished phases.',
  'settings.decrease': 'Decrease',
  'settings.increase': 'Increase',

  'config.summaryOn': 'Timer widget is shown.',
  'config.summaryOff': 'Timer widget is hidden.',
  'config.widgetHeading': 'Widget',
  'config.widgetHint': 'Show the timer pill over the app. The clock keeps running while it is hidden.',
  'config.widget': 'Floating timer',
  'config.durationsHeading': 'Focus and break lengths',
  'config.behaviourHeading': 'Cycle behaviour',
  'config.signalsHeading': 'Completion signals',
  'config.note': 'These settings live in this browser. To unload the plugin entirely, switch off its bundle or Component row on the bundle page.',

  'notify.focusDone': 'Focus block complete',
  'notify.focusBody': 'Take a {minutes}-minute break.',
  'notify.breakDone': 'Break over',
  'notify.breakBody': 'Start your next {minutes}-minute focus block.',
  'notify.denied': 'Notifications are blocked in this browser.',
}

/** Chinese copy (source-of-truth locale beside English). */
export const zh = {
  'widget.label': '番茄钟',
  'widget.open': '打开番茄钟',
  'widget.collapse': '收起番茄钟',
  'widget.expand': '展开番茄钟',

  'phase.focus': '专注',
  'phase.shortBreak': '短休息',
  'phase.longBreak': '长休息',

  'status.idle': '就绪',
  'status.running': '进行中',
  'status.paused': '已暂停',

  'action.start': '开始',
  'action.resume': '继续',
  'action.pause': '暂停',
  'action.skip': '跳过此阶段',
  'action.reset': '重置此阶段',
  'action.settings': '计时设置',
  'action.back': '返回计时器',
  'action.close': '关闭',

  'timer.aria': '番茄钟：{phase}，剩余 {time}，{status}',
  'timer.remaining': '剩余 {time}',
  'timer.cycle': '本轮已完成 {done}/{total} 个专注',
  'timer.sessionCount': '已完成 {count} 个专注',

  'done.focus': '专注结束，该休息了。',
  'done.shortBreak': '休息结束，准备下一轮专注。',
  'done.longBreak': '长休息结束，可以开始新一轮了。',

  'settings.title': '计时设置',
  'settings.focus': '专注时长',
  'settings.shortBreak': '短休息时长',
  'settings.longBreak': '长休息时长',
  'settings.every': '长休息间隔',
  'settings.minutes': '{minutes} 分钟',
  'settings.blocks': '{count} 个',
  'settings.autoBreaks': '自动开始休息',
  'settings.autoBreaksHint': '专注结束后立即开始休息。',
  'settings.autoFocus': '自动开始专注',
  'settings.autoFocusHint': '休息结束后立即开始下一轮专注。',
  'settings.sound': '提示音',
  'settings.soundHint': '阶段结束时播放简短提示音。',
  'settings.notify': '桌面通知',
  'settings.notifyHint': '允许浏览器在阶段结束时提醒。',
  'settings.decrease': '减少',
  'settings.increase': '增加',

  'config.summaryOn': '计时器已显示。',
  'config.summaryOff': '计时器已隐藏。',
  'config.widgetHeading': '悬浮计时器',
  'config.widgetHint': '在应用上方显示计时器悬浮条；隐藏后计时仍会继续。',
  'config.widget': '悬浮计时器',
  'config.durationsHeading': '专注与休息时长',
  'config.behaviourHeading': '循环行为',
  'config.signalsHeading': '结束提醒',
  'config.note': '这些设置保存在当前浏览器。如需完全卸载插件，请在插件包页面关闭对应的插件包或组件开关。',

  'notify.focusDone': '专注完成',
  'notify.focusBody': '休息 {minutes} 分钟。',
  'notify.breakDone': '休息结束',
  'notify.breakBody': '开始下一轮 {minutes} 分钟的专注。',
  'notify.denied': '浏览器已阻止通知。',
}
