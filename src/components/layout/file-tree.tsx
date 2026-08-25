import { useEffect, useRef, useState } from "react"
import { ChevronRight, ChevronDown, File, Folder, FolderOpen } from "lucide-react"
import { message } from "@tauri-apps/plugin-dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useTranslation } from "react-i18next"
import { listDirectory, openProjectFolder } from "@/commands/fs"
import { replaceNodeChildren, hashTranscriptDerivedPagePath } from "./file-tree-utils"
import { createLogger } from "@/lib/logger"
import { caps } from "@/lib/capabilities"

const logger = createLogger("file-tree")

function TreeNode({
  node,
  depth,
  onLoadChildren,
}: {
  node: FileNode
  depth: number
  onLoadChildren: (node: FileNode) => Promise<void>
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(depth < 1)
  const [loadingChildren, setLoadingChildren] = useState(false)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const openPathInPreview = useWikiStore((s) => s.openPathInPreview)
  // 纯哈希名转写源文件显示衍生 DB 页标题（web 填充 pageTitleByPath；桌面空表查不到=行为不变）
  const derivedTitle = useWikiStore((s) => {
    const pagePath = hashTranscriptDerivedPagePath(node)
    return pagePath ? s.pageTitleByPath[pagePath] : undefined
  })

  const isSelected = selectedFile === node.path
  const paddingLeft = 12 + depth * 16

  if (node.is_dir) {
    const handleToggle = async () => {
      const nextExpanded = !expanded
      setExpanded(nextExpanded)
      if (!nextExpanded || node.children) return
      setLoadingChildren(true)
      try {
        await onLoadChildren(node)
      } finally {
        setLoadingChildren(false)
      }
    }

    return (
      <div>
        <button
          onClick={() => void handleToggle()}
          className="flex w-full items-center gap-1 py-1 text-sm text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
          style={{ paddingLeft }}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          <span className="truncate">{node.name}</span>
          {loadingChildren && (
            <span className="ml-auto pr-2 text-[10px] text-muted-foreground">
              {t("common.loading", { defaultValue: "Loading..." })}
            </span>
          )}
        </button>
        {expanded && node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            onLoadChildren={onLoadChildren}
          />
        ))}
      </div>
    )
  }

  return (
    <button
      onClick={() => openPathInPreview(node.path)}
      title={derivedTitle ?? node.name}
      className={`flex w-full items-center gap-1 py-1 text-sm ${
        isSelected
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
      }`}
      style={{ paddingLeft: paddingLeft + 14 }}
    >
      <File className="h-3.5 w-3.5 shrink-0" />
      {/* shrink-0 会废掉 truncate（flex-shrink:0 → 永不收缩 → 长名溢出行宽，
          fe8f11d5 的中文长文件名首当其冲）——文件名保持可收缩，靠 overflow:hidden
          的自动最小尺寸归零触发 ellipsis；短哈希名不受影响。 */}
      <span className="truncate">{node.name}</span>
      {derivedTitle && (
        <span className="min-w-0 flex-1 truncate text-left text-[11px] text-muted-foreground/70">
          {derivedTitle}
        </span>
      )}
    </button>
  )
}

export function FileTree() {
  const { t } = useTranslation()
  const fileTree = useWikiStore((s) => s.fileTree)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const project = useWikiStore((s) => s.project)
  const loadedPaths = useRef(new Set<string>())
  const loadingPaths = useRef(new Set<string>())

  useEffect(() => {
    loadedPaths.current.clear()
    loadingPaths.current.clear()
  }, [project?.id])

  const handleOpenProjectFolder = async () => {
    if (!project) return

    try {
      await openProjectFolder(project.path)
    } catch (err) {
      logger.error("open project folder failed", { error: String(err) })
      await message(
        t("fileTree.openProjectFolderFailed", {
          defaultValue: "Failed to open the project folder.",
        }),
        {
          title: t("fileTree.openProjectFolder", {
            defaultValue: "Open project folder",
          }),
          kind: "error",
        },
      )
    }
  }

  const handleLoadChildren = async (node: FileNode) => {
    if (!project) return
    if (loadedPaths.current.has(node.path) || loadingPaths.current.has(node.path)) return
    loadingPaths.current.add(node.path)
    const projectId = project.id
    try {
      const children = await listDirectory(node.path, { maxDepth: 1 })
      if (useWikiStore.getState().project?.id !== projectId) return
      const currentTree = useWikiStore.getState().fileTree
      const result = replaceNodeChildren(currentTree, node.path, children)
      if (!result.matched) return
      loadedPaths.current.add(node.path)
      setFileTree(result.nodes, {
        syncPathIndex: false,
      })
    } catch (err) {
      console.error("[FileTree] load children failed:", err)
    } finally {
      loadingPaths.current.delete(node.path)
    }
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t("fileTree.noProject")}
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div className="p-2">
          <div className="mb-2 px-2 text-xs font-semibold uppercase text-muted-foreground">
            {project.name}
          </div>
          {fileTree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              onLoadChildren={handleLoadChildren}
            />
          ))}
        </div>
      </ScrollArea>
      {/* 桌面 only:web 无本地文件夹概念,隐藏 openProjectFolder 按钮 */}
      {caps.platform === "tauri" && (
        <div className="shrink-0 border-t p-2">
          <button
            type="button"
            onClick={() => void handleOpenProjectFolder()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
            title={project.path}
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {t("fileTree.openProjectFolder", { defaultValue: "Open project folder" })}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
