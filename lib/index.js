/**
 * Pomodoro timer plugin, node half.
 *
 * The timer is a browser concern: it renders in the conversation header and
 * keeps its own wall-clock state in the page. The host row exists so the
 * package appears in the Loader tree (which is what makes the client module
 * system discover the package's `dsh.client` declaration and serve its bundle
 * at /plugins/dsh-plugin-pomodoro/client.js), and so the plugin can be
 * enabled, disabled, and configured from the profile like any other plugin.
 *
 * No host-side service, tool, or frame is registered: nothing here reaches a
 * model request, so the plugin has no effect on prompts or KV cache.
 */

/** Cordis plugin name, surfaced in loader diagnostics. */
export const name = 'pomodoro'

/** Host plugin body — intentionally empty; see the module comment. */
export function apply() {}
