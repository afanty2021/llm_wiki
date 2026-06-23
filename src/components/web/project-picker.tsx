import { useEffect, useState } from "react"
import { apiClient } from "@/lib/api-client"
import type { TeamResponse, ProjectResponse } from "@/lib/api-types"

/** web 版 team→project 选择器（桌面版走 openProject 本地路径，不复用）。 */
export function ProjectPicker({
  onPick,
}: {
  onPick: (p: ProjectResponse) => void
}) {
  const [teams, setTeams] = useState<TeamResponse[]>([])
  const [teamId, setTeamId] = useState<number | null>(null)
  const [projects, setProjects] = useState<ProjectResponse[]>([])
  const [newName, setNewName] = useState("")
  const [err, setErr] = useState<string | null>(null)

  // 首次加载 team 列表(cancelled guard 防卸载后 setState)
  useEffect(() => {
    let cancelled = false
    apiClient
      .getUserTeams()
      .then((ts) => { if (!cancelled) setTeams(ts) })
      .catch((e) => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [])

  // team 切换后加载 project 列表（listProjects 分页，解 .items）。
  // cancelled guard 防快速切 team 时旧请求覆盖新 + 卸载后 setState。
  useEffect(() => {
    if (teamId == null) return
    let cancelled = false
    setProjects([])
    apiClient
      .listProjects(teamId)
      .then((r) => { if (!cancelled) setProjects(r.items) })
      .catch((e) => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [teamId])

  const create = async () => {
    if (!newName.trim() || teamId == null) return
    try {
      onPick(await apiClient.createProject(newName.trim(), teamId))
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6 max-w-md mx-auto">
      <h2 className="text-xl">选择工作空间</h2>
      {err && <p className="text-red-600 text-sm">{err}</p>}
      {!teamId && teams.length === 0 && !err && (
        <p className="text-gray-500 text-sm">加载中…</p>
      )}
      {!teamId &&
        teams.map((t) => (
          <button
            key={t.id}
            onClick={() => setTeamId(t.id)}
            className="px-4 py-2 border rounded hover:bg-gray-50"
          >
            {t.name}
          </button>
        ))}
      {teamId != null && (
        <>
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => onPick(p)}
              className="px-4 py-2 border rounded hover:bg-gray-50"
            >
              {p.name}
            </button>
          ))}
          <div className="flex gap-2">
            <input
              placeholder="项目名"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="flex-1 px-2 py-1 border rounded"
            />
            <button
              onClick={create}
              className="px-3 py-1 bg-blue-600 text-white rounded"
            >
              新建
            </button>
          </div>
          <button
            onClick={() => setTeamId(null)}
            className="text-sm text-gray-500"
          >
            ← 返回 team
          </button>
        </>
      )}
    </div>
  )
}
