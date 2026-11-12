import { fireEvent, render, screen, within } from '@testing-library/react'
import { PhotoCanvas, type CanvasPin } from './PhotoCanvas.tsx'

const asset = { id: 'b11c0462-6cc9-467c-98af-bd92cae7d7b4', width: 1440, height: 900 }
const pins: CanvasPin[] = [
  { id: 'issue-14', number: 14, title: '제목', xRatio: 0.25, yRatio: 0.5 },
  { id: 'issue-15', number: 15, title: '왼쪽 위', xRatio: 0, yRatio: 0 },
  { id: 'issue-16', number: 16, title: '오른쪽 아래', xRatio: 1, yRatio: 1 },
]
const baseProps = { caption: '2차 · 상품 상세 · PC', asset, alt: '상품 상세 PC 화면', pins }
const photoBox = new DOMRect(100, 50, 400, 200)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PhotoCanvas', () => {
  it('사진의 주소·원본 크기·대체 글과 caption을 보여 준다', () => {
    render(<PhotoCanvas {...baseProps} onSelectPin={vi.fn()} />)

    const photo = screen.getByRole('img', { name: baseProps.alt })

    expect(photo.getAttribute('src')).toBe(`/api/assets/${asset.id}`)
    expect(photo.getAttribute('width')).toBe('1440')
    expect(photo.getAttribute('height')).toBe('900')
    expect(photo.getAttribute('alt')).toBe(baseProps.alt)
    expect(screen.getByText(baseProps.caption)).toBeTruthy()
  })

  it.each([
    ['쪽지 #14 제목', '14', '25%', '50%'],
    ['쪽지 #15 왼쪽 위', '15', '0%', '0%'],
    ['쪽지 #16 오른쪽 아래', '16', '100%', '100%'],
  ])('%s는 번호 %s 버튼이고 left %s·top %s에 놓인다', (name, number, left, top) => {
    render(<PhotoCanvas {...baseProps} onSelectPin={vi.fn()} />)

    const pin = screen.getByRole('button', { name })

    expect(pin.textContent).toBe(number)
    expect(pin.getAttribute('type')).toBe('button')
    expect(pin.style.left).toBe(left)
    expect(pin.style.top).toBe(top)
  })

  it.each([true, false])('새 핀 허용이 %s여도 기존 핀을 누르면 그 쪽지만 고른다', (placeable) => {
    const onSelectPin = vi.fn()
    const onPlacePin = vi.fn()
    render(<PhotoCanvas {...baseProps} onSelectPin={onSelectPin} onPlacePin={placeable ? onPlacePin : undefined} />)
    vi.spyOn(screen.getByRole('img', { name: baseProps.alt }), 'getBoundingClientRect').mockReturnValue(photoBox)

    fireEvent.click(screen.getByRole('button', { name: '쪽지 #14 제목' }), { clientX: 200, clientY: 100 })

    expect(onSelectPin).toHaveBeenCalledExactlyOnceWith('issue-14')
    expect(onPlacePin).not.toHaveBeenCalled()
  })

  it('selectedPinId와 같은 핀만 선택되고 선택을 바꾸거나 없애면 표시도 바뀐다', () => {
    const onSelectPin = vi.fn()
    const { rerender } = render(<PhotoCanvas {...baseProps} selectedPinId="issue-14" onSelectPin={onSelectPin} />)

    expect(screen.getAllByRole('button', { pressed: true })).toEqual([
      screen.getByRole('button', { name: '쪽지 #14 제목' }),
    ])
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(2)

    rerender(<PhotoCanvas {...baseProps} selectedPinId="issue-16" onSelectPin={onSelectPin} />)

    expect(screen.getAllByRole('button', { pressed: true })).toEqual([
      screen.getByRole('button', { name: '쪽지 #16 오른쪽 아래' }),
    ])
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(2)

    rerender(<PhotoCanvas {...baseProps} onSelectPin={onSelectPin} />)

    expect(screen.queryByRole('button', { pressed: true })).toBeNull()
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(3)
  })

  it('목록에 없는 selectedPinId는 어느 핀도 선택하지 않는다', () => {
    render(<PhotoCanvas {...baseProps} selectedPinId="missing-issue" onSelectPin={vi.fn()} />)

    expect(screen.queryByRole('button', { pressed: true })).toBeNull()
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(3)
  })

  it.each([
    ['사진 안', 200, 100, 0.25, 0.25],
    ['왼쪽 위 경계', 100, 50, 0, 0],
    ['오른쪽 아래 경계', 500, 250, 1, 1],
    ['왼쪽 위 밖', 0, 0, 0, 0],
    ['오른쪽 아래 밖', 600, 300, 1, 1],
    ['왼쪽 밖과 세로 안', 0, 100, 0, 0.25],
    ['오른쪽 밖과 세로 안', 600, 100, 1, 0.25],
    ['가로 안과 위쪽 밖', 200, 0, 0.25, 0],
    ['가로 안과 아래쪽 밖', 200, 300, 0.25, 1],
  ])('%s를 누르면 사진 기준 비율을 알리고 각 축을 0~1로 자른다', (_label, clientX, clientY, xRatio, yRatio) => {
    const onPlacePin = vi.fn()
    const onSelectPin = vi.fn()
    render(<PhotoCanvas {...baseProps} onSelectPin={onSelectPin} onPlacePin={onPlacePin} />)
    const photo = screen.getByRole('img', { name: baseProps.alt })
    vi.spyOn(photo, 'getBoundingClientRect').mockReturnValue(photoBox)

    fireEvent.click(photo, { clientX, clientY })

    expect(photo.getAttribute('data-placeable')).toBe('true')
    expect(onPlacePin).toHaveBeenCalledExactlyOnceWith({ xRatio, yRatio })
    expect(onSelectPin).not.toHaveBeenCalled()
  })

  it('표시 크기가 바뀌어도 원본 크기 대신 현재 사진 크기로 클릭 비율을 계산한다', () => {
    const onPlacePin = vi.fn()
    render(<PhotoCanvas {...baseProps} onSelectPin={vi.fn()} onPlacePin={onPlacePin} />)
    const photo = screen.getByRole('img', { name: baseProps.alt })
    const measurePhoto = vi.spyOn(photo, 'getBoundingClientRect').mockReturnValue(photoBox)

    fireEvent.click(photo, { clientX: 200, clientY: 150 })
    measurePhoto.mockReturnValue(new DOMRect(20, 10, 200, 100))
    fireEvent.click(photo, { clientX: 70, clientY: 60 })

    expect(onPlacePin).toHaveBeenCalledTimes(2)
    expect(onPlacePin).toHaveBeenNthCalledWith(1, { xRatio: 0.25, yRatio: 0.5 })
    expect(onPlacePin).toHaveBeenNthCalledWith(2, { xRatio: 0.25, yRatio: 0.5 })
    expect(screen.getByRole('button', { name: '쪽지 #14 제목' }).style.left).toBe('25%')
    expect(screen.getByRole('button', { name: '쪽지 #14 제목' }).style.top).toBe('50%')
  })

  it('onPlacePin이 없으면 읽기 전용이고 사진을 눌러도 쪽지를 고르지 않는다', () => {
    const onSelectPin = vi.fn()
    render(<PhotoCanvas {...baseProps} onSelectPin={onSelectPin} />)
    const photo = screen.getByRole('img', { name: baseProps.alt })
    vi.spyOn(photo, 'getBoundingClientRect').mockReturnValue(photoBox)

    fireEvent.click(photo, { clientX: 200, clientY: 100 })

    expect(photo.getAttribute('data-placeable')).toBe('false')
    expect(onSelectPin).not.toHaveBeenCalled()
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
  })

  it('새 핀 허용을 없애면 이전 onPlacePin도 더 이상 부르지 않는다', () => {
    const onSelectPin = vi.fn()
    const onPlacePin = vi.fn()
    const { rerender } = render(<PhotoCanvas {...baseProps} onSelectPin={onSelectPin} onPlacePin={onPlacePin} />)
    const photo = screen.getByRole('img', { name: baseProps.alt })
    vi.spyOn(photo, 'getBoundingClientRect').mockReturnValue(photoBox)

    fireEvent.click(photo, { clientX: 200, clientY: 100 })
    rerender(<PhotoCanvas {...baseProps} onSelectPin={onSelectPin} />)
    fireEvent.click(photo, { clientX: 300, clientY: 150 })

    expect(photo.getAttribute('data-placeable')).toBe('false')
    expect(onPlacePin).toHaveBeenCalledExactlyOnceWith({ xRatio: 0.25, yRatio: 0.25 })
    expect(onSelectPin).not.toHaveBeenCalled()
  })

  it.each([
    [0, 200],
    [400, 0],
    [0, 0],
  ])('표시 크기가 %s × %s이면 새 핀 위치를 알리지 않는다', (width, height) => {
    const onPlacePin = vi.fn()
    render(<PhotoCanvas {...baseProps} onSelectPin={vi.fn()} onPlacePin={onPlacePin} />)
    const photo = screen.getByRole('img', { name: baseProps.alt })
    vi.spyOn(photo, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, width, height))

    fireEvent.click(photo, { clientX: 200, clientY: 100 })

    expect(onPlacePin).not.toHaveBeenCalled()
  })

  it.each([
    [0.25, 0.5, '25%', '50%'],
    [0, 1, '0%', '100%'],
  ])('임시 핀 (%s, %s)은 퍼센트 위치에 표시되고 버튼이 아니다', (xRatio, yRatio, left, top) => {
    const onSelectPin = vi.fn()
    const onPlacePin = vi.fn()
    render(
      <PhotoCanvas
        {...baseProps}
        pins={[]}
        draftPin={{ xRatio, yRatio }}
        onSelectPin={onSelectPin}
        onPlacePin={onPlacePin}
      />,
    )
    const draft = screen.getByRole('img', { name: '새 쪽지 위치' })

    expect(draft.style.left).toBe(left)
    expect(draft.style.top).toBe(top)
    expect(draft.tagName).not.toBe('BUTTON')
    expect(screen.queryByRole('button')).toBeNull()
    fireEvent.click(draft)
    expect(onSelectPin).not.toHaveBeenCalled()
    expect(onPlacePin).not.toHaveBeenCalled()
  })

  it('임시 핀을 옮기면 새 위치에 하나만 보이고 없애면 표시가 사라진다', () => {
    const onSelectPin = vi.fn()
    const { rerender } = render(
      <PhotoCanvas {...baseProps} draftPin={{ xRatio: 0.25, yRatio: 0.5 }} onSelectPin={onSelectPin} />,
    )

    rerender(<PhotoCanvas {...baseProps} draftPin={{ xRatio: 1, yRatio: 0 }} onSelectPin={onSelectPin} />)

    expect(screen.getAllByRole('img', { name: '새 쪽지 위치' })).toHaveLength(1)
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('100%')
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('0%')

    rerender(<PhotoCanvas {...baseProps} onSelectPin={onSelectPin} />)

    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('notice가 있을 때만 안내 문단을 보여 준다', () => {
    const notice = '이 쪽지는 초안에 남긴 요청이에요. 처음 사진의 위치를 보여 드려요.'
    const onSelectPin = vi.fn()
    const { container, rerender } = render(<PhotoCanvas {...baseProps} notice={notice} onSelectPin={onSelectPin} />)

    expect(screen.getByText(notice).tagName).toBe('P')
    expect(container.querySelectorAll('p')).toHaveLength(2)

    rerender(<PhotoCanvas {...baseProps} onSelectPin={onSelectPin} />)

    expect(screen.queryByText(notice)).toBeNull()
    expect(container.querySelectorAll('p')).toHaveLength(1)
    expect(screen.getByText(baseProps.caption)).toBeTruthy()
  })

  it('핀과 임시 핀이 없으면 버튼과 새 쪽지 위치가 없다', () => {
    render(<PhotoCanvas {...baseProps} pins={[]} onSelectPin={vi.fn()} />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    expect(screen.getByRole('img', { name: baseProps.alt })).toBeTruthy()
  })

  it('쪽지 제목의 HTML은 접근 이름의 글자 그대로 쓰고 태그로 그리지 않는다', () => {
    const title = '<img src=x onerror=alert(1)>'
    render(<PhotoCanvas {...baseProps} pins={[{ ...pins[0], title }]} onSelectPin={vi.fn()} />)

    const pin = screen.getByRole('button', { name: `쪽지 #14 ${title}` })

    expect(pin.textContent).toBe('14')
    expect(within(pin).queryByRole('img')).toBeNull()
    expect(pin.querySelector('img, script')).toBeNull()
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })
})
