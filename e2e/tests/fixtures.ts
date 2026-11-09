import { test as base } from '@playwright/test'
import { createSessionToken, hashSessionToken } from '../../api/src/auth/token.ts'
import { PrismaService } from '../../api/src/prisma/prisma.service.ts'
import { resetDatabase as resetTables } from '../../api/test/reset-database.ts'

// api 서버와 같은 테스트 DB에 붙는다. DATABASE_URL은 playwright.config.ts가 검사를 통과한 테스트 DB 주소로 바꿔 두었다.
export const db = new PrismaService()

// 표 목록과 "붙은 DB가 정말 테스트 DB인가" 검사는 api 테스트와 같은 함수 하나에 둔다. 표를 더하면 그쪽만 고친다.
export const resetDatabase = () => resetTables(db)

export const createUser = (email: string, name: string) => db.user.create({ data: { email, name } })

export const createProject = (developerId: string, name: string) =>
  db.project.create({ data: { name, members: { create: { userId: developerId, role: 'DEVELOPER' } } } })

// 로그인 화면 테스트용. 서버가 보낸 코드는 api 로그에만 있어서, 코드 해시를 아는 값의 해시로 바꿔 넣는다.
// 해시는 bcrypt 비용 4로 미리 만든 값이다. 서버는 해시에 적힌 비용대로 비교하므로 실제 비용(12)과 달라도 된다.
export const KNOWN_LOGIN_CODE = '246810'
const KNOWN_LOGIN_CODE_HASH = '$2b$04$8yY4B4jcNnJVXgLINgCoReiy.Nrs.Y3YweSweLmpa1LrZYFiV4Kv2'
export const useKnownLoginCode = (email: string) =>
  db.loginCode.update({ where: { email }, data: { codeHash: KNOWN_LOGIN_CODE_HASH } })

type Fixtures = {
  // 화면으로 로그인하지 않고 세션 줄을 넣어 쿠키를 심는다(기획 정할 것 3). 로그인 화면이 깨져도 다른 테스트가 같이 깨지지 않는다.
  loginAs: (userId: string) => Promise<void>
}

export const test = base.extend<Fixtures>({
  loginAs: async ({ context, baseURL }, use) => {
    await use(async (userId) => {
      const token = createSessionToken()
      await db.session.create({
        data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
      })
      await context.addCookies([{ name: 'sid', value: token, url: baseURL }])
    })
  },
})

export { expect } from '@playwright/test'
