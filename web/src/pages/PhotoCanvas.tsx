import type { MouseEvent, ReactNode } from 'react'
import { assetUrl } from '../api/versions.ts'
import styles from './PhotoCanvas.module.css'

export type CanvasPin = { id: string; number: number; title: string; xRatio: number; yRatio: number }
export type PinPosition = { xRatio: number; yRatio: number }

type PhotoCanvasProps = {
  caption: ReactNode
  // 사진 위에 띄우는 안내(예: 지난 버전 쪽지의 처음 사진을 보는 중).
  notice?: ReactNode
  asset: { id: string; width: number; height: number }
  alt: string
  pins: CanvasPin[]
  selectedPinId?: string
  // 아직 저장하지 않은 새 쪽지의 자리.
  draftPin?: PinPosition
  onSelectPin: (issueId: string) => void
  // 없으면 사진을 눌러도 아무 일도 없다(읽기 전용, 또는 지난 버전의 처음 사진을 보는 중).
  onPlacePin?: (position: PinPosition) => void
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))

// 핀 위치는 사진을 감싼 상자 기준 퍼센트다. 사진이 화면 폭에 맞춰 줄거나 커져도 같은 자리에 있다.
const pinStyle = ({ xRatio, yRatio }: PinPosition) => ({ left: `${xRatio * 100}%`, top: `${yRatio * 100}%` })

export const PhotoCanvas = ({
  caption,
  notice,
  asset,
  alt,
  pins,
  selectedPinId,
  draftPin,
  onSelectPin,
  onPlacePin,
}: PhotoCanvasProps) => {
  // 누른 자리를 사진의 가로·세로에 대한 비율로 바꾼다. 테두리를 누르면 0~1을 조금 벗어날 수 있어서 자른다.
  const placePin = (event: MouseEvent<HTMLImageElement>) => {
    if (!onPlacePin) return
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return
    onPlacePin({
      xRatio: clamp((event.clientX - box.left) / box.width),
      yRatio: clamp((event.clientY - box.top) / box.height),
    })
  }

  return (
    <div className={styles.canvas}>
      <p className={styles.caption}>{caption}</p>
      {notice && <p className={styles.notice}>{notice}</p>}
      <div className={styles.photo}>
        <div className={styles.frame}>
          <img
            src={assetUrl(asset.id)}
            width={asset.width}
            height={asset.height}
            alt={alt}
            data-placeable={onPlacePin !== undefined}
            onClick={placePin}
          />
          {pins.map((pin) => (
            <button
              key={pin.id}
              type="button"
              className={styles.pin}
              style={pinStyle(pin)}
              aria-pressed={pin.id === selectedPinId}
              aria-label={`쪽지 #${pin.number} ${pin.title}`}
              onClick={() => onSelectPin(pin.id)}
            >
              <span>{pin.number}</span>
            </button>
          ))}
          {draftPin && (
            <span
              className={`${styles.pin} ${styles.draft}`}
              style={pinStyle(draftPin)}
              role="img"
              aria-label="새 쪽지 위치"
            >
              <span>새</span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
