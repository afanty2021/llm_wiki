import { useState } from "react"
import { useAuthStore } from "@/stores/auth-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function RegisterPage({ onNavigate }: { onNavigate: (page: "login" | "register") => void }) {
  const [username, setUsername] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [fullName, setFullName] = useState("")
  const { register, isLoading, error, clearError } = useAuthStore()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await register(username, email, password, fullName || undefined)
    } catch {
      // error is set in store
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50">
      <div className="w-full max-w-md p-6 bg-white rounded-lg shadow-md">
        <h1 className="text-2xl font-bold mb-6">注册 LLM Wiki</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md">{error}</div>
          )}
          <Input
            placeholder="用户名"
            value={username}
            onChange={(e) => { setUsername(e.target.value); clearError() }}
            required
          />
          <Input
            type="email"
            placeholder="邮箱"
            value={email}
            onChange={(e) => { setEmail(e.target.value); clearError() }}
            required
          />
          <Input
            type="password"
            placeholder="密码（至少8位）"
            value={password}
            onChange={(e) => { setPassword(e.target.value); clearError() }}
            required
            minLength={8}
          />
          <Input
            placeholder="全名（选填）"
            value={fullName}
            onChange={(e) => { setFullName(e.target.value); clearError() }}
          />
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? "注册中..." : "注册"}
          </Button>
          <p className="text-center text-sm text-gray-500">
            已有账号？
            <button
              type="button"
              className="text-blue-600 hover:underline ml-1"
              onClick={() => { clearError(); onNavigate("login") }}
            >
              登录
            </button>
          </p>
        </form>
      </div>
    </div>
  )
}
