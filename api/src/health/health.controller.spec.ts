import {
  type INestApplication,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let controller: HealthController;
  let server: Server;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    controller = app.get(HealthController);
    server = app.getHttpServer() as Server;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await app?.close();
    app = undefined;
  });

  it('실제 DB 조회가 성공하면 GET /api/health가 200과 ok를 반환한다', async () => {
    await request(server)
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('DB 조회가 실패하면 GET /api/health가 503을 반환한다', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('DB 조회 실패'));

    await request(server).get('/api/health').expect(503);
  });

  it('DB 조회가 끝나지 않으면 5초까지 기다린 뒤 503 오류를 던진다', async () => {
    vi.useFakeTimers();
    const pendingQuery = new Promise<never>(() => {}) as ReturnType<
      PrismaService['$queryRaw']
    >;
    vi.spyOn(prisma, '$queryRaw').mockReturnValue(pendingQuery);
    const onResolved = vi.fn();
    const onRejected = vi.fn();
    const result = controller.check().then(onResolved, onRejected);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(onResolved).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await result;

    expect(onResolved).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledExactlyOnceWith(
      expect.any(ServiceUnavailableException),
    );
    const error = onRejected.mock.calls[0][0] as ServiceUnavailableException;
    expect(error.getStatus()).toBe(503);
  });
});
