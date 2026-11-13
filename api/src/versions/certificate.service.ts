import { Injectable, NotFoundException } from '@nestjs/common';
import { type IssueCategory, IssueScope, IssueStatus, ProjectRole, type Viewport } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';

// 승인할 때 Approval.summary에 저장한 쪽지 한 줄(approval.service.ts의 approve가 만든다).
type CertificateIssue = {
  number: number;
  title: string;
  category: IssueCategory;
  scope: IssueScope;
  status: IssueStatus;
};

export type Certificate = {
  // 확인서 번호. 승인 줄의 id다.
  certificateNumber: string;
  project: { id: string; name: string };
  version: { id: string; number: number; publishedAt: Date };
  approval: { approverName: string; approvedAt: Date };
  developerName: string;
  screens: { name: string; viewport: Viewport }[];
  // 범위 안의 확인 완료·철회, 범위 밖(상태와 상관없이). 승인 조건·승인 검토와 같은 기준이다(범위 밖을 따로 센다).
  counts: { verified: number; withdrawn: number; outOfScope: number };
  // 승인한 때의 쪽지 목록, 번호 순. 지금의 쪽지가 아니다.
  issues: CertificateIssue[];
};

// 없는 버전, 남의 버전, 승인되지 않은 버전 모두 이 404 하나로 답한다. 문구가 다르면 그 버전 id가 어딘가 있다는 것이 드러난다.
export const certificateNotFound = () => new NotFoundException('없는 확인서예요');

const countIssues = (issues: CertificateIssue[]) => {
  const inScope = issues.filter((issue) => issue.scope === IssueScope.IN_SCOPE);
  return {
    verified: inScope.filter((issue) => issue.status === IssueStatus.VERIFIED).length,
    withdrawn: inScope.filter((issue) => issue.status === IssueStatus.WITHDRAWN).length,
    outOfScope: issues.length - inScope.length,
  };
};

// 승인된 버전의 검수 확인서. 읽기만 한다: 승인된 버전은 화면 목록·승인 줄·summary가 더 바뀌지 않는다.
@Injectable()
export class CertificateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  async get(versionId: string, userId: string): Promise<Certificate> {
    const version = await this.prisma.deliveryVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        projectId: true,
        number: true,
        publishedAt: true,
        project: {
          select: {
            name: true,
            // 개발자는 프로젝트마다 한 명이다(DB 제약).
            members: { where: { role: ProjectRole.DEVELOPER }, select: { user: { select: { name: true } } } },
          },
        },
        approval: { select: { id: true, approvedAt: true, summary: true, approver: { select: { name: true } } } },
        screens: {
          select: { screen: { select: { name: true, viewport: true } } },
          // 검수실의 화면 순서와 같다(versions.service.ts의 loadDetail).
          orderBy: { screen: { createdAt: 'asc' } },
        },
      },
    });
    if (!version) throw certificateNotFound();
    // 멤버인지를 승인됐는지보다 먼저 본다. 멤버가 아닌 사람에게 그 버전이 승인됐는지 응답 차이로 알려 주지 않는다.
    await this.projects.requireMemberRole(version.projectId, userId).catch((error) => {
      throw error instanceof NotFoundException ? certificateNotFound() : error;
    });
    const { approval, number, publishedAt } = version;
    // 승인 줄은 버전을 승인됨으로 바꾸는 트랜잭션에서만 생겨서, 승인 줄이 있는 것이 곧 승인된 버전이다.
    // 승인된 버전은 게시한 번호·시각이 있다(DB 제약). 타입이 null을 허용해서 함께 확인한다.
    if (!approval || number === null || !publishedAt) throw certificateNotFound();

    // 승인 코드가 저장한 모양을 그대로 믿는다(이 칸을 쓰는 곳은 승인 한 곳뿐이다).
    const { issues } = approval.summary as { issues: CertificateIssue[] };
    return {
      certificateNumber: approval.id,
      project: { id: version.projectId, name: version.project.name },
      version: { id: version.id, number, publishedAt },
      approval: { approverName: approval.approver.name, approvedAt: approval.approvedAt },
      developerName: version.project.members[0].user.name,
      screens: version.screens.map(({ screen }) => screen),
      counts: countIssues(issues),
      issues,
    };
  }
}
