import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError } from '../lib/api'
import type { User } from '../lib/types'
import { useLocation } from 'react-router-dom'

interface AuthContextValue {
  user: User | null
  checking: boolean
  login: (email: string, password: string) => Promise<User>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const routeKind = location.pathname.startsWith('/admin') ? 'admin' : 'public'
  const [user, setUser] = useState<User | null>(null)
  const [checking, setChecking] = useState(routeKind === 'admin')
  const [checkedRouteKind, setCheckedRouteKind] = useState<'admin' | 'public' | null>(null)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const attempt = ++generation.current
    try {
      const result = await api.auth.me()
      if (attempt === generation.current) setUser(result)
    } catch (error) {
      if (!(error instanceof ApiError) || ![401, 403].includes(error.status)) {
        console.warn('Session check failed', error)
      }
      if (attempt === generation.current) setUser(null)
    } finally {
      if (attempt === generation.current) {
        setCheckedRouteKind('admin')
        setChecking(false)
      }
    }
  }, [])

  useEffect(() => {
    if (routeKind === 'admin') {
      setChecking(true)
      void refresh()
    } else {
      ++generation.current
      setCheckedRouteKind('public')
      setChecking(false)
    }
  }, [routeKind, refresh])

  const login = useCallback(async (email: string, password: string) => {
    ++generation.current
    try {
      await api.auth.login(email, password)
      // Confirm the browser accepted the session cookie before entering the portal.
      const nextUser = await api.auth.me()
      setUser(nextUser)
      setCheckedRouteKind('admin')
      return nextUser
    } finally { setChecking(false) }
  }, [])

  const logout = useCallback(async () => {
    ++generation.current
    try { await api.auth.logout() } finally { setUser(null) }
  }, [])

  const routeChecking = routeKind === 'admin' && (checking || checkedRouteKind !== 'admin')
  const value = useMemo(() => ({ user, checking: routeChecking, login, logout, refresh }), [user, routeChecking, login, logout, refresh])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}
