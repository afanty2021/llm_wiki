import { useState, useCallback, useMemo, useEffect, useRef } from "react"
import {
  Link2Off,
  Unlink,
  ArrowUpRight,
  AlertTriangle,
  Info,
  RefreshCw,
  CheckCircle2,
  BrainCircuit,
  Wrench,
  Trash2,
  ChevronDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore, type LintItem } from "@/stores/lint-store"
import { runStructuralLint, runSemanticLint } from "@/lib/lint"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useTranslation } from "react-i18next"

export function groupLintResultsForDisplay(results: readonly LintItem[]): {
  warnings: LintItem[]
  infos: LintItem[]
} {
  const warnings: LintItem[] = []
  const infos: LintItem[] = []

  results.forEach((result) => {
    if (result.severity === "warning") {
      warnings.push(result)
    } else {
      infos.push(result)
    }
  })

  return { warnings, infos }
}

export function shouldShowLintResults(hasRun: boolean, itemCount: number): boolean {
  return hasRun || itemCount > 0
}

export function LintView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)

  // Dynamic type config based on i18n
  const typeConfig = useMemo(() => ({
    orphan: { icon: Unlink, label: t("lint.typeLabels.orphan") },
    "broken-link": { icon: Link2Off, label: t("lint.typeLabels.broken-link") },
    "no-outlinks": { icon: ArrowUpRight, label: t("lint.typeLabels.no-outlinks") },
    semantic: { icon: BrainCircuit, label: t("lint.typeLabels.semantic") },
  }), [t])

  const items = useLintStore((s) => s.items)
  const addLintItems = useLintStore((s) => s.addItems)
  const clearLintItems = useLintStore((s) => s.clearItems)

  const [running, setRunning] = useState(false)
  const [hasRun, setHasRun] = useState(false)
  const [runSemantic, setRunSemantic] = useState(false)
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [batchFixing, setBatchFixing] = useState(false)
  const [showBatchMenu, setShowBatchMenu] = useState(false)
  const batchMenuRef = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (batchMenuRef.current && !batchMenuRef.current.contains(event.target as Node)) {
        setShowBatchMenu(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const handleRunLint = useCallback(async () => {
    if (!project || running) return
    const pp = normalizePath(project.path)
    setRunning(true)
    clearLintItems()
    try {
      const structural = await runStructuralLint(pp)
      let all = structural

      if (runSemantic && hasUsableLlm(llmConfig)) {
        const semantic = await runSemanticLint(pp, llmConfig)
        all = [...structural, ...semantic]
      }

      addLintItems(all)
      setHasRun(true)
    } catch (err) {
      console.error("Lint failed:", err)
    } finally {
      setRunning(false)
    }
  }, [project, llmConfig, running, runSemantic, addLintItems, clearLintItems])

  // ── Batch fix functions ──────────────────────────────────────────────────────

  async function handleBatchFixOrphans() {
    if (!project || batchFixing) return
    const pp = normalizePath(project.path)
    const orphans = results.filter((r) => r.type === "orphan")
    if (orphans.length === 0) return

    setBatchFixing(true)
    setShowBatchMenu(false)

    try {
      const indexPath = `${pp}/wiki/index.md`
      let indexContent = ""
      try { indexContent = await readFile(indexPath) } catch { indexContent = "# Wiki Index\n" }

      let added = 0
      for (const orphan of orphans) {
        const pageName = orphan.page.replace(".md", "").replace(/^.*\//, "")
        const entry = `- [[${pageName}]]`
        if (!indexContent.includes(entry)) {
          indexContent = indexContent.trimEnd() + "\n" + entry + "\n"
          added++
        }
      }

      if (added > 0) {
        await writeFile(indexPath, indexContent)
      }

      // Remove fixed orphans from results
      setResults((prev) => prev.filter((r) => r.type !== "orphan"))

      // Refresh tree
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } catch (err) {
      console.error("Batch fix orphans failed:", err)
    } finally {
      setBatchFixing(false)
    }
  }

  async function handleBatchFixBrokenLinks() {
    if (!project || batchFixing) return
    const brokenLinks = results.filter((r) => r.type === "broken-link")
    if (brokenLinks.length === 0) return

    setBatchFixing(true)
    setShowBatchMenu(false)

    try {
      const pp = normalizePath(project.path)

      for (const result of brokenLinks) {
        // Extract the broken link name from detail
        const match = result.detail.match(/\[\[([^\]]+)\]\]/)
        if (!match) continue

        const brokenLink = match[1]
        const pagePath = `${pp}/wiki/${result.page}`

        try {
          let content = await readFile(pagePath)
          // Remove the broken link using regex
          const linkPattern = new RegExp(`\\[\\[${brokenLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|[^\\]]+)?\\]\\]`, 'g')
          content = content.replace(linkPattern, '')
          await writeFile(pagePath, content)
        } catch (err) {
          console.error(`Failed to remove broken link from ${result.page}:`, err)
        }
      }

      // Remove fixed broken links from results
      setResults((prev) => prev.filter((r) => r.type !== "broken-link"))

      // Refresh tree
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } catch (err) {
      console.error("Batch fix broken links failed:", err)
    } finally {
      setBatchFixing(false)
    }
  }

  async function handleBatchSendToReview() {
    if (!project || batchFixing) return
    const sendable = results.filter((r) =>
      r.type === "no-outlinks" || r.type === "semantic"
    )
    if (sendable.length === 0) return

    setBatchFixing(true)
    setShowBatchMenu(false)

    try {
      const pp = normalizePath(project.path)

      for (const result of sendable) {
        useReviewStore.getState().addItem({
          type: result.type === "semantic" ? "confirm" : "suggestion",
          title: result.detail.slice(0, 80),
          description: result.detail,
          affectedPages: result.affectedPages ?? [result.page],
          options: [
            { label: t("lint.openEdit"), action: `open:${result.page}` },
            { label: t("lint.skip"), action: "Skip" },
          ],
        })
      }

      // Remove sent items from results
      setResults((prev) => prev.filter((r) => r.type !== "no-outlinks" && r.type !== "semantic"))

      // Refresh tree
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } catch (err) {
      console.error("Batch send to review failed:", err)
    } finally {
      setBatchFixing(false)
    }
  }

  // Get counts for each type
  const orphanCount = results.filter((r) => r.type === "orphan").length
  const brokenLinkCount = results.filter((r) => r.type === "broken-link").length
  const noOutlinksCount = results.filter((r) => r.type === "no-outlinks").length
  const semanticCount = results.filter((r) => r.type === "semantic").length

  async function handleOpenPage(page: string) {
    if (!project) return
    const pp = normalizePath(project.path)
    const candidates = [
      `${pp}/wiki/${page}`,
      `${pp}/wiki/${page}.md`,
    ]
    setActiveView("wiki")
    for (const path of candidates) {
      try {
        const content = await readFile(path)
        setSelectedFile(path)
        setFileContent(content)
        return
      } catch {
        // try next
      }
    }
    setSelectedFile(candidates[0])
    setFileContent(`Unable to load: ${page}`)
  }

  async function handleFix(item: LintItem) {
    if (!project) return
    const pp = normalizePath(project.path)
    setFixingId(item.id)

    try {
      switch (item.type) {
        case "orphan": {
          // Add a link to this page from index.md
          const indexPath = `${pp}/wiki/index.md`
          let indexContent = ""
          try { indexContent = await readFile(indexPath) } catch { indexContent = "# Wiki Index\n" }

          const pageName = item.page.replace(".md", "").replace(/^.*\//, "")
          const entry = `- [[${pageName}]]`
          if (!indexContent.includes(entry)) {
            indexContent = indexContent.trimEnd() + "\n" + entry + "\n"
            await writeFile(indexPath, indexContent)
          }
          // Remove from store
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "broken-link": {
          // Option: remove the broken link from the page, or send to Review for manual fix
          const pagePath = `${pp}/wiki/${item.page}`
          useReviewStore.getState().addItem({
            type: "confirm",
            title: t("lint.fixBrokenLink", { page: item.page }),
            description: item.detail,
            affectedPages: [item.page],
            options: [
              { label: t("lint.openEdit"), action: `open:${item.page}` },
              { label: t("lint.deletePage"), action: `delete:${pagePath}` },
              { label: t("lint.skip"), action: "Skip" },
            ],
          })
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "no-outlinks": {
          // Send to Review — user should add links manually
          useReviewStore.getState().addItem({
            type: "suggestion",
            title: t("lint.addCrossRefs", { page: item.page }),
            description: t("lint.addCrossRefsDescription"),
            affectedPages: [item.page],
            options: [
              { label: t("lint.openEdit"), action: `open:${item.page}` },
              { label: t("lint.skip"), action: "Skip" },
            ],
          })
          useLintStore.getState().removeItem(item.id)
          break
        }

        default: {
          // Semantic issues → send to Review for manual resolution
          useReviewStore.getState().addItem({
            type: "confirm",
            title: item.detail.slice(0, 80),
            description: item.detail,
            affectedPages: item.affectedPages ?? [item.page],
            options: [
              { label: t("lint.openEdit"), action: `open:${item.page}` },
              { label: t("lint.skip"), action: "Skip" },
            ],
          })
          useLintStore.getState().removeItem(item.id)
          break
        }
      }

      // Refresh tree
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } catch (err) {
      console.error("Fix failed:", err)
    } finally {
      setFixingId(null)
    }
  }

  async function handleDeleteOrphan(item: LintItem) {
    if (!project) return
    const pp = normalizePath(project.path)
    const pagePath = `${pp}/wiki/${item.page}`
    const confirmed = window.confirm(t("lint.deleteOrphanConfirm", { page: item.page }))
    if (!confirmed) return

    try {
      // Full cascade: file + embedding chunks + every reference to
      // the page across the wiki (body wikilinks, index.md listing,
      // `related:` frontmatter arrays). Even though "orphan" by lint
      // means no incoming wikilinks were detected, `related:` slugs
      // and index.md entries can still point at it — the orphan
      // detector only walks body refs.
      const { cascadeDeleteWikiPagesWithRefs } = await import(
        "@/lib/wiki-page-delete"
      )
      await cascadeDeleteWikiPagesWithRefs(pp, [pagePath])
      useLintStore.getState().removeItem(item.id)
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } catch (err) {
      console.error("Delete failed:", err)
    }
  }

  const { warnings, infos } = useMemo(
    () => groupLintResultsForDisplay(items),
    [items],
  )
  const showResults = shouldShowLintResults(hasRun, items.length)

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t("lint.title")}</h2>
          {showResults && items.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              {items.length === 1 ? t("lint.issues", { count: items.length }) : t("lint.issues_plural", { count: items.length })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={runSemantic}
              onChange={(e) => setRunSemantic(e.target.checked)}
            />
            {t("lint.semantic")}
          </label>
          {hasRun && results.length > 0 && (
            <div className="relative" ref={batchMenuRef}>
              <Button
                size="sm"
                variant="outline"
                disabled={batchFixing}
                onClick={() => setShowBatchMenu(!showBatchMenu)}
              >
                {batchFixing ? t("lint.fixingMultiple", { count: results.length }) : t("lint.fixAll")}
                <ChevronDown className="ml-1 h-3 w-3" />
              </Button>
              {showBatchMenu && (
                <div className="absolute right-0 top-full mt-1 z-50 min-w-[200px] rounded-md border bg-popover p-1 shadow-md">
                  {orphanCount > 0 && (
                    <button
                      type="button"
                      className="w-full text-left px-2 py-1.5 text-sm hover:bg-accent rounded"
                      onClick={handleBatchFixOrphans}
                      disabled={batchFixing}
                    >
                      {t("lint.fixAllOrphans")} ({orphanCount})
                    </button>
                  )}
                  {brokenLinkCount > 0 && (
                    <button
                      type="button"
                      className="w-full text-left px-2 py-1.5 text-sm hover:bg-accent rounded"
                      onClick={handleBatchFixBrokenLinks}
                      disabled={batchFixing}
                    >
                      {t("lint.fixAllBrokenLinks")} ({brokenLinkCount})
                    </button>
                  )}
                  {(noOutlinksCount > 0 || semanticCount > 0) && (
                    <button
                      type="button"
                      className="w-full text-left px-2 py-1.5 text-sm hover:bg-accent rounded"
                      onClick={handleBatchSendToReview}
                      disabled={batchFixing}
                    >
                      {t("lint.fixAllNoOutlinks")} ({noOutlinksCount + semanticCount})
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <Button
            size="sm"
            onClick={handleRunLint}
            disabled={running || !project}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
            {running ? t("lint.running") : t("lint.runLint")}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!showResults ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-muted-foreground/30" />
            <p>{t("lint.runLintHint")}</p>
            <p className="text-xs">{t("lint.runLintDescription")}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-emerald-500/60" />
            <p className="text-emerald-600 dark:text-emerald-400 font-medium">{t("lint.allClear")}</p>
            <p className="text-xs">{t("lint.noIssues")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {warnings.length > 0 && (
              <SectionHeader icon={AlertTriangle} label={t("lint.warnings")} count={warnings.length} color="text-amber-500" t={t} />
            )}
            {warnings.map((item) => (
              <LintCard
                key={item.id}
                item={item}
                fixing={fixingId === item.id}
                onOpenPage={handleOpenPage}
                onFix={handleFix}
                onDelete={item.type === "orphan" ? handleDeleteOrphan : undefined}
                typeConfig={typeConfig}
                t={t}
              />
            ))}
            {infos.length > 0 && (
              <SectionHeader icon={Info} label={t("lint.info")} count={infos.length} color="text-blue-500" t={t} />
            )}
            {infos.map((item) => (
              <LintCard
                key={item.id}
                item={item}
                fixing={fixingId === item.id}
                onOpenPage={handleOpenPage}
                onFix={handleFix}
                onDelete={item.type === "orphan" ? handleDeleteOrphan : undefined}
                typeConfig={typeConfig}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  label,
  count,
  color,
  t,
}: {
  icon: typeof AlertTriangle
  label: string
  count: number
  color: string
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  return (
    <div className={`flex items-center gap-1.5 px-1 py-1 text-xs font-semibold ${color}`}>
      <Icon className="h-3.5 w-3.5" />
      {t("lint.sectionCount", { label, count })}
    </div>
  )
}

function LintCard({
  item,
  fixing,
  onOpenPage,
  onFix,
  onDelete,
  typeConfig,
  t,
}: {
  item: LintItem
  fixing: boolean
  onOpenPage: (page: string) => void
  onFix: (item: LintItem) => void
  onDelete?: (item: LintItem) => void
  typeConfig: Record<string, { icon: typeof AlertTriangle; label: string }>
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const config = typeConfig[item.type] ?? typeConfig.semantic
  const Icon = config.icon

  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="mb-1.5 flex items-start gap-2">
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            item.severity === "warning" ? "text-amber-500" : "text-blue-500"
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{item.page}</div>
          <div className="text-[11px] text-muted-foreground">{config.label}</div>
        </div>
      </div>

      <p className="mb-2 text-xs text-muted-foreground">{item.detail}</p>

      {item.affectedPages && item.affectedPages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {item.affectedPages.map((page) => (
            <button
              key={page}
              type="button"
              onClick={() => onOpenPage(page)}
              className="inline-flex items-center gap-0.5 rounded bg-accent/60 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent transition-colors"
            >
              {page}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-2">
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs gap-1"
          onClick={() => onOpenPage(item.page)}
        >
          {t("lint.open")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs gap-1"
          disabled={fixing}
          onClick={() => onFix(item)}
        >
          <Wrench className="h-3 w-3" />
          {fixing ? t("lint.fixing") : t("lint.fix")}
        </Button>
        {onDelete && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs gap-1 text-destructive hover:text-destructive"
            onClick={() => onDelete(item)}
          >
            <Trash2 className="h-3 w-3" />
            {t("lint.delete")}
          </Button>
        )}
      </div>
    </div>
  )
}
