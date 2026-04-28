import { load } from "@tauri-apps/plugin-store"
import type { WikiProject } from "@/types/wiki"
import type { LlmConfig, SearchApiConfig, EmbeddingConfig, MultimodalConfig, OutputLanguage, ProviderConfigs } from "@/stores/wiki-store"

const STORE_NAME = "app-state.json"
const RECENT_PROJECTS_KEY = "recentProjects"
const LAST_PROJECT_KEY = "lastProject"

async function getStore() {
  return load(STORE_NAME, { autoSave: true, defaults: {} })
}

export async function getRecentProjects(): Promise<WikiProject[]> {
  const store = await getStore()
  const projects = await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)
  return projects ?? []
}

export async function getLastProject(): Promise<WikiProject | null> {
  const store = await getStore()
  const project = await store.get<WikiProject>(LAST_PROJECT_KEY)
  return project ?? null
}

export async function saveLastProject(project: WikiProject): Promise<void> {
  const store = await getStore()
  await store.set(LAST_PROJECT_KEY, project)
  await addToRecentProjects(project)
}

export async function addToRecentProjects(
  project: WikiProject
): Promise<void> {
  const store = await getStore()
  const existing = (await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)) ?? []
  const filtered = existing.filter((p) => p.path !== project.path)
  const updated = [project, ...filtered].slice(0, 10)
  await store.set(RECENT_PROJECTS_KEY, updated)
}

const LLM_CONFIG_KEY = "llmConfig"
const PROVIDER_CONFIGS_KEY = "providerConfigs"
const ACTIVE_PRESET_KEY = "activePresetId"

export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  const store = await getStore()
  await store.set(LLM_CONFIG_KEY, config)
}

export async function loadLlmConfig(): Promise<LlmConfig | null> {
  const store = await getStore()
  return (await store.get<LlmConfig>(LLM_CONFIG_KEY)) ?? null
}

export async function saveProviderConfigs(configs: ProviderConfigs): Promise<void> {
  const store = await getStore()
  await store.set(PROVIDER_CONFIGS_KEY, configs)
}

export async function loadProviderConfigs(): Promise<ProviderConfigs | null> {
  const store = await getStore()
  return (await store.get<ProviderConfigs>(PROVIDER_CONFIGS_KEY)) ?? null
}

export async function saveActivePresetId(id: string | null): Promise<void> {
  const store = await getStore()
  await store.set(ACTIVE_PRESET_KEY, id)
}

export async function loadActivePresetId(): Promise<string | null> {
  const store = await getStore()
  return (await store.get<string | null>(ACTIVE_PRESET_KEY)) ?? null
}

const SEARCH_API_KEY = "searchApiConfig"

export async function saveSearchApiConfig(config: SearchApiConfig): Promise<void> {
  const store = await getStore()
  await store.set(SEARCH_API_KEY, config)
}

export async function loadSearchApiConfig(): Promise<SearchApiConfig | null> {
  const store = await getStore()
  return (await store.get<SearchApiConfig>(SEARCH_API_KEY)) ?? null
}

const EMBEDDING_KEY = "embeddingConfig"

export async function saveEmbeddingConfig(config: EmbeddingConfig): Promise<void> {
  const store = await getStore()
  await store.set(EMBEDDING_KEY, config)
}

export async function loadEmbeddingConfig(): Promise<EmbeddingConfig | null> {
  const store = await getStore()
  return (await store.get<EmbeddingConfig>(EMBEDDING_KEY)) ?? null
}

const MULTIMODAL_KEY = "multimodalConfig"

export async function saveMultimodalConfig(config: MultimodalConfig): Promise<void> {
  const store = await getStore()
  await store.set(MULTIMODAL_KEY, config)
}

export async function loadMultimodalConfig(): Promise<MultimodalConfig | null> {
  const store = await getStore()
  return (await store.get<MultimodalConfig>(MULTIMODAL_KEY)) ?? null
}

export async function removeFromRecentProjects(
  path: string
): Promise<void> {
  const store = await getStore()
  const existing = (await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)) ?? []
  const updated = existing.filter((p) => p.path !== path)
  await store.set(RECENT_PROJECTS_KEY, updated)
}

const LANGUAGE_KEY = "language"

export async function saveLanguage(lang: string): Promise<void> {
  const store = await getStore()
  await store.set(LANGUAGE_KEY, lang)
}

export async function loadLanguage(): Promise<string | null> {
  const store = await getStore()
  return (await store.get<string>(LANGUAGE_KEY)) ?? null
}

const OUTPUT_LANGUAGE_KEY = "outputLanguage"

export async function saveOutputLanguage(lang: OutputLanguage): Promise<void> {
  const store = await getStore()
  await store.set(OUTPUT_LANGUAGE_KEY, lang)
}

export async function loadOutputLanguage(): Promise<OutputLanguage | null> {
  const store = await getStore()
  return (await store.get<OutputLanguage>(OUTPUT_LANGUAGE_KEY)) ?? null
}

// ── Update-check persistence ──────────────────────────────────────────────
// Small slice of state the UI-layer update store hydrates from on boot.
// Only fields that should persist across launches: the user's "enable
// auto-check" toggle, the timestamp we last checked (so the 6-hour cache
// survives restarts), and the version the user explicitly dismissed
// (so we don't re-nag on every restart until a newer version is out).

const UPDATE_CHECK_STATE_KEY = "updateCheckState"

export interface PersistedUpdateCheckState {
  enabled: boolean
  lastCheckedAt: number | null
  dismissedVersion: string | null
}

export async function saveUpdateCheckState(
  state: PersistedUpdateCheckState,
): Promise<void> {
  const store = await getStore()
  await store.set(UPDATE_CHECK_STATE_KEY, state)
}

export async function loadUpdateCheckState(): Promise<PersistedUpdateCheckState | null> {
  const store = await getStore()
  return (
    (await store.get<PersistedUpdateCheckState>(UPDATE_CHECK_STATE_KEY)) ?? null
  )
}
