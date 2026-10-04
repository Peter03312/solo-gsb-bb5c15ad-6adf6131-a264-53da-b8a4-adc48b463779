import { z } from 'zod';

const weightString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, '必须为非负十进制数字（单位 kg）')
  .refine((s) => Number(s) > 0, '必须为正数');

const positiveInt = z.number().int('必须为整数').positive('必须为正整数');
const nonNegativeInt = z.number().int('必须为整数').min(0, '必须为非负整数');

export const positionSchema = z.object({
  bay: positiveInt,
  row: positiveInt,
  tier: nonNegativeInt,
});

const moveInputSchema = z.object({
  boxNo: z.string().trim().min(1, '箱号不能为空'),
  position: positionSchema.nullable(),
});

const columnLimitSchema = z.object({
  bay: positiveInt,
  row: positiveInt,
  weightLimit: weightString,
});

const boxSchema = z.object({
  boxNo: z.string().trim().min(1, '箱号不能为空').max(32),
  weight: weightString,
  category: z.string().trim().min(1, '危险品类别不能为空').max(16),
});

const ruleSchema = z.object({
  categoryA: z.string().trim().min(1).max(16),
  categoryB: z.string().trim().min(1).max(16),
  minDistance: positiveInt,
});

const createVoyageInput = z.object({
  voyageNo: z.string().trim().min(1, '航次号不能为空').max(64),
  bays: positiveInt,
  rows: positiveInt,
  tiers: positiveInt,
  defaultColumnWeightLimit: weightString,
  columnWeightLimits: z.array(columnLimitSchema).optional(),
  boxes: z.array(boxSchema).optional(),
  incompatRules: z.array(ruleSchema).optional(),
});

export const createVoyageSchema = createVoyageInput.transform((d) => ({
  voyageNo: d.voyageNo,
  bays: d.bays,
  rows: d.rows,
  tiers: d.tiers,
  defaultColumnWeightLimit: d.defaultColumnWeightLimit,
  columnWeightLimits: d.columnWeightLimits ?? [],
  boxes: d.boxes ?? [],
  incompatRules: d.incompatRules ?? [],
}));

const applyMovesInput = z.object({
  baseRevision: nonNegativeInt,
  moves: z.array(moveInputSchema).optional(),
});

export const applyMovesSchema = applyMovesInput.transform((d) => ({
  baseRevision: d.baseRevision,
  moves: d.moves ?? [],
}));

export const issueManifestSchema = z.object({
  expectedRevision: nonNegativeInt,
});

/* ---------- 现场装船核对 ---------- */

const idString = z.string().trim().min(1, '不能为空').max(64);

/**
 * 上报内容：position 与 revoked 二选一。
 *  - 提供 position：实装到该三维坐标
 *  - revoked:true（或 position:null）：撤销，视为未装
 */
export const verificationReportSchema = z
  .object({
    reportId: idString,
    boxNo: idString.max(32),
    position: positionSchema.nullable().optional(),
    revoked: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    const wantsRevoke = d.revoked === true;
    const hasPosition = d.position !== undefined;
    if (wantsRevoke && hasPosition && d.position !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revoked'],
        message: '撤销上报不得同时携带实装坐标（revoked=true 时 position 必须为空或缺省）',
      });
    }
    if (!wantsRevoke && hasPosition && d.position === null) {
      // position:null 等价于撤销，允许
      return;
    }
    if (!wantsRevoke && !hasPosition) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['position'],
        message: '必须提供实装坐标 position，或显式 revoked:true 表示撤销',
      });
    }
  })
  .transform((d) => ({
    reportId: d.reportId,
    boxNo: d.boxNo,
    revoked: d.revoked === true || d.position === null,
    position: d.revoked === true || d.position === null || d.position === undefined
      ? null
      : d.position,
  }));

export const verificationReportsSchema = z
  .object({ reports: z.array(verificationReportSchema).min(1, '至少包含一条上报') })
  .transform((d) => ({ reports: d.reports }));
