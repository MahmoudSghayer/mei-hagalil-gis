# מי הגליל | מערכת GIS
## מדריך הפעלה ו-Deploy — מ-0 לאוויר ב-20 דקות

---

## מה יש כאן

| קובץ | תיאור |
|------|-------|
| `index.html` | כל האפליקציה — מפה, שכבות, תקלות, real-time |
| `schema.sql` | מסד הנתונים ב-Supabase |
| `README.md` | המדריך הזה |

---

## שלב 1 — הקמת Supabase (מסד הנתונים + Real-time)

### 1.1 צור חשבון
1. כנס ל-**https://supabase.com** → "Start your project"
2. הירשם עם Google או GitHub (חינמי)
3. לחץ **"New project"**
   - Name: `mei-hagalil-gis`
   - Database Password: שמור בצד!
   - Region: **West EU (Frankfurt)** — הכי קרוב לישראל
4. המתן ~2 דקות לייצור הפרויקט

### 1.2 הפעל את הסכמה (טבלות)
1. בתפריט שמאלי → **SQL Editor**
2. לחץ **"New query"**
3. הדבק את כל תוכן קובץ `schema.sql`
4. לחץ **RUN** (Ctrl+Enter)
5. תראה: `Success. No rows returned`

### 1.3 הפעל Real-time
1. תפריט שמאלי → **Database → Replication**
2. ב-"Source" → לחץ על **0 tables** ליד `supabase_realtime`
3. הפעל את **`incidents`** ← חובה!
4. שמור

### 1.4 קבל את המפתחות
1. תפריט שמאלי → **Project Settings → API**
2. העתק:
   - **Project URL** (נראה כך: `https://abcdefgh.supabase.co`)
   - **anon / public** key (מחרוזת ארוכה)

---

## שלב 2 — חבר את הקוד למסד הנתונים

פתח את `index.html` ומצא את השורות האלה (בתחילת הסקריפט):

```javascript
const SUPABASE_URL  = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON = 'YOUR_ANON_KEY';
```

החלף:
```javascript
const SUPABASE_URL  = 'https://abcdefgh.supabase.co';   // ← Project URL שלך
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1Ni...';          // ← anon key שלך
```

שמור את הקובץ.

---

## שלב 3 — העלה ל-GitHub

### אם אין לך Git מותקן:
1. כנס ל-**https://github.com** → צור חשבון חינמי
2. לחץ **"New repository"**
   - Repository name: `mei-hagalil-gis`
   - Private ✓ (מומלץ)
3. לחץ **"uploading an existing file"**
4. גרור את 3 הקבצים (`index.html`, `schema.sql`, `README.md`)
5. לחץ **"Commit changes"**

---

## שלב 4 — Deploy ב-Vercel (פומבי + HTTPS)

1. כנס ל-**https://vercel.com** → התחבר עם GitHub
2. לחץ **"Add New Project"**
3. בחר את ה-repo `mei-hagalil-gis`
4. הגדרות:
   - Framework Preset: **Other**
   - Root Directory: `./`
   - Build Command: *(ריק)*
   - Output Directory: *(ריק)*
5. לחץ **Deploy**
6. תוך 30 שניות תקבל URL כמו:
   `https://mei-hagalil-gis.vercel.app`

✅ **האתר עולה ב-Deploy אוטומטי כל פעם שמשנים קוד ב-GitHub.**

---

## בדיקה — Real-time עובד?

1. פתח את האתר בשני טאבים (או שני מחשבים)
2. באחד לחץ **"+ פתח תקלה חדשה"** ומלא פרטים
3. בטאב השני תראה את התקלה מופיעה אוטומטית תוך שנייה
4. על המפה תופיע סיכה אדומה

---

## עלויות חודשיות

| שירות | תוכנית | עלות |
|-------|--------|------|
| Supabase | Free (500MB, 50K req/day) | $0 |
| Vercel | Hobby (100GB bandwidth) | $0 |
| GitHub | Free | $0 |
| OpenStreetMap | ציבורי | $0 |
| **סה"כ** | | **$0** |

> **כשהמערכת גדלה:** Supabase Pro עולה $25/חודש ומאפשר 8GB ו-5M req/day.
> Vercel Pro עולה $20/חודש למספר בלתי מוגבל של deploys.

---

## שאלות נפוצות

**ש: האם הנתונים מאובטחים?**
ת: כן. Supabase מגיע עם SSL, Row Level Security, ואפשרות הוספת אימות משתמשים (Auth) בהמשך.

**ש: איך מוסיפים כניסה עם סיסמה לאתר?**
ת: Supabase Auth תומך ב-Email/Password, Google, Microsoft ועוד. ניתן להוסיף בשלב מאוחר יותר.

**ש: איך מחברים GeoJSON אמיתי (גבולות ישובים)?**
ת: פשוט להחליף את ה-`L.circle()` ב-`L.geoJSON()` עם קובץ מ-govmap.gov.il.

**ש: האם עובד על מובייל?**
ת: כן, המפה רספונסיבית. לחוויה מיטבית ניתן להוסיף PWA manifest.

---

## קשר

מי הגליל — מחלקת GIS
