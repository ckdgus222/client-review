import 'reflect-metadata';
import { type ExecutionContext, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthService, AuthUser } from '../auth.service.js';
import { IS_PUBLIC, Public } from '../decorators/public.decorator.js';
import { SESSION_COOKIE, SessionGuard } from './session.guard.js';

class TestController {
  @Public()
  publicRoute(this: void) {}

  protectedRoute(this: void) {}
}

@Public()
class PublicController {
  publicRoute(this: void) {}

  @SetMetadata(IS_PUBLIC, false)
  protectedRoute(this: void) {}
}

type TestRequest = {
  cookies?: Record<string, unknown>;
  user?: AuthUser;
};

const createContext = (
  request: TestRequest,
  handler = TestController.prototype.protectedRoute,
  controller = TestController,
) =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => controller,
  }) as unknown as ExecutionContext;

describe('SessionGuard', () => {
  const user = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'session@example.com',
    name: '세션 사용자',
  };
  const findSessionUser = vi.fn<AuthService['findSessionUser']>();
  let reflector: Reflector;
  let guard: SessionGuard;

  beforeEach(() => {
    findSessionUser.mockReset().mockResolvedValue(null);
    reflector = new Reflector();
    guard = new SessionGuard(reflector, {
      findSessionUser,
    } as unknown as AuthService);
  });

  it('세션 쿠키 이름은 sid다', () => {
    expect(SESSION_COOKIE).toBe('sid');
  });

  it('메서드에만 Public이 있으면 쿠키 없이 통과하고 세션을 조회하지 않는다', async () => {
    const request: TestRequest = {};
    const handler = TestController.prototype.publicRoute;

    expect(reflector.get(IS_PUBLIC, handler)).toBe(true);
    expect(reflector.get(IS_PUBLIC, TestController)).toBeUndefined();
    await expect(guard.canActivate(createContext(request, handler))).resolves.toBe(true);
    expect(findSessionUser).not.toHaveBeenCalled();
    expect(request).not.toHaveProperty('user');
  });

  it('클래스에만 Public이 있어도 통과하고 잘못된 쿠키를 조회하지 않는다', async () => {
    const request: TestRequest = { cookies: { sid: { invalid: true } } };
    const handler = PublicController.prototype.publicRoute;

    expect(reflector.get(IS_PUBLIC, PublicController)).toBe(true);
    expect(reflector.get(IS_PUBLIC, handler)).toBeUndefined();
    await expect(guard.canActivate(createContext(request, handler, PublicController))).resolves.toBe(true);
    expect(findSessionUser).not.toHaveBeenCalled();
    expect(request).not.toHaveProperty('user');
  });

  it('공개 메서드에 문자열 쿠키가 있어도 세션을 조회하지 않는다', async () => {
    const request: TestRequest = { cookies: { sid: 'public-test-session' } };

    await expect(guard.canActivate(createContext(request, TestController.prototype.publicRoute))).resolves.toBe(true);
    expect(findSessionUser).not.toHaveBeenCalled();
    expect(request).not.toHaveProperty('user');
  });

  it('같은 클래스의 다른 메서드는 Public 표시를 물려받지 않는다', async () => {
    await expect(guard.canActivate(createContext({}))).rejects.toThrow(UnauthorizedException);
    expect(findSessionUser).not.toHaveBeenCalled();
  });

  it('메서드의 비공개 표시가 클래스의 Public보다 우선한다', async () => {
    await expect(
      guard.canActivate(createContext({}, PublicController.prototype.protectedRoute, PublicController)),
    ).rejects.toMatchObject({ status: 401 });
    expect(findSessionUser).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'cookies 없음', request: {} },
    { label: 'sid 없음', request: { cookies: {} } },
    {
      label: '다른 쿠키만 있음',
      request: { cookies: { session: 'test-session' } },
    },
    { label: 'undefined', request: { cookies: { sid: undefined } } },
    { label: 'null', request: { cookies: { sid: null } } },
    { label: '숫자', request: { cookies: { sid: 123 } } },
    { label: '참', request: { cookies: { sid: true } } },
    { label: '거짓', request: { cookies: { sid: false } } },
    { label: '객체', request: { cookies: { sid: { token: 'test-session' } } } },
    { label: '배열', request: { cookies: { sid: ['test-session'] } } },
  ])('$label이면 조회하지 않고 401로 거부한다', async ({ request }) => {
    const result = guard.canActivate(createContext(request));

    await expect(result).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(result).rejects.toMatchObject({ status: 401 });
    expect(findSessionUser).not.toHaveBeenCalled();
    expect(request).not.toHaveProperty('user');
  });

  it.each(['unknown-test-session', ''])('문자열 쿠키 %j의 세션을 찾지 못하면 401로 거부한다', async (sessionId) => {
    const request: TestRequest = { cookies: { sid: sessionId } };
    const result = guard.canActivate(createContext(request));

    await expect(result).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(result).rejects.toMatchObject({ status: 401 });
    expect(findSessionUser).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(request).not.toHaveProperty('user');
  });

  it('유효한 sid를 조회해 같은 요청에 사용자를 붙이고 통과시킨다', async () => {
    findSessionUser.mockResolvedValue(user);
    const request: TestRequest = {
      cookies: { sid: 'valid-test-session', unrelated: 'other-cookie' },
    };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);

    expect(findSessionUser).toHaveBeenCalledExactlyOnceWith('valid-test-session');
    expect(request.user).toEqual(user);
    expect(request.cookies).toEqual({
      sid: 'valid-test-session',
      unrelated: 'other-cookie',
    });
  });

  it('세션 조회가 실패하면 요청을 통과시키거나 사용자를 붙이지 않는다', async () => {
    const error = new Error('세션 조회 실패');
    findSessionUser.mockRejectedValue(error);
    const request: TestRequest = { cookies: { sid: 'valid-test-session' } };

    await expect(guard.canActivate(createContext(request))).rejects.toBe(error);

    expect(request).not.toHaveProperty('user');
  });
});
