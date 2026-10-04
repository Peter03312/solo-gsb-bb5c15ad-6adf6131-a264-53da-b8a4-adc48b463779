-- 船舶危险货箱配载审定服务 初始化结构
-- 幂等：可重复执行

CREATE TABLE IF NOT EXISTS voyages (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voyage_no            TEXT NOT NULL UNIQUE,
    n_bays               INTEGER NOT NULL CHECK (n_bays > 0),
    n_rows               INTEGER NOT NULL CHECK (n_rows > 0),
    n_tiers              INTEGER NOT NULL CHECK (n_tiers > 0),
    default_column_limit BIGINT NOT NULL CHECK (default_column_limit > 0), -- 毫克 (1kg = 1e6)
    rev                  INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 各列承重上限覆盖值（bay+row 维度的“列”）
CREATE TABLE IF NOT EXISTS column_weight_limits (
    voyage_id    UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    bay          INTEGER NOT NULL CHECK (bay >= 1),
    row          INTEGER NOT NULL CHECK (row >= 1),
    weight_limit BIGINT NOT NULL CHECK (weight_limit > 0), -- 毫克
    PRIMARY KEY (voyage_id, bay, row)
);

CREATE TABLE IF NOT EXISTS boxes (
    voyage_id  UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    box_no     TEXT NOT NULL,
    weight_ug  BIGINT NOT NULL CHECK (weight_ug > 0), -- 毫克
    category   TEXT NOT NULL,
    PRIMARY KEY (voyage_id, box_no)
);

-- 不相容类别对 -> 正整数最小曼哈顿距离（未登记的类别对视为相容）
CREATE TABLE IF NOT EXISTS incompat_rules (
    voyage_id    UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    cat_a        TEXT NOT NULL,
    cat_b        TEXT NOT NULL,
    min_distance INTEGER NOT NULL CHECK (min_distance > 0),
    PRIMARY KEY (voyage_id, cat_a, cat_b),
    CHECK (cat_a <= cat_b)
);

-- 配载布局按修订号全量留痕：每接受一批调整即产生一个新修订号，
-- 该修订号下的布局由 placements 中 (voyage_id, rev) 的所有行完整表示。
CREATE TABLE IF NOT EXISTS placements (
    voyage_id UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    rev       INTEGER NOT NULL CHECK (rev >= 0),
    box_no    TEXT NOT NULL,
    bay       INTEGER NOT NULL CHECK (bay >= 1),
    row       INTEGER NOT NULL CHECK (row >= 1),
    tier      INTEGER NOT NULL CHECK (tier >= 0),
    PRIMARY KEY (voyage_id, rev, box_no),
    UNIQUE (voyage_id, rev, bay, row, tier)
);
CREATE INDEX IF NOT EXISTS idx_placements_rev ON placements (voyage_id, rev);

-- 装载清单（签发后内容冻结到该修订号的布局；空布局亦可签发，但要求所有箱已配位）
CREATE TABLE IF NOT EXISTS manifests (
    voyage_id  UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    rev        INTEGER NOT NULL CHECK (rev >= 0),
    issued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    box_count  INTEGER NOT NULL CHECK (box_count >= 0),
    PRIMARY KEY (voyage_id, rev)
);

CREATE TABLE IF NOT EXISTS manifest_items (
    voyage_id UUID NOT NULL,
    rev       INTEGER NOT NULL,
    box_no    TEXT NOT NULL,
    bay       INTEGER NOT NULL,
    row       INTEGER NOT NULL,
    tier      INTEGER NOT NULL,
    PRIMARY KEY (voyage_id, rev, box_no),
    FOREIGN KEY (voyage_id, rev) REFERENCES manifests (voyage_id, rev) ON DELETE CASCADE
);
