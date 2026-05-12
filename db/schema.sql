-- ════════════════════════════════════════════════════
--  מי הגליל GIS — Supabase Schema
--  הפעל את הקובץ הזה ב: Supabase → SQL Editor → Run
-- ════════════════════════════════════════════════════

-- הפעל את PostGIS (כבר מופעל ב-Supabase)
CREATE EXTENSION IF NOT EXISTS postgis;

-- ════════════════════════════════════════
--  טבלת תקלות
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS incidents (
  id           BIGSERIAL    PRIMARY KEY,
  title        TEXT         NOT NULL,
  description  TEXT,
  village      TEXT         NOT NULL,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  priority     TEXT         NOT NULL DEFAULT 'medium'
                            CHECK (priority IN ('high','medium','low')),
  status       TEXT         NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','in_progress','closed')),
  assigned_to  TEXT,
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW(),
  closed_at    TIMESTAMPTZ
);

-- אינדקסים
CREATE INDEX IF NOT EXISTS idx_incidents_status   ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_village  ON incidents(village);
CREATE INDEX IF NOT EXISTS idx_incidents_created  ON incidents(created_at DESC);

-- עדכון אוטומטי של updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  IF NEW.status = 'closed' AND OLD.status != 'closed' THEN
    NEW.closed_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at ON incidents;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON incidents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ════════════════════════════════════════
--  Row Level Security
-- ════════════════════════════════════════
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;

-- קריאה פתוחה לכולם (שנה בהמשך לגישה מוגבלת)
CREATE POLICY "Allow public read"
  ON incidents FOR SELECT USING (true);

-- הוספה פתוחה (שנה בהמשך לאימות משתמשים)
CREATE POLICY "Allow public insert"
  ON incidents FOR INSERT WITH CHECK (true);

-- עדכון פתוח
CREATE POLICY "Allow public update"
  ON incidents FOR UPDATE USING (true) WITH CHECK (true);

-- ════════════════════════════════════════
--  Real-time
-- ════════════════════════════════════════
-- הפעל Realtime על הטבלה
ALTER PUBLICATION supabase_realtime ADD TABLE incidents;

-- ════════════════════════════════════════
--  טבלת תשתיות (אופציונלי — לעתיד)
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS infrastructure (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('water_pipe','sewage_pipe','pump_station','reservoir','meter')),
  name        TEXT,
  village     TEXT,
  diameter_mm INTEGER,
  material    TEXT,
  year_laid   INTEGER,
  status      TEXT DEFAULT 'active',
  geom        GEOMETRY(GEOMETRY, 4326),  -- PostGIS geometry (WGS84)
  properties  JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_infra_type    ON infrastructure(type);
CREATE INDEX IF NOT EXISTS idx_infra_village ON infrastructure(village);
CREATE INDEX IF NOT EXISTS idx_infra_geom    ON infrastructure USING GIST(geom);

-- ════════════════════════════════════════
--  נתוני דוגמה לתקלות
-- ════════════════════════════════════════
INSERT INTO incidents (title, description, village, lat, lng, priority, status) VALUES
  ('נזילה בצנרת ראשית', 'נזילה גדולה ברחוב הראשי, נדרש תיקון דחוף', 'מגד אל-כרום', 32.9250, 35.1580, 'high', 'open'),
  ('לחץ מים נמוך', 'תושבים מדווחים על לחץ נמוך בשכונה המזרחית', 'סחנין', 32.8620, 35.2040, 'medium', 'in_progress'),
  ('תקלת מד מים', 'מד מים לא מציג קריאה תקינה', 'ערבה', 32.8490, 35.3300, 'low', 'open'),
  ('חסימה בקו ביוב', 'קו ביוב חסום ברחוב הגפן', 'נחף', 32.9780, 35.1920, 'high', 'open'),
  ('תחנת שאיבה בתחזוקה', 'תחנת השאיבה יצאה לתחזוקה מתוכננת', 'דיר חנא', 32.9228, 35.2083, 'medium', 'in_progress');
