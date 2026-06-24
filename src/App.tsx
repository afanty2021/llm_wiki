import { useState, useEffect } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { invoke } from "@tauri-apps/api/core"
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart"
import i18n from "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useChatStore } from "@/stores/chat-store"
import { listDirectory, openProject } from "@/commands/fs"
import { getLastProject, getRecentProjects, saveLastProject, loadLlmConfig, loadLanguage, loadSearchApiConfig, loadEmbeddingConfig, loadMineruConfig, loadMultimodalConfig, loadOutputLanguage, loadProviderConfigs, loadActivePresetId, loadProxyConfig, loadScheduledImportConfig, saveScheduledImportConfig, loadSourceWatchConfig, loadApiConfig, loadGeneralConfig } from "@/lib/project-store"
import { loadReviewItems, loadLintItems, loadChatHistory } from "@/lib/persist"
import { setupAutoSave } from "@/lib/auto-save"
import { startClipWatcher } from "@/lib/clip-watcher"
import { AppLayout } from "@/components/layout/app-layout"
import { WelcomeScreen } from "@/components/project/welcome-screen"
import { CreateProjectDialog } from "@/components/project/create-project-dialog"
import type { WikiProject } from "@/types/wiki"
import { useAuthStore } from "@/stores/auth-store"
import { LoginPage } from "@/components/auth/LoginPage"
import { RegisterPage } from "@/components/auth/RegisterPage"
import { ProjectPicker } from "@/components/web/project-picker"
import { createLogger } from "@/lib/logger"
import { caps } from "@/lib/capabilities"

const logger = createLogger("app")

function App() {
  const { isAuthenticated, isLoading: authLoading, loadSession } = useAuthStore()
  const [authPage, setAuthPage] = useState<"login" | "register">("login")

  // Load session on mount
  useEffect(() => {
    loadSession()
  }, [])

  const project = useWikiStore((s) => s.project)
  const setProject = useWikiStore((s) => s.setProject)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [loading, setLoading] = useState(true)

  // Set up auto-save and clip watcher once on mount
  useEffect(() => {
    setupAutoSave()
    // 桌面 only:clip-watcher 轮询本地 clip server,web 无此能力
    if (caps.canWatchClipboard) {
      startClipWatcher()
    }
  }, [])

  // Dev-only helper for visually testing the update-banner UX.
  // Open dev tools and run:
  //   __llmwiki_testUpdateBanner()
  // to inject a fake "available" result into the update store —
  // banner appears at the top + red dot lights up the gear icon.
  // Run again with arg `false` (or call setDismissed via the store)
  // to clear. Gated on `import.meta.env.DEV` so the helper never
  // ships in production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(async () => {
      const storeMod = await import("@/stores/update-store")
      const { useUpdateStore } = storeMod
      // Expose the live store getter on window so you can inspect
      // state from devtools when debugging banner behavior.
      ;(window as unknown as { __llmwiki_updateStore?: typeof useUpdateStore }).__llmwiki_updateStore = useUpdateStore
      ;(window as unknown as { __llmwiki_testUpdateBanner?: (clear?: boolean) => void }).__llmwiki_testUpdateBanner = (clear = false) => {
        if (clear) {
          useUpdateStore.getState().setResult(
            { kind: "up-to-date", local: __APP_VERSION__, remote: __APP_VERSION__ },
            Date.now(),
          )
          useUpdateStore.getState().setDismissed(null)
          logger.debug("update banner cleared")
          return
        }
        useUpdateStore.getState().setResult(
          {
            kind: "available",
            local: __APP_VERSION__,
            remote: "v999.0.0",
            release: {
              name: "v999.0.0 (test)",
              tag_name: "v999.0.0",
              body:
                "Test release for banner-UX verification.\n\n" +
                "- Bigger red dot on the Settings icon\n" +
                "- Top banner with one-click dismiss\n" +
                "- Once dismissed, won't reappear for this version",
              html_url: "https://github.com/nashsu/llm_wiki/releases",
              published_at: new Date().toISOString(),
            },
          },
          Date.now(),
        )
        useUpdateStore.getState().setDismissed(null)
        logger.debug("update banner injected. Run __llmwiki_testUpdateBanner(true) to clear.")
      }
    })()
  }, [])

  // Background update check — hydrate persisted user preferences, then
  // hit GitHub at most once every UPDATE_CHECK_CACHE_MS. Runs 1.5 s
  // after mount so it doesn't contend with the heaviest startup work
  // (project load, file tree, vector store init) but still surfaces
  // a new release in time for the user to notice it during their
  // first interaction. Silent on failure; the UI in Settings → About
  // lets the user retry manually.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      if (cancelled) return
      try {
        const { loadUpdateCheckState, saveUpdateCheckState } = await import(
          "@/lib/project-store"
        )
        const { useUpdateStore } = await import("@/stores/update-store")
        const { checkForUpdates, UPDATE_CHECK_CACHE_MS } = await import(
          "@/lib/update-check"
        )

        const persisted = await loadUpdateCheckState()
        if (persisted) useUpdateStore.getState().hydrate(persisted)

        const state = useUpdateStore.getState()
        if (!state.enabled) {
          logger.debug("update check skipped: user disabled auto-check in settings")
          return
        }

        const now = Date.now()
        // Cache hit requires BOTH the timestamp AND the in-memory
        // result to be present. `lastCheckedAt` is persisted to
        // disk but `lastResult` deliberately is not — keeping the
        // GitHub payload out of the persisted store keeps disk
        // size + privacy footprint small. The downside: a fresh
        // cold start has `lastResult === null` even when
        // `lastCheckedAt` is recent, in which case we MUST refetch
        // — otherwise we'd skip the check AND have no result to
        // display, leaving the banner permanently stuck off.
        // (This was the user-reported bug: "kind=none, no banner".)
        const fresh =
          state.lastCheckedAt !== null &&
          state.lastResult !== null &&
          now - state.lastCheckedAt < UPDATE_CHECK_CACHE_MS
        if (fresh) {
          const ageMin = Math.round((now - (state.lastCheckedAt ?? 0)) / 60_000)
          logger.debug("update check skipped: cache hit", {
            lastCheckAgeMin: ageMin,
            cacheWindowMin: UPDATE_CHECK_CACHE_MS / 60_000,
            lastResultKind: state.lastResult?.kind ?? "none",
          })
          return
        }

        useUpdateStore.getState().setChecking(true)
        logger.debug("update check fetching GitHub releases", { local: __APP_VERSION__ })
        const result = await checkForUpdates({
          currentVersion: __APP_VERSION__,
          repo: "nashsu/llm_wiki",
        })
        if (cancelled) return
        useUpdateStore.getState().setResult(result, Date.now())
        if (result.kind === "available") {
          logger.debug("update available", { local: result.local, remote: result.remote })
        } else if (result.kind === "up-to-date") {
          logger.debug("up to date", { local: result.local, remote: result.remote })
        } else {
          logger.debug("update check error", { message: result.message })
        }
        await saveUpdateCheckState({
          enabled: useUpdateStore.getState().enabled,
          lastCheckedAt: Date.now(),
          dismissedVersion: useUpdateStore.getState().dismissedVersion,
        })
      } catch {
        // Silent — Settings → About lets the user retry manually.
      }
    }, 1500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  // Auto-open last project on startup
  useEffect(() => {
    async function init() {
      try {
        const savedConfig = await loadLlmConfig()
        if (savedConfig) {
          useWikiStore.getState().setLlmConfig(savedConfig)
        }
        const savedProviderConfigs = await loadProviderConfigs()
        if (savedProviderConfigs) {
          useWikiStore.getState().setProviderConfigs(savedProviderConfigs)
        }
        const savedActivePreset = await loadActivePresetId()
        if (savedActivePreset) {
          useWikiStore.getState().setActivePresetId(savedActivePreset)
          // Re-resolve the active preset's LlmConfig from (preset defaults
          // + saved overrides). Without this, preset default updates
          // (e.g. a corrected Anthropic model ID shipped in a release)
          // never reach users who are relying on defaults — their stored
          // `llmConfig` snapshot from a previous launch would keep the
          // old value. Overrides still win, so an explicit user choice
          // is preserved.
          const { LLM_PRESETS } = await import("@/components/settings/llm-presets")
          const { resolveConfig } = await import("@/components/settings/preset-resolver")
          const preset = LLM_PRESETS.find((p) => p.id === savedActivePreset)
          if (preset) {
            const currentFallback = useWikiStore.getState().llmConfig
            const override = (savedProviderConfigs ?? {})[savedActivePreset]
            const resolved = resolveConfig(preset, override, currentFallback)
            useWikiStore.getState().setLlmConfig(resolved)
            const { saveLlmConfig } = await import("@/lib/project-store")
            await saveLlmConfig(resolved)
          }
        }
        const savedSearchConfig = await loadSearchApiConfig()
        if (savedSearchConfig) {
          useWikiStore.getState().setSearchApiConfig(savedSearchConfig)
        }
        const savedEmbeddingConfig = await loadEmbeddingConfig()
        if (savedEmbeddingConfig) {
          useWikiStore.getState().setEmbeddingConfig(savedEmbeddingConfig)
        }
        const savedMultimodalConfig = await loadMultimodalConfig()
        if (savedMultimodalConfig) {
          useWikiStore.getState().setMultimodalConfig(savedMultimodalConfig)
        }

        const savedMineruConfig = await loadMineruConfig()
        if (savedMineruConfig) {
          useWikiStore.getState().setMineruConfig(savedMineruConfig)
        }
        const savedProxy = await loadProxyConfig()
        if (savedProxy) {
          useWikiStore.getState().setProxyConfig(savedProxy)
        }
        // Local HTTP API server config — global (single token + enable
        // flag for the whole install, not per-project). The Rust side
        // reads `apiConfig.{enabled,token,mcpEnabled}` from `app-state.json`
        // directly; this only hydrates the Zustand store so the
        // Settings UI reflects the persisted values.
        const savedApi = await loadApiConfig()
        if (savedApi) {
          useWikiStore.getState().setApiConfig({
            enabled: typeof savedApi.enabled === "boolean" ? savedApi.enabled : true,
            allowUnauthenticated:
              typeof savedApi.allowUnauthenticated === "boolean"
                ? savedApi.allowUnauthenticated
                : false,
            mcpEnabled:
              typeof savedApi.mcpEnabled === "boolean"
                ? savedApi.mcpEnabled
                : false,
            token: typeof savedApi.token === "string" ? savedApi.token : "",
          })
        }
        const savedGeneral = await loadGeneralConfig()
        useWikiStore.getState().setGeneralConfig(savedGeneral)
        try {
          await invoke<string>("set_close_behavior", { value: savedGeneral.closeBehavior })
        } catch (err) {
          logger.warn("failed to hydrate close behavior", { error: String(err) })
        }
        // 桌面 only:开机自启同步,web 无此能力(canAutoStart=false 跳过)
        if (caps.canAutoStart) {
          try {
            const currentAutostart = await isAutostartEnabled()
            if (savedGeneral.autostart && !currentAutostart) {
              await enableAutostart()
            } else if (!savedGeneral.autostart && currentAutostart) {
              await disableAutostart()
            }
          } catch (err) {
            logger.warn("failed to sync autostart", { error: String(err) })
          }
        }
        const savedLang = await loadLanguage()
        if (savedLang) {
          await i18n.changeLanguage(savedLang)
        }
        if (caps.platform === "tauri") {
          const lastProject = await getLastProject()
          if (lastProject) {
            try {
              const proj = await openProject(lastProject.path)
              await handleProjectOpened(proj)
            } catch {
              // Last project no longer valid
            }
          }
        }
        // web:auth 已由现有 isAuthenticated 门控(Login/Register 就绪);
        // 项目选择 UI 留期2,期1 不自动 openProject(无本地路径)。
      } catch {
        // ignore init errors
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [])

  // Auth gates — 必须在所有 hooks 之后（React hooks 规则：条件 return 不能早于 hooks，
  // 否则认证状态变化会改变 hooks 数量 → "Rendered more hooks than during the previous
  // render" 崩溃白屏）。注册/登录成功 isAuthenticated false→true 时尤其会触发。
  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <p className="text-gray-500">加载中...</p>
      </div>
    )
  }
  if (!isAuthenticated) {
    if (authPage === "register") {
      return <RegisterPage onNavigate={setAuthPage} />
    }
    return <LoginPage onNavigate={setAuthPage} />
  }

  // web:登录后强制走 team→project 选择器（桌面走本地 openProject，零回归）。
  // __currentProjectId 缺空时显示选择器；选中后立即写入并经 handleProjectOpened 加载。
  if (caps.platform === "web" && (window as any).__currentProjectId == null) {
    return (
      <ProjectPicker
        onPick={async (p) => {
          // WikiProject.id 是 string（前端），ProjectResponse.id 是 number（后端），String 强转。
          // __currentProjectId 由 handleProjectOpened 内部设（proj.id），此处不重复写。
          const proj = { id: String(p.id), path: "", name: p.name } as WikiProject
          await handleProjectOpened(proj)
        }}
      />
    )
  }

  async function handleProjectOpened(proj: WikiProject) {
    // Clear all per-project state BEFORE loading new project data
    // to prevent cross-project contamination. MUST be awaited so the
    // ingest queue / graph cache are actually cleared before the new
    // project's state is populated.
    const { resetProjectState } = await import("@/lib/reset-project-state")
    await resetProjectState()

    // __currentProjectId 供 web 的 fs HTTP / streamViaServer / file-url 消费。web 注入 number
    // (后端 as_i64/Path<i32> 解析;WikiProject.id 是 string,web 下 String(p.id));桌面保留
    // proj.id(桌面不读此值,走 invoke)。streamViaServer 仍 Number() 防御(双保险)。
    ;(window as any).__currentProjectId = caps.platform === "web" ? Number(proj.id) : proj.id
    setProject(proj)
    // web 下 project-store(@tauri-apps/plugin-store)不可用 → outputLanguage 用默认 "auto";
    // 桌面从 app-state.json 读 per-project 语言。
    const projectOutputLang = caps.platform === "web" ? null : await loadOutputLanguage(proj.id)
    useWikiStore.getState().setOutputLanguage(projectOutputLang ?? "auto")
    setSelectedFile(null)
    setActiveView("wiki")
    // Bump data version so any cached graphs/views invalidate
    useWikiStore.getState().bumpDataVersion()
    // web 无 app-state.json,跳过 last-project 持久化(桌面专属;web 每次走 team/project picker)。
    if (caps.platform !== "web") {
      await saveLastProject(proj)
    }

    // Restore ingest queue (resume interrupted tasks). Keyed by the
    // project's stable UUID so the queue still finds the right project
    // even if the filesystem path changed since the task was enqueued.
    // Await this before starting file sync: watcher events for raw/sources
    // may enqueue ingest tasks and require an active project queue.
    // 桌面 only:恢复本地持久化的摄取/去重队列。web 摄取走 server(triggerIngest + poll
    // getIngestJob),队列状态在 server 端,不读本地 .llm-wiki/*.json,跳过避免无谓请求。
    if (caps.platform !== "web") {
      try {
        const { restoreQueue } = await import("@/lib/ingest-queue")
        await restoreQueue(proj.id, proj.path)
      } catch (err) {
        logger.error("failed to restore ingest queue", { error: String(err) })
      }
      // Same handshake for the dedup-merge queue.
      import("@/lib/dedup-queue").then(({ restoreQueue }) => {
        restoreQueue(proj.id, proj.path).catch((err) =>
          logger.error("failed to restore dedup queue", { error: String(err) })
        )
      })
    }
    // Load per-project scheduled import config
    try {
      const savedScheduledImport = await loadScheduledImportConfig(proj.path)
      if (savedScheduledImport) {
        // Migrate relative path to absolute (backward compatibility)
        let path = savedScheduledImport.path
        if (path && !path.startsWith("/") && !path.match(/^[a-zA-Z]:[/\\]/)) {
          path = `${proj.path}/${path}`
        }
        useWikiStore.getState().setScheduledImportConfig({
          ...savedScheduledImport,
          path,
        })
      } else {
        // Reset to default for new projects
        useWikiStore.getState().setScheduledImportConfig({
          enabled: false,
          path: `${proj.path}/raw/sources`,
          interval: 60,
          lastScan: null,
        })
      }
    } catch {
      // ignore
    }
    // Start scheduled import if enabled
    const scheduledImportConfig = useWikiStore.getState().scheduledImportConfig
    if (scheduledImportConfig.enabled && scheduledImportConfig.path && scheduledImportConfig.interval > 0) {
      import("@/lib/scheduled-import").then(({ startScheduledImport }) => {
        startScheduledImport(proj, scheduledImportConfig)
      }).catch((err) =>
        logger.error("failed to start scheduled import", { error: String(err) })
      )
    }

    // Start project source watch if enabled
    import("@/lib/project-file-sync").then(async ({ startProjectFileSync, stopProjectFileSync }) => {
      const config = await loadSourceWatchConfig(proj.id)
      useWikiStore.getState().setSourceWatchConfig(config)
      if (config.enabled) {
        startProjectFileSync(proj, config).catch((err) =>
          logger.error("failed to start project file sync", { error: String(err) })
        )
      } else {
        stopProjectFileSync().catch(() => {})
      }
    }).catch((err) => logger.error("failed to configure project file sync", { error: String(err) }))
    // 桌面 only:通知本地 clip server(Web Clipper 扩展用)。web 无本地 clip server,
    // fetch 必然 ERR_CONNECTION_REFUSED;getRecentProjects 亦走桌面 project-store。web 下整体跳过。
    if (caps.platform !== "web") {
      fetch("http://127.0.0.1:19827/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: proj.path }),
      }).catch(() => {})

      // Send all recent projects to clip server for extension project picker
      getRecentProjects().then((recents) => {
        const projects = recents.map((p) => ({ name: p.name, path: p.path }))
        fetch("http://127.0.0.1:19827/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projects }),
        }).catch(() => {})
      }).catch(() => {})
    }
    try {
      const tree = await listDirectory(proj.path)
      setFileTree(tree)
    } catch (err) {
      logger.error("failed to load file tree", { error: String(err) })
    }
    // Load review items(桌面 localStorage;web 从服务器 HTTP)
    try {
      if (caps.platform === "web") {
        await useReviewStore.getState().loadReviewsFromServer(Number(proj.id))
      } else {
        const savedReview = await loadReviewItems(proj.path)
        if (savedReview.length > 0) {
          useReviewStore.getState().setItems(savedReview)
        }
      }
    } catch {
      // ignore, start fresh
    }
    // Load persisted lint items(桌面;web lint 视图隐藏,不加载本地 lint.json)
    useLintStore.getState().setItems([])
    if (caps.platform !== "web") {
      try {
        const savedLint = await loadLintItems(proj.path)
        useLintStore.getState().setItems(savedLint)
      } catch {
        useLintStore.getState().setItems([])
      }
    }
    // Load persisted chat history
    try {
      const savedChat = await loadChatHistory(proj.path)
      if (savedChat.conversations.length > 0) {
        useChatStore.getState().setConversations(savedChat.conversations)
        useChatStore.getState().setMessages(savedChat.messages)
        // Set most recent conversation as active
        const sorted = [...savedChat.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
        if (sorted[0]) {
          useChatStore.getState().setActiveConversation(sorted[0].id)
        }
      }
    } catch {
      // ignore, start fresh
    }
  }

  async function handleSelectRecent(proj: WikiProject) {
    try {
      const validated = await openProject(proj.path)
      await handleProjectOpened(validated)
    } catch (err) {
      window.alert(`Failed to open project: ${err}`)
    }
  }

  async function handleOpenProject() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open Wiki Project",
    })
    if (!selected) return
    try {
      const proj = await openProject(selected)
      await handleProjectOpened(proj)
    } catch (err) {
      window.alert(`Failed to open project: ${err}`)
    }
  }

  async function handleSwitchProject() {
    // Stop scheduled import before switching projects
    import("@/lib/scheduled-import").then(({ stopScheduledImport }) => {
      stopScheduledImport()
    }).catch(() => {})

    // Save current project's scheduled import config before clearing
    const currentProject = useWikiStore.getState().project
    if (currentProject) {
      const currentConfig = useWikiStore.getState().scheduledImportConfig
      saveScheduledImportConfig(currentProject.path, currentConfig).catch(() => {})
    }

    // Clear all per-project state BEFORE flipping back to the welcome screen
    // so old data cannot leak in via any async render pass.
    const { resetProjectState } = await import("@/lib/reset-project-state")
    await resetProjectState()
    setProject(null)
    setFileTree([])
    setSelectedFile(null)
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-muted-foreground">
        Loading...
      </div>
    )
  }

  if (!project) {
    return (
      <>
        <WelcomeScreen
          onCreateProject={() => setShowCreateDialog(true)}
          onOpenProject={handleOpenProject}
          onSelectProject={handleSelectRecent}
        />
        <CreateProjectDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          onCreated={handleProjectOpened}
        />
      </>
    )
  }

  return (
    <>
      <AppLayout onSwitchProject={handleSwitchProject} />
      <CreateProjectDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreated={handleProjectOpened}
      />
    </>
  )
}

export default App
