import { useEffect, useState } from 'react'
import { type AuthUser, getMe } from '../api/auth.ts'

// 로그인이 필요한 화면이 처음 뜰 때 한 번 "로그인한 사람"을 확인한다.
// user: undefined는 아직 확인 중, null은 로그인 안 함이다.
// 오류면 user를 undefined로 둔다. null로 바꾸면 화면이 로그인한 사람도 로그인 화면으로 보낸다.
export const useMe = () => {
  const [user, setUser] = useState<AuthUser | null>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch(() => setError('불러오지 못했어요. 잠시 뒤 새로고침해 주세요'))
  }, [])

  return { user, error }
}
