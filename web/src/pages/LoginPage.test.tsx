import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import App from '../App.tsx'
import { ApiError, requestCode, verifyCode } from '../api/auth.ts'
import { LoginPage } from './LoginPage.tsx'

vi.mock('../api/auth.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/auth.ts')>('../api/auth.ts')
  return { ...actual, requestCode: vi.fn(), verifyCode: vi.fn() }
})

const email = 'reader@example.com'
const code = '012345'
const user = { id: '5b3a934d-ef8e-4ce8-b26a-a9d1cdd4983f', email, name: '김수정' }

const renderLogin = () =>
  render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<p>첫 화면</p>} />
      </Routes>
    </MemoryRouter>,
  )

const enterCodeStep = async () => {
  fireEvent.change(screen.getByLabelText('이메일'), { target: { value: email } })
  fireEvent.click(screen.getByRole('button', { name: '코드 받기' }))
  return screen.findByLabelText<HTMLInputElement>('로그인 코드')
}

const enterNameStep = async () => {
  const input = await enterCodeStep()
  vi.mocked(verifyCode).mockRejectedValueOnce(new ApiError(422, 'NAME_REQUIRED'))
  fireEvent.change(input, { target: { value: code } })
  fireEvent.click(screen.getByRole('button', { name: '로그인' }))
  return screen.findByLabelText<HTMLInputElement>('이름')
}

beforeEach(() => {
  vi.mocked(requestCode).mockReset().mockResolvedValue(undefined)
  vi.mocked(verifyCode).mockReset().mockResolvedValue(user)
})

describe('LoginPage', () => {
  it('처음에는 이메일 입력과 제출 버튼만 보이고 API를 부르지 않는다', () => {
    renderLogin()

    const input = screen.getByLabelText<HTMLInputElement>('이메일')
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '코드 받기' })
    expect(screen.getByRole('heading', { name: '로그인', level: 1 })).toBeDefined()
    expect(input.value).toBe('')
    expect(input.type).toBe('email')
    expect(input.autocomplete).toBe('email')
    expect(input.form?.noValidate).toBe(true)
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(submit.type).toBe('submit')
    expect(submit.disabled).toBe(false)
    expect(screen.queryByLabelText('로그인 코드')).toBeNull()
    expect(screen.queryByLabelText('이름')).toBeNull()
    expect(screen.queryByRole('button', { name: '이메일 다시 입력' })).toBeNull()
    expect(requestCode).not.toHaveBeenCalled()
    expect(verifyCode).not.toHaveBeenCalled()
  })

  it('App의 /login 경로에서 로그인 화면을 보여 준다', () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>,
    )

    expect(screen.getByLabelText('이메일')).toBeDefined()
    expect(screen.getByRole('button', { name: '코드 받기' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: '없는 화면이에요' })).toBeNull()
  })

  it('코드를 받으면 이메일 안내와 빈 코드 칸, 로그인과 이메일 다시 입력 버튼을 보여 준다', async () => {
    renderLogin()
    const input = await enterCodeStep()

    expect(requestCode).toHaveBeenCalledExactlyOnceWith(email)
    expect(verifyCode).not.toHaveBeenCalled()
    expect(screen.getByText(`${email}로 받은 코드 6자리를 넣어 주세요.`)).toBeDefined()
    expect(input.value).toBe('')
    expect(input.inputMode).toBe('numeric')
    expect(input.autocomplete).toBe('one-time-code')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '로그인' }).type).toBe('submit')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '로그인' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '이메일 다시 입력' }).type).toBe('button')
    expect(screen.queryByLabelText('이메일')).toBeNull()
    expect(screen.queryByLabelText('이름')).toBeNull()
  })

  it('코드 발급 응답이 오기 전에는 이메일 단계에 머물고 성공한 뒤 버튼 잠금이 풀린다', async () => {
    let resolveRequest!: () => void
    vi.mocked(requestCode).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRequest = resolve
        }),
    )
    renderLogin()
    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: email } })
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '코드 받기' })
    fireEvent.click(submit)

    expect(submit.disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('이메일').value).toBe(email)
    expect(screen.queryByLabelText('로그인 코드')).toBeNull()
    fireEvent.click(submit)
    expect(requestCode).toHaveBeenCalledExactlyOnceWith(email)

    resolveRequest()

    expect(await screen.findByLabelText('로그인 코드')).toBeDefined()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '로그인' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '이메일 다시 입력' }).disabled).toBe(false)
  })

  it.each(['000000', '012345', '999999'])(
    '기존 사용자는 코드 %s를 그대로 보내고 첫 화면으로 이동한다',
    async (value) => {
      renderLogin()
      const input = await enterCodeStep()
      fireEvent.change(input, { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: '로그인' }))

      expect(await screen.findByText('첫 화면')).toBeDefined()
      expect(verifyCode).toHaveBeenCalledExactlyOnceWith(email, value, undefined)
      expect(screen.queryByLabelText('이름')).toBeNull()
      expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
    },
  )

  it.each(['김', '가'.repeat(30)])('새 사용자는 이름 %j와 같은 코드를 보내고 첫 화면으로 이동한다', async (name) => {
    renderLogin()
    const input = await enterNameStep()

    expect(verifyCode).toHaveBeenCalledExactlyOnceWith(email, code, undefined)
    expect(screen.getByText('처음 오셨네요. 이름을 알려 주세요.')).toBeDefined()
    expect(screen.queryByText('이름은 1~30자로 써 주세요')).toBeNull()
    expect(screen.queryByText('코드는 숫자 6자리예요')).toBeNull()
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(input.hasAttribute('aria-describedby')).toBe(false)
    expect(input.value).toBe('')
    expect(input.autocomplete).toBe('name')
    expect(screen.queryByLabelText('로그인 코드')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '시작하기' }).type).toBe('submit')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '시작하기' }).disabled).toBe(false)

    fireEvent.change(input, { target: { value: name } })
    fireEvent.click(screen.getByRole('button', { name: '시작하기' }))

    expect(await screen.findByText('첫 화면')).toBeDefined()
    expect(verifyCode).toHaveBeenCalledTimes(2)
    expect(verifyCode).toHaveBeenLastCalledWith(email, code, name)
    expect(requestCode).toHaveBeenCalledTimes(1)
  })

  it('Enter가 일으키는 form submit으로 이메일, 코드, 이름을 차례로 보낼 수 있다', async () => {
    renderLogin()
    const emailInput = screen.getByLabelText<HTMLInputElement>('이메일')
    fireEvent.change(emailInput, { target: { value: email } })
    // jsdom은 Enter의 기본 제출 동작을 재현하지 않아 submit 이벤트를 직접 보낸다.
    fireEvent.submit(emailInput.form!)

    const codeInput = await screen.findByLabelText<HTMLInputElement>('로그인 코드')
    vi.mocked(verifyCode).mockRejectedValueOnce(new ApiError(422, 'NAME_REQUIRED'))
    fireEvent.change(codeInput, { target: { value: code } })
    fireEvent.submit(codeInput.form!)

    const nameInput = await screen.findByLabelText<HTMLInputElement>('이름')
    fireEvent.change(nameInput, { target: { value: user.name } })
    fireEvent.submit(nameInput.form!)

    expect(await screen.findByText('첫 화면')).toBeDefined()
    expect(requestCode).toHaveBeenCalledExactlyOnceWith(email)
    expect(verifyCode).toHaveBeenNthCalledWith(1, email, code, undefined)
    expect(verifyCode).toHaveBeenNthCalledWith(2, email, code, user.name)
    expect(verifyCode).toHaveBeenCalledTimes(2)
  })

  describe('이메일 오류', () => {
    it('422에 모르는 code가 있으면 일반 오류를 표시하고 보존한 이메일로 다시 요청할 수 있다', async () => {
      vi.mocked(requestCode).mockRejectedValueOnce(new ApiError(422, 'SOMETHING_NEW'))
      renderLogin()
      const input = screen.getByLabelText<HTMLInputElement>('이메일')
      fireEvent.change(input, { target: { value: email } })
      fireEvent.click(screen.getByRole('button', { name: '코드 받기' }))

      const errorText = await screen.findByText('잠시 뒤 다시 시도해 주세요')
      expect(screen.queryByText('이메일 주소를 확인해 주세요')).toBeNull()
      expect(screen.getByLabelText('이메일')).toBe(input)
      expect(input.value).toBe(email)
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(input.getAttribute('aria-describedby')).toBe(errorText.id)
      expect(requestCode).toHaveBeenCalledExactlyOnceWith(email)
      expect(verifyCode).not.toHaveBeenCalled()
      expect(screen.queryByLabelText('로그인 코드')).toBeNull()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '코드 받기' }).disabled).toBe(false)

      fireEvent.click(screen.getByRole('button', { name: '코드 받기' }))

      const codeInput = await screen.findByLabelText<HTMLInputElement>('로그인 코드')
      expect(requestCode).toHaveBeenCalledTimes(2)
      expect(requestCode).toHaveBeenLastCalledWith(email)
      expect(screen.queryByText('잠시 뒤 다시 시도해 주세요')).toBeNull()
      expect(codeInput.hasAttribute('aria-invalid')).toBe(false)
    })

    it.each([
      { value: '', error: new ApiError(422), message: '이메일 주소를 확인해 주세요' },
      { value: '잘못된주소', error: new ApiError(422), message: '이메일 주소를 확인해 주세요' },
      { value: email, error: new ApiError(429), message: '코드는 1분에 한 번만 받을 수 있어요' },
      { value: email, error: new TypeError('Failed to fetch'), message: '연결을 확인하고 다시 시도해 주세요' },
      { value: email, error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    ])('$value 제출 실패 시 $message를 표시하고 입력을 보존한다', async ({ value, error, message }) => {
      vi.mocked(requestCode).mockRejectedValueOnce(error)
      renderLogin()
      const input = screen.getByLabelText<HTMLInputElement>('이메일')
      fireEvent.change(input, { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: '코드 받기' }))

      const errorText = await screen.findByText(message)
      expect(requestCode).toHaveBeenCalledExactlyOnceWith(value)
      expect(verifyCode).not.toHaveBeenCalled()
      expect(input.value).toBe(value)
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(input.getAttribute('aria-describedby')).toBe(errorText.id)
      expect(input.compareDocumentPosition(errorText) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      expect(screen.queryByLabelText('로그인 코드')).toBeNull()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '코드 받기' }).disabled).toBe(false)
    })
  })

  describe('코드 오류', () => {
    it('422에 모르는 code가 있으면 일반 오류를 표시하고 보존한 코드로 다시 로그인할 수 있다', async () => {
      renderLogin()
      const input = await enterCodeStep()
      vi.mocked(verifyCode).mockRejectedValueOnce(new ApiError(422, 'SOMETHING_NEW'))
      fireEvent.change(input, { target: { value: code } })
      fireEvent.click(screen.getByRole('button', { name: '로그인' }))

      const errorText = await screen.findByText('잠시 뒤 다시 시도해 주세요')
      expect(screen.queryByText('코드는 숫자 6자리예요')).toBeNull()
      expect(screen.getByLabelText('로그인 코드')).toBe(input)
      expect(input.value).toBe(code)
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(input.getAttribute('aria-describedby')).toBe(errorText.id)
      expect(verifyCode).toHaveBeenCalledExactlyOnceWith(email, code, undefined)
      expect(screen.queryByLabelText('이름')).toBeNull()
      expect(screen.queryByText('첫 화면')).toBeNull()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '로그인' }).disabled).toBe(false)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '이메일 다시 입력' }).disabled).toBe(false)

      fireEvent.click(screen.getByRole('button', { name: '로그인' }))

      expect(await screen.findByText('첫 화면')).toBeDefined()
      expect(verifyCode).toHaveBeenCalledTimes(2)
      expect(verifyCode).toHaveBeenLastCalledWith(email, code, undefined)
      expect(requestCode).toHaveBeenCalledTimes(1)
    })

    it.each([
      { value: code, error: new ApiError(422, 'CODE_WRONG'), message: '코드가 맞지 않아요' },
      { value: code, error: new ApiError(422, 'CODE_EXPIRED'), message: '코드를 쓸 수 없어요. 새 코드를 받아 주세요' },
      { value: '', error: new ApiError(422), message: '코드는 숫자 6자리예요' },
      { value: '12345', error: new ApiError(422), message: '코드는 숫자 6자리예요' },
      { value: '1234567', error: new ApiError(422), message: '코드는 숫자 6자리예요' },
      { value: 'abcdef', error: new ApiError(422), message: '코드는 숫자 6자리예요' },
      { value: code, error: new TypeError('Failed to fetch'), message: '연결을 확인하고 다시 시도해 주세요' },
      { value: code, error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    ])('$value 제출 실패 시 $message를 표시하고 코드를 보존한다', async ({ value, error, message }) => {
      renderLogin()
      const input = await enterCodeStep()
      vi.mocked(verifyCode).mockRejectedValueOnce(error)
      fireEvent.change(input, { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: '로그인' }))

      const errorText = await screen.findByText(message)
      expect(verifyCode).toHaveBeenCalledExactlyOnceWith(email, value, undefined)
      expect(input.value).toBe(value)
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(input.getAttribute('aria-describedby')).toBe(errorText.id)
      expect(input.compareDocumentPosition(errorText) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      expect(screen.queryByText('첫 화면')).toBeNull()
      expect(screen.queryByLabelText('이름')).toBeNull()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '로그인' }).disabled).toBe(false)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '이메일 다시 입력' }).disabled).toBe(false)
    })
  })

  describe('이름 오류', () => {
    it('422에 모르는 code가 있으면 일반 오류를 표시하고 보존한 이름과 코드로 다시 가입할 수 있다', async () => {
      renderLogin()
      const input = await enterNameStep()
      vi.mocked(verifyCode).mockRejectedValueOnce(new ApiError(422, 'SOMETHING_NEW'))
      fireEvent.change(input, { target: { value: user.name } })
      fireEvent.click(screen.getByRole('button', { name: '시작하기' }))

      const errorText = await screen.findByText('잠시 뒤 다시 시도해 주세요')
      expect(screen.queryByText('이름은 1~30자로 써 주세요')).toBeNull()
      expect(screen.getByLabelText('이름')).toBe(input)
      expect(input.value).toBe(user.name)
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(input.getAttribute('aria-describedby')).toBe(errorText.id)
      expect(verifyCode).toHaveBeenCalledTimes(2)
      expect(verifyCode).toHaveBeenLastCalledWith(email, code, user.name)
      expect(screen.queryByText('첫 화면')).toBeNull()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '시작하기' }).disabled).toBe(false)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '이메일 다시 입력' }).disabled).toBe(false)

      fireEvent.click(screen.getByRole('button', { name: '시작하기' }))

      expect(await screen.findByText('첫 화면')).toBeDefined()
      expect(verifyCode).toHaveBeenCalledTimes(3)
      expect(verifyCode).toHaveBeenLastCalledWith(email, code, user.name)
      expect(requestCode).toHaveBeenCalledTimes(1)
    })

    it.each([
      { value: '', error: new ApiError(422), message: '이름은 1~30자로 써 주세요' },
      { value: '   ', error: new ApiError(422), message: '이름은 1~30자로 써 주세요' },
      { value: '가'.repeat(31), error: new ApiError(422), message: '이름은 1~30자로 써 주세요' },
      { value: user.name, error: new ApiError(422, 'CODE_WRONG'), message: '코드가 맞지 않아요' },
      {
        value: user.name,
        error: new ApiError(422, 'CODE_EXPIRED'),
        message: '코드를 쓸 수 없어요. 새 코드를 받아 주세요',
      },
      { value: user.name, error: new TypeError('Failed to fetch'), message: '연결을 확인하고 다시 시도해 주세요' },
      { value: user.name, error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    ])('$value 제출 실패 시 $message를 이름 칸에 표시하고 입력을 보존한다', async ({ value, error, message }) => {
      renderLogin()
      const input = await enterNameStep()
      vi.mocked(verifyCode).mockRejectedValueOnce(error)
      fireEvent.change(input, { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: '시작하기' }))

      const errorText = await screen.findByText(message)
      expect(verifyCode).toHaveBeenCalledTimes(2)
      expect(verifyCode).toHaveBeenLastCalledWith(email, code, value)
      expect(input.value).toBe(value)
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(input.getAttribute('aria-describedby')).toBe(errorText.id)
      expect(input.compareDocumentPosition(errorText) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      expect(screen.queryByText('첫 화면')).toBeNull()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '시작하기' }).disabled).toBe(false)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '이메일 다시 입력' }).disabled).toBe(false)
    })
  })

  it.each(['email', 'code', 'name'] as const)(
    '%s 단계에서 재제출하면 오류를 지우고 응답 전까지 버튼을 잠가 중복 클릭을 막는다',
    async (step) => {
      renderLogin()
      if (step === 'code') await enterCodeStep()
      if (step === 'name') await enterNameStep()
      const label = { email: '이메일', code: '로그인 코드', name: '이름' }[step]
      const buttonLabel = { email: '코드 받기', code: '로그인', name: '시작하기' }[step]
      const value = { email, code, name: user.name }[step]
      const input = screen.getByLabelText<HTMLInputElement>(label)
      const submit = screen.getByRole<HTMLButtonElement>('button', { name: buttonLabel })
      const api = step === 'email' ? vi.mocked(requestCode) : vi.mocked(verifyCode)
      api.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      fireEvent.change(input, { target: { value } })
      fireEvent.click(submit)
      await screen.findByText('연결을 확인하고 다시 시도해 주세요')

      let rejectRequest!: (error: Error) => void
      api.mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectRequest = reject
          }),
      )
      const previousCalls = api.mock.calls.length
      fireEvent.click(submit)

      expect(screen.queryByText('연결을 확인하고 다시 시도해 주세요')).toBeNull()
      expect(input.hasAttribute('aria-invalid')).toBe(false)
      expect(input.hasAttribute('aria-describedby')).toBe(false)
      expect(input.value).toBe(value)
      expect(submit.disabled).toBe(true)
      fireEvent.click(submit)
      if (step !== 'email') {
        const back = screen.getByRole<HTMLButtonElement>('button', { name: '이메일 다시 입력' })
        expect(back.disabled).toBe(true)
        fireEvent.click(back)
      }
      expect(screen.getByLabelText(label)).toBe(input)
      expect(api).toHaveBeenCalledTimes(previousCalls + 1)
      if (step === 'email') expect(requestCode).toHaveBeenLastCalledWith(email)
      if (step !== 'email')
        expect(verifyCode).toHaveBeenLastCalledWith(email, code, step === 'name' ? user.name : undefined)
      expect(screen.queryByText('첫 화면')).toBeNull()

      rejectRequest(new ApiError(500))
      await screen.findByText('잠시 뒤 다시 시도해 주세요')
      expect(submit.disabled).toBe(false)
      expect(input.value).toBe(value)
      if (step !== 'email') {
        expect(screen.getByRole<HTMLButtonElement>('button', { name: '이메일 다시 입력' }).disabled).toBe(false)
      }
    },
  )

  it.each(['code', 'name'] as const)(
    '%s 단계에서 이메일로 돌아가 재발급하면 이전 오류와 코드가 남지 않는다',
    async (step) => {
      renderLogin()
      const input = step === 'code' ? await enterCodeStep() : await enterNameStep()
      fireEvent.change(input, { target: { value: step === 'code' ? code : user.name } })
      vi.mocked(verifyCode).mockRejectedValueOnce(new ApiError(422, 'CODE_EXPIRED'))
      fireEvent.click(screen.getByRole('button', { name: step === 'code' ? '로그인' : '시작하기' }))
      await screen.findByText('코드를 쓸 수 없어요. 새 코드를 받아 주세요')
      const previousCalls = vi.mocked(verifyCode).mock.calls.length

      fireEvent.click(screen.getByRole('button', { name: '이메일 다시 입력' }))

      const emailInput = screen.getByLabelText<HTMLInputElement>('이메일')
      expect(emailInput.value).toBe(email)
      expect(emailInput.hasAttribute('aria-invalid')).toBe(false)
      expect(emailInput.hasAttribute('aria-describedby')).toBe(false)
      expect(screen.queryByText('코드를 쓸 수 없어요. 새 코드를 받아 주세요')).toBeNull()
      expect(screen.queryByLabelText('로그인 코드')).toBeNull()
      expect(screen.queryByLabelText('이름')).toBeNull()
      expect(requestCode).toHaveBeenCalledTimes(1)
      expect(verifyCode).toHaveBeenCalledTimes(previousCalls)

      const nextEmail = step === 'code' ? email : 'another@example.com'
      fireEvent.change(emailInput, { target: { value: nextEmail } })
      fireEvent.click(screen.getByRole('button', { name: '코드 받기' }))

      const codeInput = await screen.findByLabelText<HTMLInputElement>('로그인 코드')
      expect(codeInput.value).toBe('')
      expect(screen.getByText(`${nextEmail}로 받은 코드 6자리를 넣어 주세요.`)).toBeDefined()
      expect(requestCode).toHaveBeenCalledTimes(2)
      expect(requestCode).toHaveBeenLastCalledWith(nextEmail)
      fireEvent.change(codeInput, { target: { value: '999999' } })
      fireEvent.click(screen.getByRole('button', { name: '로그인' }))

      expect(await screen.findByText('첫 화면')).toBeDefined()
      expect(verifyCode).toHaveBeenLastCalledWith(nextEmail, '999999', undefined)
    },
  )

  it.each(['code', 'name'] as const)(
    '%s 단계에서 성공하면 로그인 방문 기록을 바꿔 뒤로 가도 로그인으로 돌아오지 않는다',
    async (step) => {
      const HistoryButtons = () => {
        const navigate = useNavigate()
        return <button onClick={() => navigate(-1)}>뒤로 가기</button>
      }
      render(
        <MemoryRouter initialEntries={['/before', '/login']} initialIndex={1}>
          <HistoryButtons />
          <Routes>
            <Route path="/before" element={<p>이전 화면</p>} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<p>첫 화면</p>} />
          </Routes>
        </MemoryRouter>,
      )
      const input = step === 'code' ? await enterCodeStep() : await enterNameStep()
      fireEvent.change(input, { target: { value: step === 'code' ? code : user.name } })
      fireEvent.click(screen.getByRole('button', { name: step === 'code' ? '로그인' : '시작하기' }))
      await screen.findByText('첫 화면')

      fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))

      await waitFor(() => expect(screen.getByText('이전 화면')).toBeDefined())
      expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
      expect(screen.queryByText('첫 화면')).toBeNull()
    },
  )
})
