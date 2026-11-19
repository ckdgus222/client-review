import { ActivityType, type ProjectRole } from '../generated/prisma/client.js';

// 보낼 때 사건 줄에서 읽어 오는 것. 메일 내용은 넣을 때가 아니라 보낼 때 만든다.
export type NotificationEvent = {
  id: string;
  type: ActivityType;
  // DB가 가진 백만분의 1초까지 적은 글자(2026-11-14T03:04:05.123456Z)다. Date로 받으면 천분의 1초 아래가 잘려
  // 같은 밀리초에 생긴 두 사건의 순서를 알 수 없다(docs/deploy.md 정할 것 16).
  occurredAt: string;
  projectId: string;
  projectName: string;
  // 사건의 대상 멤버(초대 수락, 접근 철회, 승인자 바꾸기). 참여 시각도 occurredAt과 같은 모양의 글자다.
  member: { id: string; role: ProjectRole; userId: string; email: string; name: string; joinedAt: string } | null;
  version: { id: string; number: number | null } | null;
  issue: { id: string; number: number; title: string } | null;
};

export type NotificationMessage = { subject: string; text: string };

// 프로젝트 이름과 쪽지 제목은 사용자가 쓴 글이다. 줄바꿈이 제목(메일 머리말)에 들어가면 다른 머리말을 끼워 넣을 수 있어서 한 줄로 만든다.
const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();

// 화면의 versionLabel(web/src/api/versions.ts)과 같은 이름이다. 번호 0은 "초안"이다.
// "초안이", "1차가"처럼 받침에 따라 조사가 다르다.
const versionSubject = (number: number | null) => {
  if (number === null) return '버전이';
  return number === 0 ? '초안이' : `${number}차가`;
};

// 기록 메일은 사람이 아니라 복원 절차가 읽는다. 복원 뒤 다시 적용 스크립트가 이 줄들을 시간순으로 다시 적용한다
// (docs/deploy.md 정할 것 15·16). 백업 뒤에 바뀐 참여·승인자·프로젝트 상태를 알 서버 밖 기록이 이 메일뿐이다.
export const RECORD_TYPES: ActivityType[] = [
  ActivityType.MEMBER_REVOKED,
  ActivityType.INVITATION_ACCEPTED,
  ActivityType.PROJECT_DELETE_REQUESTED,
  ActivityType.PROJECT_RESTORED,
  ActivityType.PROJECT_ARCHIVED,
  ActivityType.PROJECT_UNARCHIVED,
  ActivityType.APPROVER_CHANGED,
];

const recordMessage = (event: NotificationEvent): NotificationMessage => {
  const { member } = event;
  // 백업에 없는 멤버(백업 뒤 처음 수락한 사람)도 이 줄들만으로 다시 만들 수 있게 사람 값까지 적는다.
  // 대상이 없을 때 승인자 바꾸기는 "아무도 지정하지 않음"이 뜻이 있어서 따로 적는다.
  const targetLines = member
    ? [
        `대상 멤버 id: ${member.id}`,
        `대상 역할: ${member.role}`,
        `대상 사용자 id: ${member.userId}`,
        // 이메일과 이름은 사람이 쓴 값이다. JSON 문자열로 적어서 줄바꿈이나 "사건:" 같은 글이 다른 항목으로 읽히지 않게 한다.
        `대상 이메일: ${JSON.stringify(member.email)}`,
        `대상 이름: ${JSON.stringify(member.name)}`,
        `대상 참여 시각: ${member.joinedAt}`,
      ]
    : [`대상 멤버 id: ${event.type === ActivityType.APPROVER_CHANGED ? '지정하지 않음' : '-'}`];

  return {
    subject: `[Client Review 기록] ${event.type}`,
    text: [
      `사건: ${event.type}`,
      // 같은 사건의 메일이 두 번 가도(보낸 뒤 완료 기록 실패) 다시 적용할 때 하나로 친다.
      `사건 id: ${event.id}`,
      `시각: ${event.occurredAt}`,
      `프로젝트 id: ${event.projectId}`,
      ...targetLines,
    ].join('\n'),
  };
};

export const buildNotificationMessage = (event: NotificationEvent, appUrl: string): NotificationMessage => {
  if (RECORD_TYPES.includes(event.type)) return recordMessage(event);

  const project = oneLine(event.projectName);
  const roomUrl = `${appUrl}/app/projects/${event.projectId}`;
  if (event.type === ActivityType.RESOLUTION_SUBMITTED && event.issue) {
    const { id, number, title } = event.issue;
    return {
      subject: `[Client Review] ${project} #${number} 쪽지를 고쳤어요`,
      text: `"${project}"의 #${number} "${oneLine(title)}" 쪽지를 고쳤어요. 확인하고 확인 완료나 재요청을 해 주세요.\n${roomUrl}?issue=${id}`,
    };
  }
  if (event.type === ActivityType.VERSION_PUBLISHED && event.version) {
    const what = versionSubject(event.version.number);
    return {
      subject: `[Client Review] ${project} ${what} 올라왔어요`,
      text: `"${project}"에 ${what} 올라왔어요. 검수실에서 화면을 보고 수정 요청을 남겨 주세요.\n${roomUrl}?version=${event.version.id}`,
    };
  }
  if (event.type === ActivityType.VERSION_APPROVED && event.version) {
    const what = versionSubject(event.version.number);
    return {
      subject: `[Client Review] ${project} ${what} 승인됐어요`,
      text: `"${project}"의 ${what} 승인됐어요. 검수실에서 검수 확인서를 볼 수 있어요.\n${roomUrl}?version=${event.version.id}`,
    };
  }
  // 우편함에는 위 사건만 들어간다(docs/mail.md 정할 것 6). 여기까지 오면 넣는 규칙과 어긋난 것이라 보내지 않고 실패로 남긴다.
  throw new Error(`메일 내용이 없는 사건이에요: ${event.type}`);
};
