import { fireEvent, render, screen } from '@testing-library/react'
import { Button } from './Button.tsx'
import styles from './Button.module.css'

describe('Button', () => {
  it('children의 글자가 버튼 이름으로 보인다', () => {
    render(<Button>로그인</Button>)

    expect(screen.getByRole('button', { name: '로그인' })).toBeDefined()
  })

  it('옵션을 생략하면 type은 button이고 공통 클래스와 primary 클래스가 붙는다', () => {
    render(<Button>로그인</Button>)

    const button = screen.getByRole('button', { name: '로그인' })

    expect(button.getAttribute('type')).toBe('button')
    expect(button.classList.contains(styles.button)).toBe(true)
    expect(button.classList.contains(styles.primary)).toBe(true)
    expect(button.classList.contains(styles.secondary)).toBe(false)
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  it('secondary에는 공통 클래스와 secondary 클래스가 붙고 primary 클래스는 없다', () => {
    render(<Button variant="secondary">로그아웃</Button>)

    const button = screen.getByRole('button', { name: '로그아웃' })

    expect(button.classList.contains(styles.button)).toBe(true)
    expect(button.classList.contains(styles.secondary)).toBe(true)
    expect(button.classList.contains(styles.primary)).toBe(false)
  })

  it('type을 submit으로 지정하면 제출 버튼이 된다', () => {
    render(<Button type="submit">로그인</Button>)

    expect(screen.getByRole('button', { name: '로그인' }).getAttribute('type')).toBe('submit')
  })

  it('버튼을 한 번 누르면 onClick이 한 번 불린다', () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>로그인</Button>)

    fireEvent.click(screen.getByRole('button', { name: '로그인' }))

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('disabled이면 버튼이 비활성화되고 눌러도 onClick이 불리지 않는다', () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        로그인
      </Button>,
    )

    const button = screen.getByRole('button', { name: '로그인' })

    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('폼 안에서 기본 버튼을 눌러도 폼이 제출되지 않는다', () => {
    const onSubmit = vi.fn((event) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button>코드 다시 받기</Button>
      </form>,
    )

    fireEvent.click(screen.getByRole('button', { name: '코드 다시 받기' }))

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('폼 안에서 submit 버튼을 누르면 폼이 한 번 제출된다', () => {
    const onSubmit = vi.fn((event) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit">로그인</Button>
      </form>,
    )

    fireEvent.click(screen.getByRole('button', { name: '로그인' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('disabled인 submit 버튼을 눌러도 폼이 제출되지 않는다', () => {
    const onSubmit = vi.fn((event) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" disabled>
          로그인
        </Button>
      </form>,
    )

    fireEvent.click(screen.getByRole('button', { name: '로그인' }))

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('disabled를 false로 바꾸면 다시 누를 수 있다', () => {
    const onClick = vi.fn()
    const { rerender } = render(
      <Button disabled onClick={onClick}>
        로그인
      </Button>,
    )

    fireEvent.click(screen.getByRole('button', { name: '로그인' }))
    expect(onClick).not.toHaveBeenCalled()

    rerender(
      <Button disabled={false} onClick={onClick}>
        로그인
      </Button>,
    )

    const button = screen.getByRole('button', { name: '로그인' })

    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
