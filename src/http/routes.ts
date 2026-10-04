import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { VoyageService } from '../service';
import { VerificationService } from '../verification';
import { HttpError } from '../errors';
import {
  applyMovesSchema,
  createVoyageSchema,
  issueManifestSchema,
  verificationReportsSchema,
} from './schemas';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApiRouter(
  service: VoyageService,
  verification: VerificationService,
): Router {
  const router = Router();

  function parseVoyageId(req: Request): string {
    const id = req.params['id'] ?? '';
    if (!UUID_RE.test(id)) {
      throw HttpError.badRequest('invalid_voyage_id', `航次 ID 格式非法: ${id}`);
    }
    return id;
  }

  function parseBody<Schema extends z.ZodTypeAny>(schema: Schema, body: unknown): z.infer<Schema> {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw HttpError.badRequest(
        'invalid_request_body',
        '请求体校验失败',
        result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    return result.data;
  }

  // 创建航次（登记三维舱位、列承重、箱、不相容类别对）
  router.post('/voyages', (req, res, next) => {
    (async () => {
      const input = parseBody(createVoyageSchema, req.body);
      const voyage = await service.createVoyage(input);
      res.status(201).json(voyage);
    })().catch(next);
  });

  router.get('/voyages', (_req, res, next) => {
    service.listVoyages().then((v) => res.json(v)).catch(next);
  });

  router.get('/voyages/:id', (req, res, next) => {
    const id = parseVoyageId(req);
    service.getVoyage(id).then((v) => res.json(v)).catch(next);
  });

  // 布局：当前修订号或指定历史修订号 ?rev=N
  router.get('/voyages/:id/layout', (req, res, next) => {
    const id = parseVoyageId(req);
    const revRaw = req.query.rev;
    let rev: number | undefined;
    if (revRaw !== undefined) {
      if (typeof revRaw !== 'string' || !/^\d+$/.test(revRaw)) {
        throw HttpError.badRequest('invalid_revision', 'rev 必须为非负整数');
      }
      rev = Number(revRaw);
    }
    service.getLayout(id, rev).then((v) => res.json(v)).catch(next);
  });

  // 整批调整（携带所见修订号，允许同批交换）
  router.post('/voyages/:id/moves', (req, res, next) => {
    const id = parseVoyageId(req);
    const input = parseBody(applyMovesSchema, req.body);
    service
      .applyMoves(id, input)
      .then((v) => res.status(200).json(v))
      .catch(next);
  });

  // 签发装载清单（冻结当前布局，旧清单保留）
  router.post('/voyages/:id/manifests', (req, res, next) => {
    const id = parseVoyageId(req);
    const input = parseBody(issueManifestSchema, req.body);
    service
      .issueManifest(id, input.expectedRevision)
      .then((r) => res.status(r.reused ? 200 : 201).json(r.manifest))
      .catch(next);
  });

  router.get('/voyages/:id/manifests', (req, res, next) => {
    const id = parseVoyageId(req);
    service.listManifests(id).then((v) => res.json(v)).catch(next);
  });

  router.get('/voyages/:id/manifests/:rev', (req, res, next) => {
    const id = parseVoyageId(req);
    const raw = req.params['rev'] ?? '';
    if (!/^\d+$/.test(raw)) {
      throw HttpError.badRequest('invalid_revision', '修订号必须为非负整数');
    }
    service.getManifest(id, Number(raw)).then((v) => res.json(v)).catch(next);
  });

  /* ================= 现场装船核对 ================= */

  const JOB_UUID_RE = UUID_RE;

  function parseJobId(req: Request): string {
    const jobId = req.params['jobId'] ?? '';
    if (!JOB_UUID_RE.test(jobId)) {
      throw HttpError.badRequest('invalid_job_id', `核对作业 ID 格式非法: ${jobId}`);
    }
    return jobId;
  }

  function parseManifestRev(req: Request): number {
    const raw = req.params['rev'] ?? '';
    if (!/^\d+$/.test(raw)) {
      throw HttpError.badRequest('invalid_revision', '清单修订号必须为非负整数');
    }
    return Number(raw);
  }

  // 以某修订号的“已签发清单”开启核对作业（同一清单至多一个，重复开启幂等）
  router.post('/voyages/:id/verification-jobs/:rev', (req, res, next) => {
    const id = parseVoyageId(req);
    const rev = parseManifestRev(req);
    verification
      .openJob(id, rev)
      .then((r) => res.status(r.reused ? 200 : 201).json(r.job))
      .catch(next);
  });

  // 航次的核对作业列表
  router.get('/voyages/:id/verification-jobs', (req, res, next) => {
    const id = parseVoyageId(req);
    verification.listJobs(id).then((v) => res.json(v)).catch(next);
  });

  // 作业详情 + 核对明细（应装/已核对/缺失/错位/清单外）
  router.get('/verification-jobs/:jobId', (req, res, next) => {
    const jobId = parseJobId(req);
    verification.getJob(jobId).then((v) => res.json(v)).catch(next);
  });

  // 上报实装 / 撤销（唯一上报号；同号同内容重试幂等，同号异内容冲突）
  router.post('/verification-jobs/:jobId/reports', (req, res, next) => {
    const jobId = parseJobId(req);
    const input = parseBody(verificationReportsSchema, req.body);
    verification
      .submitReports(jobId, input)
      .then((v) => res.status(202).json(v))
      .catch(next);
  });

  // 上报留痕（按作业内顺序）
  router.get('/verification-jobs/:jobId/reports', (req, res, next) => {
    const jobId = parseJobId(req);
    verification.listReports(jobId).then((v) => res.json(v)).catch(next);
  });

  // 申请结案：完全一致才冻结，否则 409 返回差异且作业继续开放
  router.post('/verification-jobs/:jobId/close', (req, res, next) => {
    const jobId = parseJobId(req);
    verification
      .closeJob(jobId)
      .then((r) => res.status(r.reused ? 200 : 201).json(r.job))
      .catch(next);
  });

  return router;
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
  res.status(500).json({ error: { code: 'internal_error', message } });
}
