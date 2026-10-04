import { Pool, PoolClient } from 'pg';
import { HttpError } from './errors';
import {
  ActualBoxState,
  Placement,
  Position,
  ReconciliationResult,
  reconcile,
  positionInBounds,
  verificationContentHash,
} from './domain';

/* ---------- DTO ---------- */

export interface VerificationReportInput {
  reportId: string;
  boxNo: string;
  revoked: boolean;
  position: Position | null;
}

export interface SubmitReportsInput {
  reports: VerificationReportInput[];
}

interface JobRow {
  id: string;
  voyage_id: string;
  manifest_rev: number;
  status: 'open' | 'closed';
  box_count: number;
  report_seq: number;
  report_count: number;
  frozen_result: ReconciliationResult | null;
  created_at: Date;
  closed_at: Date | null;
}

/* ---------- 内部辅助 ---------- */

function mapJobRow(r: Record<string, unknown>): JobRow {
  return {
    id: r.id as string,
    voyage_id: r.voyage_id as string,
    manifest_rev: Number(r.manifest_rev),
    status: r.status as 'open' | 'closed',
    box_count: Number(r.box_count),
    report_seq: Number(r.report_seq),
    report_count: Number(r.report_count),
    frozen_result: (r.frozen_result as ReconciliationResult | null) ?? null,
    created_at: r.created_at as Date,
    closed_at: (r.closed_at as Date | null) ?? null,
  };
}

interface StoredReport {
  seq: number;
  boxNo: string;
  revoked: boolean;
  position: Position | null;
  reportId: string;
  contentHash: string;
  reportedAt: string;
}

function mapReportRow(r: Record<string, unknown>): StoredReport {
  const revoked = Boolean(r.revoked);
  return {
    seq: Number(r.seq),
    boxNo: r.box_no as string,
    revoked,
    position:
      revoked || r.bay === null
        ? null
        : { bay: Number(r.bay), row: Number(r.row), tier: Number(r.tier) },
    reportId: r.report_id as string,
    contentHash: r.content_hash as string,
    reportedAt: new Date(r.reported_at as string).toISOString(),
  };
}

/* ---------- 服务 ---------- */

export class VerificationService {
  constructor(private readonly pool: Pool) {}

  /** 取作业并加行锁（顺序生效的关键），不存在返回 null */
  private async lockJob(client: PoolClient, jobId: string): Promise<JobRow | null> {
    const res = await client.query(
      `SELECT id, voyage_id, manifest_rev, status, box_count, report_seq, report_count,
              frozen_result, created_at, closed_at
         FROM verification_jobs WHERE id=$1 FOR UPDATE`,
      [jobId],
    );
    const row = res.rows[0];
    return row ? mapJobRow(row) : null;
  }

  private async getJobNoLock(client: PoolClient, jobId: string): Promise<JobRow | null> {
    const res = await client.query(
      `SELECT id, voyage_id, manifest_rev, status, box_count, report_seq, report_count,
              frozen_result, created_at, closed_at
         FROM verification_jobs WHERE id=$1`,
      [jobId],
    );
    const row = res.rows[0];
    return row ? mapJobRow(row) : null;
  }

  private async loadVoyageGeometry(client: PoolClient, voyageId: string) {
    const res = await client.query(
      `SELECT voyage_no, n_bays, n_rows, n_tiers
         FROM voyages WHERE id=$1`,
      [voyageId],
    );
    const row = res.rows[0];
    if (!row) {
      throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
    }
    return {
      voyageNo: row.voyage_no as string,
      geometry: {
        bays: Number(row.n_bays),
        rows: Number(row.n_rows),
        tiers: Number(row.n_tiers),
      },
    };
  }

  private async loadManifest(client: PoolClient, voyageId: string, rev: number): Promise<Placement[]> {
    const res = await client.query(
      `SELECT box_no, bay, row, tier FROM manifest_items
        WHERE voyage_id=$1 AND rev=$2 ORDER BY box_no`,
      [voyageId, rev],
    );
    return res.rows.map(
      (r): Placement => ({
        boxNo: r.box_no as string,
        position: { bay: Number(r.bay), row: Number(r.row), tier: Number(r.tier) },
      }),
    );
  }

  /** 由留痕表推导每个箱号“最后一条上报”所确定的当前实装状态 */
  private async loadActualStates(client: PoolClient, jobId: string): Promise<ActualBoxState[]> {
    const res = await client.query(
      `SELECT DISTINCT ON (box_no) box_no, revoked, bay, row, tier
         FROM verification_reports
        WHERE job_id=$1
        ORDER BY box_no, seq DESC`,
      [jobId],
    );
    return res.rows.map((r): ActualBoxState => {
      const revoked = Boolean(r.revoked);
      return {
        boxNo: r.box_no as string,
        position:
          revoked || r.bay === null
            ? null
            : { bay: Number(r.bay), row: Number(r.row), tier: Number(r.tier) },
      };
    });
  }

  private async loadReports(client: PoolClient, jobId: string): Promise<StoredReport[]> {
    const res = await client.query(
      `SELECT seq, report_id, box_no, revoked, bay, row, tier, content_hash, reported_at
         FROM verification_reports WHERE job_id=$1 ORDER BY seq ASC`,
      [jobId],
    );
    return res.rows.map((r) => mapReportRow(r));
  }

  private reportToJson(r: StoredReport) {
    return {
      seq: r.seq,
      reportId: r.reportId,
      boxNo: r.boxNo,
      revoked: r.revoked,
      position: r.position,
      reportedAt: r.reportedAt,
    };
  }

  private jobSummary(job: JobRow, voyageNo: string) {
    return {
      id: job.id,
      voyageId: job.voyage_id,
      voyageNo,
      manifestRevision: job.manifest_rev,
      status: job.status,
      expectedBoxCount: job.box_count,
      reportCount: job.report_count,
      createdAt: job.created_at.toISOString(),
      closedAt: job.closed_at ? job.closed_at.toISOString() : null,
    };
  }

  /**
   * 以航次某修订号“已签发清单”开启核对作业。
   * 清单不存在 -> 404 manifest_not_found（拒绝开工）。
   * 同一清单至多一个作业：重复开启幂等返回既有作业（含已结案作业）。
   */
  async openJob(voyageId: string, manifestRevision: number) {
    if (!Number.isInteger(manifestRevision) || manifestRevision < 0) {
      throw HttpError.badRequest('invalid_revision', 'manifestRevision 必须为非负整数');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { voyageNo } = await this.loadVoyageGeometry(client, voyageId);

      const manifest = await client.query(
        `SELECT rev, box_count FROM manifests WHERE voyage_id=$1 AND rev=$2`,
        [voyageId, manifestRevision],
      );
      if (manifest.rows.length === 0) {
        throw HttpError.notFound(
          'manifest_not_found',
          `航次在修订号 ${manifestRevision} 没有已签发的装载清单，无法开启核对作业`,
        );
      }
      const boxCount = Number(manifest.rows[0].box_count);

      let reused = true;
      let job: JobRow;
      const insert = await client.query(
        `INSERT INTO verification_jobs (voyage_id, manifest_rev, box_count)
         VALUES ($1,$2,$3)
         ON CONFLICT (voyage_id, manifest_rev) DO NOTHING
         RETURNING id, voyage_id, manifest_rev, status, box_count, report_seq, report_count,
                   frozen_result, created_at, closed_at`,
        [voyageId, manifestRevision, boxCount],
      );
      if (insert.rows.length === 1) {
        reused = false;
        job = mapJobRow(insert.rows[0]);
      } else {
        const existing = await client.query(
          `SELECT id, voyage_id, manifest_rev, status, box_count, report_seq, report_count,
                  frozen_result, created_at, closed_at
             FROM verification_jobs WHERE voyage_id=$1 AND manifest_rev=$2`,
          [voyageId, manifestRevision],
        );
        job = mapJobRow(existing.rows[0]);
      }

      await client.query('COMMIT');
      return { reused, job: this.jobSummary(job, voyageNo) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listJobs(voyageId: string) {
    const client = await this.pool.connect();
    try {
      const { voyageNo } = await this.loadVoyageGeometry(client, voyageId);
      const res = await client.query(
        `SELECT id, voyage_id, manifest_rev, status, box_count, report_seq,
                report_count, frozen_result, created_at, closed_at
           FROM verification_jobs
          WHERE voyage_id=$1
          ORDER BY created_at DESC, manifest_rev DESC`,
        [voyageId],
      );
      return res.rows.map((r) => this.jobSummary(mapJobRow(r), voyageNo));
    } finally {
      client.release();
    }
  }

  /** 组装作业详情（含核对明细）。已结案返回冻结快照，未结案实时计算。 */
  private async buildDetail(client: PoolClient, job: JobRow, voyageNo: string) {
    const summary = this.jobSummary(job, voyageNo);
    if (job.status === 'closed' && job.frozen_result) {
      return { ...summary, reconciliation: job.frozen_result };
    }
    const manifest = await this.loadManifest(client, job.voyage_id, job.manifest_rev);
    const actual = await this.loadActualStates(client, job.id);
    return { ...summary, reconciliation: reconcile(manifest, actual) };
  }

  async getJob(jobId: string) {
    const client = await this.pool.connect();
    try {
      const job = await this.getJobNoLock(client, jobId);
      if (!job) throw HttpError.notFound('verification_job_not_found', `核对作业 ${jobId} 不存在`);
      const { voyageNo } = await this.loadVoyageGeometry(client, job.voyage_id);
      return this.buildDetail(client, job, voyageNo);
    } finally {
      client.release();
    }
  }

  /**
   * 受理上报（一个请求可含多条，作为一个顺序批次原子生效）。
   *  - 相同上报号 + 相同内容：幂等，返回原受理结果（不新增留痕）
   *  - 相同上报号 + 不同内容：409 report_conflict
   *  - 作业已结案：新上报 409；已受理上报号仍可幂等重试
   *  - 坐标越界：整批拒绝（400），无副作用
   */
  async submitReports(jobId: string, input: SubmitReportsInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const job = await this.lockJob(client, jobId);
      if (!job) {
        throw HttpError.notFound('verification_job_not_found', `核对作业 ${jobId} 不存在`);
      }
      const { geometry } = await this.loadVoyageGeometry(client, job.voyage_id);

      // 1) 幂等 / 冲突判定（先于结案、越界检查）：已受理上报号恒可重试
      const accepted: Array<{ input: VerificationReportInput; stored: StoredReport }> = [];
      const fresh: VerificationReportInput[] = [];
      for (const rep of input.reports) {
        const existing = await client.query(
          `SELECT seq, report_id, box_no, revoked, bay, row, tier, content_hash, reported_at
             FROM verification_reports WHERE job_id=$1 AND report_id=$2`,
          [jobId, rep.reportId],
        );
        if (existing.rows.length === 1) {
          const stored = mapReportRow(existing.rows[0]);
          const hash = verificationContentHash(rep.boxNo, rep.position);
          if (stored.contentHash !== hash) {
            throw HttpError.reportConflict({
              reportId: rep.reportId,
              original: this.reportToJson(stored),
              attempted: { boxNo: rep.boxNo, revoked: rep.revoked, position: rep.position },
            });
          }
          accepted.push({ input: rep, stored });
        } else {
          fresh.push(rep);
        }
      }

      // 2) 已结案：仅当本批全部为已受理的幂等重试时才放行；任何新上报拒绝
      if (job.status === 'closed' && fresh.length > 0) {
        throw HttpError.jobClosed(undefined, { jobId, closedAt: job.closed_at?.toISOString() ?? null });
      }

      // 3) 新上报坐标越界检查（清单外箱同样受舱位边界约束，整批拒绝）
      const outOfBounds = fresh.filter(
        (r) => r.position !== null && !positionInBounds(r.position, geometry),
      );
      if (outOfBounds.length > 0) {
        throw HttpError.badRequest('invalid_coordinates', '上报坐标超出舱位范围，整批拒绝', {
          bounds: {
            bay: `1..${geometry.bays}`,
            row: `1..${geometry.rows}`,
            tier: `0..${geometry.tiers - 1}`,
          },
          reports: outOfBounds.map((r) => ({ reportId: r.reportId, boxNo: r.boxNo, position: r.position })),
        });
      }

      // 4) 顺序写入新上报（作业内自增 seq），更新作业计数
      let seq = job.report_seq;
      const inserted: StoredReport[] = [];
      for (const rep of fresh) {
        seq += 1;
        const hash = verificationContentHash(rep.boxNo, rep.position);
        const res = await client.query(
          `INSERT INTO verification_reports
             (job_id, seq, report_id, box_no, revoked, bay, row, tier, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING seq, report_id, box_no, revoked, bay, row, tier, content_hash, reported_at`,
          [
            jobId,
            seq,
            rep.reportId,
            rep.boxNo,
            rep.revoked,
            rep.position?.bay ?? null,
            rep.position?.row ?? null,
            rep.position?.tier ?? null,
            hash,
          ],
        );
        inserted.push(mapReportRow(res.rows[0]));
      }

      if (fresh.length > 0) {
        await client.query(
          `UPDATE verification_jobs SET report_seq=$2, report_count=report_count+$3 WHERE id=$1`,
          [jobId, seq, fresh.length],
        );
      }

      await client.query('COMMIT');

      const replayed = accepted.map((a) => this.reportToJson(a.stored));
      const created = inserted.map((r) => this.reportToJson(r));
      return {
        jobId,
        status: job.status,
        acceptedCount: replayed.length + created.length,
        replayedCount: replayed.length,
        createdCount: created.length,
        reports: [...created, ...replayed].sort((a, b) => a.seq - b.seq),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 申请结案：仅当所有清单箱当前坐标与冻结清单一致且无清单外箱时成功并冻结；
   * 否则返回 409 与差异明细，作业继续开放。重复结案已结案作业幂等。
   */
  async closeJob(jobId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const job = await this.lockJob(client, jobId);
      if (!job) {
        throw HttpError.notFound('verification_job_not_found', `核对作业 ${jobId} 不存在`);
      }
      const { voyageNo } = await this.loadVoyageGeometry(client, job.voyage_id);

      // 已结案：幂等返回冻结结果
      if (job.status === 'closed') {
        await client.query('COMMIT');
        return { reused: true, job: await this.buildDetail(client, job, voyageNo) };
      }

      const manifest = await this.loadManifest(client, job.voyage_id, job.manifest_rev);
      const actual = await this.loadActualStates(client, job.id);
      const result = reconcile(manifest, actual);

      if (!result.complete) {
        throw HttpError.verificationNotComplete({
          jobId,
          manifestRevision: job.manifest_rev,
          counts: {
            expected: result.expected.length,
            verified: result.verified.length,
            missing: result.missing.length,
            misplaced: result.misplaced.length,
            extra: result.extra.length,
          },
          reconciliation: result,
        });
      }

      await client.query(
        `UPDATE verification_jobs
            SET status='closed', closed_at=now(), frozen_result=$2 WHERE id=$1`,
        [jobId, JSON.stringify(result)],
      );
      const closed: JobRow = { ...job, status: 'closed', closed_at: new Date(), frozen_result: result };

      await client.query('COMMIT');
      return { reused: false, job: await this.buildDetail(client, closed, voyageNo) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 上报留痕（作业内顺序） */
  async listReports(jobId: string) {
    const client = await this.pool.connect();
    try {
      const job = await this.getJobNoLock(client, jobId);
      if (!job) throw HttpError.notFound('verification_job_not_found', `核对作业 ${jobId} 不存在`);
      const reports = await this.loadReports(client, jobId);
      return {
        jobId,
        manifestRevision: job.manifest_rev,
        status: job.status,
        total: reports.length,
        reports: reports.map((r) => this.reportToJson(r)),
      };
    } finally {
      client.release();
    }
  }
}
