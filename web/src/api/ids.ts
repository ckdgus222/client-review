// 주소에서 온 id라 '.'이나 '..'도 올 수 있다. encodeURIComponent가 이 둘은 감싸지 않아서 다른 API를 부를 수 있으므로,
// 화면은 UUID 모양이 아니면 서버를 부르기 전에 없는 것으로 본다.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (value: string) => UUID_PATTERN.test(value)
