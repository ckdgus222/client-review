import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { TextField } from './TextField.tsx'

describe('TextField', () => {
  it('라벨로 입력칸을 찾을 수 있고 부모가 준 값이 보인다', () => {
    render(<TextField label="이메일" value="reader@example.com" onChange={vi.fn()} />)

    const input = screen.getByLabelText<HTMLInputElement>('이메일')
    const label = screen.getByText('이메일')

    expect(input.tagName).toBe('INPUT')
    expect(input.id).not.toBe('')
    expect(label.getAttribute('for')).toBe(input.id)
    expect(input.value).toBe('reader@example.com')
  })

  it.each(['새 이름', '  이름  ', '012345', ''])('입력한 값 %j를 문자열로 한 번 전달한다', (value) => {
    const onChange = vi.fn()
    render(<TextField label="입력" value="기존 글" onChange={onChange} />)

    const input = screen.getByLabelText<HTMLInputElement>('입력')
    fireEvent.change(input, { target: { value } })

    expect(onChange).toHaveBeenCalledExactlyOnceWith(value)
    expect(input.value).toBe('기존 글')
  })

  it('부모가 state로 값을 바꾸면 입력과 지우기가 화면에 반영된다', () => {
    const Parent = () => {
      const [value, setValue] = useState('')
      return <TextField label="이름" value={value} onChange={setValue} />
    }
    render(<Parent />)

    const input = screen.getByLabelText<HTMLInputElement>('이름')
    expect(input.value).toBe('')

    fireEvent.change(input, { target: { value: '새 이름' } })
    expect(input.value).toBe('새 이름')

    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
  })

  it('부모가 value를 바꾸면 새 값이 보이고 onChange는 불리지 않는다', () => {
    const onChange = vi.fn()
    const { rerender } = render(<TextField label="이름" value="이전 이름" onChange={onChange} />)

    rerender(<TextField label="이름" value="새 이름" onChange={onChange} />)

    expect(screen.getByLabelText<HTMLInputElement>('이름').value).toBe('새 이름')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('오류 문구가 보이고 입력칸의 접근성 속성이 그 문구를 가리킨다', () => {
    render(<TextField label="이메일" value="잘못된 주소" onChange={vi.fn()} error="이메일을 확인해 주세요" />)

    const input = screen.getByLabelText('이메일')
    const error = screen.getByText('이메일을 확인해 주세요')

    expect(error.id).not.toBe('')
    expect(error.id).not.toBe(input.id)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
    expect(document.getElementById(error.id)).toBe(error)
  })

  it.each([undefined, ''])('error가 %j이면 오류 문구와 접근성 오류 속성이 없다', (error) => {
    render(<TextField label="이메일" value="" onChange={vi.fn()} error={error} />)

    const input = screen.getByLabelText('이메일')

    expect(screen.queryByRole('paragraph')).toBeNull()
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(input.hasAttribute('aria-describedby')).toBe(false)
  })

  it('옵션을 생략하면 기본 text 입력칸이고 선택 속성이 없다', () => {
    render(<TextField label="이름" value="" onChange={vi.fn()} />)

    const input = screen.getByLabelText<HTMLInputElement>('이름')

    expect(input.type).toBe('text')
    expect(input.hasAttribute('type')).toBe(false)
    expect(input.hasAttribute('autocomplete')).toBe(false)
    expect(input.hasAttribute('inputmode')).toBe(false)
  })

  it.each(['text', 'email'] as const)('type=%s를 입력칸에 전달한다', (type) => {
    render(<TextField label="입력" value="" onChange={vi.fn()} type={type} />)

    expect(screen.getByLabelText('입력').getAttribute('type')).toBe(type)
  })

  it.each(['email', 'one-time-code', 'name'] as const)('autoComplete=%s를 입력칸에 전달한다', (autoComplete) => {
    render(<TextField label="입력" value="" onChange={vi.fn()} autoComplete={autoComplete} />)

    expect(screen.getByLabelText('입력').getAttribute('autocomplete')).toBe(autoComplete)
  })

  it('숫자 자판 옵션을 전달하고 앞자리 0이 있는 입력도 문자열로 유지한다', () => {
    const onChange = vi.fn()
    render(<TextField label="코드" value="000000" onChange={onChange} inputMode="numeric" />)

    const input = screen.getByLabelText<HTMLInputElement>('코드')

    expect(input.getAttribute('inputmode')).toBe('numeric')
    expect(input.value).toBe('000000')
    fireEvent.change(input, { target: { value: '012345' } })
    expect(onChange).toHaveBeenCalledExactlyOnceWith('012345')
  })

  it('두 입력칸의 id가 다르고 각 라벨과 오류 문구가 자기 칸에만 연결된다', () => {
    const { rerender } = render(
      <>
        <TextField label="이메일" value="잘못된 주소" onChange={vi.fn()} error="이메일을 확인해 주세요" />
        <TextField label="이름" value="" onChange={vi.fn()} error="이름을 입력해 주세요" />
      </>,
    )

    const email = screen.getByLabelText<HTMLInputElement>('이메일')
    const name = screen.getByLabelText<HTMLInputElement>('이름')
    const emailError = screen.getByText('이메일을 확인해 주세요')
    const nameError = screen.getByText('이름을 입력해 주세요')

    expect(email.value).toBe('잘못된 주소')
    expect(name.value).toBe('')
    expect(email.id).not.toBe('')
    expect(name.id).not.toBe('')
    expect(emailError.id).not.toBe('')
    expect(nameError.id).not.toBe('')
    expect(new Set([email.id, name.id, emailError.id, nameError.id]).size).toBe(4)
    expect(email.getAttribute('aria-describedby')).toBe(emailError.id)
    expect(name.getAttribute('aria-describedby')).toBe(nameError.id)

    rerender(
      <>
        <TextField label="이메일" value="잘못된 주소" onChange={vi.fn()} error="이메일을 확인해 주세요" />
        <TextField label="이름" value="새 이름" onChange={vi.fn()} />
      </>,
    )

    expect(screen.queryByText('이름을 입력해 주세요')).toBeNull()
    expect(screen.getByLabelText('이름').hasAttribute('aria-invalid')).toBe(false)
    expect(screen.getByLabelText('이름').hasAttribute('aria-describedby')).toBe(false)
    expect(screen.getByLabelText('이메일').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText('이메일').getAttribute('aria-describedby')).toBe(
      screen.getByText('이메일을 확인해 주세요').id,
    )
  })

  it('오류가 생기거나 문구가 바뀌어도 입력값을 지우지 않는다', () => {
    const onChange = vi.fn()
    const { rerender } = render(<TextField label="이메일" value="입력한 주소" onChange={onChange} />)

    rerender(<TextField label="이메일" value="입력한 주소" onChange={onChange} error="이메일을 확인해 주세요" />)

    expect(screen.getByLabelText<HTMLInputElement>('이메일').value).toBe('입력한 주소')
    expect(screen.getByLabelText('이메일').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText('이메일').getAttribute('aria-describedby')).toBe(
      screen.getByText('이메일을 확인해 주세요').id,
    )

    rerender(<TextField label="이메일" value="입력한 주소" onChange={onChange} error="다시 시도해 주세요" />)

    expect(screen.queryByText('이메일을 확인해 주세요')).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>('이메일').value).toBe('입력한 주소')
    expect(screen.getByLabelText('이메일').getAttribute('aria-describedby')).toBe(
      screen.getByText('다시 시도해 주세요').id,
    )
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each([undefined, ''])('오류를 %j로 바꾸면 문구와 접근성 오류 속성이 사라진다', (error) => {
    const onChange = vi.fn()
    const { rerender } = render(
      <TextField label="이메일" value="입력한 주소" onChange={onChange} error="이메일을 확인해 주세요" />,
    )

    expect(screen.getByText('이메일을 확인해 주세요')).toBeDefined()

    rerender(<TextField label="이메일" value="입력한 주소" onChange={onChange} error={error} />)

    const input = screen.getByLabelText<HTMLInputElement>('이메일')

    expect(screen.queryByText('이메일을 확인해 주세요')).toBeNull()
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(input.hasAttribute('aria-describedby')).toBe(false)
    expect(input.value).toBe('입력한 주소')
    expect(onChange).not.toHaveBeenCalled()
  })
})
