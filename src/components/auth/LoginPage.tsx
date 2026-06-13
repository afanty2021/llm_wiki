import { useState } from "react"
import { useAuthStore } from "@/stores/auth-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function LoginPage({ onNavigate }: { onNavigate: (page: string) => void }) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const { login, isLoading, error, clearError } = useAuthStore()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await login(username, password)
    } catch {
      // error is set in store
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50">
      <div className="w-full max-w-md p-6 bg-white rounded-lg shadow-md">
        <h1 className="text-2xl font-bold mb-6">登录 LLM Wiki</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md">
              {error}
            </div>
          )}
          <div>
            <Input
              type="text"
              placeholder="用户名"
              value={username}
              onChange={(e) => { setUsername(e.target.value); clearError() }}
              required
            />
          </div>
          <div>
            <Input
              type="password"
              placeholder="密码"
              value={password}
              onChange={(e) => { setPassword(e.target.value); clearError() }}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? "登录中..." : "登录"}
          </Button>
          <p className="text-center text-sm text-gray-500">
            还没有账号？
            <button
              type="button"
              className="text-blue-600 hover:underline ml-1"
              onClick={() => onNavigate("register")}
            >
              注册
            </button>
          </p>
        </form>
      </div>
    </div>
  )
}
