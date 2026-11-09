import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { processImage } from './image.js';

const createImage = (width = 32, height = 16) =>
  sharp({ create: { width, height, channels: 3, background: '#e02040' } });

// PNG 덩어리의 CRC는 종류와 내용에 대해 계산한다. 길이와 CRC 자체는 제외한다.
const createPngChunk = (type: string, data: Buffer) => {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
};

describe('processImage', () => {
  it.each([
    { format: 'png', mime: 'image/png', extension: 'png' },
    { format: 'jpeg', mime: 'image/jpeg', extension: 'jpg' },
    { format: 'webp', mime: 'image/webp', extension: 'webp' },
  ] as const)(
    '$format을 같은 형식으로 다시 저장하고 크기와 메타데이터를 정리한다',
    async ({ format, mime, extension }) => {
      const input = await createImage()
        .withMetadata()
        .withExif({ IFD0: { Artist: 'test photographer' } })
        .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">test metadata</x:xmpmeta>')
        .toFormat(format)
        .toBuffer();
      const before = await sharp(input).metadata();
      expect(before.exif).toBeDefined();
      expect(before.icc).toBeDefined();
      expect(before.xmp).toBeDefined();

      const result = await processImage(input);

      expect(Buffer.isBuffer(result.data)).toBe(true);
      expect(result).toEqual({
        data: expect.any(Buffer),
        mime,
        extension,
        width: 32,
        height: 16,
        bytes: result.data.length,
      });
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.data.equals(input)).toBe(false);
      const after = await sharp(result.data).metadata();
      expect(after).toMatchObject({ format, width: 32, height: 16 });
      expect(after.orientation).toBeUndefined();
      expect(after.exif).toBeUndefined();
      expect(after.icc).toBeUndefined();
      expect(after.xmp).toBeUndefined();
      expect(after.iptc).toBeUndefined();
      const decoded = await sharp(result.data).raw().toBuffer({ resolveWithObject: true });
      expect(decoded.info).toMatchObject({ width: 32, height: 16 });
    },
  );

  it.each([
    { name: 'empty.png', data: Buffer.alloc(0) },
    { name: 'notes.txt', data: Buffer.from('This is a text file.') },
    { name: 'fake.png', data: Buffer.from('This is not a PNG image.') },
    { name: 'signature-only.png', data: Buffer.from('89504e470d0a1a0a', 'hex') },
    {
      name: 'drawing.svg',
      data: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
      ),
    },
  ])('$name의 실제 내용이 허용된 사진이 아니면 415로 거부한다', async ({ data }) => {
    // 이 함수는 이름이나 브라우저의 MIME을 받지 않고 파일 내용만 받는다.
    await expect(processImage(data)).rejects.toMatchObject({ status: 415 });
  });

  it.each(['gif', 'tiff'] as const)(
    '읽을 수 있는 정지 %s 사진도 허용하지 않은 형식이면 415로 거부한다',
    async (format) => {
      const input = await createImage().toFormat(format).toBuffer();
      expect((await sharp(input).metadata()).format).toBe(format);

      await expect(processImage(input)).rejects.toMatchObject({ status: 415 });
    },
  );

  it('서로 다른 두 프레임이 있는 움직이는 WebP는 415로 거부한다', async () => {
    const red = Buffer.alloc(16 * 16 * 3, Buffer.from([255, 0, 0]));
    const blue = Buffer.alloc(16 * 16 * 3, Buffer.from([0, 0, 255]));
    const input = await sharp(Buffer.concat([red, blue]), {
      raw: { width: 16, height: 32, channels: 3, pageHeight: 16 },
    })
      .webp({ delay: [100, 100], loop: 0 })
      .toBuffer();
    expect(await sharp(input, { animated: true }).metadata()).toMatchObject({
      format: 'webp',
      pages: 2,
      pageHeight: 16,
    });

    await expect(processImage(input)).rejects.toMatchObject({ status: 415 });
  });

  it('IHDR 뒤와 IDAT 앞에 acTL이 있는 APNG는 415로 거부한다', async () => {
    const png = await createImage().png().toBuffer();
    const animation = Buffer.alloc(8);
    animation.writeUInt32BE(2, 0);
    const text = createPngChunk('tEXt', Buffer.from('Comment\0animation fixture'));
    const animationChunk = createPngChunk('acTL', animation);
    const afterHeader = 8 + 12 + png.readUInt32BE(8);
    const input = Buffer.concat([png.subarray(0, afterHeader), text, animationChunk, png.subarray(afterHeader)]);
    // sharp가 머리를 정상 PNG로 읽더라도 별도의 APNG 검사가 거부해야 한다.
    expect(await sharp(input).metadata()).toMatchObject({ format: 'png', width: 32, height: 16 });
    await expect(sharp(input).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);

    await expect(processImage(input)).rejects.toMatchObject({ status: 415 });
  });

  it('acTL이 IDAT 뒤에만 있으면 정지 PNG로 받는다', async () => {
    const png = await createImage().png().toBuffer();
    const animation = Buffer.alloc(8);
    animation.writeUInt32BE(2, 0);
    const input = Buffer.concat([png.subarray(0, -12), createPngChunk('acTL', animation), png.subarray(-12)]);

    const result = await processImage(input);

    expect(result).toMatchObject({ mime: 'image/png', extension: 'png', width: 32, height: 16 });
    expect(await sharp(result.data).metadata()).toMatchObject({ format: 'png', width: 32, height: 16 });
  });

  it('PNG 설명 안의 acTL 글자는 움직임 정보로 오인하지 않는다', async () => {
    const png = await createImage().png().toBuffer();
    const afterHeader = 8 + 12 + png.readUInt32BE(8);
    const text = createPngChunk('tEXt', Buffer.from('Comment\0acTL'));
    const input = Buffer.concat([png.subarray(0, afterHeader), text, png.subarray(afterHeader)]);

    const result = await processImage(input);

    expect(result).toMatchObject({ mime: 'image/png', width: 32, height: 16 });
    expect(await sharp(result.data).metadata()).toMatchObject({ format: 'png', width: 32, height: 16 });
  });

  it.each([
    { width: 6400, height: 6400 },
    { width: 8000, height: 5001 },
    { width: 20001, height: 1 },
    { width: 1, height: 20001 },
  ])('$width × $height 사진이 픽셀 수나 긴 변 제한을 넘으면 413으로 거부한다', async ({ width, height }) => {
    const input = await createImage(width, height).png().toBuffer();

    await expect(processImage(input)).rejects.toMatchObject({ status: 413 });
  });

  it.each([
    { width: 1, height: 1 },
    { width: 20000, height: 1 },
    { width: 1, height: 20000 },
    { width: 8000, height: 5000 },
  ])('$width × $height 사진은 경계값을 포함해 허용한다', async ({ width, height }) => {
    const input = await createImage(width, height).png().toBuffer();

    const result = await processImage(input);

    expect(result).toMatchObject({ mime: 'image/png', width, height, bytes: result.data.length });
    expect(await sharp(result.data).metadata()).toMatchObject({ format: 'png', width, height });
  });

  it('EXIF orientation 6인 JPEG를 시계 방향으로 세우고 회전 정보와 EXIF를 지운다', async () => {
    const blue = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#0000ff' } })
      .png()
      .toBuffer();
    const input = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#ff0000' } })
      .composite([{ input: blue, left: 40, top: 0 }])
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    expect(await sharp(input).metadata()).toMatchObject({
      width: 80,
      height: 40,
      orientation: 6,
      exif: expect.any(Buffer),
    });

    const result = await processImage(input);

    expect(result).toMatchObject({
      mime: 'image/jpeg',
      extension: 'jpg',
      width: 40,
      height: 80,
      bytes: result.data.length,
    });
    const metadata = await sharp(result.data).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 40, height: 80 });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    // 크기만 바꾼 것이 아니라, 왼쪽의 빨강이 위로, 오른쪽의 파랑이 아래로 이동해야 한다.
    const top = await sharp(result.data).extract({ left: 20, top: 20, width: 1, height: 1 }).raw().toBuffer();
    const bottom = await sharp(result.data).extract({ left: 20, top: 60, width: 1, height: 1 }).raw().toBuffer();
    expect(top[0]).toBeGreaterThan(200);
    expect(top[2]).toBeLessThan(40);
    expect(bottom[0]).toBeLessThan(40);
    expect(bottom[2]).toBeGreaterThan(200);
  });

  it('PNG 머리는 읽히지만 그림 데이터가 잘려 처리에 실패하면 415로 거부한다', async () => {
    const png = await createImage().png().toBuffer();
    const idatType = png.indexOf(Buffer.from('IDAT'));
    expect(idatType).toBeGreaterThan(0);
    const input = png.subarray(0, idatType + 4 + Math.floor(png.readUInt32BE(idatType - 4) / 2));
    expect(await sharp(input).metadata()).toMatchObject({ format: 'png', width: 32, height: 16 });
    await expect(sharp(input).raw().toBuffer()).rejects.toThrow();

    await expect(processImage(input)).rejects.toMatchObject({ status: 415 });
  });
});
