import { createEffect, createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { DragDropProvider, PointerSensor, useDroppable } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis, RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { displayName } from "@opencode/ui/project-avatar"
import { Icon } from "@opencode/ui/icon"
import { moveSessionDirectory } from "@/session/commands/move"
import { tabHref, tabKey, type SessionTab, type Tab } from "@/shell/tabs/tabs"
import { ServerConnection } from "@/runtime/server/registry"
import { DraftTabItem, TabNavItem } from "@/shell/titlebar/tab-nav"
import { useGlobal, useServerCtx, type ServerCtx } from "@/runtime/server/runtime"
import { useLayout } from "@/shell/state/layout"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"
import { useCommand } from "@/shell/commands/command"
import { useTabs } from "@/shell/tabs/tabs"
import { createTabComposerState } from "@/composer/persistence"
import { base64Encode } from "@opencode/util/encode"
import { showToast } from "@/shell/notifications/toast"
import { adjacentTabKey, mergeVisibleTabOrder } from "./tab-order"
import type { SessionInfo } from "@opencode/client/promise"

function SessionTabSlot(props: {
  tab: SessionTab
  id: string
  index: number
  active: boolean
  hideProject: boolean
  orientation: "horizontal" | "vertical"
  session: SessionInfo | undefined
  preparing: boolean
  fallbackTitle?: string
  onRename: (title: string) => Promise<void>
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index
    },
  })

  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active}
      data-orientation={props.orientation}
      class="relative flex"
      classList={{
        "w-56 min-w-7 max-w-56 flex-shrink": props.orientation === "horizontal",
        "w-full shrink-0": props.orientation === "vertical",
      }}
    >
      <TabNavItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        server={props.tab.server}
        session={props.session}
        preparing={props.preparing}
        fallbackTitle={props.fallbackTitle}
        hideProject={props.hideProject}
        onRename={props.onRename}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active}
        dragging={sortable.isDragSource()}
        orientation={props.orientation}
      />
    </div>
  )
}

function SessionTabEntry(props: {
  tab: SessionTab
  id: string
  index: number
  active: boolean
  orientation: "horizontal" | "vertical"
  serverCtx: ServerCtx | undefined
  onVisibleChange: (visible: boolean) => void
  onProjectChange: (project: { worktree: string; name: string } | undefined) => void
  hideProject: boolean
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const sdk = createMemo(() => props.serverCtx?.sdk ?? null)
  const pending = createMemo(() => tabs.pendingSession(props.tab.server, props.tab.sessionId))
  const cachedSession = createMemo(() => props.serverCtx?.data.session.get(props.tab.sessionId))
  const persisted = createMemo(() => tabs.info[props.id])

  const [loadedSession] = createResource(
    () => {
      if (pending()) return null
      const ctx = props.serverCtx

      return ctx ? { id: props.tab.sessionId, ctx } : null
    },
    ({ id, ctx }) =>
      ctx.data.session
        .sync(id)
        .then(() => ctx.data.session.get(id))
        .catch(() => undefined),
  )

  const session = createMemo(() => (pending() ? undefined : (cachedSession() ?? loadedSession())))
  const missingSession = createMemo(() => !pending() && !!props.serverCtx && !loadedSession.loading && !session())
  const visible = createMemo(() => !!pending() || !!session() || missingSession() || !!persisted()?.title)

  const rename = async (title: string) => {
    const value = session()
    const ctx = props.serverCtx

    if (!value || !ctx) return

    ctx.data.session.remember({ ...value, title })

    try {
      await ctx.sdk.api.session.update({ sessionID: value.id, title })
    } catch (err) {
      const current = session()
      const currentCtx = props.serverCtx

      if (current && currentCtx) currentCtx.data.session.remember({ ...current, title: value.title })
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  createEffect(() => props.onVisibleChange(visible()))

  // Report the tab's project upward so the strip can cluster tabs by project.
  createEffect(() => {
    const value = session()
    const ctx = props.serverCtx

    if (!ctx || !value) {
      props.onProjectChange(undefined)

      return
    }

    const project = ctx.projects.forSession(value)

    props.onProjectChange(project ? { worktree: project.worktree, name: displayName(project) } : undefined)
  })

  createEffect(() => {
    const ctx = props.serverCtx
    const value = session()

    if (!ctx || !value || props.active || ctx.sdk.connection.status() !== "connected") return

    const timer = window.setTimeout(
      () =>
        void Promise.allSettled([
          ctx.data.session.sync(value.id, { children: true }),
          // The selected timeline loads the transcript; inactive tabs need attention, metadata, and the inbox,
          // whose waiting work keeps the tab busy.
          ctx.data.session.permission.sync(value.id),
          ctx.data.session.form.sync(value.id),
          ctx.data.session.pending.sync(value.id),
        ]),
      300 + props.index * 50,
    )

    onCleanup(() => window.clearTimeout(timer))
  })

  createEffect(() => {
    const value = session()

    if (!value) return
    tabs.rememberSessionInfo(
      props.tab,
      value,
      props.serverCtx?.data.session.message.list(value.id).some((message) => message.type === "user") ?? false,
    )
    const current = sdk()

    if (!current) return
    createTabComposerState(tabs, props.tab, current.scope, {
      dir: base64Encode(value.location.directory),
      id: value.id,
    })
  })

  return (
    <Show when={visible()}>
      <SessionTabSlot
        tab={props.tab}
        id={props.id}
        index={props.index}
        active={props.active}
        hideProject={props.hideProject}
        orientation={props.orientation}
        session={session()}
        preparing={!!pending()}
        fallbackTitle={
          pending()
            ? language.t("session.tab.session")
            : (persisted()?.title ?? (missingSession() ? language.t("session.tab.unknown") : undefined))
        }
        onRename={rename}
        onNavigate={props.onNavigate}
        onClose={props.onClose}
      />
    </Show>
  )
}

function DraftTabSlot(props: {
  tab: Extract<Tab, { type: "draft" }>
  id: string
  index: number
  active: boolean
  orientation: "horizontal" | "vertical"
  title: string
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index
    },
  })

  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active}
      data-orientation={props.orientation}
      class="relative flex"
      classList={{
        "w-56 min-w-7 max-w-56 flex-shrink": props.orientation === "horizontal",
        "w-full shrink-0": props.orientation === "vertical",
      }}
    >
      <DraftTabItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        title={props.title}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active}
        dragging={sortable.isDragSource()}
        orientation={props.orientation}
      />
    </div>
  )
}

function TabGroupHeader(props: {
  worktree: string | null
  name: string
  count: number
  collapsed: boolean
  orientation: "horizontal" | "vertical"
  onToggle: () => void
}) {
  const droppable = useDroppable({
    id: props.worktree === null ? "tab-group-ungrouped" : `tab-group:${props.worktree}`,
    disabled: props.worktree === null,
  })

  return (
    <button
      ref={droppable.ref}
      type="button"
      data-slot="titlebar-tab-group"
      data-collapsed={props.collapsed}
      aria-expanded={!props.collapsed}
      class="flex h-7 min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-[6px] px-1.5 text-start text-[12px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
      classList={{
        "w-full": props.orientation === "vertical",
        "outline-dashed outline-1 outline-v2-border-border-focus": droppable.isDropTarget(),
      }}
      onClick={props.onToggle}
    >
      <Icon name={props.collapsed ? "chevron-right" : "chevron-down"} size="small" />
      <span class="min-w-0 flex-1 truncate">{props.name}</span>
      <span class="shrink-0">{props.count}</span>
    </button>
  )
}

function TitlebarTabItem(props: {
  tab: Tab
  orientation: "horizontal" | "vertical"
  active: boolean
  hideProject: boolean
  visibleTabs: Tab[]
  onVisibleChange: (visible: boolean) => void
  onProjectChange: (project: { worktree: string; name: string } | undefined) => void
  onNavigate: (tab: Tab, el?: HTMLDivElement) => void
  onClose: (tab: Tab) => void
}) {
  const global = useGlobal()
  const language = useLanguage()
  const id = tabKey(props.tab)
  let ref!: HTMLDivElement
  const visibleIndex = () => props.visibleTabs.findIndex((item) => tabKey(item) === id)
  useTabShortcut(visibleIndex, () => props.onNavigate(props.tab, ref))

  const serverCtx = useServerCtx(() => {
    if (props.tab.type !== "session") return

    return global.servers.list().find((item) => ServerConnection.key(item) === props.tab.server)
  })

  if (props.tab.type === "session") {
    return (
      <SessionTabEntry
        tab={props.tab}
        id={id}
        index={visibleIndex()}
        active={props.active}
        hideProject={props.hideProject}
        orientation={props.orientation}
        serverCtx={serverCtx()}
        onVisibleChange={props.onVisibleChange}
        onProjectChange={props.onProjectChange}
        onNavigate={(element) => {
          ref = element
          props.onNavigate(props.tab, element)
        }}
        onClose={() => props.onClose(props.tab)}
      />
    )
  }

  return (
    <DraftTabSlot
      tab={props.tab}
      id={id}
      index={visibleIndex()}
      active={props.active}
      orientation={props.orientation}
      title={language.t("session.tab.session")}
      onNavigate={(element) => {
        ref = element
        props.onNavigate(props.tab, element)
      }}
      onClose={() => props.onClose(props.tab)}
    />
  )
}

export function TitlebarTabStrip(props: {
  orientation?: "horizontal" | "vertical"
  tabs: Tab[]
  currentTab: Tab | undefined
  onNavigate: (tab: Tab, el?: HTMLDivElement) => void
  onClose: (tab: Tab) => void
  onReorder: (keys: string[]) => void
}) {
  const language = useLanguage()
  const command = useCommand()
  const settings = useSettings()
  const global = useGlobal()
  const vertical = () => props.orientation === "vertical"
  let listRef!: HTMLDivElement
  const [visibility, setVisibility] = createStore<Record<string, boolean>>({})

  // Project clustering for tab groups, reported by entries that resolve their session.
  const [tabProjects, setTabProjects] = createStore<Record<string, { worktree: string; name: string } | undefined>>(
    {},
  )

  const layout = useLayout()

  const grouped = () => settings.appearance.tabGroups() === "project"

  const groupKey = (tab: Tab) => (tab.type === "session" ? tabProjects[tabKey(tab)]?.worktree : undefined)

  const visibleTabs = createMemo(() =>
    props.tabs.filter((tab) => {
      if (tab.type !== "draft" && !visibility[tabKey(tab)]) return false

      if (!grouped()) return true

      const key = groupKey(tab)

      return !key || !layout.tabGroups.collapsed(key)
    }),
  )

  const visibleTabIds = () => visibleTabs().map(tabKey)

  type TitlebarTabGroup = { key: string | null; name: string; tabs: Tab[] }

  const groups = createMemo(() => {
    const list: TitlebarTabGroup[] = []
    const byKey = new Map<string | null, TitlebarTabGroup>()

    for (const tab of props.tabs) {
      const project = tab.type === "session" ? tabProjects[tabKey(tab)] : undefined
      const key = project?.worktree ?? null
      let group = byKey.get(key)

      if (!group) {
        group = { key, name: project?.name ?? language.t("tabs.group.ungrouped"), tabs: [] }
        byKey.set(key, group)
        list.push(group)
      }

      group.tabs.push(tab)
    }

    return list
  })

  const reportTabProject = (tab: Tab, project: { worktree: string; name: string } | undefined) => {
    const id = tabKey(tab)
    const current = tabProjects[id]

    if (current?.worktree === project?.worktree && current?.name === project?.name) return
    setTabProjects(id, project ? { worktree: project.worktree, name: project.name } : undefined)
  }

  command.register("titlebar-tab-cycle", () => [
    {
      id: `tab.prev`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowLeft,ctrl+shift+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      id: `tab.next`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowRight,ctrl+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(1),
    },
  ])

  const moveTabToProject = async (tab: Tab, worktree: string) => {
    if (tab.type !== "session") return

    const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
    const ctx = conn ? global.serverCtx(ServerConnection.key(conn)) : undefined

    if (!ctx) return

    const current =
      ctx.data.session.get(tab.sessionId) ??
      (await ctx.sdk.api.session.get({ sessionID: tab.sessionId }).catch(() => undefined))

    if (!current) return

    const project = ctx.projects.forSession(current)

    if (!project || project.worktree === worktree) return

    await moveSessionDirectory({
      api: ctx.sdk.api,
      projects: ctx.projects,
      sessions: ctx.data.session,
      session: current,
      directory: worktree,
      language,
    })
  }

  function selectAdjacentTab(offset: -1 | 1) {
    const current = props.currentTab
    const key = adjacentTabKey(visibleTabIds(), current ? tabKey(current) : undefined, offset)
    const next = props.tabs.find((tab) => tabKey(tab) === key)

    if (next) props.onNavigate(next)
  }

  return (
    <div
      data-slot={vertical() ? "vertical-tabs" : "titlebar-tabs"}
      data-orientation={vertical() ? "vertical" : "horizontal"}
      class="relative min-w-0"
      classList={{ "min-h-0 overflow-hidden": vertical() }}
    >
      <div
        data-slot={vertical() ? "vertical-tabs-scroll" : "titlebar-tabs-scroll"}
        class="flex min-w-0 no-scrollbar [app-region:no-drag]"
        classList={{
          "flex-row items-center gap-1.5 overflow-x-auto": !vertical(),
          "max-h-full flex-col overflow-y-auto overflow-x-hidden": vertical(),
        }}
      >
        <DragDropProvider
          sensors={[
            PointerSensor.configure({
              activationConstraints: (event) =>
                event.pointerType === "touch"
                  ? [new PointerActivationConstraints.Distance({ value: 8 })]
                  : [new PointerActivationConstraints.Distance({ value: 4 })],
              preventActivation: (event) =>
                event.target instanceof Element &&
                !!event.target.closest('[data-slot="tab-close"], [contenteditable="true"]'),
            }),
          ]}
          modifiers={[
            vertical() ? RestrictToVerticalAxis : RestrictToHorizontalAxis,
            RestrictToElement.configure({ element: () => listRef }),
          ]}
          plugins={(defaults) => [
            ...defaults.filter((plugin) => plugin !== Accessibility),
            AutoScroller.configure({ acceleration: 8, threshold: vertical() ? { x: 0, y: 0.05 } : { x: 0.05, y: 0 } }),
            Feedback.configure({ dropAnimation: null }),
          ]}
          onDragStart={(event) => {
            const source = event.operation.source

            if (!source) return
            const tab = props.tabs.find((item) => tabKey(item) === source.id.toString())

            if (!tab) return

            if (vertical()) return
            const tabEl = source.element?.querySelector<HTMLDivElement>("[data-titlebar-tab]")
            props.onNavigate(tab, tabEl ?? undefined)
          }}
          onDragEnd={(event) => {
            const target = event.operation.target
            const targetId = target ? `${target.id}` : undefined

            if (targetId?.startsWith("tab-group:")) {
              const source = event.operation.source

              if (event.canceled || !source) return

              const tab = props.tabs.find((item) => tabKey(item) === source.id.toString())

              if (tab) void moveTabToProject(tab, targetId.slice("tab-group:".length))

              return
            }

            const current = visibleTabIds()
            const source = event.operation.source

            if (event.canceled || !isSortable(source)) return

            const { initialIndex, index } = source

            if (initialIndex !== index) {
              props.onReorder(
                mergeVisibleTabOrder(
                  props.tabs.map(tabKey),
                  current,
                  arrayMove(current, source.initialIndex, source.index),
                ),
              )
            }
          }}
        >
          <div
            data-titlebar-tab-list
            data-orientation={vertical() ? "vertical" : "horizontal"}
            class="flex w-full min-w-0"
            classList={{ "flex-row items-center": !vertical(), "flex-col items-stretch": vertical() }}
            ref={listRef}
          >
            <Show
              when={grouped()}
              fallback={
                <For each={props.tabs}>
                  {(tab) => (
                    <TitlebarTabItem
                      tab={tab}
                      orientation={vertical() ? "vertical" : "horizontal"}
                      active={props.currentTab === tab}
                      hideProject={false}
                      visibleTabs={visibleTabs()}
                      onVisibleChange={(visible) => setVisibility(tabKey(tab), visible)}
                      onProjectChange={(project) => reportTabProject(tab, project)}
                      onNavigate={props.onNavigate}
                      onClose={props.onClose}
                    />
                  )}
                </For>
              }
            >
              <For each={groups()}>
                {(group) => (
                  <>
                    <TabGroupHeader
                      worktree={group.key}
                      name={group.name}
                      count={group.tabs.length}
                      collapsed={group.key === null ? false : layout.tabGroups.collapsed(group.key)}
                      orientation={vertical() ? "vertical" : "horizontal"}
                      onToggle={() => {
                        const key = group.key

                        if (key) layout.tabGroups.toggle(key)
                      }}
                    />
                    <Show when={group.key === null || !layout.tabGroups.collapsed(group.key)}>
                      <For each={group.tabs}>
                        {(tab) => (
                          <TitlebarTabItem
                            tab={tab}
                            orientation={vertical() ? "vertical" : "horizontal"}
                            active={props.currentTab === tab}
                            hideProject={group.key !== null}
                            visibleTabs={visibleTabs()}
                            onVisibleChange={(visible) => setVisibility(tabKey(tab), visible)}
                            onProjectChange={(project) => reportTabProject(tab, project)}
                            onNavigate={props.onNavigate}
                            onClose={props.onClose}
                          />
                        )}
                      </For>
                    </Show>
                  </>
                )}
              </For>
            </Show>
          </div>
        </DragDropProvider>
      </div>
      <Show when={!vertical()}>
        <div
          data-slot="titlebar-tabs-fade-left"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-deep),transparent)]"
        />
        <div
          data-slot="titlebar-tabs-fade-right"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-deep),transparent)]"
        />
      </Show>
    </div>
  )
}

function useTabShortcut(index: () => number, onSelect: () => void) {
  const command = useCommand()

  command.register(() => {
    const number = index() + 1

    if (number < 1 || number > 9) return []

    return [
      {
        id: `tab.${number}`,
        category: "tab",
        title: "",
        keybind: `mod+${number}`,
        hidden: true,
        onSelect,
      },
    ]
  })
}
