import { create } from "zustand"
import { apiClient } from "@/lib/api-client"
import type { UserResponse, TeamResponse } from "@/lib/api-types"

interface AuthState {
  user: UserResponse | null
  teams: TeamResponse[]
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null

  login: (username: string, password: string) => Promise<void>
  register: (username: string, email: string, password: string, full_name?: string) => Promise<void>
  logout: () => Promise<void>
  loadSession: () => Promise<void>
  loadTeams: () => Promise<void>
  clearError: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  teams: [],
  isAuthenticated: false,
  isLoading: false,
  error: null,

  login: async (username, password) => {
    set({ isLoading: true, error: null })
    try {
      const data = await apiClient.login({ username, password })
      set({
        user: data.user,
        isAuthenticated: true,
        isLoading: false,
      })
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Login failed",
        isLoading: false,
      })
      throw e
    }
  },

  register: async (username, email, password, full_name) => {
    set({ isLoading: true, error: null })
    try {
      const data = await apiClient.register({ username, email, password, full_name })
      set({
        user: data.user,
        isAuthenticated: true,
        isLoading: false,
      })
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Registration failed",
        isLoading: false,
      })
      throw e
    }
  },

  logout: async () => {
    await apiClient.logout()
    set({ user: null, teams: [], isAuthenticated: false })
  },

  loadSession: async () => {
    if (!apiClient.loadTokens()) return
    set({ isLoading: true })
    try {
      const user = await apiClient.getMe()
      set({ user, isAuthenticated: true, isLoading: false })
    } catch {
      apiClient.clearTokens()
      set({ isLoading: false })
    }
  },

  loadTeams: async () => {
    try {
      const teams = await apiClient.getUserTeams()
      set({ teams })
    } catch {
      // ignore - user may not have teams yet
    }
  },

  clearError: () => set({ error: null }),
}))
