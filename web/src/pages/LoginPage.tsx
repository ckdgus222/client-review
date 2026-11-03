import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError, requestCode, verifyCode } from '../api/auth.ts'
import { Button } from '../components/Button.tsx'
import { TextField } from '../components/TextField.tsx'
import styles from './LoginPage.module.css'

type Step = 'email' | 'code' | 'name'

const SUBMIT_LABELS = { email: '코드 받기', code: '로그인', name: '시작하기' }

// 입력 검사 오류(422)에는 code가 없어서, 지금 단계를 보고 어느 칸이 틀렸는지 고른다.
const INPUT_ERRORS = {
  email: '이메일 주소를 확인해 주세요',
  code: '코드는 숫자 6자리예요',
  name: '이름은 1~30자로 써 주세요',
}

const toMessage = (error: unknown, step: Step) => {
  if (!(error instanceof ApiError)) return '연결을 확인하고 다시 시도해 주세요'
  if (error.status === 429) return '코드는 1분에 한 번만 받을 수 있어요'
  if (error.code === 'CODE_WRONG') return '코드가 맞지 않아요'
  if (error.code === 'CODE_EXPIRED') return '코드를 쓸 수 없어요. 새 코드를 받아 주세요'
  if (error.status === 422 && !error.code) return INPUT_ERRORS[step]
  return '잠시 뒤 다시 시도해 주세요'
}

export const LoginPage = () => {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()
  const [sending, setSending] = useState(false)

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSending(true)
    setError(undefined)
    try {
      if (step === 'email') {
        await requestCode(email)
        // 새 코드를 받으면 옛 코드는 서버가 거부해서 칸을 비운다.
        setCode('')
        setStep('code')
        return
      }
      await verifyCode(email, code, step === 'name' ? name : undefined)
      // 로그인 화면을 방문 기록에서 바꿔치기해서, 뒤로 가기로 다시 오지 않게 한다.
      navigate('/', { replace: true })
    } catch (caught) {
      // 처음 온 사람은 코드를 맞힌 뒤 이름을 받는다. 오류가 아니라 다음 단계다.
      if (caught instanceof ApiError && caught.code === 'NAME_REQUIRED') {
        setStep('name')
        return
      }
      // 처음부터 다시 쓰지 않고 고쳐서 보내게 입력은 그대로 둔다.
      setError(toMessage(caught, step))
    } finally {
      setSending(false)
    }
  }

  const backToEmail = () => {
    setStep('email')
    setError(undefined)
  }

  // noValidate: 브라우저 기본 검사 말풍선 대신 우리 문구를 입력칸 아래에 보여 준다.
  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <h1>로그인</h1>
      {step === 'email' && (
        <TextField
          label="이메일"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          error={error}
          disabled={sending}
        />
      )}
      {step === 'code' && (
        <>
          <p>{email}로 받은 코드 6자리를 넣어 주세요.</p>
          <TextField
            label="로그인 코드"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={setCode}
            error={error}
            disabled={sending}
          />
        </>
      )}
      {step === 'name' && (
        <>
          <p>처음 오셨네요. 이름을 알려 주세요.</p>
          <TextField
            label="이름"
            autoComplete="name"
            value={name}
            onChange={setName}
            error={error}
            disabled={sending}
          />
        </>
      )}
      <Button type="submit" disabled={sending}>
        {SUBMIT_LABELS[step]}
      </Button>
      {step !== 'email' && (
        <Button variant="secondary" disabled={sending} onClick={backToEmail}>
          이메일 다시 입력
        </Button>
      )}
    </form>
  )
}
