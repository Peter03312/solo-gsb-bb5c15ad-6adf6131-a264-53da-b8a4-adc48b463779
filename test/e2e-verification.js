/* eslint-disable no-console */
// 现场装船核对 端到端验证：embedded-postgres + 真实 Express HTTP
// 运行: node test/e2e-verification.js
const path = require('path');
process.env.SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema.sql');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 30198;
const BASE = `http://127.0.0.1:${PORT}/api`;
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

async function http(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join('/tmp', 'pgdata-e2e-verify'),
    user: 'stowage',
    password: 'stowage',
    port: 54398,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stowage');

  const { createPool, waitForDatabase, initSchema } = require('../dist/src/db');
  const { createApp } = require('../dist/src/app');
  const pool = createPool({
    databaseUrl: 'postgres://stowage:stowage@127.0.0.1:54398/stowage',
    schemaPath: process.env.SCHEMA_PATH,
  });
  await waitForDatabase(pool, 30);
  await initSchema(pool, { schemaPath: process.env.SCHEMA_PATH });
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    /* ---- 准备：登记航次 + 合法布局 + 签发清单 rev=1 ---- */
    const create = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-VERIFY-001',
      bays: 3, rows: 2, tiers: 3,
      defaultColumnWeightLimit: '10000',
      boxes: [
        { boxNo: 'BOX-1', weight: '500', category: '1' },
        { boxNo: 'BOX-2', weight: '600', category: '3' },
        { boxNo: 'BOX-3', weight: '400', category: '5' },
      ],
      incompatRules: [],
    });
    check('登记航次 201', create.status === 201, JSON.stringify(create.body));
    const vid = create.body.id;

    const moves = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'BOX-2', position: { bay: 2, row: 1, tier: 0 } },
        { boxNo: 'BOX-3', position: { bay: 3, row: 1, tier: 0 } },
      ],
    });
    check('布局调整到 rev=1', moves.status === 200 && moves.body.revision === 1);

    const manifest = await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 1 });
    check('签发清单 rev=1', manifest.status === 201 && manifest.body.boxCount === 3);

    /* ---- 1. 清单不存在拒绝开工 ---- */
    const noManifest = await http('POST', `${BASE}/voyages/${vid}/verification-jobs/9`);
    check('对未签发修订号开工 404 manifest_not_found',
      noManifest.status === 404 && noManifest.body.error.code === 'manifest_not_found',
      JSON.stringify(noManifest.body));

    /* ---- 2. 开启作业，重复开启幂等 ---- */
    const opened = await http('POST', `${BASE}/voyages/${vid}/verification-jobs/1`);
    check('首次开启作业 201', opened.status === 201 && opened.body.status === 'open' &&
      opened.body.manifestRevision === 1 && opened.body.expectedBoxCount === 3,
      JSON.stringify(opened.body));
    const jobId = opened.body.id;

    const reopened = await http('POST', `${BASE}/voyages/${vid}/verification-jobs/1`);
    check('同清单重复开启 200 返回同一作业',
      reopened.status === 200 && reopened.body.id === jobId, JSON.stringify(reopened.body));

    const badJobId = await http('GET', `${BASE}/verification-jobs/not-a-uuid`);
    check('非法作业 ID 400', badJobId.status === 400 && badJobId.body.error.code === 'invalid_job_id');
    const missingJob = await http('GET', `${BASE}/verification-jobs/00000000-0000-0000-0000-000000000000`);
    check('未知作业 404', missingJob.status === 404 && missingJob.body.error.code === 'verification_job_not_found');

    /* ---- 3. 初始核对：全部 missing ---- */
    let job = (await http('GET', `${BASE}/verification-jobs/${jobId}`)).body;
    check('初始 expected=3 / missing=3 / verified=0',
      job.reconciliation.expected.length === 3 &&
      job.reconciliation.missing.length === 3 &&
      job.reconciliation.verified.length === 0 &&
      job.reconciliation.complete === false,
      JSON.stringify(job.reconciliation));

    /* ---- 4. 坐标越界拒绝（整批无副作用）---- */
    const oob = await http('POST', `${BASE}/verification-jobs/${jobId}/reports`, {
      reports: [
        { reportId: 'R-OOB', boxNo: 'BOX-1', position: { bay: 9, row: 1, tier: 0 } },
      ],
    });
    check('越界坐标 400 invalid_coordinates',
      oob.status === 400 && oob.body.error.code === 'invalid_coordinates', JSON.stringify(oob.body));
    job = (await http('GET', `${BASE}/verification-jobs/${jobId}`)).body;
    check('越界拒绝后仍无任何上报', job.reportCount === 0);

    /* ---- 5. 上报两条实装 ---- */
    const rep1 = await http('POST', `${BASE}/verification-jobs/${jobId}/reports`, {
      reports: [
        { reportId: 'R-1', boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } },
        { reportId: 'R-2', boxNo: 'BOX-2', position: { bay: 2, row: 1, tier: 0 } },
      ],
    });
    check('受理两条上报 202 createdCount=2',
      rep1.status === 202 && rep1.body.createdCount === 2 && rep1.body.replayedCount === 0,
      JSON.stringify(rep1.body));

    /* ---- 6. 相同上报号+相同内容重试 -> 幂等返回原结果 ---- */
    const retry = await http('POST', `${BASE}/verification-jobs/${jobId}/reports`, {
      reports: [
        { reportId: 'R-1', boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } },
      ],
    });
    check('同号同内容重试幂等 replayedCount=1 seq 不变',
      retry.status === 202 && retry.body.replayedCount === 1 && retry.body.createdCount === 0 &&
      retry.body.reports[0].seq === 1,
      JSON.stringify(retry.body));
    job = (await http('GET', `${BASE}/verification-jobs/${jobId}`)).body;
    check('幂等重试不增加计数', job.reportCount === 2);

    /* ---- 7. 相同上报号+不同内容 -> 409 冲突 ---- */
    const conflict = await http('POST', `${BASE}/verification-jobs/${jobId}/reports`, {
      reports: [
        { reportId: 'R-1', boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 1 } },
      ],
    });
    check('同号异内容 409 report_conflict',
      conflict.status === 409 && conflict.body.error.code === 'report_conflict' &&
      conflict.body.error.details.reportId === 'R-1',
      JSON.stringify(conflict.body));

    const revokeConflict = await http('POST', `${BASE}/verification-jobs/${jobId}/reports`, {
      reports: [{ reportId: 'R-1', boxNo: 'BOX-1', revoked: true }],
    });
    check('实装号改撤销也算冲突 409', revokeConflict.status === 409);

    /* ---- 8. 撤销语义（position:null 与 revoked:true 等价），最后一条为准 ---- */
    const revoke = await http('POST', `${BASE}/verification-jobs/${jobId}/reports`, {
      reports: [{ reportId: 'R-3', boxNo: 'BOX-2', revoked: true }],
    });
    check('撤销 BOX-2 受理', revoke.status === 202 && revoke.body.createdCount === 1);
    job = (await http('GET', `${BASE}/verification-jobs/${jobId}`)).body;
    check('撤销后 BOX-2 归为 missing，BOX-1 verified',
      job.reconciliation.verified.length === 1 &&
      job.reconciliation.verified[0].boxNo === 'BOX-1' &&
      job.reconciliation.missing.some((x) => x.boxNo === 'BOX-2'),
      JSON.stringify(job.reconciliation));

    const putBack = await http('POST', `${BASE}/verification-jobs/${jobId}/reports`, {
      reports: [{ reportId: 'R-4', boxNo: 'BOX-2', position: { bay: 2, row: 1, tier: 0 } }],
    });
    check('再次实装 BOX-2（position:null 与 revoked 等价已验证）', putBack.status === 202);

    /* ---- 9. 上报第三箱 + 清单外箱：不可结案，extra 命中 ---- */
    const withExtra = await http('POST', `${BASE}/verification-jobs/${jobId}/reports`, {
      reports: [
        { reportId: 'R-5', boxNo: 'BOX-3', position: { bay: 3, row: 1, tier: 0 } },
        { reportId: 'R-6', boxNo: 'GHOST', position: { bay: 1, row: 2, tier: 0 } },
      ],
    });
    check('清单箱三箱到位且出现清单外箱', withExtra.status === 202);
    job = (await http('GET', `${BASE}/verification-jobs/${jobId}`)).body;
    check('verified=3, extra=[GHOST], complete=false',
      job.reconciliation.verified.length === 3 &&
      job.reconciliation.extra.length === 1 &&
      job.reconciliation.extra[0].boxNo === 'GHOST' &&
      job.reconciliation.complete === false,
      JSON.stringify(job.reconciliation));

    /* ---- 10. 有差异时结案被拒，作业继续开放 ---- */
    const closeFail = await http('POST', `${BASE}/verification-jobs/${jobId}/close`);
    check('有清单外箱结案 409 verification_not_complete 且含差异',
      closeFail.status === 409 &&
      closeFail.body.error.code === 'verification_not_complete' &&
      closeFail.body.error.details.reconciliation.extra.length === 1,
      JSON.stringify(closeFail.body));
    job = (await http('GET', `${BASE}/verification-jobs/${jobId}`)).body;
    check('结案失败后作业仍 open', job.status === 'open');

    /* ---- 11. 撤销清单外箱后，完全一致，结案冻结 ---- */
    const removeExtra = await http('POST', `${BASE}/verification-jobs/${jobId}/reports`, {
      reports: [{ reportId: 'R-7', boxNo: 'GHOST', position: null }],
    });
    check('撤销清单外箱', removeExtra.status === 202);
    job = (await http('GET', `${BASE}/verification-jobs/${jobId}`)).body;
    check('撤销后 extra 清空 complete=true',
      job.reconciliation.extra.length === 0 && job.reconciliation.complete === true);

    const closed = await http('POST', `${BASE}/verification-jobs/${jobId}/close`);
    check('结案成功 201 且 status=closed verified=3',
      closed.status === 201 && closed.body.status === 'closed' &&
      closed.body.reconciliation.verified.length === 3 &&
      closed.body.closedAt !== null,
      JSON.stringify(closed.body));

    const closeAgain = await http('POST', `${BASE}/verification-jobs/${jobId}/close`);
    check('重复结案幂等 200', closeAgain.status === 200 && closeAgain.body.status === 'closed');

    /* ---- 12. 结案后拒绝新上报，已受理上报号仍可重试 ---- */
    const afterCloseNew = await http('POST', `${BASE}/verification-jobs/${jobId}/reports`, {
      reports: [{ reportId: 'R-NEW', boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } }],
    });
    check('结案后新上报 409 verification_job_closed',
      afterCloseNew.status === 409 && afterCloseNew.body.error.code === 'verification_job_closed',
      JSON.stringify(afterCloseNew.body));

    const afterCloseReplay = await http('POST', `${BASE}/verification-jobs/${jobId}/reports`, {
      reports: [{ reportId: 'R-1', boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } }],
    });
    check('结案后已受理上报号同内容仍可重试 202',
      afterCloseReplay.status === 202 && afterCloseReplay.body.replayedCount === 1,
      JSON.stringify(afterCloseReplay.body));

    const afterCloseConflict = await http('POST', `${BASE}/verification-jobs/${jobId}/reports`, {
      reports: [{ reportId: 'R-1', boxNo: 'BOX-1', position: { bay: 2, row: 1, tier: 0 } }],
    });
    check('结案后同号异内容仍 409 冲突', afterCloseConflict.status === 409);

    /* ---- 13. 上报留痕：以箱号最后一条确定当前状态 ---- */
    const trail = await http('GET', `${BASE}/verification-jobs/${jobId}/reports`);
    const box2Trail = trail.body.reports.filter((r) => r.boxNo === 'BOX-2').map((r) => r.revoked);
    check('留痕完整（BOX-2：实装->撤销->实装，末条非撤销）',
      trail.status === 200 && trail.body.total === 7 &&
      JSON.stringify(box2Trail) === JSON.stringify([false, true, false]),
      JSON.stringify({ total: trail.body.total, box2Trail }));

    /* ---- 14. 核对基准不随后续布局调整/新签发改变 ---- */
    // 结案后再调整布局 rev1 -> rev2，并签发新清单 rev2；原作业仍冻结在 rev1
    const adjust = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'BOX-3', position: { bay: 3, row: 2, tier: 0 } }],
    });
    check('结案后布局调整到 rev=2', adjust.status === 200 && adjust.body.revision === 2);
    const manifest2 = await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 2 });
    check('签发新清单 rev=2', manifest2.status === 201);

    job = (await http('GET', `${BASE}/verification-jobs/${jobId}`)).body;
    check('原作业核对基准仍是 rev=1 且结果冻结',
      job.manifestRevision === 1 && job.status === 'closed' &&
      job.reconciliation.verified.length === 3,
      JSON.stringify({ rev: job.manifestRevision, status: job.status }));

    // 新清单开启独立作业，与旧作业并存
    const job2 = await http('POST', `${BASE}/voyages/${vid}/verification-jobs/2`);
    check('可对新清单 rev=2 开启第二个作业',
      job2.status === 201 && job2.body.id !== jobId && job2.body.manifestRevision === 2);
    const list = await http('GET', `${BASE}/voyages/${vid}/verification-jobs`);
    check('作业列表含两个作业', list.status === 200 && list.body.length === 2);

    /* ---- 15. 错位（misplaced）分类 ---- */
    const job2Id = job2.body.id;
    const mis = await http('POST', `${BASE}/verification-jobs/${job2Id}/reports`, {
      reports: [
        { reportId: 'J2-1', boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } },
        { reportId: 'J2-2', boxNo: 'BOX-2', position: { bay: 2, row: 1, tier: 0 } },
        // rev2 清单中 BOX-3 在 (3,2,0)，故意报到 (3,1,0)
        { reportId: 'J2-3', boxNo: 'BOX-3', position: { bay: 3, row: 1, tier: 0 } },
      ],
    });
    check('job2 上报三箱', mis.status === 202);
    const job2detail = (await http('GET', `${BASE}/verification-jobs/${job2Id}`)).body;
    check('BOX-3 判为 misplaced（应装 3/2/0，实装 3/1/0）',
      job2detail.reconciliation.misplaced.length === 1 &&
      job2detail.reconciliation.misplaced[0].boxNo === 'BOX-3' &&
      job2detail.reconciliation.misplaced[0].expectedPosition.row === 2 &&
      job2detail.reconciliation.misplaced[0].actualPosition.row === 1,
      JSON.stringify(job2detail.reconciliation.misplaced));

    /* ---- 16. 并发上报与结案顺序生效 ---- */
    // 先修正 job2 使其一致
    await http('POST', `${BASE}/verification-jobs/${job2Id}/reports`, {
      reports: [{ reportId: 'J2-4', boxNo: 'BOX-3', position: { bay: 3, row: 2, tier: 0 } }],
    });
    // 并发：结案 与 一个会制造错位的新上报；只可能有一个“决定最终态”
    const [closeRes, concReport] = await Promise.all([
      http('POST', `${BASE}/verification-jobs/${job2Id}/close`),
      http('POST', `${BASE}/verification-jobs/${job2Id}/reports`, {
        reports: [{ reportId: 'J2-5', boxNo: 'BOX-3', position: { bay: 1, row: 1, tier: 1 } }],
      }),
    ]);
    const finalJob = (await http('GET', `${BASE}/verification-jobs/${job2Id}`)).body;
    const serialized =
      // 若结案先生效：结案 201，随后上报因作业关闭被 409；最终 closed 且 verified=3
      (closeRes.status === 201 && concReport.status === 409 &&
        finalJob.status === 'closed' && finalJob.reconciliation.verified.length === 3) ||
      // 若上报先生效：上报 202 制造错位，结案因差异 409；最终 open 且 BOX-3 misplaced
      (concReport.status === 202 && closeRes.status === 409 &&
        finalJob.status === 'open' && finalJob.reconciliation.misplaced.length === 1);
    check('并发结案+上报顺序生效（二者之一先，状态自洽）', serialized,
      JSON.stringify({ close: closeRes.status, report: concReport.status, final: finalJob.status }));

    /* ---- 17. 兼容性：原有布局/清单/历史接口不受影响 ---- */
    const history = await http('GET', `${BASE}/voyages/${vid}/layout?rev=1`);
    check('历史布局 rev=1 仍可查', history.status === 200 && history.body.revision === 1);
    const manifests = await http('GET', `${BASE}/voyages/${vid}/manifests`);
    check('清单列表保留 rev=1,2', manifests.status === 200 && manifests.body.length === 2);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('E2E 异常:', e);
    process.exitCode = 1;
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
    await pg.stop();
  }
}

main();
