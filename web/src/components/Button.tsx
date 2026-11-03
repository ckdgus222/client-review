import type { ReactNode } from 'react'
import styles from './Button.module.css'

type ButtonProps = {
  children: ReactNode
  // 모양만 정한다. primary는 화면의 주 동작, secondary는 보조 동작이다. 제출 여부는 type이 정한다.
  variant?: 'primary' | 'secondary'
  // 폼 안에서 HTML 기본값은 submit이라 아무 버튼이나 눌러도 폼이 제출된다. 그래서 기본을 button으로 둔다.
  type?: 'button' | 'submit'
  disabled?: boolean
  onClick?: () => void
}

export const Button = ({ children, variant = 'primary', type = 'button', disabled, onClick }: ButtonProps) => (
  <button className={`${styles.button} ${styles[variant]}`} type={type} disabled={disabled} onClick={onClick}>
    {children}
  </button>
)
