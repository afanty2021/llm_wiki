import { create } from "zustand"
import type { UpdateStatus } from "@/lib/update-check"

/**
 * UI-side state for the update-check feature. Persistence (user-level
 * "auto check enabled" flag, "dismissed this version" memo, and last-
 * checked timestamp) lives in plugin-store via src/lib/project-store.ts.
 * The store mirrors the persisted values at runtime and lets the UI
 * subscribe to them without awaiting the store read every render.
 */
export interface UpdateStoreState {
  /** True while a check-for-updates HTTP call is in flight. */
  checking: boolean
  /** The most recent result (null if never checked this session). */
  lastResult: UpdateStatus | null
  /** Unix ms timestamp of the last successful (or attempted) check. */
  lastCheckedAt: number | null
  /**
   * Remote version the user clicked "later" on. If the remote version
   * later becomes something different, the "available" UI returns.
   * null = no dismissal active.
   */
  dismissedVersion: string | null
  /** User preference: run the automatic check on app startup. */
  enabled: boolean

  setChecking: (b: boolean) => void
  setResult: (result: UpdateStatus, at: number) => void
  setDismissed: (version: string | null) => void
  setEnabled: (b: boolean) => void
  hydrate: (partial: Partial<UpdateStoreState>) => void
}

export const useUpdateStore = create<UpdateStoreState>((set) => ({
  checking: false,
  lastResult: null,
  lastCheckedAt: null,
  dismissedVersion: null,
  enabled: true,

  setChecking: (checking) => set({ checking }),
  setResult: (lastResult, lastCheckedAt) =>
    set({ lastResult, lastCheckedAt, checking: false }),
  setDismissed: (dismissedVersion) => set({ dismissedVersion }),
  setEnabled: (enabled) => set({ enabled }),
  hydrate: (partial) => set(partial),
}))

/**
 * Helper the UI uses to decide whether to show the "update available"
 * surface. Suppresses the surface when the user has explicitly
 * dismissed this exact version; reappears naturally when a newer one
 * ships because `dismissedVersion` no longer matches `result.remote`.
 */
export function shouldShowUpdateBanner(state: UpdateStoreState): boolean {
  if (!state.lastResult) return false
  if (state.lastResult.kind !== "available") return false
  if (state.dismissedVersion && state.dismissedVersion === state.lastResult.remote) {
    return false
  }
  return true
}
