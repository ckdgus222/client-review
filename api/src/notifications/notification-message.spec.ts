import { ActivityType } from '../generated/prisma/client.js';
import { buildNotificationMessage, type NotificationEvent } from './notification-message.js';

describe('buildNotificationMessage', () => {
  const appUrl = 'https://review.example.com';
  const event: NotificationEvent = {
    type: ActivityType.VERSION_PUBLISHED,
    createdAt: new Date('2026-11-14T12:34:56.789+09:00'),
    projectId: '10000000-0000-4000-8000-000000000001',
    projectName: '꽃집 홈페이지',
    memberId: '20000000-0000-4000-8000-000000000002',
    version: null,
    issue: null,
  };
  const version = { id: '30000000-0000-4000-8000-000000000003', number: 2 };
  const issue = { id: '40000000-0000-4000-8000-000000000004', number: 17, title: '주문 버튼 색상' };

  it.each([
    { number: 0, label: '초안이' },
    { number: 1, label: '1차가' },
    { number: 12, label: '12차가' },
    { number: null, label: '버전이' },
  ])('버전 번호 $number의 게시 메일은 "$label 올라왔어요"와 해당 버전 링크를 담는다', ({ number, label }) => {
    const message = buildNotificationMessage({ ...event, version: { ...version, number } }, appUrl);

    expect(message.subject).toBe(`[Client Review] 꽃집 홈페이지 ${label} 올라왔어요`);
    expect(message.text).toContain(`"꽃집 홈페이지"에 ${label} 올라왔어요.`);
    expect(message.text.split('\n').at(-1)).toBe(`${appUrl}/app/projects/${event.projectId}?version=${version.id}`);
    expect(message.text).not.toContain('?issue=');
  });

  it.each([
    { number: 0, label: '초안이' },
    { number: 1, label: '1차가' },
    { number: 12, label: '12차가' },
    { number: null, label: '버전이' },
  ])('버전 번호 $number의 승인 메일은 "$label 승인됐어요"와 승인된 버전 링크를 담는다', ({ number, label }) => {
    const message = buildNotificationMessage(
      { ...event, type: ActivityType.VERSION_APPROVED, version: { ...version, number } },
      appUrl,
    );

    expect(message.subject).toBe(`[Client Review] 꽃집 홈페이지 ${label} 승인됐어요`);
    expect(message.text).toContain(`"꽃집 홈페이지"의 ${label} 승인됐어요.`);
    expect(message.text.split('\n').at(-1)).toBe(`${appUrl}/app/projects/${event.projectId}?version=${version.id}`);
    expect(message.text).not.toContain('?issue=');
  });

  it.each([
    { label: '없어도', version: null },
    { label: '있어도', version },
  ])('버전 정보가 $label 고쳤어요 메일은 프로젝트 이름·쪽지 번호·제목과 쪽지 링크를 담는다', ({ version }) => {
    const message = buildNotificationMessage(
      { ...event, type: ActivityType.RESOLUTION_SUBMITTED, version, issue },
      appUrl,
    );

    expect(message.subject).toBe('[Client Review] 꽃집 홈페이지 #17 쪽지를 고쳤어요');
    expect(message.text).toContain('"꽃집 홈페이지"의 #17 "주문 버튼 색상" 쪽지를 고쳤어요.');
    expect(message.text.split('\n').at(-1)).toBe(`${appUrl}/app/projects/${event.projectId}?issue=${issue.id}`);
    expect(message.text).not.toContain('?version=');
  });

  it.each([
    ActivityType.MEMBER_REVOKED,
    ActivityType.INVITATION_ACCEPTED,
    ActivityType.PROJECT_DELETE_REQUESTED,
    ActivityType.PROJECT_RESTORED,
  ])('%s 기록 메일은 사건 시각을 UTC ISO로 바꾸고 복원에 필요한 네 줄만 담는다', (type) => {
    const message = buildNotificationMessage({ ...event, type }, appUrl);

    expect(message).toEqual({
      subject: `[Client Review 기록] ${type}`,
      text: [
        `사건: ${type}`,
        '시각: 2026-11-14T03:34:56.789Z',
        `프로젝트 id: ${event.projectId}`,
        `대상 멤버 id: ${event.memberId}`,
      ].join('\n'),
    });
  });

  it.each([
    ActivityType.MEMBER_REVOKED,
    ActivityType.INVITATION_ACCEPTED,
    ActivityType.PROJECT_DELETE_REQUESTED,
    ActivityType.PROJECT_RESTORED,
  ])('%s 기록 메일의 대상 멤버가 없으면 마지막 줄에 -를 적는다', (type) => {
    const message = buildNotificationMessage({ ...event, type, memberId: null }, appUrl);

    expect(message.text.split('\n')).toEqual([
      `사건: ${type}`,
      '시각: 2026-11-14T03:34:56.789Z',
      `프로젝트 id: ${event.projectId}`,
      '대상 멤버 id: -',
    ]);
  });

  it.each(
    [ActivityType.VERSION_PUBLISHED, ActivityType.RESOLUTION_SUBMITTED, ActivityType.VERSION_APPROVED].flatMap((type) =>
      ['\r', '\n', '\r\n'].map((newline) => ({ type, newline })),
    ),
  )('$type 메일에서 프로젝트 이름과 쪽지 제목의 $newline 줄바꿈을 한 줄로 만든다', ({ type, newline }) => {
    const message = buildNotificationMessage(
      {
        ...event,
        type,
        projectName: `꽃집${newline}홈페이지`,
        version,
        issue: { ...issue, title: `주문 버튼${newline}색상` },
      },
      appUrl,
    );

    expect(message.subject).toContain('[Client Review] 꽃집 홈페이지');
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.text).not.toContain('\r');
    expect(message.text.split('\n')).toHaveLength(2);
    expect(message.text.split('\n')[0]).toContain('"꽃집 홈페이지"');
    if (type === ActivityType.RESOLUTION_SUBMITTED) {
      expect(message.text.split('\n')[0]).toContain('"주문 버튼 색상"');
    }
  });

  it.each([
    ActivityType.VERSION_PUBLISHED,
    ActivityType.RESOLUTION_SUBMITTED,
    ActivityType.VERSION_APPROVED,
    ActivityType.MEMBER_REVOKED,
    ActivityType.INVITATION_ACCEPTED,
    ActivityType.PROJECT_DELETE_REQUESTED,
    ActivityType.PROJECT_RESTORED,
  ])('%s 메일에 쪽지 본문·댓글·이메일·로그인 코드·초대 토큰을 넣지 않는다', (type) => {
    // 실제 비밀값이 아닌 누출 확인용 표식이다. 조회 결과에 칸이 더 있어도 메일에 복사하면 안 된다.
    const privateFields = {
      body: 'fake-private-issue-body',
      comment: 'fake-private-comment',
      email: 'private-client@example.com',
      code: 'fake-login-code',
      token: 'fake-invitation-token',
    };
    const eventWithPrivateFields = {
      ...event,
      type,
      ...privateFields,
      version,
      issue: { ...issue, body: privateFields.body, comments: [{ body: privateFields.comment }] },
    };

    const message = buildNotificationMessage(eventWithPrivateFields, appUrl);

    expect(Object.keys(message).sort()).toEqual(['subject', 'text']);
    for (const value of Object.values(privateFields)) {
      expect(message.subject).not.toContain(value);
      expect(message.text).not.toContain(value);
    }
  });

  it.each([
    ActivityType.INVITATION_CREATED,
    ActivityType.APPROVER_CHANGED,
    ActivityType.ISSUE_CREATED,
    ActivityType.ISSUE_STARTED,
    ActivityType.ISSUE_VERIFIED,
    ActivityType.ISSUE_REOPENED,
    ActivityType.ISSUE_WITHDRAWN,
    ActivityType.PROJECT_ARCHIVED,
    ActivityType.PROJECT_UNARCHIVED,
  ])('메일 대상이 아닌 %s 사건은 버전과 쪽지가 있어도 오류를 던진다', (type) => {
    expect(() => buildNotificationMessage({ ...event, type, version, issue }, appUrl)).toThrow();
  });

  it.each([ActivityType.VERSION_PUBLISHED, ActivityType.VERSION_APPROVED])(
    '%s 사건의 버전 정보가 없으면 쪽지로 대신 보내지 않고 오류를 던진다',
    (type) => {
      expect(() => buildNotificationMessage({ ...event, type, version: null, issue }, appUrl)).toThrow();
    },
  );

  it('고쳤어요 사건의 쪽지 정보가 없으면 버전으로 대신 보내지 않고 오류를 던진다', () => {
    expect(() =>
      buildNotificationMessage({ ...event, type: ActivityType.RESOLUTION_SUBMITTED, version, issue: null }, appUrl),
    ).toThrow();
  });
});
