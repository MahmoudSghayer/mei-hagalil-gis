-- ════════════════════════════════════════════════════════════════════════
--  DEMO SEED DATA — DO NOT run on production.
--  5 sample incidents for a local/demo environment only. Run manually:
--    Supabase (a throwaway/dev project) → SQL Editor → paste → Run.
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO incidents (title, description, village, lat, lng, priority, status) VALUES
  ('נזילה בצנרת ראשית',       'נזילה גדולה ברחוב הראשי, נדרש תיקון דחוף',          'מגד אל-כרום', 32.9250, 35.1580, 'high',   'open'),
  ('לחץ מים נמוך',             'תושבים מדווחים על לחץ נמוך בשכונה המזרחית',         'סחנין',        32.8620, 35.2040, 'medium', 'in_progress'),
  ('תקלת מד מים',              'מד מים לא מציג קריאה תקינה',                        'עראבה',        32.8490, 35.3300, 'low',    'open'),
  ('חסימה בקו ביוב',           'קו ביוב חסום ברחוב הגפן',                           'נחף',          32.9780, 35.1920, 'high',   'open'),
  ('תחנת שאיבה בתחזוקה',      'תחנת השאיבה יצאה לתחזוקה מתוכננת',                 'דיר חנא',      32.9228, 35.2083, 'medium', 'in_progress')
ON CONFLICT DO NOTHING;
