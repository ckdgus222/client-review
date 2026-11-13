import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type {
  IssueCategory,
  IssueScope,
  IssueStatus,
} from "../../api/src/generated/prisma/client.ts";
import {
  test,
  expect,
  db,
  resetDatabase,
  createUser,
  createProject,
} from "./fixtures.ts";

const publishedAt = new Date("2026-11-10T16:05:00.000Z");
const approvedAt = new Date("2026-11-13T06:10:22.123Z");

type SavedIssue = {
  number: number;
  title: string;
  category: IssueCategory;
  scope: IssueScope;
  status: IssueStatus;
};

const exampleIssues: SavedIssue[] = [
  {
    number: 1,
    title: "버튼 색",
    category: "BUG",
    scope: "IN_SCOPE",
    status: "VERIFIED",
  },
  {
    number: 2,
    title: "배너 추가",
    category: "DESIGN",
    scope: "OUT_OF_SCOPE",
    status: "OPEN",
  },
  {
    number: 10,
    title: "안내 문장",
    category: "COPY",
    scope: "IN_SCOPE",
    status: "WITHDRAWN",
  },
  {
    number: 11,
    title: "추가 요청",
    category: "OTHER",
    scope: "OUT_OF_SCOPE",
    status: "IN_PROGRESS",
  },
];

// 사진 자체는 확인서에 나오지 않는다. 화면·사진의 DB 연결만 준비한다.
const prepareRoom = async (issues: SavedIssue[] = exampleIssues) => {
  const developer = await createUser("developer@example.com", "김개발");
  const approver = await createUser("approver@example.com", "홍승인");
  const client = await createUser("client@example.com", "이클라이언트");
  const project = await createProject(developer.id, "쇼핑몰 리뉴얼");
  const approverMember = await db.projectMember.create({
    data: { projectId: project.id, userId: approver.id, role: "CLIENT" },
  });
  const clientMember = await db.projectMember.create({
    data: { projectId: project.id, userId: client.id, role: "CLIENT" },
  });
  const version = await db.deliveryVersion.create({
    data: {
      projectId: project.id,
      number: 1,
      status: "IN_REVIEW",
      publishedAt,
    },
  });
  await db.project.update({
    where: { id: project.id },
    data: { currentVersionId: version.id, approverMemberId: approverMember.id },
  });
  const home = await db.screen.create({
    data: {
      projectId: project.id,
      name: "홈",
      viewport: "PC",
      createdAt: new Date("2026-11-01T00:00:00Z"),
    },
  });
  const checkout = await db.screen.create({
    data: {
      projectId: project.id,
      name: "결제",
      viewport: "MOBILE",
      createdAt: new Date("2026-11-02T00:00:00Z"),
    },
  });
  const asset = await db.asset.create({
    data: {
      projectId: project.id,
      storageKey: `${project.id}/screen.png`,
      mime: "image/png",
      bytes: 100,
      width: 1200,
      height: 800,
    },
  });
  // 화면 생성 순서와 버전에 연결한 순서를 다르게 해서 검수실의 화면 순서를 확인한다.
  for (const screen of [checkout, home]) {
    await db.versionScreen.create({
      data: { versionId: version.id, screenId: screen.id, assetId: asset.id },
    });
  }
  await db.issue.createMany({
    data: issues.map((issue) => ({
      ...issue,
      projectId: project.id,
      originVersionId: version.id,
      authorId: client.id,
      body: "확인서 검수용 쪽지",
      requestId: randomUUID(),
    })),
  });
  return { developer, approver, client, clientMember, project, version };
};

type Room = Awaited<ReturnType<typeof prepareRoom>>;

// 실제 승인 코드와 같은 칸과 순서로 저장한다. 상태와 승인 기록은 한 트랜잭션에서 함께 만든다.
const seedApproval = async (room: Room) => {
  const issues = await db.issue.findMany({
    where: { projectId: room.project.id },
    orderBy: { number: "asc" },
    select: {
      number: true,
      title: true,
      category: true,
      scope: true,
      status: true,
    },
  });
  const [approval] = await db.$transaction([
    db.approval.create({
      data: {
        versionId: room.version.id,
        approverId: room.approver.id,
        approvedAt,
        summary: { issues },
      },
    }),
    db.deliveryVersion.update({
      where: { id: room.version.id },
      data: { status: "APPROVED" },
    }),
  ]);
  return approval;
};

const openCertificate = async (page: Page, versionId: string) => {
  await page.goto(`/app/versions/${versionId}/certificate`);
  await expect(
    page.getByRole("heading", { level: 1, name: "검수 확인서" }),
  ).toBeVisible();
};

const expectNotFound = async (page: Page, versionId: string) => {
  await page.goto(`/app/versions/${versionId}/certificate`);
  await expect(
    page.getByRole("heading", { name: "없는 확인서예요" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "프로젝트 목록" }),
  ).toHaveAttribute("href", "/app");
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PDF로 저장" })).toHaveCount(0);
};

test.beforeEach(async () => {
  await resetDatabase();
});

test("승인자가 승인하면 승인 완료 안내의 링크로 확인서가 열리고 승인자·개발자·쪽지 수·쪽지 목록이 보인다", async ({
  page,
  loginAs,
}) => {
  const room = await prepareRoom();
  await loginAs(room.approver.id);
  await page.goto(`/app/projects/${room.project.id}`);
  await page.getByRole("button", { name: "버전 승인", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAccessibleName("1차 승인 검토");
  await expect(
    dialog.getByRole("link", { name: "검수 확인서 보기" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "승인하기", exact: true }).click();
  await expect(
    dialog.getByText("이 버전을 승인할까요? 승인하면 되돌릴 수 없어요.", {
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "승인 확정", exact: true }).click();
  await expect(dialog).toHaveAccessibleName("1차 승인 완료");
  const link = dialog.getByRole("link", { name: "검수 확인서 보기" });
  await expect(link).toHaveAttribute(
    "href",
    `/app/versions/${room.version.id}/certificate`,
  );

  await link.click();

  await expect(page).toHaveURL(`/app/versions/${room.version.id}/certificate`);
  await expect(
    page.getByRole("heading", { level: 1, name: "검수 확인서" }),
  ).toBeVisible();
  const approval = await db.approval.findUniqueOrThrow({
    where: { versionId: room.version.id },
  });
  const approvalTime = new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(approval.approvedAt);
  await expect(
    page.getByText(`확인서 번호 ${approval.id}`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("definition")).toHaveText([
    "쇼핑몰 리뉴얼",
    "1차",
    "2026. 11. 11. 오전 1:05",
    approvalTime,
    "홍승인",
    "김개발",
  ]);
  await expect(page.getByRole("listitem")).toHaveText([
    "홈 · PC",
    "결제 · 모바일",
  ]);
  await expect(
    page.getByText("확인 완료 1건 · 철회 1건 · 범위 밖(추가 요청) 2건", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(2);
  await expect(page.getByRole("cell")).toHaveText([
    "#1",
    "버튼 색",
    "버그",
    "확인 완료",
    "#10",
    "안내 문장",
    "문구",
    "철회",
    "#2",
    "배너 추가",
    "디자인",
    "접수",
    "#11",
    "추가 요청",
    "기타",
    "수정 중",
  ]);
});

test("개발자와 다른 클라이언트도 승인 띠의 링크로 같은 확인서를 본다", async ({
  page,
  loginAs,
}) => {
  const room = await prepareRoom();
  const approval = await seedApproval(room);
  await loginAs(room.approver.id);
  await openCertificate(page, room.version.id);
  const certificateText = await page.getByRole("article").innerText();

  for (const user of [room.developer, room.client]) {
    await loginAs(user.id);
    await page.goto(`/app/projects/${room.project.id}`);
    const banner = page.getByRole("region", { name: "승인 안내", exact: true });
    await expect(banner).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const link = banner.getByRole("link", { name: "검수 확인서 보기" });
    await expect(link).toHaveAttribute(
      "href",
      `/app/versions/${room.version.id}/certificate`,
    );

    await link.click();

    await expect(page).toHaveURL(
      `/app/versions/${room.version.id}/certificate`,
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "검수 확인서" }),
    ).toBeVisible();
    await expect(
      page.getByText(`확인서 번호 ${approval.id}`, { exact: true }),
    ).toBeVisible();
    expect(await page.getByRole("article").innerText()).toBe(certificateText);
  }
});

test("검수 중에는 확인서 링크가 없고 지난 승인 버전을 고르면 그 버전의 확인서가 열린다", async ({
  page,
  loginAs,
}) => {
  const room = await prepareRoom();
  const approval = await seedApproval(room);
  const next = await db.deliveryVersion.create({
    data: {
      projectId: room.project.id,
      number: 2,
      status: "IN_REVIEW",
      publishedAt: new Date("2026-11-14T00:00:00Z"),
    },
  });
  const screens = await db.versionScreen.findMany({
    where: { versionId: room.version.id },
  });
  await db.versionScreen.createMany({
    data: screens.map(({ screenId, assetId }) => ({
      versionId: next.id,
      screenId,
      assetId,
    })),
  });
  await db.project.update({
    where: { id: room.project.id },
    data: { currentVersionId: next.id },
  });
  await loginAs(room.client.id);
  await page.goto(`/app/projects/${room.project.id}`);
  const picker = page.getByRole("combobox", { name: "버전", exact: true });
  await expect(picker).toHaveValue(next.id);
  await expect(page.getByText("검수 중", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "검수 확인서 보기" }),
  ).toHaveCount(0);

  await picker.selectOption(room.version.id);
  const link = page
    .getByRole("region", { name: "승인 안내", exact: true })
    .getByRole("link", { name: "검수 확인서 보기" });
  await expect(link).toHaveAttribute(
    "href",
    `/app/versions/${room.version.id}/certificate`,
  );
  await link.click();

  await expect(page).toHaveURL(`/app/versions/${room.version.id}/certificate`);
  await expect(
    page.getByText(`확인서 번호 ${approval.id}`, { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "검수실로 돌아가기" }).click();
  await expect(picker).toHaveValue(room.version.id);
  await expect(link).toBeVisible();
  await picker.selectOption(next.id);
  await expect(page.getByText("검수 중", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "검수 확인서 보기" }),
  ).toHaveCount(0);
});

test("승인 뒤 다음 버전에서 쪽지를 다시 열어도 확인서의 쪽지 목록은 승인 때 그대로다", async ({
  page,
  loginAs,
  baseURL,
}) => {
  const room = await prepareRoom();
  const approval = await seedApproval(room);
  await loginAs(room.client.id);
  await openCertificate(page, room.version.id);
  const originalRows = await page.locator("tbody tr").allTextContents();
  const next = await db.deliveryVersion.create({
    data: {
      projectId: room.project.id,
      number: 2,
      status: "IN_REVIEW",
      publishedAt: new Date("2026-11-14T00:00:00Z"),
    },
  });
  await db.project.update({
    where: { id: room.project.id },
    data: { currentVersionId: next.id },
  });
  const issue = await db.issue.findUniqueOrThrow({
    where: { projectId_number: { projectId: room.project.id, number: 1 } },
  });
  const response = await page.request.post(`/api/issues/${issue.id}/reopen`, {
    headers: { Origin: baseURL! },
    data: { versionId: next.id, reason: "다음 버전에서 다시 확인해 주세요" },
  });
  expect(response.status()).toBe(200);
  expect(
    (await db.issue.findUniqueOrThrow({ where: { id: issue.id } })).status,
  ).toBe("OPEN");
  await db.issue.update({
    where: { id: issue.id },
    data: { title: "바뀐 제목", category: "OTHER", scope: "OUT_OF_SCOPE" },
  });

  await openCertificate(page, room.version.id);

  await expect(page.locator("tbody tr")).toHaveText(originalRows);
  await expect(
    page.getByText(`확인서 번호 ${approval.id}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("확인 완료 1건 · 철회 1건 · 범위 밖(추가 요청) 2건", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("바뀐 제목", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "검수실로 돌아가기" }),
  ).toHaveAttribute(
    "href",
    `/app/projects/${room.project.id}?version=${room.version.id}`,
  );
});

test("쪽지 없이 승인된 버전의 확인서는 쪽지가 없었다고 알린다", async ({
  page,
  loginAs,
}) => {
  const room = await prepareRoom([]);
  await seedApproval(room);
  await loginAs(room.approver.id);
  await openCertificate(page, room.version.id);

  await expect(
    page.getByText("이 버전에는 쪽지가 없었어요", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("확인 완료 0건 · 철회 0건 · 범위 밖(추가 요청) 0건", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("검수 중인 버전의 확인서 주소를 열면 없는 확인서라고 알린다", async ({
  page,
  loginAs,
}) => {
  const room = await prepareRoom();
  await loginAs(room.developer.id);
  await expectNotFound(page, room.version.id);
  await page.getByRole("link", { name: "프로젝트 목록" }).click();
  await expect(page).toHaveURL(/\/app\/?$/);
  await expect(
    page.getByRole("heading", { name: "내 프로젝트" }),
  ).toBeVisible();
});

test("멤버가 아닌 사람이 확인서 주소를 열면 없는 확인서라고 알린다", async ({
  page,
  loginAs,
}) => {
  const room = await prepareRoom();
  await seedApproval(room);
  const outsider = await createUser("outsider@example.com", "외부인");
  await loginAs(outsider.id);

  await expectNotFound(page, room.version.id);
  await expect(page.getByText(room.project.name, { exact: true })).toHaveCount(
    0,
  );
});

test("인쇄 모양에서는 버튼과 사이트 머리말이 감춰지고 확인서 내용은 보인다", async ({
  page,
  loginAs,
}) => {
  const room = await prepareRoom();
  const approval = await seedApproval(room);
  await loginAs(room.developer.id);
  await openCertificate(page, room.version.id);
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF로 저장" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "검수실로 돌아가기" }),
  ).toBeVisible();

  await page.emulateMedia({ media: "print" });

  await expect(page.getByRole("banner", { includeHidden: true })).toBeHidden();
  await expect(
    page.getByRole("button", { name: "PDF로 저장", includeHidden: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("link", { name: "검수실로 돌아가기", includeHidden: true }),
  ).toBeHidden();
  await expect(
    page.getByText("인쇄 창에서 'PDF로 저장'을 고르면 돼요", { exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "검수 확인서", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`확인서 번호 ${approval.id}`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("definition")).toHaveText([
    "쇼핑몰 리뉴얼",
    "1차",
    "2026. 11. 11. 오전 1:05",
    "2026. 11. 13. 오후 3:10",
    "홍승인",
    "김개발",
  ]);
  await expect(page.getByRole("listitem")).toHaveText([
    "홈 · PC",
    "결제 · 모바일",
  ]);
  await expect(page.getByRole("article")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(page.getByRole("article")).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(page.locator("tbody tr")).toHaveCount(4);
  for (const issue of exampleIssues)
    await expect(
      page.getByRole("cell", { name: issue.title, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByText("시각은 한국 표준시(KST) 기준이에요", { exact: true }),
  ).toBeVisible();
});

test("쪽지가 많은 확인서를 A4 PDF로 만들면 여러 쪽으로 나뉘고 모든 쪽지가 들어 있다", async ({
  page,
  loginAs,
}, testInfo) => {
  const issues: SavedIssue[] = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    title: `인쇄 확인 쪽지 ${index + 1}`,
    category: "BUG",
    scope: "IN_SCOPE",
    status: "VERIFIED",
  }));
  const room = await prepareRoom(issues);
  await seedApproval(room);
  await loginAs(room.developer.id);
  await openCertificate(page, room.version.id);
  await page.emulateMedia({ media: "print" });

  await expect(page.locator("tbody tr")).toHaveCount(issues.length);
  await expect(page.locator("tbody tr td:nth-child(2)")).toHaveText(
    issues.map((issue) => issue.title),
  );
  const rowBreaks = await page
    .locator("tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) => getComputedStyle(row).breakInside),
    );
  expect(rowBreaks).toEqual(issues.map(() => "avoid"));
  await expect(page.locator("thead")).toHaveCSS(
    "display",
    "table-header-group",
  );
  const pdfPath = testInfo.outputPath("certificate-a4.pdf");
  const pdf = await page.pdf({ format: "A4", path: pdfPath });
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  const pageCount = (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? [])
    .length;
  expect(pageCount).toBeGreaterThan(1);
  await testInfo.attach("A4 검수 확인서", {
    path: pdfPath,
    contentType: "application/pdf",
  });
});

test("PDF로 저장을 누르면 브라우저 인쇄가 열린다", async ({
  page,
  loginAs,
}) => {
  const room = await prepareRoom();
  await seedApproval(room);
  await loginAs(room.developer.id);
  await page.addInitScript(() => {
    window.print = () => {
      document.documentElement.dataset.printCalls = String(
        Number(document.documentElement.dataset.printCalls ?? 0) + 1,
      );
    };
  });
  await openCertificate(page, room.version.id);
  expect(
    await page.locator("html").getAttribute("data-print-calls"),
  ).toBeNull();

  await page.getByRole("button", { name: "PDF로 저장" }).click();

  await expect(page.locator("html")).toHaveAttribute("data-print-calls", "1");
  await expect(
    page.getByText("인쇄 창에서 'PDF로 저장'을 고르면 돼요", { exact: true }),
  ).toBeVisible();
});

test("쪽지 제목의 HTML은 글자 그대로 보이고 긴 제목은 확인서 밖으로 넘치지 않는다", async ({
  page,
  loginAs,
}) => {
  const html =
    '<img src=x onerror="document.body.dataset.injected=1"><b>추가 요청</b>';
  const longTitle = "W".repeat(200);
  const room = await prepareRoom([
    { ...exampleIssues[0], title: html },
    { ...exampleIssues[1], title: longTitle },
  ]);
  await seedApproval(room);
  await loginAs(room.developer.id);
  await page.setViewportSize({ width: 794, height: 1123 });
  await openCertificate(page, room.version.id);

  for (const media of ["screen", "print"] as const) {
    await page.emulateMedia({ media });
    const htmlCell = page.getByRole("cell", { name: html, exact: true });
    await expect(htmlCell).toHaveText(html);
    await expect(htmlCell.locator("*")).toHaveCount(0);
    expect(await page.locator("body").getAttribute("data-injected")).toBeNull();
    const longCell = page.getByRole("cell", { name: longTitle, exact: true });
    await expect(longCell).toBeVisible();
    const fits = await longCell.evaluate((cell) => {
      const paper = cell.closest("article")!;
      const bounds = paper.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(cell);
      return (
        paper.scrollWidth <= paper.clientWidth + 1 &&
        bounds.right <= window.innerWidth &&
        Array.from(range.getClientRects()).every(
          (rect) => rect.left >= bounds.left && rect.right <= bounds.right + 1,
        )
      );
    });
    expect(fits, `${media} 모양에서 긴 제목이 확인서 안에 있어야 한다`).toBe(
      true,
    );
  }
});

test("확인서에 이번 범위의 쪽지와 범위 밖 쪽지가 따로 번호 순으로 보인다", async ({
  page,
  loginAs,
}) => {
  const room = await prepareRoom();
  await seedApproval(room);
  await loginAs(room.client.id);
  await openCertificate(page, room.version.id);

  await expect(
    page.getByRole("heading", { name: "이번 범위의 쪽지 2건", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "범위 밖(추가 요청) 쪽지 2건",
      exact: true,
    }),
  ).toBeVisible();
  const tables = page.getByRole("table");
  await expect(tables).toHaveCount(2);
  await expect(tables.nth(0).getByRole("cell")).toHaveText([
    "#1",
    "버튼 색",
    "버그",
    "확인 완료",
    "#10",
    "안내 문장",
    "문구",
    "철회",
  ]);
  await expect(tables.nth(1).getByRole("cell")).toHaveText([
    "#2",
    "배너 추가",
    "디자인",
    "접수",
    "#11",
    "추가 요청",
    "기타",
    "수정 중",
  ]);
  for (const table of await tables.all()) {
    await expect(table.getByRole("columnheader")).toHaveText([
      "번호",
      "제목",
      "분류",
      "상태",
    ]);
  }
  await expect(
    page.getByRole("columnheader", { name: "범위", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("확인 완료 1건 · 철회 1건 · 범위 밖(추가 요청) 2건", {
      exact: true,
    }),
  ).toBeVisible();
});

test("다른 시간대의 브라우저에서 열어도 확인서의 시각은 한국 시각으로 찍힌다", async ({
  browser,
  context,
  baseURL,
  loginAs,
}) => {
  const room = await prepareRoom();
  await seedApproval(room);
  await loginAs(room.client.id);
  const storageState = await context.storageState();
  for (const timezoneId of ["America/Los_Angeles", "Asia/Seoul"]) {
    const viewer = await browser.newContext({
      baseURL,
      storageState,
      timezoneId,
    });
    try {
      const page = await viewer.newPage();
      expect(
        await page.evaluate(
          () => Intl.DateTimeFormat().resolvedOptions().timeZone,
        ),
      ).toBe(timezoneId);
      await openCertificate(page, room.version.id);
      await expect(page.getByRole("definition")).toHaveText([
        "쇼핑몰 리뉴얼",
        "1차",
        "2026. 11. 11. 오전 1:05",
        "2026. 11. 13. 오후 3:10",
        "홍승인",
        "김개발",
      ]);
      await expect(
        page.getByText("시각은 한국 표준시(KST) 기준이에요", { exact: true }),
      ).toBeVisible();
    } finally {
      await viewer.close();
    }
  }
});

test("세션이 끝난 뒤 확인서를 열면 로그인 화면으로 간다", async ({
  page,
  loginAs,
}) => {
  const room = await prepareRoom();
  await seedApproval(room);
  await loginAs(room.client.id);
  await openCertificate(page, room.version.id);
  await db.session.updateMany({
    where: { userId: room.client.id },
    data: { expiresAt: new Date("2020-01-01T00:00:00Z") },
  });

  await page.goto(`/app/versions/${room.version.id}/certificate`);

  await expect(page).toHaveURL(/\/app\/login$/);
  await expect(
    page.getByRole("heading", { name: "로그인", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "검수 확인서", exact: true }),
  ).toHaveCount(0);
});

test("게시 전 버전의 확인서 주소는 개발자에게도 없는 확인서라고 알린다", async ({
  page,
  loginAs,
}) => {
  const room = await prepareRoom();
  const draft = await db.deliveryVersion.create({
    data: { projectId: room.project.id },
  });
  await loginAs(room.developer.id);

  await expectNotFound(page, draft.id);
});

test("접근이 철회된 클라이언트가 확인서를 다시 열면 없는 확인서라고 알린다", async ({
  page,
  loginAs,
}) => {
  const room = await prepareRoom();
  await seedApproval(room);
  await loginAs(room.client.id);
  await openCertificate(page, room.version.id);
  await db.projectMember.update({
    where: { id: room.clientMember.id },
    data: { revokedAt: new Date() },
  });

  await expectNotFound(page, room.version.id);
});

test("없는 버전과 UUID가 아닌 확인서 주소는 없는 확인서라고 알린다", async ({
  page,
  loginAs,
}) => {
  const room = await prepareRoom();
  await loginAs(room.client.id);

  for (const id of [randomUUID(), "not-a-uuid"]) await expectNotFound(page, id);
});

for (const { scope, message } of [
  { scope: "IN_SCOPE", message: "범위 밖 쪽지가 없어요" },
  { scope: "OUT_OF_SCOPE", message: "이번 범위의 쪽지가 없어요" },
]) {
  test(`${scope} 쪽지만 있는 확인서는 '${message}'라고 알리고 빈 테이블을 만들지 않는다`, async ({
    page,
    loginAs,
  }) => {
    const room = await prepareRoom(
      exampleIssues.filter((issue) => issue.scope === scope),
    );
    await seedApproval(room);
    await loginAs(room.client.id);
    await openCertificate(page, room.version.id);

    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(1);
    await expect(
      page.getByText("이 버전에는 쪽지가 없었어요", { exact: true }),
    ).toHaveCount(0);
  });
}
