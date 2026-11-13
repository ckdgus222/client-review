import { type ReactNode, useId, useLayoutEffect, useRef } from 'react'
import styles from './Modal.module.css'

type ModalProps = {
  title: string
  // ×와 Esc가 부른다. 닫을지는 부르는 쪽이 정한다(이 부품을 그만 그리면 닫힌다). 그래서 보내는 중에는 닫지 않을 수 있다.
  onClose: () => void
  children: ReactNode
}

// 위에 뜨는 창. 브라우저의 <dialog>를 showModal()로 열어서, 뒤 화면을 못 누르게 막기·초점을 창 안에 두기·
// Esc를 닫기 요청으로 알리기를 브라우저가 해 준다. 창 밖(어두운 부분)을 눌러서는 닫히지 않는다.
export const Modal = ({ title, onClose, children }: ModalProps) => {
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)

  // useEffect가 아니라 useLayoutEffect다. 이 부품이 사라질 때 useEffect의 정리 함수는 <dialog>가 문서에서 빠진 뒤에 돌아서,
  // 그때 닫으면 브라우저가 초점을 창을 연 버튼으로 돌려주지 못한다(초점이 문서 맨 앞으로 간다).
  // useLayoutEffect의 정리 함수는 빠지기 전에 돈다.
  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    // 개발 모드(StrictMode)는 effect를 두 번 돌린다. 닫지 않고 다시 열면 이미 열린 창이라고 오류를 내는 브라우저가 있다.
    return () => element?.close()
  }, [])

  return (
    <dialog
      ref={dialog}
      className={styles.modal}
      aria-labelledby={titleId}
      // Esc를 누르면 브라우저가 스스로 닫으려 한다. 그 기본 동작을 막고 닫기 요청만 알린다.
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      // 브라우저는 막은 Esc를 한 번만 들어준다. 클릭 없이 Esc를 또 누르면 막지 못하고 창이 닫힌다(Chrome).
      // 그런데도 이 부품이 아직 그려져 있으면 부르는 쪽이 닫지 않기로 한 것이라, 다시 연다.
      // 닫힌 채로 두면 화면은 창이 떠 있다고 알고 있는데 보이는 것이 없다.
      // 이 부품이 사라진 뒤에는 React가 이 함수를 부르지 않아서, 사라지며 닫힌 창을 다시 여는 일은 없다.
      onClose={(event) => {
        if (!event.currentTarget.open) event.currentTarget.showModal()
      }}
    >
      <header className={styles.header}>
        <h2 id={titleId}>{title}</h2>
        <button type="button" className={styles.close} aria-label="닫기" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className={styles.body}>{children}</div>
    </dialog>
  )
}
