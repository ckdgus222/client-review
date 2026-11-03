import { useId } from 'react'
import styles from './TextField.module.css'

type TextFieldProps = {
  label: string
  value: string
  // 이벤트가 아니라 글자만 넘겨서, 쓰는 쪽이 onChange={setEmail}처럼 바로 넘길 수 있다.
  onChange: (value: string) => void
  error?: string
  // 안 주면 input 기본값인 text다.
  type?: 'text' | 'email'
  autoComplete?: 'email' | 'one-time-code' | 'name'
  // numeric이면 휴대폰에서 숫자 자판이 뜬다.
  inputMode?: 'numeric'
}

export const TextField = ({ label, value, onChange, error, type, autoComplete, inputMode }: TextFieldProps) => {
  // 한 화면에 칸이 여러 개여도 라벨과 오류 문구가 자기 칸에만 이어지게 칸마다 다른 id를 만든다.
  const id = useId()
  const errorId = `${id}-error`

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        className={styles.input}
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        inputMode={inputMode}
        // 화면을 못 보는 사람에게 칸이 틀렸다는 것과 오류 문구를 함께 읽어 준다.
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      {error && (
        <p className={styles.error} id={errorId}>
          {error}
        </p>
      )}
    </div>
  )
}
