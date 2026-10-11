import type { LocalProject } from "@/shell/state/layout"
import type { ServerConnection } from "@/runtime/server/registry"
import { useSessionTabAvatarState, type SessionTabStatus } from "@/shell/layout/project-avatar-state"
import { useLanguage } from "@/runtime/i18n/language"
import {
  displayName,
  getProjectAvatarSource,
  getProjectAvatarVariant,
  ProjectAvatar,
} from "@opencode/ui/project-avatar"
import { SessionProgressIndicatorV2 } from "@opencode/session-ui/v2/session-progress-indicator-v2"
import { Show } from "solid-js"

export function SessionTabAvatar(props: {
  project?: LocalProject
  directory: string
  sessionId: string
  server: ServerConnection.Key
}) {
  const state = useSessionTabAvatarState(
    () => props.server,
    () => props.sessionId,
    () => true,
  )

  return (
    <SessionTabAvatarView
      project={props.project}
      directory={props.directory}
      unread={state.unread()}
      loading={state.loading()}
    />
  )
}

export function SessionTabAvatarView(props: {
  project?: LocalProject
  directory: string
  unread: boolean
  loading: boolean
}) {
  return (
    <Show
      when={props.loading}
      fallback={
        <ProjectAvatar
          fallback={displayName(props.project ?? { worktree: props.directory })}
          src={getProjectAvatarSource(props.project?.id, props.project?.icon)}
          variant={getProjectAvatarVariant(props.project?.icon?.color)}
          unread={props.unread}
        />
      }
    >
      <SessionProgressIndicatorV2 />
    </Show>
  )
}

const statusDotClass: Record<SessionTabStatus, string> = {
  waiting: "bg-v2-state-fg-warning",
  error: "bg-v2-state-fg-danger",
  running: "bg-v2-state-fg-info animate-pulse",
  ready: "bg-v2-state-fg-success",
  idle: "bg-v2-text-text-faint",
}

export function SessionStatusDot(props: { server: ServerConnection.Key; sessionId: string }) {
  const language = useLanguage()

  const state = useSessionTabAvatarState(
    () => props.server,
    () => props.sessionId,
    () => false,
  )

  const label = () => {
    const status = state.status()

    if (status === "waiting") return language.t("session.tab.status.waiting")

    if (status === "error") return language.t("session.tab.status.error")

    if (status === "running") return language.t("session.tab.status.running")

    if (status === "ready") return language.t("session.tab.status.ready")

    return language.t("session.tab.status.idle")
  }

  return (
    <span
      role="img"
      aria-label={label()}
      title={label()}
      data-status={state.status()}
      class={`block size-2 rounded-full ${statusDotClass[state.status()]}`}
    />
  )
}
