// 개발자는 서버 설정에 적은 이메일 하나다. 값이 비어 있으면 아무도 개발자가 아니다(막힌 쪽으로 남긴다).
// 로그인 이메일은 소문자로 저장되므로 설정 값도 정리해서 비교한다.
export const isDeveloper = (email: string) => {
  const developerEmail = process.env.DEVELOPER_EMAIL?.trim().toLowerCase();
  return Boolean(developerEmail) && email === developerEmail;
};
