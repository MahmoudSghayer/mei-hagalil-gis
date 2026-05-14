# מי הגליל GIS

> מערכת ניהול תשתית מים וביוב לתאגיד מי הגליל — 7 ישובים בצפון הארץ

[![Live Demo](https://img.shields.io/badge/Live-Demo-success)](https://mei-hagalil-gis.vercel.app)
[![Stack](https://img.shields.io/badge/Stack-Supabase%20%2B%20Vercel-blue)]()
[![License](https://img.shields.io/badge/License-Proprietary-red)]()

מערכת GIS מבוססת web לניהול ושיתוף מפות תשתית של רשת המים והביוב. מאפשרת למפעילי המערכת לנהל בזמן אמת תקלות, להציג שכבות תשתית מקבצי DWG / Shapefile / GeoJSON, ולייצא נתונים לפורמטים סטנדרטיים בענף (DXF, GeoJSON, CSV).

---

## פיצ'רים עיקריים

### מפה אינטראקטיבית

* **4 בוררי רקע**: Google לוויין HD, Google היברידי, Google רחובות, CartoDB בהיר
* תמיכה בזום עד רמה 20
* תצוגת קואורדינטות חיה
* **30 קטגוריות שכבות** — מים, ביוב, מבנים, מתקנים, הערות, קדסטרה
* שכבת קדסטרה (WMS ממפ"י) לחיפוש חלקות מגרש בזמן אמת
* כלי מדידה — אורך קו, שטח פוליגון
* חיפוש על המפה לפי קואורדינטות / כתובת

### ניהול משתמשים

* 2 רולים: **מנהל מערכת** ו-**משתמש**
* יצירה, עריכה, השהיה ומחיקה של משתמשים
* איפוס סיסמה דרך אימייל
* התנתקות אוטומטית לאחר 25 דקות של חוסר פעילות (עם אזהרה 60 שניות מראש)

### ניהול תקלות

* פתיחת תקלות עם מיקום geographically-tagged
* 3 רמות עדיפות (גבוהה / בינונית / נמוכה)
* workflow מלא: פתוחה → בטיפול → סגורה
* שיוך תקלות למטפלים ספציפיים
* עדכונים בזמן אמת (Supabase Realtime) — כל מי שמחובר רואה תקלות חדשות מיד
* יומן פעולות מפורט עם מדידת זמן טיפול

### העלאת שכבות חכמה

* **GeoJSON** ישירות מהדפדפן (עד 100 MB)
* **Shapefile ZIP** — גילוי אוטומטי של `.shp / .dbf / .prj` בתוך הקובץ, קריאת שדות סוג F (Float) ידנית, המרת ITM → WGS84
* **זיהוי כפר אוטומטי** לפי קואורדינטות האובייקטים (רדיוס 0.045°)
* **פיצול אוטומטי לכמה כפרים** — קובץ רב-כפרי מועלה לכל כפר בנפרד
* **מיפוי שכבות חכם** — תיוג אוטומטי לפי חוקי מיפוי גלובליים
* אפשרות עקיפה ידנית לכל שכבה לפני ההעלאה
* שמירה אוטומטית של חוקים חדשים שנלמדו

### חוקי מיפוי שכבות

* הגדרת חוקים לזיהוי שכבות AutoCAD (contains / exact / starts\_with / regex)
* סיווג אוטומטי ל-30 קטגוריות (כולל IGNORE לדילוג)
* עדיפות בין חוקים (מספר נמוך = נבדק ראשון)
* מעקב אחר מספר התאמות לכל חוק

### יצוא נתונים

* בחירת אזור על המפה (rectangle drawing)
* סינון לפי קטגוריות
* 3 פורמטים: **GeoJSON**, **DXF** (AutoCAD — דרך שרת המרה), **CSV** (Excel + BOM עברית)
* שליחה ישירה במייל

---

## Tech Stack

| רכיב | טכנולוגיה |
|---|---|
| Frontend | Vanilla JavaScript + HTML/CSS (zero build step) |
| Map Engine | [Leaflet 1.9.4](https://leafletjs.com/) |
| Database | [Supabase Postgres](https://supabase.com/) + PostGIS |
| Authentication | Supabase Auth (JWT + RLS) |
| Storage | Supabase Storage (bucket: `village-layers`) |
| Realtime | Supabase Realtime (WebSocket) |
| Hosting | [Vercel](https://vercel.com/) (Serverless Functions) |
| Conversion Backend | Render (DWG/DXF → GeoJSON via Aspose + GDAL) |
| Projection | proj4.js (ITM ↔ WGS84) |
| Shapefile | shapefile.js + JSZip |

---

## מבנה הפרויקט

```
mei-hagalil-gis/
├── index.html                  # מפה ראשית — דף הבית
├── pages/
│   ├── login.html              # כניסה למערכת
│   ├── reset.html              # איפוס סיסמה
│   ├── admin.html              # ניהול משתמשים
│   ├── upload.html             # העלאת שכבות (GeoJSON / Shapefile ZIP)
│   ├── layer-rules.html        # חוקי מיפוי שכבות AutoCAD
│   └── logs.html               # יומן פעילות
├── css/pages/
│   ├── index.css
│   ├── login.css
│   ├── reset.css
│   ├── admin.css
│   ├── upload.css
│   ├── layer-rules.css
│   └── logs.css
├── js/
│   ├── auth.js                 # Supabase init + getProfile + idle timer
│   ├── backend-client.js       # DWG/DXF conversion API (Render)
│   ├── export-feature.js       # יצוא GeoJSON / DXF / CSV
│   ├── search-feature.js       # חיפוש על המפה
│   ├── measure-tools.js        # כלי מדידה (קו / פוליגון)
│   ├── motion-utils.js         # אנימציות UI (toast, fade-in, table rows)
│   └── pages/
│       ├── index.js            # לוגיקת המפה הראשית (~1,100 שורות)
│       ├── login.js
│       ├── reset.js
│       ├── admin.js
│       ├── upload.js           # העלאה חכמה (~800 שורות)
│       ├── layer-rules.js
│       └── logs.js
├── api/
│   └── parcel.js               # Vercel serverless: חיפוש חלקה דרך data.gov.il
├── db/
│   └── schema.sql              # סכמה מלאה (6 טבלאות, RLS, triggers)
├── Data/                       # Shapefiles לדוגמה (7 כפרים)
├── vercel.json                 # Cache headers
└── package.json
```

---

## התחלה מהירה

### דרישות מקדימות

* חשבון [Supabase](https://supabase.com/) (חינמי)
* חשבון [Vercel](https://vercel.com/) (חינמי)
* חשבון [GitHub](https://github.com/) (חינמי)

### התקנה מ-0

1. **Clone הריפו**:

```bash
git clone https://github.com/YOUR_USERNAME/mei-hagalil-gis.git
cd mei-hagalil-gis
```

2. **צור פרויקט חדש ב-Supabase**:

   * לך ל-https://supabase.com/dashboard
   * New Project → תן שם וסיסמה
   * שמור את ה-`Project URL` וה-`anon key` מ-Settings → API

3. **הרץ את ה-SQL Schema**:

   * Supabase → SQL Editor
   * פתח את `db/schema.sql` והרץ הכל

4. **ב-Supabase, בטל אימות אימייל**:

   * Authentication → Providers → Email
   * בטל "Confirm email"

5. **עדכן את `js/auth.js`**:

```javascript
var SUPABASE_URL  = 'https://your-project-id.supabase.co';
var SUPABASE_ANON = 'your-anon-key-here';
```

6. **צור bucket לאחסון**:

   * Supabase → Storage → New bucket
   * שם: `village-layers`
   * **Public bucket** ✅

7. **צור משתמש Admin ראשון**:

   * Authentication → Users → Add user
   * אחרי היצירה, ב-SQL Editor:

```sql
UPDATE profiles SET role = 'admin' WHERE email = 'your@email.com';
```

8. **Deploy ל-Vercel**:

   * Vercel → New Project → Import את ה-GitHub repo
   * זהו, האתר חי!

---

## סכמת מסד הנתונים

| טבלה | תיאור |
|---|---|
| `profiles` | חשבונות משתמשים (מראה של `auth.users`) |
| `incidents` | תקלות שדה עם מיקום גאוגרפי |
| `incident_logs` | יומן ביקורת מלא לכל פעולה על תקלה |
| `village_layers` | מטה-דאטה של קבצי GeoJSON שהועלו |
| `layer_mapping_rules` | חוקי מיפוי AutoCAD → קטגוריית GIS |
| `infrastructure` | שמור לעתיד — טבלת נכסים עם PostGIS |

כל הטבלאות מוגנות ב-Row Level Security. פונקציית `is_admin()` (SECURITY DEFINER) משמשת את כל מדיניות ה-RLS.

---

## הישובים הנתמכים

| ישוב | Slug | קואורדינטות |
|---|---|---|
| מגד אל-כרום | `majd` | 32.9189°N, 35.2456°E |
| בענה | `biina` | 32.9485°N, 35.2617°E |
| דיר אל-אסד | `deir_al_asad` | 32.9356°N, 35.2697°E |
| נחף | `nahf` | 32.9344°N, 35.3025°E |
| סחנין | `sakhnin` | 32.8650°N, 35.2978°E |
| דיר חנא | `deir_hanna` | 32.8631°N, 35.3589°E |
| עראבה | `arrabeh` | 32.8514°N, 35.3339°E |

---

## אבטחה

* אימות מבוסס JWT דרך Supabase Auth
* Row Level Security (RLS) על כל הטבלאות
* `is_admin()` SECURITY DEFINER — בודק role + is_active
* Trigger אוטומטי יוצר פרופיל בהרשמה (`handle_new_user`)
* HTTPS בלבד (Vercel TLS)
* Idle timeout: 25 דקות עם אזהרה 60 שניות מראש
* אין אחסון סיסמאות בצד הלקוח

---

## סטטיסטיקות הפרויקט

* **שורות קוד**: ~6,500 (HTML/CSS/JS)
* **עמודים**: 7 (index, login, reset, admin, upload, layer-rules, logs)
* **טבלאות DB**: 6 (profiles, incidents, incident\_logs, village\_layers, layer\_mapping\_rules, infrastructure)
* **קטגוריות שכבות נתמכות**: 30
* **גודל מקסימלי להעלאה**: 100 MB
* **גודל אחסון**: < 100 MB ל-7 כפרים מלאים

---

## מפת דרכים (Roadmap)

### הושלם

* [x] מפה אינטראקטיבית עם 30 קטגוריות שכבות
* [x] ניהול תקלות עם Realtime
* [x] ניהול משתמשים (admin/user roles)
* [x] העלאת GeoJSON + Shapefile ZIP
* [x] זיהוי כפר אוטומטי + פיצול לכמה כפרים
* [x] חוקי מיפוי שכבות AutoCAD עם regex
* [x] יצוא DXF / GeoJSON / CSV
* [x] יומן פעילות מלא עם מדידת זמן טיפול
* [x] כלי מדידה (קו + פוליגון)
* [x] שכבת קדסטרה WMS + חיפוש חלקות
* [x] המרת ITM → WGS84 אוטומטית

### בתכנון

* [ ] דוחות PDF מודפסים
* [ ] גרפים סטטיסטיים (תקלות לפי חודש/כפר)
* [ ] תמיכה באורטופוטו מפ"י
* [ ] אפליקציה ניידת (PWA)
* [ ] התראות SMS לתקלות בעדיפות גבוהה
* [ ] שילוב עם מערכות SCADA קיימות

---

## פיתוח

פותח על ידי **מחמוד סגייר** (Mahmoud Sghayer) עבור **תאגיד מי הגליל**.

תוכן הפרויקט הוא קניין רוחני של תאגיד מי הגליל. אין להעתיק, להפיץ או לעשות שימוש מסחרי ללא אישור מפורש.

---

## תמיכה

* **באגים / הצעות**: פתח issue ב-GitHub
* **תמיכה תפעולית**: פנה למנהל המערכת בתאגיד
