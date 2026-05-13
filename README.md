# 💧 Mei HaGalil GIS

> מערכת ניהול תשתית מים וביוב לתאגיד מי הגליל — 7 ישובים בצפון הארץ

[![Live Demo](https://img.shields.io/badge/Live-Demo-success)](https://mei-hagalil-gis.vercel.app)
[![Stack](https://img.shields.io/badge/Stack-Supabase%20%2B%20Vercel-blue)]()
[![License](https://img.shields.io/badge/License-Proprietary-red)]()

מערכת GIS מבוססת web לניהול ושיתוף מפות תשתית של רשת המים והביוב. מאפשרת למפעילי המערכת לנהל בזמן אמת תקלות, להציג שכבות תשתית מקבצי DWG/GeoJSON, ולייצא נתונים לפורמטים סטנדרטיים בענף (DXF, GeoJSON, CSV).

---
// Deployment Test
## ✨ פיצ'רים עיקריים

### 🗺️ מפה אינטראקטיבית

* **4 בוררי רקע**: Google לוויין HD, Google היברידי, Google רחובות, CartoDB בהיר
* תמיכה בזום עד רמה 20
* תצוגת קואורדינטות חיה
* 24 קטגוריות שכבות מוגדרות מראש (מים, ביוב, מבנים, מתקנים)

### 👥 ניהול משתמשים

* 2 רולים: **מנהל מערכת** ו-**משתמש**
* יצירה, עריכה, השהיה ומחיקה של משתמשים
* איפוס סיסמה דרך אימייל
* התנתקות אוטומטית לאחר 25 דקות של חוסר פעילות

### 🚨 ניהול תקלות

* פתיחת תקלות עם מיקום geographically-tagged
* 3 רמות עדיפות (גבוהה / בינונית / נמוכה)
* workflow מלא: פתוחה → בטיפול → סגורה
* שיוך תקלות למטפלים ספציפיים
* עדכונים בזמן אמת (Realtime) — כל מי שמחובר רואה תקלות חדשות מיד
* יומן פעולות מפורט

### 📤 העלאת שכבות חכמה

* העלאת קבצי GeoJSON ישירות מהדפדפן (עד 50 MB)
* **זיהוי כפר אוטומטי** לפי קואורדינטות האובייקטים
* **מיפוי שכבות חכם** — תיוג אוטומטי לפי חוקי מיפוי גלובליים
* אפשרות עקיפה ידנית לכל שכבה לפני ההעלאה
* שמירה אוטומטית של חוקים חדשים שנלמדו

### 🎯 חוקי מיפוי שכבות

* הגדרת חוקים לזיהוי שכבות AutoCAD (contains / exact / starts\_with / regex)
* סיווג אוטומטי ל-24 קטגוריות מוגדרות
* עדיפות בין חוקים (מספר נמוך = נבדק ראשון)
* מעקב אחר מספר התאמות לכל חוק
* קטגוריית IGNORE לדילוג על שכבות לא רלוונטיות

### 📥 יצוא נתונים

* בחירת אזור על המפה (rectangle drawing)
* סינון לפי קטגוריות
* 3 פורמטים: **GeoJSON** (סטנדרט GIS), **DXF** (AutoCAD), **CSV** (Excel)
* שליחה ישירה במייל
* תמיכה מלאה בעברית (BOM ב-CSV)

---

## 🛠️ Tech Stack

| רכיב | טכנולוגיה |
|---|---|
| Frontend | Vanilla JavaScript + HTML/CSS |
| Map Engine | [Leaflet 1.9.4](https://leafletjs.com/) |
| Database | [Supabase Postgres](https://supabase.com/) |
| Authentication | Supabase Auth (JWT) |
| Storage | Supabase Storage (S3-compatible) |
| Realtime | Supabase Realtime (WebSocket) |
| Hosting | [Vercel](https://vercel.com/) |
| Source Control | GitHub |

**Zero build step** — קוד גולמי שרץ ישירות בדפדפן. אין webpack, אין npm install, אין compilation.

---

## 📂 מבנה הפרויקט

```
mei-hagalil-gis/
├── index.html                  # מפה ראשית — דף הבית
├── pages/                      # כל שאר העמודים
│   ├── login.html              # כניסה למערכת
│   ├── reset.html              # איפוס סיסמה
│   ├── admin.html              # ניהול משתמשים
│   ├── upload.html             # העלאת שכבות GeoJSON
│   ├── layer-rules.html        # חוקי מיפוי שכבות AutoCAD
│   └── logs.html               # יומן פעילות
├── css/
│   └── pages/                  # קובץ CSS נפרד לכל עמוד
│       ├── index.css
│       ├── login.css
│       ├── reset.css
│       ├── admin.css
│       ├── upload.css
│       ├── layer-rules.css
│       └── logs.css
├── js/
│   ├── auth.js                 # Supabase init + helpers משותפים
│   ├── export-feature.js       # לוגיקת יצוא (GeoJSON/DXF/CSV)
│   ├── search-feature.js       # חיפוש על המפה
│   ├── backend-client.js       # קריאות API משותפות
│   └── pages/                  # קובץ JS נפרד לכל עמוד
│       ├── index.js
│       ├── login.js
│       ├── reset.js
│       ├── admin.js
│       ├── upload.js
│       ├── layer-rules.js
│       └── logs.js
├── db/                         # סכמות SQL ל-Supabase
└── README.md
```

---

## 🚀 התחלה מהירה

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

5. **עדכן את `auth.js`**:

```javascript
var SUPABASE_URL  = 'https://your-project-id.supabase.co';
var SUPABASE_ANON = 'your-anon-key-here';
```

הקובץ נמצא ב-`js/auth.js`.

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
   * ✨ זהו, האתר חי!

---

## 📚 תיעוד מלא

התיעוד המלא עדיין לא צורף לריפו (הקוד עצמו הוא ה-Source of Truth).

---

## 🌍 הישובים הנתמכים

המערכת מותאמת ל-7 הישובים שבאחריות תאגיד מי הגליל:

1. **מגד אל-כרום** (Majd al-Krum)
2. **בענה** (Bi'ina)
3. **דיר אל-אסד** (Deir al-Asad)
4. **נחף** (Nahf)
5. **סחנין** (Sakhnin)
6. **דיר חנא** (Deir Hanna)
7. **עראבה** (Arrabeh)

---

## 🔐 אבטחה

* אימות מבוסס JWT דרך Supabase Auth
* Row Level Security (RLS) על כל הטבלאות
* אדמין יכול לראות הכל דרך פונקציית `is_admin()` SECURITY DEFINER
* HTTPS בלבד (Vercel TLS)
* Idle timeout: 25 דקות
* אין אחסון של סיסמאות בצד הלקוח

---

## 📊 סטטיסטיקות הפרויקט

* **שורות קוד**: ~5,000 (HTML/CSS/JS)
* **עמודים**: 6 (index, login, reset, admin, upload, layer-rules, logs)
* **טבלאות DB**: 5 (profiles, incidents, incident\_logs, village\_layers, layer\_mapping\_rules)
* **קטגוריות שכבות נתמכות**: 24
* **זמן פיתוח**: ~8 ימים
* **גודל אחסון**: < 100MB ל-7 כפרים מלאים

---

## 🗺️ מפת דרכים (Roadmap)

### בפיתוח

* [ ] תמיכה באורטופוטו מפ"י (גרסה 23)
* [ ] דוחות PDF מודפסים
* [ ] גרפים סטטיסטיים (תקלות לפי חודש/כפר)

### בתכנון

* [ ] אפליקציה ניידת (PWA)
* [ ] התראות SMS לתקלות גבוהות
* [ ] שילוב עם מערכות SCADA קיימות
* [ ] תמיכה בשכבות WMS חיצוניות

---

## 👨‍💻 פיתוח

פותח על ידי **מחמוד סגייר** (Mahmoud Sghayer) עבור **תאגיד מי הגליל**.

תוכן הפרויקט הוא קניין רוחני של תאגיד מי הגליל. אין להעתיק, להפיץ או לעשות שימוש מסחרי ללא אישור מפורש.

---

## 📞 תמיכה

* **באגים / הצעות**: פתח issue ב-GitHub
* **תמיכה תפעולית**: פנה למנהל המערכת בתאגיד

---

**Built with ☕**
