import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActualBoxState,
  Placement,
  Position,
  reconcile,
  verificationContentHash,
} from '../src/domain';

const pos = (bay: number, row: number, tier: number): Position => ({ bay, row, tier });

// 冻结清单：A、B、C 三个箱的应装位置
const manifest: Placement[] = [
  { boxNo: 'A', position: pos(1, 1, 0) },
  { boxNo: 'B', position: pos(2, 1, 0) },
  { boxNo: 'C', position: pos(3, 1, 0) },
];

test('全部一致：全部 verified 且可结案', () => {
  const actual: ActualBoxState[] = [
    { boxNo: 'A', position: pos(1, 1, 0) },
    { boxNo: 'B', position: pos(2, 1, 0) },
    { boxNo: 'C', position: pos(3, 1, 0) },
  ];
  const r = reconcile(manifest, actual);
  assert.equal(r.verified.length, 3);
  assert.equal(r.missing.length, 0);
  assert.equal(r.misplaced.length, 0);
  assert.deepEqual(r.extra, []);
  assert.equal(r.complete, true);
  assert.equal(r.expected.length, 3);
});

test('无任何上报：清单箱全部 missing，不可结案', () => {
  const r = reconcile(manifest, []);
  assert.equal(r.missing.length, 3);
  assert.equal(r.verified.length, 0);
  assert.equal(r.complete, false);
  assert.deepEqual(
    r.missing.map((x) => x.boxNo),
    ['A', 'B', 'C'],
  );
});

test('撤销即未装：最后一条为撤销的清单箱计入 missing', () => {
  const actual: ActualBoxState[] = [
    { boxNo: 'A', position: pos(1, 1, 0) },
    { boxNo: 'B', position: null }, // 撤销
    { boxNo: 'C', position: pos(3, 1, 0) },
  ];
  const r = reconcile(manifest, actual);
  assert.equal(r.verified.length, 2);
  assert.deepEqual(r.missing.map((x) => x.boxNo), ['B']);
  assert.equal(r.missing[0]!.actualPosition, null);
  assert.equal(r.complete, false);
});

test('坐标不一致：misplaced 并给出应装/实装坐标', () => {
  const actual: ActualBoxState[] = [
    { boxNo: 'A', position: pos(1, 1, 0) },
    { boxNo: 'B', position: pos(2, 2, 0) }, // 行错位
    { boxNo: 'C', position: pos(3, 1, 0) },
  ];
  const r = reconcile(manifest, actual);
  assert.equal(r.misplaced.length, 1);
  const m = r.misplaced[0]!;
  assert.equal(m.boxNo, 'B');
  assert.deepEqual(m.expectedPosition, pos(2, 1, 0));
  assert.deepEqual(m.actualPosition, pos(2, 2, 0));
  assert.equal(r.complete, false);
});

test('清单外实装箱计入 extra；撤销的清单外箱不计入', () => {
  const actual: ActualBoxState[] = [
    { boxNo: 'A', position: pos(1, 1, 0) },
    { boxNo: 'B', position: pos(2, 1, 0) },
    { boxNo: 'C', position: pos(3, 1, 0) },
    { boxNo: 'X', position: pos(1, 2, 0) }, // 清单外实装
    { boxNo: 'Y', position: null },        // 清单外但已撤销
  ];
  const r = reconcile(manifest, actual);
  assert.equal(r.verified.length, 3);
  assert.deepEqual(r.extra.map((x) => x.boxNo), ['X']);
  assert.equal(r.complete, false);
});

test('完全一致但有清单外箱：仍不可结案', () => {
  const actual: ActualBoxState[] = [
    { boxNo: 'A', position: pos(1, 1, 0) },
    { boxNo: 'B', position: pos(2, 1, 0) },
    { boxNo: 'C', position: pos(3, 1, 0) },
    { boxNo: 'X', position: pos(2, 2, 1) },
  ];
  const r = reconcile(manifest, actual);
  assert.equal(r.missing.length, 0);
  assert.equal(r.misplaced.length, 0);
  assert.equal(r.extra.length, 1);
  assert.equal(r.complete, false);
});

test('撤销清单外箱后即可结案', () => {
  const actual: ActualBoxState[] = [
    { boxNo: 'A', position: pos(1, 1, 0) },
    { boxNo: 'B', position: pos(2, 1, 0) },
    { boxNo: 'C', position: pos(3, 1, 0) },
    { boxNo: 'X', position: null },
  ];
  const r = reconcile(manifest, actual);
  assert.deepEqual(r.extra, []);
  assert.equal(r.complete, true);
});

test('空清单：无实装即可结案；有实装即清单外不可结案', () => {
  assert.equal(reconcile([], []).complete, true);
  const withExtra = reconcile([], [{ boxNo: 'X', position: pos(1, 1, 0) }]);
  assert.equal(withExtra.extra.length, 1);
  assert.equal(withExtra.complete, false);
});

test('内容指纹：坐标相同才相同；撤销与坐标互不相同', () => {
  assert.equal(
    verificationContentHash('A', pos(1, 1, 0)),
    verificationContentHash('A', pos(1, 1, 0)),
  );
  assert.notEqual(
    verificationContentHash('A', pos(1, 1, 0)),
    verificationContentHash('A', pos(1, 1, 1)),
  );
  assert.notEqual(
    verificationContentHash('A', pos(1, 1, 0)),
    verificationContentHash('A', null),
  );
  assert.notEqual(
    verificationContentHash('A', null),
    verificationContentHash('B', null),
  );
});
