# 船舶危险货箱配载审定服务

TypeScript / Node.js + PostgreSQL 实现的危险货箱三维舱位配载审定（stowage plan approval）HTTP 服务。

调度员按**修订号（乐观并发）**整批调整箱位，服务仅按**最终布局**一次性校验全部规则，任一违反即**整批拒绝**并指出相关箱号、舱位与原因；签发装载清单时内容冻结到当时修订号，旧清单永久保留。

---

## 1. 模型与规则

### 坐标系（三维舱位）

| 维度 | 字段 | 取值 |
| --- | --- | --- |
| 舱/贝 | `bay` | `1..bays` |
| 列 | `row` | `1..rows` |
| 层（自底向上） | `tier` | `0..tiers-1`，底层为 `tier=0` |

“列”指同一 `(bay, row)` 下垂直堆叠的一列箱。两箱位距离为三维曼哈顿距离：

```
d = |Δbay| + |Δrow| + |Δtier|
```

### 登记数据

- 航次三维舱位尺寸 `bays / rows / tiers`；
- 各列承重上限：默认上限 + 按 `(bay,row)` 覆盖的单列上限（重量单位 kg，支持最多 6 位小数，内部以整数存储，无浮点误差）；
- 箱号、重量（正数）、危险品类别；
- 不相容类别对的**正整数**最小曼哈顿距离；**未设定的类别对视为相容**。

### 整批调整语义

- 每次提交携带调度员所见的 `baseRevision`；
- 一批中可包含任意多条 `{boxNo, position}`，`position=null` 表示该箱**暂留空（撤位）**；
- **允许同批交换**：以最终布局为准（先撤后放只是计算方式，不存在“中间态冲突”）；
- 未出现在批次中的箱保持原位；
- 箱位可以留空（未配位），仅在**签发清单**时要求所有箱已配位。

### 最终布局校验规则（任一违反则整批拒绝）

1. **一箱至多一位**（同一箱在最终布局中不得出现两次）；
2. **一位至多一箱**（同一三维坐标不得放两个箱）；
3. **各列自底向上连续占用**：同列占用层必须恰好为 `tier 0..k-1`，不得悬空；
4. **列总重量不超上限**：按默认/单列上限逐列核算；
5. **不相容类别对距离**：两箱曼哈顿距离必须 ≥ 设定的最小距离。

### 请求级错误（HTTP 400 / 409）

- 未知箱号 → `unknown_box`；
- 坐标越界、重量非法 → `invalid_coordinates` / 请求体校验错误；
- 同一批中同一箱号出现多次 → `duplicate_box_in_batch`；
- `baseRevision` 与当前修订号不一致 → **409 `stale_revision`**（响应中给出当前修订号）。

### 修订号与清单

- 初始修订号为 `0`（空布局）；每接受一批合法调整，修订号 +1，历史布局全量留痕可查；
- 事务内对航次行 `SELECT ... FOR UPDATE`，并发提交只有一个能成功，其余得到 409；
- 签发要求**所有箱已配位**（否则 422 `unplaced_boxes`），且 `expectedRevision` 必须等于当前修订号；
- 清单内容**复制冻结**到独立的 `manifest_items`，之后调整布局不影响旧清单；
- 旧清单继续可查，列表中以 `current` 标识其是否指向当前修订号——因此**永远不存在指向过期布局的“当前清单”**；
- 对同一修订号重复签发幂等（返回已冻结的清单）。

---

## 2. 一键启动（Docker Compose）

前置：Docker 20.10+（支持 Compose v2）。

```bash
# 在项目根目录
docker compose up --build -d
```

启动后：

- API 服务：`http://localhost:3000`
- 健康检查：`http://localhost:3000/health`
- PostgreSQL：`localhost:5432`（库/用户/密码默认均为 `stowage`，数据持久化在命名卷 `stowage-pgdata`）

应用容器会等待数据库健康、自动执行幂等的 `src/schema.sql` 建表，无需手动初始化。

停止与清理：

```bash
docker compose down          # 停止，保留数据
docker compose down -v       # 停止并删除数据库卷
```

### 配置（环境变量 / `.env`）

复制 `.env.example` 为 `.env` 后由 Compose 自动读取：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `API_PORT` | `3000` | API 对宿主端口 |
| `DB_PORT` | `5432` | PostgreSQL 对宿主端口 |
| `POSTGRES_USER` | `stowage` | 数据库用户 |
| `POSTGRES_PASSWORD` | `stowage` | 数据库密码 |
| `POSTGRES_DB` | `stowage` | 数据库名 |
| `PORT`（容器内） | `3000` | 服务监听端口 |
| `DATABASE_URL` | 指向 `db:5432` | 应用连接串 |
| `DB_STARTUP_TIMEOUT_SEC` | `60` | 等待数据库就绪最长秒数 |
| `SCHEMA_PATH` | `/app/src/schema.sql` | 建表脚本路径 |

---

## 3. 本地开发（不用 Docker）

```bash
npm install
npm run build      # tsc 编译到 dist/
# 需自行准备 PostgreSQL 14+，并设置连接串，例如：
export DATABASE_URL='postgres://stowage:stowage@localhost:5432/stowage'
npm start          # 启动（自动等待 DB + 建表）

npm run dev        # 或 tsx watch 热重载
npm test           # 纯函数校验规则单元测试（11 个）
```

---

## 4. HTTP API

基址 `/api`，请求/响应均为 JSON。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/voyages` | 登记航次（舱位、列承重、箱、不相容规则） |
| `GET` | `/api/voyages` | 航次列表 |
| `GET` | `/api/voyages/:id` | 航次元数据（含当前修订号） |
| `GET` | `/api/voyages/:id/layout?rev=N` | 查看布局（缺省当前修订号；可查历史） |
| `POST` | `/api/voyages/:id/moves` | **整批调整**（携带 `baseRevision`） |
| `POST` | `/api/voyages/:id/manifests` | **签发装载清单**（携带 `expectedRevision`） |
| `GET` | `/api/voyages/:id/manifests` | 清单列表（旧清单保留，带 `current` 标记） |
| `GET` | `/api/voyages/:id/manifests/:rev` | 取某修订号的冻结清单 |
| `GET` | `/health` | 健康检查（含数据库连通性） |

### 4.1 登记航次

```bash
curl -sS -X POST http://localhost:3000/api/voyages \
  -H 'content-type: application/json' -d '{
  "voyageNo": "V-2026-001",
  "bays": 3, "rows": 2, "tiers": 3,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [
    { "bay": 1, "row": 1, "weightLimit": "1200" }
  ],
  "boxes": [
    { "boxNo": "BOX-1", "weight": "500",    "category": "1" },
    { "boxNo": "BOX-2", "weight": "600",    "category": "3" },
    { "boxNo": "BOX-3", "weight": "400",    "category": "5" },
    { "boxNo": "BOX-4", "weight": "300.25", "category": "1" }
  ],
  "incompatRules": [
    { "categoryA": "1", "categoryB": "3", "minDistance": 3 }
  ]
}'
```

响应（修订号初始为 0）：

```json
{ "id": "…uuid…", "voyageNo": "V-2026-001", "bays": 3, "rows": 2, "tiers": 3,
  "defaultColumnWeightLimit": "10000", "revision": 0, "createdAt": "…" }
```

### 4.2 整批调整（合法）

```bash
curl -sS -X POST http://localhost:3000/api/voyages/<id>/moves \
  -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-2", "position": { "bay": 3, "row": 2, "tier": 0 } },
    { "boxNo": "BOX-3", "position": { "bay": 2, "row": 2, "tier": 0 } },
    { "boxNo": "BOX-4", "position": { "bay": 1, "row": 1, "tier": 1 } }
  ]
}'
```

`position: null` 表示把该箱撤下留空。成功返回新修订号与完整新布局。

### 4.3 规则违反：整批拒绝（422，含箱号/舱位/原因）

```json
{
  "error": {
    "code": "validation_failed",
    "message": "配载校验未通过，共 1 项违反，整批调整已拒绝",
    "details": {
      "violationCount": 1,
      "violations": [
        {
          "reason": "incompatible_too_close",
          "message": "不相容类别箱 BOX-1(1类) 与 BOX-2(3类) 曼哈顿距离为 1，要求至少 3",
          "boxA": "BOX-1", "boxB": "BOX-2",
          "categoryA": "1", "categoryB": "3",
          "positionA": { "bay": 1, "row": 1, "tier": 0 },
          "positionB": { "bay": 2, "row": 1, "tier": 0 },
          "distance": 1, "minDistance": 3
        }
      ]
    }
  }
}
```

违反原因码：

| `reason` | 含义 | 关键定位字段 |
| --- | --- | --- |
| `box_duplicated` | 一箱多位 | `boxNo`, `positions[]` |
| `position_collision` | 一位多箱 | `position`, `boxNos[]` |
| `column_not_continuous` | 列未自底向上连续/悬空 | `bay`,`row`,`occupiedTiers`,`missingTiers`,`boxNos[]` |
| `column_overweight` | 列总重超限 | `bay`,`row`,`totalWeight`,`weightLimit`,`boxNos[]` |
| `incompatible_too_close` | 不相容箱距离不足 | `boxA`,`boxB`,`positionA`,`positionB`,`distance`,`minDistance` |

### 4.4 过期修订号（409）

```json
{
  "error": {
    "code": "stale_revision",
    "message": "修订号已过期：携带的 0 与当前修订号 2 不一致，请重新读取最新布局后再提交",
    "details": { "expectedRevision": 0, "currentRevision": 2 }
  }
}
```

### 4.5 签发与冻结

```bash
curl -sS -X POST http://localhost:3000/api/voyages/<id>/manifests \
  -H 'content-type: application/json' -d '{ "expectedRevision": 4 }'
```

返回冻结清单（`current:true`）。之后再调整布局，重新 `GET /manifests` 可见旧清单 `current:false` 仍在；只有再次签发才会产生指向当前布局的新清单。

### 状态码约定

| 状态 | 场景 |
| --- | --- |
| 200 / 201 | 查询成功 / 创建或首次签发成功（同修订号重复签发返回 200） |
| 400 | 请求体非法、未知箱、坐标越界、同批重复箱号 |
| 404 | 航次/修订号/清单不存在 |
| 409 | 修订号过期（乐观并发冲突） |
| 422 | 配载规则违反整批拒绝；或尚有箱未配位即签发 |
| 503 | `/health` 数据库不可达 |

---

## 5. 调用示例

- `examples/curl-examples.sh` —— 全流程 curl（登记→违规拒绝→合法整批→同批交换→撤位→签发→后续调整→旧清单）：

  ```bash
  BASE=http://localhost:3000 bash examples/curl-examples.sh
  ```

- `examples/api.http` —— REST Client / JetBrains HTTP Client 文件；
- `examples/demo.ts` —— Node 示例（内置 fetch）：

  ```bash
  BASE=http://localhost:3000 npx tsx examples/demo.ts
  ```

---

## 6. 项目结构

```
src/
  domain.ts        领域模型 + 纯函数规则校验（最终布局五项规则、请求级检查、十进制重量）
  service.ts       事务编排：乐观修订号、整批调整、签发冻结、并发互斥
  db.ts            连接池、等待就绪、幂等建表
  schema.sql       PostgreSQL 表结构（航次/列限/箱/不相容规则/修订布局/清单）
  http/            Express 路由与 zod 请求校验
  config.ts errors.ts app.ts start.ts
test/
  validator.test.ts  规则单元测试（node --test）
  e2e.js             对真实 PostgreSQL 的端到端/并发验证（开发辅助）
examples/          curl / .http / Node 调用示例
Dockerfile  docker-compose.yml
```

### 存储要点

- `voyages.rev` 为当前修订号；`placements` 按 `(voyage_id, rev)` 全量保存每个接受批次后的完整布局（历史可追溯）；
- `manifests` + `manifest_items` 保存签发时刻的**独立冻结副本**，与后续布局解耦；
- 重量以 `BIGINT` 微千克（1kg = 10⁶）存储，精确支持小数重量。
