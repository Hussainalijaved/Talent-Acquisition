# LinkedIn par job kaise post karein

Yeh guide batati hai ke apni portal ki job LinkedIn par kaise dikhegi — **Easy Apply band** karke candidates ko apni website par apply karwana.

## Pehle portal par job publish karein

1. **Recruiter portal** kholo: `recruiter-intake.html?tab=jobs`
2. **Manage Jobs** → naya job banao (title, JD, interviewer email)
3. **Publish** dabao — status **Open** ho jayega
4. **Copy apply link** — yeh URL LinkedIn par paste hogi:
   ```
   https://talent-acquisition-six.vercel.app/apply.html?job=junior-net-developer
   ```
5. **Careers page** (sab open jobs): `https://talent-acquisition-six.vercel.app/careers.html`

## LinkedIn par job post — step by step

### 1. Job create karein

1. LinkedIn → **Jobs** → **Create job**
2. **Job title** — portal wala same title (e.g. Junior .NET Full Stack Developer)
3. **Company** — apni company page select karein
4. **Location** — portal job ki location (Remote / city)
5. **Workplace type** — Remote / Hybrid / On-site
6. **Employment type** — Full-time / Contract waghera

### 2. Job description

Portal se **JD text** copy karke LinkedIn description mein paste karein. Last line mein add karein:

> Apply on our careers page: [your apply link]

### 3. Easy Apply band karein (zaroori)

LinkedIn default **Easy Apply** on karta hai — isse band karein:

1. Application settings / **How candidates apply** section
2. **"Apply on company website"** select karein (Easy Apply **nahi**)
3. **External apply URL** mein apna link paste karein:
   ```
   https://talent-acquisition-six.vercel.app/apply.html?job=YOUR-JOB-SLUG
   ```
   `YOUR-JOB-SLUG` = portal par job ka ID (e.g. `junior-net-developer`)

### 4. Publish

Job **Post** / **Publish** karein. LinkedIn par job dikhegi; **Apply** button candidates ko aapki site par le jayega.

## Candidate apply hone par kya hota hai

```
LinkedIn → Apply → apply.html → CV upload → n8n webhook → AI screening (24/7)
```

- CV automatically AI se score hoti hai
- Shortlist hone par assessment email jata hai
- Results recruiter portal → **Screening Results** mein dikhte hain

## Tips

| Topic | Recommendation |
|--------|----------------|
| Apply URL | Har job ka alag link — slug `job_id` se match kare |
| Easy Apply | Hamesha off — warna CV portal pipeline mein nahi aati |
| Job band karna | Portal par status **Closed** — careers list se hat jati hai |
| Webhook | Recruiter → Manage Jobs → **Application webhook** ek bar set karein |

## LinkedIn par job kaisi dikhegi

- **Title + company** — normal LinkedIn job listing
- **Apply** button → external link icon → aapki `apply.html` page
- Candidate email + PDF CV submit karta hai → same flow jaise recruiter manual upload kare

## Troubleshooting

| Issue | Fix |
|--------|-----|
| Apply link 404 | Job portal par **Open** hai? Slug URL mein sahi hai? |
| CV submit fail | Manage Jobs mein n8n webhook URL set hai? Workflow active? |
| Job careers par nahi | Status `open` hona chahiye, `draft` / `closed` nahi |
| Duplicate applications | Same email + same job + same CV fingerprint = duplicate flag |
