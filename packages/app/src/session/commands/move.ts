import type { SessionInfo } from "@opencode/client/promise"
import type { Data } from "@opencode/client/solid"
import type { ServerApi } from "@/runtime/server/api"
import type { useLanguage } from "@/runtime/i18n/language"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"

export async function moveSessionDirectory(input: {
  api: Pick<ServerApi, "session">
  projects: { open: (directory: string) => void }
  sessions: Pick<Data["session"], "remember" | "invalidate" | "sync">
  session: SessionInfo
  directory: string
  language: ReturnType<typeof useLanguage>
}): Promise<void> {
  const { api, projects, sessions, session, directory, language } = input

  try {
    await api.session.move({ sessionID: session.id, directory })
    // The destination may not be a known project yet; opening it registers
    // the sidebar entry (idempotent for exact duplicates).
    projects.open(directory)
    sessions.remember(session)
    sessions.invalidate(session.id)
    void sessions.sync(session.id).catch(() => {})
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("session.move.success.title"),
      description: language.t("session.move.success.description", { directory }),
    })
  } catch (cause) {
    showToast({
      variant: "error",
      title: language.t("session.location.moveFailed"),
      description: errorMessage(cause, language.t("common.requestFailed")),
    })
  }
}
