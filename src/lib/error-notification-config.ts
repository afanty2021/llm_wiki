import { load } from "@tauri-apps/plugin-store"

const STORE_NAME = "app-state.json"
const KEY = "error_notification"

async function getStore() {
  return load(STORE_NAME, { autoSave: true, defaults: {} })
}

export async function loadErrorNotificationConfig(): Promise<boolean> {
  const store = await getStore()
  const val = await store.get<boolean>(KEY)
  return val ?? true
}

export async function setErrorNotificationConfig(enabled: boolean): Promise<void> {
  const store = await getStore()
  await store.set(KEY, enabled)
  await store.save()
}
