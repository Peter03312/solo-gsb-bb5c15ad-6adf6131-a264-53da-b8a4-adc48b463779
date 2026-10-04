#!/usr/bin/env bash
# 现场装船核对 —— curl 调用示例
# 用法: BASE=http://localhost:3000 bash examples/curl-verification.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }

# ---- 准备：登记航次 -> 合法布局 -> 签发清单 rev=1 ----
say "登记航次 V-VERIFY-001"
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-VERIFY-001",
  "bays": 3, "rows": 2, "tiers": 3,
  "defaultColumnWeightLimit": "10000",
  "boxes": [
    { "boxNo": "BOX-1", "weight": "500", "category": "1" },
    { "boxNo": "BOX-2", "weight": "600", "category": "3" },
    { "boxNo": "BOX-3", "weight": "400", "category": "5" }
  ],
  "incompatRules": []
}')
echo "$VOYAGE_JSON"
VID=$(echo "$VOYAGE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

say "布局调整（rev 0 -> 1，三箱全部配位）"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-2", "position": { "bay": 2, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-3", "position": { "bay": 3, "row": 1, "tier": 0 } }
  ]
}' >/dev/null
echo done

say "签发装载清单（冻结 rev=1）"
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' \
  -d '{ "expectedRevision": 1 }' | head -c 300; echo

# ---- 1) 清单不存在拒绝开工 ----
say "1) 对未签发修订号 rev=9 开工 -> 404 manifest_not_found"
curl -sS -X POST "$API/voyages/$VID/verification-jobs/9"; echo

# ---- 2) 以 rev=1 已签发清单开启核对作业 ----
say "2) 开启核对作业（基准=清单 rev=1；重复开启幂等返回同一作业）"
JOB_JSON=$(curl -sS -X POST "$API/voyages/$VID/verification-jobs/1")
echo "$JOB_JSON"
JID=$(echo "$JOB_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "jobId=$JID"
say "   重复开启 -> 200 同一作业"
curl -sS -X POST "$API/voyages/$VID/verification-jobs/1" | head -c 300; echo

# ---- 3) 初始核对：全部缺失 ----
say "3) 查询核对明细（尚未上报：三箱均 missing）"
curl -sS "$API/verification-jobs/$JID" | head -c 800; echo

# ---- 4) 坐标越界拒绝 ----
say "4) 上报越界坐标 -> 400 invalid_coordinates（整批拒绝）"
curl -sS -X POST "$API/verification-jobs/$JID/reports" -H 'content-type: application/json' -d '{
  "reports": [
    { "reportId": "R-OOB", "boxNo": "BOX-1", "position": { "bay": 99, "row": 1, "tier": 0 } }
  ]
}'; echo

# ---- 5) 上报实装 ----
say "5) 上报 BOX-1、BOX-2 实装（202，createdCount=2）"
curl -sS -X POST "$API/verification-jobs/$JID/reports" -H 'content-type: application/json' -d '{
  "reports": [
    { "reportId": "R-1", "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "reportId": "R-2", "boxNo": "BOX-2", "position": { "bay": 2, "row": 1, "tier": 0 } }
  ]
}'; echo

# ---- 6) 同号同内容重试：幂等 ----
say "6) 相同上报号+相同内容重试 -> 202 replayedCount=1（返回原结果，不新增留痕）"
curl -sS -X POST "$API/verification-jobs/$JID/reports" -H 'content-type: application/json' -d '{
  "reports": [
    { "reportId": "R-1", "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } }
  ]
}'; echo

# ---- 7) 同号异内容：冲突 ----
say "7) 相同上报号+不同内容 -> 409 report_conflict"
curl -sS -X POST "$API/verification-jobs/$JID/reports" -H 'content-type: application/json' -d '{
  "reports": [
    { "reportId": "R-1", "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 1 } }
  ]
}'; echo

# ---- 8) 撤销：BOX-2 撤销后再装回（以箱号最后一条为准）----
say "8) 撤销 BOX-2（revoked:true；position:null 等价）-> 归为 missing"
curl -sS -X POST "$API/verification-jobs/$JID/reports" -H 'content-type: application/json' -d '{
  "reports": [ { "reportId": "R-3", "boxNo": "BOX-2", "revoked": true } ]
}' >/dev/null
curl -sS -X POST "$API/verification-jobs/$JID/reports" -H 'content-type: application/json' -d '{
  "reports": [ { "reportId": "R-4", "boxNo": "BOX-2", "position": { "bay": 2, "row": 1, "tier": 0 } } ]
}' >/dev/null
echo "BOX-2 已重新实装"

# ---- 9) 第三箱到位 + 一个清单外箱 ----
say "9) BOX-3 到位并上报一个清单外箱 GHOST（-> extra，尚不可结案）"
curl -sS -X POST "$API/verification-jobs/$JID/reports" -H 'content-type: application/json' -d '{
  "reports": [
    { "reportId": "R-5", "boxNo": "BOX-3", "position": { "bay": 3, "row": 1, "tier": 0 } },
    { "reportId": "R-6", "boxNo": "GHOST", "position": { "bay": 1, "row": 2, "tier": 0 } }
  ]
}'; echo

say "   申请结案 -> 409 verification_not_complete（返回差异，作业继续开放）"
curl -sS -X POST "$API/verification-jobs/$JID/close"; echo

# ---- 10) 撤销清单外箱后结案冻结 ----
say "10) 撤销清单外箱后完全一致 -> 结案 201 并冻结"
curl -sS -X POST "$API/verification-jobs/$JID/reports" -H 'content-type: application/json' -d '{
  "reports": [ { "reportId": "R-7", "boxNo": "GHOST", "position": null } ]
}' >/dev/null
curl -sS -X POST "$API/verification-jobs/$JID/close" | head -c 800; echo

# ---- 11) 结案后：拒绝新上报，已受理号可重试 ----
say "11) 结案后新上报 -> 409；已受理上报号 R-1 同内容仍可重试 -> 202"
curl -sS -X POST "$API/verification-jobs/$JID/reports" -H 'content-type: application/json' -d '{
  "reports": [ { "reportId": "R-NEW", "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } } ]
}'; echo
curl -sS -X POST "$API/verification-jobs/$JID/reports" -H 'content-type: application/json' -d '{
  "reports": [ { "reportId": "R-1", "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } } ]
}'; echo

# ---- 12) 上报留痕 ----
say "12) 上报留痕（作业内顺序，撤销/重试均可追溯）"
curl -sS "$API/verification-jobs/$JID/reports" | head -c 800; echo
