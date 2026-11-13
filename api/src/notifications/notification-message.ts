import { ActivityType } from '../generated/prisma/client.js';

// 보낼 때 사건 줄에서 읽어 오는 것. 메일 내용은 넣을 때가 아니라 보낼 때 만든다.
export type NotificationEvent = {
  type: ActivityType;
  createdAt: Date;
  projectId: string;
  projectName: string;
  memberId: string | null;
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

// 기록 메일(접근 철회, 초대 수락, 삭제 대기, 되살리기)은 사람이 아니라 복원 절차가 읽는다. 11번 복원 때 이 줄들을 시간순으로 다시 적용한다.
export const RECORD_TYPES: ActivityType[] = [
  ActivityType.MEMBER_REVOKED,
  ActivityType.INVITATION_ACCEPTED,
  ActivityType.PROJECT_DELETE_REQUESTED,
  ActivityType.PROJECT_RESTORED,
];

const recordMessage = (event: NotificationEvent): NotificationMessage => ({
  subject: `[Client Review 기록] ${event.type}`,
  text: [
    `사건: ${event.type}`,
    `시각: ${event.createdAt.toISOString()}`,
    `프로젝트 id: ${event.projectId}`,
    `대상 멤버 id: ${event.memberId ?? '-'}`,
  ].join('\n'),
});

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
