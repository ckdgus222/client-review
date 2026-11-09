import { PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import sharp from 'sharp';

const MAX_PIXELS = 40_000_000;
const MAX_SIDE = 20_000;

// 브라우저가 알려 준 형식은 믿지 않고, sharp가 파일 내용으로 알아낸 형식만 받는다.
const FORMATS = {
  png: { mime: 'image/png', extension: 'png' },
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  webp: { mime: 'image/webp', extension: 'webp' },
} as const;

type Format = keyof typeof FORMATS;

export type ProcessedImage = {
  data: Buffer;
  mime: string;
  extension: string;
  width: number;
  height: number;
  bytes: number;
};

const isFormat = (format: string): format is Format => Object.hasOwn(FORMATS, format);

const unsupported = () => new UnsupportedMediaTypeException('PNG, JPEG, WebP 사진만 올릴 수 있어요');

// sharp는 움직이는 PNG(APNG)의 첫 장만 읽고 여러 장이라고 알려 주지 않는다.
// APNG는 첫 그림 데이터(IDAT) 앞에 움직임 정보(acTL) 덩어리가 있으므로 그것을 직접 찾는다.
const isAnimatedPng = (input: Buffer) => {
  let offset = 8; // PNG 서명 8바이트 뒤부터 덩어리가 이어진다.
  while (offset + 8 <= input.length) {
    const type = input.toString('latin1', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    offset += 12 + input.readUInt32BE(offset); // 길이 4 + 종류 4 + 내용 + CRC 4
  }
  return false;
};

export const processImage = async (input: Buffer): Promise<ProcessedImage> => {
  // sharp는 빈 Buffer를 받으면 Promise를 만들기 전에 바로 던져서 아래 catch가 잡지 못한다.
  if (input.length === 0) throw unsupported();

  // 머리 정보만 읽으므로 픽셀 제한을 끈다. 켜 두면 큰 사진이 413이 아니라 읽기 실패로 끝난다.
  const metadata = await sharp(input, { limitInputPixels: false })
    .metadata()
    .catch(() => {
      throw unsupported();
    });
  if (!isFormat(metadata.format)) throw unsupported();
  if ((metadata.pages ?? 1) > 1 || (metadata.format === 'png' && isAnimatedPng(input))) {
    throw new UnsupportedMediaTypeException('움직이는 사진은 올릴 수 없어요');
  }
  if (metadata.width * metadata.height > MAX_PIXELS || Math.max(metadata.width, metadata.height) > MAX_SIDE) {
    throw new PayloadTooLargeException('사진이 너무 커요');
  }

  // sharp는 따로 요청하지 않으면 촬영 위치 같은 메타데이터를 남기지 않는다.
  const { data, info } = await sharp(input)
    .autoOrient()
    .toFormat(metadata.format)
    .timeout({ seconds: 10 })
    .toBuffer({ resolveWithObject: true })
    .catch(() => {
      throw new UnsupportedMediaTypeException('사진을 처리하지 못했어요');
    });

  return { data, ...FORMATS[metadata.format], width: info.width, height: info.height, bytes: data.length };
};
