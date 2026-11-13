import { StrictMode, useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Modal } from './Modal.tsx'

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
const showModal = vi.fn<() => void>()
const close = vi.fn<() => void>()

beforeEach(() => {
  showModal.mockReset()
  close.mockReset()
  // contexts에는 메서드를 부른 dialog가 들어 있다. 화살표 함수에서도 그 창의 open을 바꾼다.
  showModal.mockImplementation(() => {
    const dialog = showModal.mock.contexts.at(-1) as HTMLDialogElement
    if (dialog.open) throw new DOMException('이미 열린 창이에요', 'InvalidStateError')
    dialog.open = true
  })
  close.mockImplementation(() => {
    const dialog = close.mock.contexts.at(-1) as HTMLDialogElement
    dialog.open = false
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    writable: true,
    value: showModal,
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    writable: true,
    value: close,
  })
})

afterEach(() => {
  // unmount의 close까지 가짜 메서드를 쓴 뒤 원래 속성(없었다면 없음)으로 돌린다.
  cleanup()
  for (const [name, descriptor] of [
    ['showModal', originalShowModal],
    ['close', originalClose],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
      continue
    }
    Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  }
})

describe('Modal', () => {
  it('그려지면 dialog의 showModal을 한 번 불러 연다', () => {
    const onClose = vi.fn()
    render(
      <Modal title="승인 검토" onClose={onClose}>
        내용
      </Modal>,
    )

    const dialog = screen.getByRole<HTMLDialogElement>('dialog', { name: '승인 검토' })

    expect(dialog.tagName).toBe('DIALOG')
    expect(dialog.open).toBe(true)
    expect(showModal).toHaveBeenCalledTimes(1)
    expect(showModal.mock.contexts[0]).toBe(dialog)
    expect(close).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('제목이 h2이고 aria-labelledby로 창의 이름이 된다', () => {
    render(
      <Modal title="2차 승인 검토" onClose={vi.fn()}>
        내용
      </Modal>,
    )

    const dialog = screen.getByRole('dialog', { name: '2차 승인 검토' })
    const title = within(dialog).getByRole('heading', { level: 2, name: '2차 승인 검토' })

    expect(title.tagName).toBe('H2')
    expect(title.id).not.toBe('')
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
    expect(document.getElementById(title.id)).toBe(title)
  })

  it('넘긴 children을 창 안에 그리고 내용의 버튼도 동작한다', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(
      <Modal title="승인 검토" onClose={onClose}>
        <p>이번 차수에 달린 댓글이 없어요</p>
        <button onClick={onConfirm}>승인하기</button>
      </Modal>,
    )

    const dialog = screen.getByRole('dialog', { name: '승인 검토' })
    expect(within(dialog).getByText('이번 차수에 달린 댓글이 없어요')).toBeDefined()
    fireEvent.click(within(dialog).getByRole('button', { name: '승인하기' }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('× 버튼은 닫기라는 이름으로 닫기 요청만 한 번 알리고 스스로 닫지 않는다', () => {
    const onClose = vi.fn()
    render(
      <Modal title="승인 검토" onClose={onClose}>
        내용
      </Modal>,
    )

    const dialog = screen.getByRole<HTMLDialogElement>('dialog')
    const button = within(dialog).getByRole('button', { name: '닫기' })
    expect(button.textContent).toBe('×')
    fireEvent.click(button)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)
    expect(showModal).toHaveBeenCalledTimes(1)
  })

  it('cancel 사건은 기본 닫힘을 막고 닫기 요청만 한 번 알린다', () => {
    const onClose = vi.fn()
    render(
      <Modal title="승인 검토" onClose={onClose}>
        내용
      </Modal>,
    )

    const dialog = screen.getByRole<HTMLDialogElement>('dialog')
    const cancel = new Event('cancel', { cancelable: true })
    fireEvent(dialog, cancel)

    expect(cancel.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)
    expect(showModal).toHaveBeenCalledTimes(1)
  })

  it('부모가 닫지 않으면 cancel 사건이 반복돼도 매번 기본 닫힘을 막는다', () => {
    const onClose = vi.fn()
    render(
      <Modal title="승인 검토" onClose={onClose}>
        내용
      </Modal>,
    )
    const dialog = screen.getByRole<HTMLDialogElement>('dialog')

    for (let count = 1; count <= 2; count += 1) {
      const cancel = new Event('cancel', { cancelable: true })
      fireEvent(dialog, cancel)

      expect(cancel.defaultPrevented).toBe(true)
      expect(onClose).toHaveBeenCalledTimes(count)
      expect(dialog.open).toBe(true)
    }
    expect(close).not.toHaveBeenCalled()
  })

  it('부품이 사라지면 열었던 창의 close를 한 번 부른다', () => {
    const onClose = vi.fn()
    const { unmount } = render(
      <Modal title="승인 검토" onClose={onClose}>
        내용
      </Modal>,
    )
    const dialog = screen.getByRole<HTMLDialogElement>('dialog')

    unmount()

    expect(close).toHaveBeenCalledTimes(1)
    expect(close.mock.contexts[0]).toBe(dialog)
    expect(dialog.open).toBe(false)
    expect(dialog.isConnected).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('브라우저가 닫아 close 사건이 오면 남아 있는 창을 다시 연다', () => {
    const onClose = vi.fn()
    render(
      <Modal title="승인 검토" onClose={onClose}>
        내용
      </Modal>,
    )
    const dialog = screen.getByRole<HTMLDialogElement>('dialog')

    dialog.open = false
    fireEvent(dialog, new Event('close'))

    expect(dialog.open).toBe(true)
    expect(showModal).toHaveBeenCalledTimes(2)
    expect(showModal.mock.contexts[1]).toBe(dialog)
    expect(onClose).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('이미 열린 창에 close 사건이 와도 showModal을 다시 부르지 않는다', () => {
    const onClose = vi.fn()
    render(
      <Modal title="승인 검토" onClose={onClose}>
        내용
      </Modal>,
    )
    const dialog = screen.getByRole<HTMLDialogElement>('dialog')

    fireEvent(dialog, new Event('close'))

    expect(showModal).toHaveBeenCalledTimes(1)
    expect(dialog.open).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('StrictMode에서도 이미 열린 창을 다시 여는 오류 없이 열린 상태를 유지한다', () => {
    const onClose = vi.fn()
    render(
      <StrictMode>
        <Modal title="승인 검토" onClose={onClose}>
          내용
        </Modal>
      </StrictMode>,
    )

    expect(screen.getByRole<HTMLDialogElement>('dialog', { name: '승인 검토' }).open).toBe(true)
    expect(showModal.mock.results.every((result) => result.type === 'return')).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('창 바깥에 해당하는 dialog 자체를 눌러도 닫기 요청을 하지 않는다', () => {
    const onClose = vi.fn()
    render(
      <Modal title="승인 검토" onClose={onClose}>
        내용
      </Modal>,
    )
    const dialog = screen.getByRole<HTMLDialogElement>('dialog')

    fireEvent.click(dialog)

    expect(onClose).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)
  })

  it('제목과 내용이 바뀌면 열린 창에 반영하고 창을 닫았다 다시 열지 않는다', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <Modal title="승인 검토" onClose={onClose}>
        검토 목록
      </Modal>,
    )
    const dialog = screen.getByRole<HTMLDialogElement>('dialog')

    rerender(
      <Modal title="승인 완료" onClose={onClose}>
        2차가 승인됐어요
      </Modal>,
    )

    expect(screen.getByRole('dialog', { name: '승인 완료' })).toBe(dialog)
    expect(within(dialog).getByRole('heading', { level: 2, name: '승인 완료' })).toBeDefined()
    expect(within(dialog).getByText('2차가 승인됐어요')).toBeDefined()
    expect(screen.queryByText('검토 목록')).toBeNull()
    expect(dialog.open).toBe(true)
    expect(showModal).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it.each(['×', 'cancel'])('닫기 함수가 바뀌면 %s는 새 함수만 부른다', (request) => {
    const previousOnClose = vi.fn()
    const nextOnClose = vi.fn()
    const { rerender } = render(
      <Modal title="승인 검토" onClose={previousOnClose}>
        내용
      </Modal>,
    )

    rerender(
      <Modal title="승인 검토" onClose={nextOnClose}>
        내용
      </Modal>,
    )
    if (request === '×') fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    if (request === 'cancel') fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))

    expect(previousOnClose).not.toHaveBeenCalled()
    expect(nextOnClose).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    expect(showModal).toHaveBeenCalledTimes(1)
  })

  it.each(['×', 'cancel'])('%s 요청을 받은 부모가 부품을 없애면 창이 닫힌다', (request) => {
    const Parent = () => {
      const [isOpen, setIsOpen] = useState(true)
      if (!isOpen) return null
      return (
        <Modal title="승인 검토" onClose={() => setIsOpen(false)}>
          내용
        </Modal>
      )
    }
    render(<Parent />)
    const dialog = screen.getByRole<HTMLDialogElement>('dialog')

    if (request === '×') fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    if (request === 'cancel') fireEvent(dialog, new Event('cancel', { cancelable: true }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(dialog.open).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
    expect(showModal).toHaveBeenCalledTimes(1)
  })

  it('폼 안에서 ×를 눌러도 폼을 제출하지 않는다', () => {
    const onClose = vi.fn()
    const onSubmit = vi.fn()
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <Modal title="승인 검토" onClose={onClose}>
          내용
        </Modal>
      </form>,
    )

    fireEvent.click(screen.getByRole('button', { name: '닫기' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
