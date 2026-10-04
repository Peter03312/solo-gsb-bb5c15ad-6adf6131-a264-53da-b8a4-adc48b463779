import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { VoyageService } from '../service';
import { HttpError } from '../errors';
import {
  applyMovesSchema,
  createVoyageSchema,
  issueManifestSchema,
} from './schemas';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApiRouter(service: VoyageService): Router {
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
