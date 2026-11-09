import { isUuid } from './ids.ts'

describe('isUuid', () => {
  it.each(['ebf058f0-dc9e-4a14-adcd-cb2712594e5a', 'EBF058F0-DC9E-4A14-ADCD-CB2712594E5A'])(
    'UUID %s를 받는다',
    (id) => {
      expect(isUuid(id)).toBe(true)
    },
  )

  it.each([
    '',
    'abc',
    '.',
    '..',
    '../auth/me',
    'ebf058f0dc9e4a14adcdcb2712594e5a',
    'gbf058f0-dc9e-4a14-adcd-cb2712594e5a',
    'ebf058f0-dc9e-4a14-adcd-cb2712594e5',
    'ebf058f0-dc9e-4a14-adcd-cb2712594e5aa',
    ' ebf058f0-dc9e-4a14-adcd-cb2712594e5a',
    'ebf058f0-dc9e-4a14-adcd-cb2712594e5a ',
    'ebf058f0-dc9e-4a14-adcd-cb2712594e5a\n',
    'ebf058f0-dc9e-4a14-adcd-cb2712594e5a/path',
    'ebf058f0-dc9e-4a14-adcd-cb2712594e5a?version=1',
  ])('잘못된 id %s를 거절한다', (id) => {
    expect(isUuid(id)).toBe(false)
  })
})
