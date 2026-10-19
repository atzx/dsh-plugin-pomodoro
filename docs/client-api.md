# DSH web client plugin API — hand-written bundle specification

Scope: everything needed to write `pomodoro-plugin/lib/client.js` **by hand** (no tsdown/webpack),
installable into a DSH profile, plus the host-side packaging requirements.

## Citation convention

- `@deepseek-ai/<pkg>/<file>:<line>` = `<pkg>/<file>` under
  `~/.dsh/profiles/node_modules/@deepseek-ai/` (these are symlinks into the harness checkout;
  the read tool reports the checkout path).
- `REPO:<path>:<line>` = a file that ships only in the harness checkout, not in a published package
  (`<dsh-checkout>/<path>`).
- All line numbers are from `src/` (readable TypeScript), never the minified `lib/client.js`
  except where the built bundle itself is the evidence.

Verified against: 196 packages in `~/.dsh/profiles/node_modules/@deepseek-ai/`, profile
`desktop`, web GUI `http://127.0.0.1:55022`.

---

# 1. Bundle contract

## 1.1 Exact shape of `window.__ModuleLoader__.load`

A client bundle is a **classic script** (loaded via `<script src>`, not ESM — no `import`/`export`
statements) whose entire top level is exactly one registration call:

```js
window.__ModuleLoader__.load({
  id: "<package name>",              // = graph row id = loader entry name
  factory: (require) => {            // receives the module table's sync require
    // whole bundle body lives here; runs ONCE, at materialization
    const React = require("react")
    // ...
    return { apply, inject }         // becomes module.exports
  },
})
```

- Handoff type `ClientPluginHandoff { id, factory }`: `@deepseek-ai/dsh-client-modules/src/client/manifest.ts:146-156`.
- Registration sink installed once per page by the module system constructor:
  `@deepseek-ai/dsh-client-modules/src/client/system.ts:86-96`. Duplicate `id` registration throws
  (`system.ts:91-93`); a bundle whose script loads without registering its `id` is a loud boot failure
  (`system.ts:104-107`).
- The module system is installed by the shell kernel **before** any plugin bundle loads;
  `window.__ModuleLoader__` is undefined only if the shell boot broke.
- `id` must be the **exact npm package name** (graph row id == entry name == package name; a second
  fiber/table entry under a different id is a different module). Normatively: `WebBootEntry.id`
  comment “Entry name == package name” `manifest.ts:50-56`; table keying `system.ts:89-94`.
- Factory semantics: lazy CJS table. Executing the bundle only **registers** the factory; every module
  side effect — including CSS injection — runs at materialization (`manifest.ts:9-16`, `system.ts:113-133`).
  Materialization is memoized in `ClientModuleRecord.exports` (`manifest.ts:173-183`); a re-entrant
  require cycle throws (`system.ts:120-122`).

## 1.2 What `require` can answer (the only legal specifiers)

`makeRequire` resolution order: **seed word → shell-own static module → memoized record →
registered factory (recursive materialize) → throw** (`system.ts:142-156`). It is synchronous, so it
can never fetch a bundle; an unregistered plugin specifier throws the “missed the module table”
error (`system.ts:151-154`).

The **complete** seed table (`REPO:packages/client/web/src/platform.ts:8-17`, values installed by
`REPO:packages/client/web/src/seed.ts:21-44`):

| specifier | contents |
|---|---|
| `react` | React 18 (the shell's singleton) |
| `react/jsx-runtime` | `jsx`, `jsxs`, `Fragment` |
| `react-dom` | ReactDOM 18 |
| `react-dom/client` | `createRoot` |
| `@deepseek-ai/cordis` | cordis `Context`, `Service`, … |
| `@deepseek-ai/dsh-client-ui-slots` | slot contracts/`SlotCore`/store types (no runtime binding needed) |
| `@deepseek-ai/dsh-client-web-react` | slot renderer (`createSlotRenderer`) |
| `@deepseek-ai/dsh-client-ui-primitives` | Button/Tooltip/Modal/Toast/StateDot/icons/… — see §3 |
| `@deepseek-ai/dsh-client-ui-attachment` | attachment UI |
| `@deepseek-ai/dsh-client-schema-form` | schema form |

Plus exactly one documented cross-package exemption:
`@deepseek-ai/dsh-client-runtime/client` (`REPO:packages/client/tsdown.client.ts:55-65`), which is
usable because the runtime package is an `immediately:true` graph row
(`@deepseek-ai/dsh-client-runtime/package.json:35-41`) and its factory is registered during the
stage-one prefetch barrier (`REPO:packages/client/web/src/boot.tsx:151-157`, barrier comment
`boot.tsx:24-28,184-187`). It exports `createSnapshotStore`, `defineStore`, `shallowEqual`
(`@deepseek-ai/dsh-client-runtime/lib/client.js` tail), i.e. the persistent store engine.

**Any other `@deepseek-ai/*` value import is forbidden by the build purity gate**
(`REPO:packages/client/tsdown.client.ts:210-225`) and, in a hand-written bundle, will either inline a
duplicate runtime instance or throw a module-table miss at materialization. Cross-plugin
collaboration goes through cordis services (`ctx.*`), never `require`.

Rules of thumb for a hand-written bundle:

- Whitelist: `react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-ui-primitives`, and (optionally)
  `@deepseek-ai/dsh-client-runtime/client`.
- Never require another UI plugin's client package, even though it appears in the boot graph: unless
  its factory was already registered (only the `immediately` tier is), `require` throws.
- Requires must be inside the factory, not at script top level (`require` does not exist outside it).

## 1.3 How `exports.apply` / `exports.inject` are consumed

The browser boot creates one loader entry per graph row **by name only**:
`loader.create({ name: row.id })` (`REPO:packages/client/web/src/boot.tsx:189-205`). The entry then
imports the package through the module table, and the vendored loader normalizes the namespace:

- `unwrapExports`: `exports.default ?? exports`, then `if (!exports.__esModule) return exports`
  (`REPO:vendor/loader/src/index.ts:192-200`). Our factory returns a plain object, so it is used
  directly.
- `ctx.registry.plugin(plugin, config)` resolves a plugin from either a function or
  `{ apply }`; **anything without a callable `apply` is rejected**
  (“invalid plugin, expect function or object with an "apply" method”,
  `REPO:vendor/cordis/src/registry.ts:217-226,315-320`).
- `inject` is read from the same object: `Inject.resolve(plugin.inject)` accepts the array form
  `['slots','locale',…]` or a map form (`REPO:vendor/cordis/src/registry.ts:114-129,338`). The
  fiber waits until every named service exists; boot then sweeps and fails loudly if anything is
  still PENDING (`boot.tsx:207-235`).

Therefore a bundle must return:

```js
return { apply, inject }            // inject: string[] (or { service: config })
```

`apply(ctx, config)` receives the cordis client `Context` (the same context object every shipped
plugin uses). `config` is whatever the loader row passes (usually `undefined`; our row carries none).

> Note: `package.json` `dsh.client.inject` is **informational graph metadata** (“the authoritative
> edges live in each package's `dsh.client` declaration and reach fibers through entry creation”,
> `@deepseek-ai/dsh-client-modules/src/client/manifest.ts:43-49`). In the actual browser boot the row
> list is created from ids only (`boot.tsx:189-205`); activation ordering is owned by the
> **bundle-exported `inject`** service names. Keep both in sync by convention.

## 1.4 CSS injection (`data-plugin-css` pattern)

CSS is plain text injected by the factory at materialization, tagged `data-plugin` (owner id) and
`data-plugin-css` (stable tag id). This is the exact prebuilt pattern (quote from
`@deepseek-ai/dsh-client-ui-jobs/lib/client.js:10-19`):

```js
//#region .../JobListAction.module.css.mjs
const css = "._1ExDoW_root{position:relative}...";                   // minified CSS text
const tagId = "@deepseek-ai/dsh-client-ui-jobs/JobListAction.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-jobs";            // -> data-plugin
  tag.dataset.pluginCss = tagId;                                     // -> data-plugin-css
  tag.textContent = css;
  document.head.appendChild(tag);
}
```

The loader claims the tags a factory injected into its `ClientModuleRecord.styles`
(`system.ts:36-51`, `system.ts:127`), and HMR removes owned styles before re-materialization
(`@deepseek-ai/dsh-client-hmr/src/client/index.ts:120-140`). The idempotence guard
(`querySelector(...) === null`) is required: a factory can materialize again after HMR invalidate.

No CSS-file import, no `<link>`, no `import './x.css'` — a hand-written classic script can only do
the DOM `<style>` injection above.

---

# 2. Slots

## 2.1 Registration API

Two calls, always used together when the slot may not be declared yet:

```js
ctx.slots.inject("<slot key>", () =>
  ctx.slots.register({
    name: "<slot key>",
    // kind-shaped options (see table)
    locale: "pomodoro",      // optional: injects t()
  }, Component)
)
```

- `ctx.slots.register(options, component)` → disposer; returns via the caller fiber's `effect`, so
  plugin unload removes the contribution (`@deepseek-ai/dsh-client-runtime/src/client/slots.ts:458-471`).
  Registering into an **undeclared** slot throws (`@deepseek-ai/dsh-client-ui-slots/src/index.ts:787-791`).
- `ctx.slots.inject(key, cb)` waits for the slot's declaration lifetime, runs `cb` when declared,
  disposes on collapse, and belongs to the caller fiber (`dsh-client-runtime/src/client/slots.ts:143-205`).
  Use it for every slot declared by another package; it is also what the shipped plugins do
  (`@deepseek-ai/dsh-client-ui-jobs/src/client/index.ts:28-38`).
- Slot kinds (`ui-slots/src/index.ts:87-91`): `single` (one occupant per cell), `list` (ordered
  additive entries keyed by `id`), `keyed` (dispatch by `key`), `chain` (selector-routed).
  Scopes: `root` (no session), `session-maybe` (`sessionId` may be undefined), `session` (definite).
- Register options (`ui-slots/src/index.ts:480-550`; runtime erased view
  `dsh-client-runtime/src/client/slots.ts:68-84`):

| option | kind | meaning |
|---|---|---|
| `name` | all | target slot key (must already be declared) |
| `id` | `list` (required) | stable cell id; a second entry with same `id` + same `priority` throws |
| `order` | `list` | display order, ascending, applied after priority (`ui-slots/src/index.ts:861-868`) |
| `label` | `list` | `string \| (() => string)` display label for owner projections |
| `key` | `keyed` (required) | dispatch key |
| `select` | `chain` (required) | pure routing function |
| `priority` | all | shadowing rank; ascending, lowest renders; same-priority duplicate in one cell throws (`ui-slots/src/index.ts:796-824`) |
| `locale` | all | dictionary namespace; framework injects `t` prop (see §5) |
| `children` | all | child-slot declaration table — never needed by a leaf widget |
| `store` | all | store handle/factory; framework injects `useStore`/`actions` |
| `inject` | all | callback returning the registrant's private prop face (runs per session/root, result cached) |

Everything else about `single`/`chain` semantics is at `ui-slots/src/index.ts:706-896`.

## 2.2 Props: the four-share composition

A registered component's full props are `ComposedProps`
(`@deepseek-ai/dsh-client-ui-slots/src/index.ts:434-450`):

```
PropsRuntime(key)            // owner share + key props + slot inject + scope standard kit + global kit
& PropsRenderSlots<children> // only if `children` was declared
& PropsStore<store>          // only if `store` was declared
& InjectFace<inject>         // registrant's own face; `hooks` compartment becomes use<Name>()
& PropsLocale<locale>        // `t` iff `locale:` declared
```

The standard kit (`PropsRuntime`, `ui-slots/src/index.ts:207-221`):

- **every** slot component: `GlobalStandardProps = { useSessions, useWorkspaces }`
  (merged by the runtime, `@deepseek-ai/dsh-client-runtime/src/client/index.ts:145-151`).
- `scope: 'session'` adds `SessionStandardProps = { sessionId, useSession, useProjection }`
  (`dsh-client-runtime/src/client/index.ts:124-136`) **plus** ui-conversation's merge
  `{ useInput, inputActions }` (`@deepseek-ai/dsh-client-ui-conversation/src/client/contract/slots.ts:224-241`).
- `scope: 'session-maybe'` adds `SessionMaybeStandardProps` with the same names, `undefined`-able
  (`dsh-client-runtime/src/client/index.ts:137-144`).
- Owner share is whatever the owning package passes at its `renderSlot` call site
  (`ui-slots/src/index.ts:93-122`).

`useSession` / `useSessions` / `useWorkspaces` are selector hooks `(selector) => value`; they are
bound from `getSnapshot/subscribe` sources (`REPO:packages/client/web-react/src/scoped-slots.tsx:344-395`).
`useProjection(key)` reads host-computed projections (undefined = absent).

## 2.3 Slot inventory (all declared slots at this build)

| slot key | kind | scope | declared by |
|---|---|---|---|
| `root` | single | root | runtime (`dsh-client-runtime/src/client/slots.ts:41`) — **do not register** |
| `sidebar` | single | root | ui-layout (`src/client/index.ts:49`) — occupied by SidebarRoot |
| `conversation` | single | session-maybe | ui-layout (`:62`) — occupied by ConversationRoot |
| `details` | single | session | ui-layout (`:72`) — occupied by DetailsPanel |
| `shell.overlay` | list | root | ui-layout (`:73-83`) |
| `sidebar.workspaces` | single | root | ui-sidebar (`contract/slots.ts:24`) |
| `sidebar.settings` | single | root | ui-sidebar (`:30`) |
| `sidebar.footer.action` | list | root | ui-sidebar (`:35`) |
| `conversation.session` | single | session | ui-conversation (`contract/slots.ts:44`) |
| `conversation.session.header` | single | session | ui-conversation (`:52`) |
| `conversation.session.header.actions` | list | session | ui-conversation (`:63`) |
| `conversation.session.header.utilities` | list | session | ui-conversation (`:68`) |
| `conversation.view` | list | session | ui-conversation (`:76`) |
| `conversation.chat.node` | keyed | session | ui-conversation (`:78-85`) |
| `conversation.chat.commandview` | keyed | session | ui-conversation (`:94`) |
| `conversation.chat.turnTail` | chain | session | ui-conversation (`:101`) |
| `conversation.chat.assistant-actions` | list | session | ui-conversation (`:109`) |
| `conversation.details.tool` | single | session | ui-conversation (`:124`) |
| `conversation.composer` | chain | session | ui-conversation (`:132`) |
| `conversation.hero.workspace` | single | root | ui-conversation (`:139`) |
| `conversation.hero.agentPreset` | single | root | ui-conversation (`:145`) |
| `conversation.input.overlay` | list | session | ui-input-trigger (`src/client/slots.ts:24`), declared by ui-conversation (`apply.ts:203`) |
| `conversation.input.dock` | list | session | ui-conversation (`:161`) |
| `conversation.composer.dock` | list | session | ui-conversation (`:170`) |
| `conversation.input.left` | list | session | ui-conversation (`:179`) |
| `conversation.input.right` | list | session | ui-conversation (`:187`) |
| `conversation.composer.bar` | single | session-maybe | ui-conversation (`:201`) — **occupied by InputBar** |
| `conversation.input.plan` | single | session | ui-conversation (`:211`) |
| `conversation.input.model` | single | session | ui-conversation (`:221`) |
| `settings.trigger/header/action/close/section/plugins.tab/onboarding/general.item` | — | root | ui-settings (`src/client/contract/slots.ts:23-88`) |
| `settings.plugin.item` | keyed | root | ui-settings-plugins (`src/client/slot-contract.ts:19`) |
| `tool.call.toolview` | keyed | session | ui-tool (`src/client/contract/slots.ts:23`) |
| `conversation.hero.workspace.directoryFlow`, `sidebar.workspaces.directoryFlow` | single | root | ui-workspace (`contract/slots.ts:56-58`) |

Child declarations are listed in the owning `apply` (`@deepseek-ai/dsh-client-ui-conversation/src/client/apply.ts:196-300`;
`@deepseek-ai/dsh-client-ui-sidebar/src/client/index.ts:50`; `@deepseek-ai/dsh-client-ui-layout/src/client/index.ts:120-137`).

## 2.4 The five candidate slots for a persistent compact timer

### (A) `shell.overlay` — **recommended for a global/persistent timer**

- Declaration: `'shell.overlay': { kind: 'list'; scope: 'root' }`, additive, explicitly documented
  as “a badge, a toast stack or a status pill all belong here”
  (`@deepseek-ai/dsh-client-ui-layout/src/client/index.ts:73-83`).
- Rendered once per app at the frame root: `<div className={css.overlayLayer} data-shell-overlay>
  {renderSlot('shell.overlay', {})}</div>` (`.../src/client/AppFrame.tsx:193-194`).
- Layer CSS: `position:absolute; inset:0; z-index:20; pointer-events:none`, and every **direct child**
  gets `pointer-events:auto` (`.../src/client/AppFrame.module.css:110-119`). So the widget does not
  block the app; it must position itself (e.g. `position:absolute; right:16px; bottom:16px`).
- Owner props: `{}` (nothing passed; declaration has no `owner`).
- Component props: `{ useSessions, useWorkspaces }` + your `inject` face + `t` (with `locale`).
  No `sessionId` (root scope).
- Global, always mounted, survives session switches — best fit for a persistent Pomodoro.
- Registration options required: `name`, `id` (unique, e.g. `"pomodoro-timer"`), optional `order`
  (defaults 0; ascending). No shipped registrant currently, so any `order` is safe.

### (B) `conversation.session.header.actions` — per-session header control

- Declaration + contract: `@deepseek-ai/dsh-client-ui-conversation/src/client/contract/slots.ts:53-67`.
- Rendered in the session header: `renderSlot('conversation.session.header.actions', {})`
  (`.../src/client/skeleton/ConversationSession.tsx:103`), entries render by `order`.
- Owner props: `{}`. Props: `sessionId`, `useSession`, `useProjection`, `useInput`, `inputActions`,
  `useSessions`, `useWorkspaces`, `t` (if `locale`).
- Session scope: **it only exists while a session is current** (header/body unmount in the hero /
  no-session state; see `conversation.session.header` single scope `session`).
- Real registration template (`@deepseek-ai/dsh-client-ui-jobs/src/client/index.ts:22-38`, built
  bundle `lib/client.js:250-277`):

```js
export const inject = ['sessions', 'slots', 'locale']
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-job: dictionaries')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'job-list',
      order: 20,            // after the subagent catalog
      locale: NS,
    }, JobListAction),
  )
}
```

- `order` is display order; negative values are reserved by convention for static session context
  (`contract/slots.ts:56-61`). Different ids may share a priority; only same cell+priority throws.
- Use this if the timer should be scoped to a conversation/session rather than global.

### (C) `conversation.input.right` — small control inside the composer tool row

- Declaration `contract/slots.ts:180-187`; owner `InputZone { session: ConversationSnapshot,
  input: InputState }` (`:268-277`); rendered at
  `renderSlot('conversation.input.right', zone)` (`.../skeleton/ConversationRoot.tsx:153`).
- Session scope, one-row height budget, sits before the send button. Props = `InputZone` +
  `sessionId/useSession/useProjection/useInput/inputActions` + `useSessions/useWorkspaces` + `t`.
- Good for a timer chip the user sees while composing; it disappears with the composer/session.

### (D) `conversation.composer.bar` — **do not use**

- `single`, `session-maybe`, and already occupied by `InputBar` in the same package
  (`@deepseek-ai/dsh-client-ui-conversation/src/client/apply.ts:278-364`). Registering at default
  priority 0 throws; registering at another priority **shadows/replaces the whole composer**, which
  is almost certainly not wanted. It is documented as the composer body
  (`contract/slots.ts:188-201`).

### (E) `sidebar.footer.action` — sidebar-foot action

- Declaration `@deepseek-ai/dsh-client-ui-sidebar/src/client/contract/slots.ts:31-36`; owner
  `{ wide: boolean }` (`:59-63`); rendered as `renderSlot('sidebar.footer.action', { wide })`
  (`.../src/client/SidebarRoot.tsx:184`).
- Root/global, always mounted, but the owner passes `wide = false` in the 56px rail, so the component
  must render an icon-only variant. Props: `{ wide }` + `useSessions` + `useWorkspaces` + `t`.
- Real registration (root list): `@deepseek-ai/dsh-client-ui-cordis/src/client/index.ts:84-91`.

### Decision

- Persistent, always-visible, session-independent: **`shell.overlay`** (this spec's template).
- Tied to a conversation: `conversation.session.header.actions`.
- Small control next to send: `conversation.input.right`.
- Never `conversation.composer.bar` (occupied single slot).

## 2.5 Conditional rendering, errors, hooks

- A slot component **may render conditionally**, including `null`, as long as React hook calls stay
  unconditional. Shipped example: `JobListAction` calls all hooks first and then `if (jobs.length ===
  0) return null` (`@deepseek-ai/dsh-client-ui-jobs/lib/client.js:117-139`).
- Each entry is wrapped in a `SlotErrorBoundary`; a crash shows `<div data-slot-error="...">` and for
  list/single/keyed entries the registry abdicates the entry (next survivor renders)
  (`REPO:packages/client/web-react/src/scoped-slots.tsx:317-337`; ledger behavior
  `ui-slots/src/index.ts:1082-1121`). Do not rely on it as control flow — it logs an error.
- Components are ordinary React function components rendered by the shell's React 18 singleton
  (§1.2, `react` seed). There is no custom component protocol.

---

# 3. Primitives (`@deepseek-ai/dsh-client-ui-primitives`)

**Import:** `const ui = require("@deepseek-ai/dsh-client-ui-primitives")` inside the factory.
This is safe and intended from third-party bundles: it is a platform seed word
(`REPO:packages/client/web/src/platform.ts:8-17`, `seed.ts:21-44`) and shipped bundles require it
exactly this way (`@deepseek-ai/dsh-client-ui-jobs/lib/client.js:9`). It has **no** `dsh.client`
field and no `./client` export — it is a library bundled into the seed, not a plugin
(`@deepseek-ai/dsh-client-ui-primitives/package.json`).

Availability is total (whole `lib/index.js` namespace is seeded, `src/index.ts:1-51`). Most useful
exports and signatures:

| export | signature / props |
|---|---|
| `Button` | `{ variant?: 'primary'\|'ghost'\|'outline'\|'toolbar'; size?: 'md'\|'sm'; icon?: ReactNode; className?; children? } & ButtonHTMLAttributes` — `src/Button.tsx:9-31` |
| `Pill` | `{ active?: boolean; className?; children? } & ButtonHTMLAttributes`; renders `<button>` when `onClick` given, else `<span>` — `src/Pill.tsx:7-27` |
| `Tooltip` | `{ label: string \| (()=>string); side?: 'right'\|'bottom'\|'top'; delayMs?; disabled?; maxWidth?; children: ReactElement }` (clones the child, forces `ref`) — `src/Tooltip.tsx:41-56` |
| `Modal` | `{ open: boolean; onClose: ()=>void; title: string; closeLabel?; description?; children?; footer?; className?; contentClassName?; headless? }` — portals to `document.body` — `src/Modal.tsx:29-64` |
| `Toast` | `{ text: string; icon?: ReactNode; anchor?: HTMLElement\|null; onDone: ()=>void }`, self-dismisses after 4 s — `src/Toast.tsx:28-46` |
| `StateDot` | `{ state: 'done'\|'warning'\|'ongoing'\|'error'; size?: number = 10; className? }`, `aria-hidden` — `src/StateDot.tsx:10-32` |
| `Menu`, `Input`, `HoverCard`, `DisclosureRow`, `RiskConfirmation`, `ConnectionBanner`, `OnboardingSurface`, `FishLogo`, `BrandWordmark` | see `src/index.ts:5-27` |
| `JsonTree`, `TerminalBlock`, `ReadBlock`, `DiffBlock`, `SearchBlock`, `WebBlock`, `CodeBlock`, `JsonBlock`, `MarkdownText`, `MessageText` | read-only renderers, `src/index.ts:29-50` |
| `useDismissOnOutsidePointer(ref, open, setOpen)` | used by the jobs popover — `src/index.ts:15`, `lib/client.js:125` |
| `useAnchoredMaxHeight`, `writeClipboard`, `extractMarkdownPlainText` | utility hooks/helpers (`src/index.ts:14,26,49`) |
| `Icon*` | every icon is `({ size?: number; className? }) => SVG` with `fill="currentColor"` (`src/icons/props.ts:1-9`); ~70 glyphs incl. **`IconPlayOutline16`**, **`IconPauseOutline16`**, **`IconStopFill16`**, **`IconRefreshOutline16`**, `IconChevronDownOutline14`, `IconCloseOutline16` (`src/icons/index.tsx:181,245,513,553,567`) |

Bundled with the primitives, not separately requirable: `react-dom` (available as its own seed word)
and third-party libs (`clsx`, `shiki`, `katex`, …) are already inlined into the seeded build.

Do not require `@deepseek-ai/dsh-client-web-react` unless you actually need `createSlotRenderer`;
ordinary widgets never do.

---

# 4. Design tokens

## 4.1 Where they live and how theming switches

- Token sheets are imported by the web shell's `base.css`
  (`REPO:packages/client/web/src/base.css:1-12` → `@deepseek-ai/dsh-client-ui-theme/styles/*.css`):
  `design-platform.css` (palette), `scrollbar.css`, `gradient-shadow-text.css` (shadows/fonts),
  `shiki.css`, `base.css`.
- Tokens are declared on **`body`** (light), overridden on **`body[data-ds-dark-theme]`**
  (`design-platform.css:155-338`); custom properties inherit to every component subtree.
- Dark mode is an **attribute on `<body>`**, written by `ThemePresenter` from the resolved theme:
  `document.documentElement.style.colorScheme = scheme` and `body.setAttribute('data-ds-dark-theme','')`
  (`@deepseek-ai/dsh-client-ui-layout/src/client/theme-presenter.ts:10-52`). The pre-plugin boot script
  sets the same attribute early (`@deepseek-ai/dsh-client-ui-theme/src/boot-theme.ts:8-24`).
- Third-party theme layers can inject inline alias-token overrides on `body` from `ctx.theme`
  (`theme-presenter.ts:44-49`), so **always consume variables, never hardcode palette colors**.
- Note: `--dsw-*` tokens are inside `body`; `:root` only holds font/motion basics (`base.css:1-16`).

## 4.2 Token reference (all exist in the shipped sheets)

Surfaces:

| token | light | dark |
|---|---|---|
| `--dsw-alias-bg-base` | `neutral-bluish-00` (white) | `neutral-bluish-950` (`design-platform.css:157,249`) |
| `--dsw-alias-bg-layer-1/2/3` | white / white / white | `875/850/800` grey (`:158-160,250-252`) |
| `--dsw-alias-bg-overlay` | `neutral-bluish-150` | `neutral-bluish-700` (`:168,260`) |
| `--dsw-specific-menu` | layer-3 (popover/menu surface) (`:239,331`) | same indirection |
| `--dsw-specific-sidebar-fill` | `neutral-bluish-50` | `900` (`:241,333`) |
| `--dsw-alias-bg-mask-1/2/3`, `--dsw-alias-bg-skeleton` | scrims (`:161-169`) | `:253-261` |

Text:

| token | role | light / dark |
|---|---|---|
| `--dsw-alias-label-primary` | primary text | `neutral-bluish-1000` / `50` (`:207,299`) |
| `--dsw-alias-label-secondary` | secondary text | `700` / `300` (`:208,300`) |
| `--dsw-alias-label-tertiary` | captions/metadata | `600` / `400` (`:209,301`) |
| `--dsw-alias-label-dimmed` | disabled/hint | `neutral-bluish-200` / `750` (`:202,294`) |
| `--dsw-alias-label-caption` | caption | `neutral-bluish-400` / `600` (`:201,293`) |
| `--dsw-alias-label-primary-foreground` | text on primary fill | `00` / `1000` (`:205,297`) |

Borders: `--dsw-alias-border-l1` (4%/6%), `-l2` (10%/12%), `-l3` (12%/16%), `-l4` (16%/20%)
(`design-platform.css:172-176,264-268`).

Accent / state — **important nuance**:

| token | light | dark |
|---|---|---|
| `--dsw-alias-brand-primary` | `neutral-bluish-1000` = **near-black**, not blue (`:179`) | `neutral-bluish-50` = near-white (`:271`) |
| `--dsw-alias-state-business-primary` | `deepseek-500` (the blue accent) (`:222`) | `deepseek-400` (`:314`) |
| `--dsw-alias-state-business-tertiary` | `deepseek-100` | `deepseek-800` (`:223`) |
| `--dsw-alias-state-success-primary` | `green-500` (`:226`) | same (`:318`) |
| `--dsw-alias-state-warn-primary` | `amber-500` (`:230`) | same (`:322`) |
| `--dsw-alias-state-error-primary` | `red-600` (`:224`) | `red-400` (`:316`) |
| `--dsw-alias-interactive-bg-hover` / `-active` | 6% / 10% ink (`:196,200`) | 8% / 14% white (`:288,292`) |

Fill: there is **no `--dsw-alias-fill-*` family in the shipped sheets** (the string `--dsw-alias-fill-l2`
appears in `ui-jobs/src/client/JobListAction.module.css:91` and `--dsw-alias-fill-tsp-secondary` in
`ui-agent-preset`, but neither is defined in `design-platform.css`). For a chip background use
`--dsw-alias-bg-layer-2/3` or `--dsw-alias-interactive-bg-hover`.

Radius: **no radius token exists** (`grep --dsw-radius` finds nothing). Hardcoded conventions in
shipped CSS: 5-8 px (chips/rows/menus), 12 px (popover cards), 14-18 px (buttons), 24 px (dialog)
(`ui-primitives/src/Button.module.css:10,35`, `Modal.module.css:32`, `Toast.module.css:23`,
`ui-jobs/src/client/JobListAction.module.css:34-42,70,85`).

Shadow (`@deepseek-ai/dsh-client-ui-theme/src/styles/gradient-shadow-text.css:5-9`):
`--dsw-shadow-lv1` (0 2px 4px 5%), `--dsw-shadow-lv1-blur` (0 4px 12px 2%), `--dsw-shadow-lv2`,
`--dsw-shadow-lv3` (popover/menu: 0 0 1px 20% + 0 12px 32px 8%). Also `--dsw-mask-blur`.

Fonts:

- `--dsw-font-family` — UI sans stack, defined in `:root` (`base.css:7-9`).
- `--ds-font-family-code` — code stack, defined in `:root` (`base.css:10-12`).
- Composite shorthands: `--dsw-font-xxs-12`, `--dsw-font-xs-13`, `--dsw-font-s-14`,
  `--dsw-font-base-16`, `--dsw-font-*-strong-*`, markdown heading/code tokens
  (`gradient-shadow-text.css:22-213`).
- `--dsw-font-mono` is **used** by shipped CSS (`ui-jobs/src/client/JobListAction.module.css:101`) but
  **not defined** in any package sheet. Use `font-family: var(--ds-font-family-code)` or
  `var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)`.

Scrollbar (rebindable indirection, `scrollbar.css:18-30,44-90`):

- raw: `--dsw-alias-scrollbar-bg-l1/l2`, `--dsw-alias-scrollbar-hover-l1/l2`
  (`design-platform.css:218-221,310-313`);
- consumer indirection: `--dsh-scrollbar-thumb`, `--dsh-scrollbar-thumb-hover`,
  `--dsh-scrollbar-width` (8 px), declared on `body` and re-declared per element; an elevated
  surface rebinds the l2 pair on its own container — exactly what the jobs menu does
  (`ui-jobs/src/client/JobListAction.module.css:53-56`).

Motion: `--ds-ease-in-out`, `--ds-transition-duration` (0.2s), `-fast` (0.1s), `-slow` (0.3s)
(`base.css:13-15`).

## 4.3 Compact-widget token recipe (copied in the template)

```css
background: var(--dsw-specific-menu);
color: var(--dsw-alias-label-primary);
border: 1px solid var(--dsw-alias-border-l2);
border-radius: 12px;
box-shadow: var(--dsw-shadow-lv2);
font-family: var(--ds-font-family-code);       /* digits */
font-variant-numeric: tabular-nums;
```

---

# 5. Locale

## 5.1 API

Service id `locale` (`@deepseek-ai/dsh-client-locale/src/client/index.ts:70-75,91-96`), provided by
`dsh-client-locale` (`immediately:true`). Inject `'locale'` when registering dictionaries.

Two callable forms (implementation `src/client/index.ts:196-244`):

```js
// 3-arg UNTYPED form — the plain-JS-safe overload (declared at :216)
const dispose = ctx.locale.register("pomodoro", "en", { start: "Start", pause: "Pause" })
const disposeZh = ctx.locale.register("pomodoro", "zh", { start: "开始", pause: "暂停" })

// 2-arg typed form (:207). At RUNTIME this also works from plain JS — the implementation
// dispatches on `typeof localeOrDicts === 'string'` (:217-221) — but the public overload is
// constrained to `keyof LocaleNamespaceMap`, i.e. namespaces declared by TS module augmentation.
const dispose2 = ctx.locale.register("pomodoro", { en: enDict, zh: zhDict })
```

- Returns an idempotent disposer (register inside `ctx.effect` so plugin unload unregisters).
- Re-registering the same `(namespace, locale)` throws (`src/client/index.ts:222-224`). One owner per
  namespace/locale pair.
- No runtime declaration is needed. `LocaleNamespaceMap` is a **compile-time only** table
  (`@deepseek-ai/dsh-client-ui-slots/src/index.ts:26-34`) used to type-check dictionary keys at TS
  registration sites; a plain JS bundle can register an arbitrary namespace string. Only the 2-arg
  overload’s typing requires the merge — use the 3-arg form if you ever build in TS without adding a
  `declare module` block.

## 5.2 Getting `t` in the component

Add `locale: "pomodoro"` to the slot registration options. The renderer synthesizes the `t` prop from
the installed locale face and re-mints it on every locale revision
(`REPO:packages/client/web-react/src/scoped-slots.tsx:218-243,405-416`). If the declared namespace has
no dictionaries, `t(key)` falls back to the key (and then the shared `common` namespace)
(`dsh-client-locale/src/client/index.ts:274-286`).

Failure mode to avoid: declaring `locale:` while the locale plugin is not in the client composition
throws a loud `SlotAssemblyError` (“no locale face is installed”) at render
(`REPO:packages/client/web-react/src/scoped-slots.tsx:405-414`). This composition always has it.

---

# 6. Persistence

## 6.1 `localStorage` — acceptable, use it for widget state

There is **no** client storage service. The framework itself writes plugin state through raw
`localStorage` in its store engine:

- `createSnapshotStore(init, { persist: { name } })` rehydrates with `localStorage.getItem(name)` and
  writes on every state change; failures (quota, private mode, non-browser) silently disable
  persistence (`@deepseek-ai/dsh-client-runtime/src/client/contract/store.ts:83-92,120-147`).
- `defineStore({ init, persist: "key", actions })` wraps it; session-scoped store instances get the
  key suffix `.${sessionId}` and expose `clearPersisted()` (`store.ts:192-240`).

So direct `localStorage` in a plugin component is consistent with framework behavior. Requirements:
guard `typeof localStorage === "undefined"` (Node/jsdom boot has none — `store.ts:128-131`),
`try/catch` every access, and namespace the key (the template uses
`dsh-pomodoro.state.v1`). **Do not** use `sessionStorage` for state that should survive restart.

Optionally require `@deepseek-ai/dsh-client-runtime/client` and use `defineStore`/`createSnapshotStore`
for the same engine (safe only for that one specifier — §1.2).

## 6.2 Host-durable settings (`ctx.settingsScope`) — available but heavier

Service id `settingsScope`, provided by `dsh-client-ui-settings`
(`@deepseek-ai/dsh-client-ui-settings/src/client/index.ts:2-7,49-56`;
merge declared at `settings-scope.ts:209-213`). API:

```js
const scope = ctx.settingsScope.bind({ namespace: "pomodoro" })  // must inject 'settingsScope'
scope.getSnapshot()       // { status, value, base, user, revision, writable, mode }
scope.subscribe(fn)       // disposer
await scope.set(field, value)
await scope.unset(field)
```

Contract: `@deepseek-ai/dsh-client-runtime/src/client/contract/settings-scope.ts:22-83`.
Caveats: the namespace must be **registered on the Host** with a schema by a host plugin
(`settingsCtx.settings.register(namespace, schema)`, example
`@deepseek-ai/dsh-client-ui-theme/src/index.ts:46-52`); remote browsers run memory-only
(`settings-scope.ts:243-247`); writes are revision-fenced asynchronous RPC. For a timer’s
running/remaining state this is overkill — use `localStorage`. Use `settingsScope` only if the timer
configuration must sync across machines/sessions through the Host settings document.

There is no `ctx.settings`, `ctx.preferences`, or `ctx.storage` client service
(grep across all `dsh-client-*/src` returns none; the host-side `ctx.settings` is a different,
server-side service, e.g. `ui-theme/src/index.ts:34-40`).

---

# 7. Timers and effects

## 7.1 React hooks: fully available, no constraint

A slot component is rendered by the shell’s React 18 instance obtained from the `react` seed (§1.2),
so `useState/useEffect/useRef/useMemo/useCallback` behave exactly as in shipped plugins.

The canonical tick pattern is the jobs widget (`@deepseek-ai/dsh-client-ui-jobs/lib/client.js:117-138`):

```js
const [open, setOpen] = React.useState(false)
const [now, setNow] = React.useState(() => Date.now())
React.useEffect(() => {
  if (!open || liveCount === 0) return
  setNow(Date.now())
  const timer = setInterval(() => { setNow(Date.now()) }, 1000)
  return () => { clearInterval(timer) }          // MUST clear on unmount/dep change
}, [open, liveCount])
if (jobs.length === 0) return null                 // conditional render AFTER all hooks
```

For a countdown, avoid accumulating drift: store the target epoch in a ref and recompute
`endAt - Date.now()` on each tick (template does this at 250 ms; display resolution is 1 s).

## 7.2 Plugin-level lifetime: `ctx.effect`

Resources that outlive a component (locale dictionaries, event listeners, intervals the plugin owns)
are registered through `ctx.effect(setup, label)`; the returned disposer runs on plugin unload
(`REPO:vendor/cordis/src/fiber.ts:69-95`). Shipped usage: `ctx.effect(() => ctx.locale.register(...),
'ui-job: dictionaries')` (`dsh-client-ui-jobs/src/client/index.ts:29`).

Rules:

- Never start a timer at factory top level (factory runs at materialization, outside any fiber/lifecycle).
- Component timers: `useEffect` + cleanup; plugin timers: `ctx.effect(() => { const id = setInterval…
  ; return () => clearInterval(id) }, label)`.
- `ctx.effect` may be called only while the plugin/fiber is active (during `apply`) —
  `INACTIVE_EFFECT` otherwise (`vendor/cordis/src/fiber.ts:172`).

No constraint blocks a plain bundle from hooks or timers; the only hard rule is that hook calls must
be unconditional (React rules), which is already required in TS plugin code too.

---

# 8. Host-side counterpart and package.json

## 8.1 A browser-only package still needs a host half

The host that serves bundles scans **loader entries**, not the filesystem: `resolveMeta` is only
called for entry names in `ctx.loader.entries()` whose fiber is alive
(`@deepseek-ai/dsh-client-modules/src/index.ts:380-401`). A package with no host half never becomes
an entry, so its `client.js` is never put in `window.__DSH_BOOT__` and never loaded.

Therefore the package needs:

1. A resolvable `main` module that exports a callable plugin (empty `apply`). The entry imports it,
   and cordis rejects a module without `apply` (`vendor/cordis/src/registry.ts:315-320`). Shipped
   precedent: `@deepseek-ai/dsh-client-ui-jobs/src/index.ts` (“the empty apply exists so the plugin
   appears in the host cordis.yml / Loader; the browser half ships via exports["./client"]”),
   built form `lib/index.js` = `export function apply() {}`.
2. A `dsh.client` declaration with `platform: "web"`; `exports["./client"]` is resolved and the file
   read for its rev (`dsh-client-modules/src/index.ts:109-151,332-372`). `platform !== "web"` means
   “not a client row”.
3. A loader entry in the profile (`cordis.patch.yml` insert) and the package installed where
   `require.resolve('<pkg>/package.json')` works from the profile directory
   (`resolvePkgJson` anchored at `ctx.baseUrl`, `dsh-client-modules/src/index.ts:196-205,332-343`;
   resolution is ordinary Node resolution from the profile dir plus the flat fallback
   `~/.dsh/profiles/node_modules`).

## 8.2 Mandatory package.json fields

Minimal working manifest (derived from `@deepseek-ai/dsh-client-ui-jobs/package.json` and
`dsh-client-modules` validation):

```json
{
  "name": "dsh-plugin-pomodoro",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-layout"
      ]
    }
  },
  "files": ["lib/index.js", "lib/client.js"]
}
```

Field-by-field:

| field | required | enforced by |
|---|---|---|
| `name` | yes | must equal `window.__ModuleLoader__.load({id})` and the loader entry name |
| `type: "module"` | yes for the host half | `main` is ESM in every shipped package; the loader imports it via Node ESM |
| `main` | yes | loader entry import of the package root (`Entry._init`, `REPO:vendor/loader/src/config/entry.ts:275-300`) |
| `exports["./client"]` | yes | `clientExportOf` accepts a string or `{ default: string }` (`dsh-client-modules/src/index.ts:132-143`); missing → boot error `declares dsh.client but exports no "./client" bundle` (`:355-357`) |
| `dsh.client.platform === "web"` | yes | `parseDshClient` (`:109-130`) / `resolveMeta` (`:345-352`) |
| `dsh.client.inject` | recommended | validated as `string[]` (`:120-121`), placed on the graph row as informational edges (`:150-156`); keep package names here matching the services you lean on |
| `dsh.client.immediately` | optional bool | stage-one prefetch tier (`:122-127`; `boot.tsx:151-157`); omit for a normal widget |
| `types`, `files`, `scripts` | not runtime-required | packaging hygiene only |

## 8.3 Profile wiring (desktop profile)

1. Install the package so it resolves from the profile dir (profile `package.json` dependency +
   install, or a link under `~/.dsh/profiles/node_modules`). Note: `~/.dsh` is out of scope for this
   task — do not modify it; document/patch it at install time.
2. Append a loader entry with the profile’s own patch layer. `cordis.patch.yml` is a top-level list
   of patch entries; an `insert` without `id` appends top-level entries
   (`@deepseek-ai/cordis-plugin-include/src/index.ts:44-103`; format documented at
   `REPO:packages/boot/app-boot/src/profile.ts:127-129`):

```yaml
- insert:
    - id: pomodoro
      name: "dsh-plugin-pomodoro"
```

3. Restart the app (the plugin set is scanned at boot; negative verdicts are cached until restart,
   `dsh-client-modules/src/index.ts:185-193`). The boot manifest gains
   `<script>window.__DSH_BOOT__ = {... entries …}</script>` and the bundle is served from
   `/plugins/dsh-plugin-pomodoro/client.js?rev=<sha1-12>` (`:145-177,236-247`).

## 8.4 Checklist for “it actually loads”

- [ ] `lib/index.js` exists, ESM, exports `apply` (may be empty).
- [ ] `lib/client.js` is a **classic script** (no ESM syntax) whose only top-level statement is
      `window.__ModuleLoader__.load({...})`.
- [ ] handoff `id` === package.json `name` === loader entry name.
- [ ] factory is synchronous, returns `{ apply, inject }`, does all requires inside itself.
- [ ] only seed specifiers required (react, react/jsx-runtime, ui-primitives, optionally runtime/client).
- [ ] `exports.apply` registers via `ctx.slots.inject(key, () => ctx.slots.register(...))`.
- [ ] declared `inject` includes every service touched (`slots`, plus `locale` if used).
- [ ] CSS injected inside factory, tagged `data-plugin` + unique `data-plugin-css`, idempotent guard.
- [ ] profile patch inserts the loader row; app restarted.
- [ ] spot-check in DevTools: `document.querySelector('style[data-plugin="dsh-plugin-pomodoro"]')`,
      and `window.__DSH_BOOT__.entries.find(e => e.id === "dsh-plugin-pomodoro")`.

---

# Appendix A — verified minimal template

The block below is the exact artifact validated in Appendix B (real `ClientModuleSystem` + real React
18 render). Replace the package id in **all three** places it appears (`load` id, style owner, package
name) with the real package name. Keep the two marker comments so the verification script can
re-extract it.

```js
// == TEMPLATE START ==
window.__ModuleLoader__.load({
  // MUST equal package.json "name" (graph row id / loader entry name).
  id: "dsh-plugin-pomodoro",
  factory: (require) => {
    "use strict"

    // Only platform seed words may be required (see spec §1.2).
    const React = require("react")
    const { jsx, jsxs } = require("react/jsx-runtime")
    const ui = require("@deepseek-ai/dsh-client-ui-primitives")

    const PLUGIN_ID = "dsh-plugin-pomodoro"

    // ---- CSS: injected at materialization, inside the factory, never at top level ----
    const CSS_TAG_ID = PLUGIN_ID + "/pomodoro.css"
    const CSS_TEXT = [
      ".dsh-pomodoro{position:absolute;right:16px;bottom:16px;display:flex;align-items:center;gap:8px;",
      "box-sizing:border-box;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;",
      "background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv2);",
      "font-size:13px;line-height:18px}",
      ".dsh-pomodoro[data-mode=break]{border-color:var(--dsw-alias-state-success-primary)}",
      ".dsh-pomodoro-mode{color:var(--dsw-alias-label-tertiary);font-size:11px}",
      ".dsh-pomodoro-time{font-family:var(--ds-font-family-code);font-variant-numeric:tabular-nums}",
      ".dsh-pomodoro-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;",
      "padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".dsh-pomodoro-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsh-pomodoro-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
    ].join("")
    if (typeof document !== "undefined"
      && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
      const tag = document.createElement("style")
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS_TEXT
      document.head.appendChild(tag)
    }

    // ---- dictionaries: namespace "pomodoro" (untyped 3-arg register form) ----
    const zh = { focus: "专注", rest: "休息", start: "开始", pause: "暂停", reset: "重置", mode: "切换专注/休息" }
    const en = { focus: "Focus", rest: "Break", start: "Start", pause: "Pause", reset: "Reset", mode: "Switch focus/break" }

    // ---- widget state machine ----
    const FOCUS_MS = 25 * 60 * 1000
    const BREAK_MS = 5 * 60 * 1000
    const STORAGE_KEY = "dsh-pomodoro.state.v1"

    function readPersisted() {
      try {
        if (typeof localStorage === "undefined") return null
        const raw = localStorage.getItem(STORAGE_KEY)
        return raw === null ? null : JSON.parse(raw)
      } catch (_error) {
        return null
      }
    }
    function persist(state) {
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      } catch (_error) { /* quota / private mode: persistence is best-effort */ }
    }
    function durationOf(mode) { return mode === "break" ? BREAK_MS : FOCUS_MS }
    function formatClock(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000))
      return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0")
    }

    /**
     * Persistent compact timer. Rendered into the global `shell.overlay` list slot:
     * props = { useSessions, useWorkspaces, t } (locale: "pomodoro").
     */
    function PomodoroWidget({ t }) {
      const saved = React.useRef(readPersisted())
      const initialMode = saved.current !== null && saved.current.mode === "break" ? "break" : "focus"
      const [mode, setMode] = React.useState(initialMode)
      const [remaining, setRemaining] = React.useState(() => {
        const value = saved.current !== null ? saved.current.remaining : undefined
        return typeof value === "number" && value >= 0 && value <= durationOf(initialMode)
          ? value
          : durationOf(initialMode)
      })
      const [running, setRunning] = React.useState(false)
      const endAt = React.useRef(0)

      // Countdown: target-epoch ref + 250 ms tick; cleanup is mandatory.
      React.useEffect(() => {
        if (!running) return undefined
        endAt.current = Date.now() + remaining
        const timer = setInterval(() => {
          const left = endAt.current - Date.now()
          if (left > 0) {
            setRemaining(left)
          } else {
            setRemaining(0)
            setRunning(false)
            persist({ mode: mode, remaining: 0 })
          }
        }, 250)
        return () => { clearInterval(timer) }
      }, [running]) // `remaining` seeds endAt at start; it is not a dependency

      function toggle() {
        if (running) {
          setRunning(false)
          persist({ mode: mode, remaining: remaining })
          return
        }
        const next = remaining > 0 ? remaining : durationOf(mode)
        if (next !== remaining) setRemaining(next)
        setRunning(true)
      }
      function reset() {
        setRunning(false)
        setRemaining(durationOf(mode))
        persist({ mode: mode, remaining: durationOf(mode) })
      }
      function switchMode() {
        const next = mode === "focus" ? "break" : "focus"
        setRunning(false)
        setMode(next)
        setRemaining(durationOf(next))
        persist({ mode: next, remaining: durationOf(next) })
      }

      const mainLabel = t(running ? "pause" : "start")
      return jsxs("div", {
        className: "dsh-pomodoro",
        "data-mode": mode,
        children: [
          jsx(ui.StateDot, { state: running ? "ongoing" : "done", size: 8 }),
          jsx("span", { className: "dsh-pomodoro-mode", children: t(mode) }),
          jsx("span", { className: "dsh-pomodoro-time", children: formatClock(remaining) }),
          jsx(ui.Tooltip, {
            label: mainLabel,
            side: "top",
            children: jsx("button", {
              type: "button",
              className: "dsh-pomodoro-btn",
              "aria-label": mainLabel,
              onClick: toggle,
              children: running
                ? jsx(ui.IconPauseOutline16, { size: 14 })
                : jsx(ui.IconPlayOutline16, { size: 14 }),
            }),
          }),
          jsx(ui.Tooltip, {
            label: t("reset"),
            side: "top",
            children: jsx("button", {
              type: "button",
              className: "dsh-pomodoro-btn",
              "aria-label": t("reset"),
              onClick: reset,
              children: jsx(ui.IconRefreshOutline16, { size: 13 }),
            }),
          }),
          jsx("button", {
            type: "button",
            className: "dsh-pomodoro-btn",
            "aria-label": t("mode"),
            onClick: switchMode,
            children: jsx(ui.IconChevronRightOutline14, { size: 12 }),
          }),
        ],
      })
    }

    // ---- plugin face consumed by cordis: services + entry point ----
    const inject = ["slots", "locale"]

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register("pomodoro", "en", en), "pomodoro: en dictionary")
      ctx.effect(() => ctx.locale.register("pomodoro", "zh", zh), "pomodoro: zh dictionary")
      // `shell.overlay` is declared by ui-layout's AppFrame; inject() waits for it.
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "pomodoro-timer",   // unique list-cell id
        order: 100,             // ascending display order; no shipped overlay entries
        locale: "pomodoro",     // injects the t() prop
      }, PomodoroWidget))
    }

    return { apply: apply, inject: inject }
  },
})
// == TEMPLATE END ==
```

Notes:

- `jsx`/`jsxs` come from the **real** seeded `react/jsx-runtime`; this is exactly what the tsdown
  bundles do (`ui-jobs/lib/client.js:7,147`). No JSX syntax is needed in a hand-written file.
- The `useEffect` dependency list intentionally omits `remaining` (it is read only when the effect
  starts); this avoids restarting the interval every tick.
- `t(mode)` relies on the `focus`/`rest` dictionary keys matching the mode values.
- If the widget should live per-session instead, swap the apply body for the
  `conversation.session.header.actions` registration from §2.4(B) and add `sessionId`/`useSession`
  to the props (they arrive automatically for session-scope slots).

---

# Appendix B — how the template was verified

No live app installation was performed (`~/.dsh` is read-only for this task). The contract was
verified mechanically against the **real shipped module system**:

1. `@deepseek-ai/dsh-client-modules/lib/client.js` was executed in Node with a stubbed
   `window.__ModuleLoader__` + `document`; its exported `ClientModuleSystem` was instantiated with
   `staticModules` seeded by the real React 18.3.1 (`react`, `react/jsx-runtime`) and stub
   primitives, `modules: []` (the bundle registers itself).
2. The template block from Appendix A was evaluated as a classic script; it registered the factory
   under `id: "dsh-plugin-pomodoro"` exactly as `system.ts:86-96` requires.
3. `system.import("dsh-plugin-pomodoro")` materialized the factory, which:
   - injected one `<style data-plugin="dsh-plugin-pomodoro" data-plugin-css="dsh-plugin-pomodoro/pomodoro.css">`;
   - returned `{ apply, inject }` with `inject = ["slots","locale"]`.
4. `exports.apply(fakeCtx)` was invoked with recording stubs:
   - two `ctx.locale.register("pomodoro", <locale>, <dict>)` calls;
   - one `ctx.slots.inject("shell.overlay", cb)` whose callback registered
     `{ name: "shell.overlay", id: "pomodoro-timer", order: 100, locale: "pomodoro" }` with the
     `PomodoroWidget` component.
5. The component was server-rendered with React 18 `renderToStaticMarkup` and props
   `{ t: key => key }`; it produced the expected widget markup (hooks executed, no throw).

What this does **not** prove (must be confirmed on a real profile, since the deliverable may not
touch `~/.dsh`): bundle serving over `/plugins/...`, the boot graph row, and slot rendering inside
the live shell. Those paths are covered by source evidence in §1.1, §1.3, §8 rather than execution.

---

# Appendix C — unresolved / caution list

- **`dsh.client.inject` runtime effect**: in this build the browser boot passes only row ids to the
  loader (`boot.tsx:189-205`); the package list is informational graph metadata
  (`manifest.ts:43-49`). Do not rely on it for activation order — use bundle `exports.inject`.
- **`--dsw-font-mono` and `--dsw-alias-fill-*` are referenced by some shipped CSS but not defined**
  in the shipped token sheets. Use `--ds-font-family-code` and `--dsw-alias-bg-layer-*` /
  `--dsw-alias-interactive-bg-hover` instead.
- **No radius token**: hardcode 8-12 px following shipped components.
- **No generic storage/preferences client service**: `localStorage` (framework-sanctioned) or
  `ctx.settingsScope` (needs a host namespace + schema).
- The HMR plugin additionally consumes the graph (`onGraphChanged`, bundle revs); a hand-edited
  bundle is picked up only if `dsh-client-hmr` is watching it
  (`dsh-client-modules/src/index.ts:262-299`). Restart is the reliable path.
