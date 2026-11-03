import { useEffect, useState } from 'react'
import { Navigate } from 'react-router'
import { type AuthUser, getMe, logout } from '../api/auth.ts'
import { Button } from '../components/Button.tsx'

// 임시 첫 화면이다. 2번 기능에서 프로젝트 목록으로 바뀐다.
export const HomePage = () => {
  // undefined는 아직 확인 중, null은 로그인 안 함이다.
  const [user, setUser] = useState<AuthUser | null>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch(() => setError('불러오지 못했어요. 잠시 뒤 새로고침해 주세요'))
  }, [])

  const handleLogout = async () => {
    try {
      await logout()
      // 로그아웃하면 로그인 안 한 상태와 같다. 아래 Navigate가 로그인 화면으로 보낸다.
      setUser(null)
    } catch {
      setError('로그아웃하지 못했어요. 다시 눌러 주세요')
    }
  }

  // replace라서 뒤로 가기를 눌러도 이 화면으로 돌아와 다시 보내지는 고리가 생기지 않는다.
  if (user === null) return <Navigate to="/login" replace />
  if (user === undefined) return <p>{error ?? '확인하는 중이에요.'}</p>

  return (
    <>
      <h1>{user.name}님, 안녕하세요</h1>
      <Button variant="secondary" onClick={handleLogout}>
        로그아웃
      </Button>
      {error && <p>{error}</p>}
    </>
  )
}
