/**
 * Talent Acquisition — Admin panel extensions
 * Loaded by dashboard.html after core bootstrap.
 */
(function () {
    'use strict';

    const WEBHOOK_STORAGE = 'ta_cv_ingest_webhook';
    const JD_WEBHOOK_STORAGE = 'ta_jd_generate_webhook';
    // Update when ngrok restarts (free tier gets a new subdomain each time).
    const N8N_WEBHOOK_BASE = 'https://randy-gaunt-bradley.ngrok-free.dev/webhook';
    const DEFAULT_JD_WEBHOOK_LOCAL = 'http://localhost:5678/webhook/talent/jd-generate';
    const DEFAULT_JD_WEBHOOK_PUBLIC = N8N_WEBHOOK_BASE + '/talent/jd-generate';
    let deps = null;
    let JOBS = [];
    let ONSITE = [];
    let SCOPED_JOB_SLUGS = null;
    let screenMode = 'single';
    let batchExtractGen = 0;
    const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const BLOCKED_LOCAL = /^(noreply|no-reply|donotreply|support|info|admin|contact|hr|careers|jobs|hello)$/i;
    const BLOCKED_DOMAIN = /@(example\.com|test\.com|domain\.com|email\.com)$/i;

    function initPdfJs() {
        if (window.pdfjsLib) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
    }

    function slugFromTitle(title) {
        return String(title || 'role')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 48) || 'role';
    }

    function normalizeWebhookUrl(raw) {
        let url = String(raw || '').trim();
        if (!url) return '';
        if (!/^https?:\/\//i.test(url)) {
            url = /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url) ? 'http://' + url : 'https://' + url;
        }
        return url.replace(/\/+$/, '');
    }

    function isLocalHost() {
        const h = location.hostname;
        return h === 'localhost' || h === '127.0.0.1' || h === '';
    }

    function deriveJdWebhookFromCv(cvUrl) {
        const u = normalizeWebhookUrl(cvUrl);
        if (!u) return '';
        if (/\/talent\/cv-ingest$/i.test(u)) return u.replace(/\/talent\/cv-ingest$/i, '/talent/jd-generate');
        if (/\/webhook\//i.test(u)) return u.replace(/\/[^/]+$/, '/talent/jd-generate');
        return u + '/webhook/talent/jd-generate';
    }

    async function resolveJdWebhookUrl() {
        const fromInput = normalizeWebhookUrl(document.getElementById('admJdWebhook')?.value || '');
        if (fromInput) return fromInput;

        const fromStorage = normalizeWebhookUrl(localStorage.getItem(JD_WEBHOOK_STORAGE) || '');
        if (fromStorage) return fromStorage;

        if (deps?.sb) {
            const { data } = await deps.sb.from('app_config').select('value').eq('key', 'jd_generate_webhook').maybeSingle();
            const fromDb = normalizeWebhookUrl(data?.value || '');
            if (fromDb) return fromDb;
        }

        const cvUrl = normalizeWebhookUrl(
            document.getElementById('admWebhook')?.value ||
            localStorage.getItem(WEBHOOK_STORAGE) ||
            ''
        );
        if (!cvUrl && deps?.sb) {
            const { data } = await deps.sb.from('app_config').select('value').eq('key', 'cv_ingest_webhook').maybeSingle();
            const derived = deriveJdWebhookFromCv(data?.value || '');
            if (derived) return derived;
        }
        if (cvUrl) {
            const derived = deriveJdWebhookFromCv(cvUrl);
            if (derived) return derived;
        }

        return isLocalHost() ? DEFAULT_JD_WEBHOOK_LOCAL : DEFAULT_JD_WEBHOOK_PUBLIC;
    }

    function parseBulletLines(raw) {
        return String(raw || '')
            .split(/\n/)
            .map((l) => l.replace(/^[\s\-•*]+/, '').trim())
            .filter(Boolean);
    }

    function toBullets(lines) {
        return lines.map((l) => `• ${l}`).join('\n');
    }

    function detectSeniority(title) {
        const t = String(title || '').toLowerCase();
        if (/\b(intern|trainee|graduate|entry[\s-]?level)\b/.test(t)) return 'intern';
        if (/\b(junior|jr\.?)\b/.test(t)) return 'junior';
        if (/\b(senior|sr\.?|lead|principal|staff|architect|head)\b/.test(t)) return 'senior';
        return 'mid';
    }

    function detectRoleFamily(title) {
        const t = String(title || '').toLowerCase();
        if (/\.net|dotnet|asp\.net|c#|csharp/.test(t)) return 'dotnet';
        if (/flutter|dart/.test(t)) return 'flutter';
        if (/react|frontend|front[\s-]?end|vue|angular|ui developer/.test(t)) return 'frontend';
        if (/node\.?js|backend|back[\s-]?end|api developer|python|java|golang|go developer/.test(t)) return 'backend';
        if (/devops|sre|platform|cloud/.test(t)) return 'devops';
        if (/qa|test|quality/.test(t)) return 'qa';
        return 'general';
    }

    function roleTemplates() {
        const dotnetResp = {
            intern: [
                'Support the development team in building and testing .NET applications under close mentorship.',
                'Assist with bug fixes, documentation, and small feature tasks using C# and ASP.NET Core.',
                'Learn coding standards, Git workflows, and Agile practices through hands-on project work.',
            ],
            junior: [
                'Develop, test, and maintain web applications using C#, ASP.NET Core, and the Microsoft technology stack.',
                'Write clean, efficient, and well-documented code in line with team standards and best practices.',
                'Collaborate with senior developers and cross-functional teams to implement features and resolve defects.',
                'Participate in code reviews, debugging, and troubleshooting to improve application quality and reliability.',
                'Work with SQL Server and Entity Framework to support data access, queries, and basic database tasks.',
                'Build and consume RESTful APIs and integrate application components with third-party services.',
                'Contribute to Agile ceremonies including daily stand-ups, sprint planning, and retrospectives.',
            ],
            mid: [
                'Design and deliver scalable web applications and services using .NET Core, C#, and related technologies.',
                'Own feature development end-to-end — from requirements analysis through deployment and support.',
                'Produce maintainable code, unit tests, and technical documentation for production systems.',
                'Collaborate with product, QA, and engineering peers to ship reliable software on schedule.',
                'Optimize application performance, database queries, and API integrations.',
                'Mentor junior developers and uphold engineering best practices across the codebase.',
            ],
            senior: [
                'Lead the design and architecture of enterprise-grade .NET solutions aligned with business goals.',
                'Drive technical decisions on frameworks, patterns, security, performance, and scalability.',
                'Deliver complex features and integrations while setting standards for code quality and review.',
                'Partner with stakeholders to translate requirements into robust technical roadmaps.',
                'Coach engineers, conduct in-depth code reviews, and improve engineering processes.',
            ],
        };

        const dotnetReq = {
            intern: [
                'Currently pursuing or recently completed a degree in Computer Science, Software Engineering, or a related field.',
                'Exposure to C#, object-oriented programming, and basic web development concepts.',
                'Eagerness to learn .NET, ASP.NET Core, SQL, and modern development tools.',
                'Strong communication skills and ability to work collaboratively in a team.',
            ],
            junior: [
                "Bachelor's degree in Computer Science, Software Engineering, or a related field (or equivalent practical experience).",
                '0–2 years of experience with C#, .NET / .NET Core, and object-oriented programming principles.',
                'Working knowledge of ASP.NET Core, MVC, Web API, and relational databases (SQL Server preferred).',
                'Familiarity with HTML, CSS, JavaScript, and version control (Git).',
                'Solid problem-solving skills, attention to detail, and willingness to learn in a fast-paced environment.',
                'Strong written and verbal communication skills.',
            ],
            mid: [
                "Bachelor's degree in Computer Science or a related discipline.",
                '2–5 years of professional experience building applications with .NET / .NET Core and C#.',
                'Strong proficiency in ASP.NET Core, Web API, Entity Framework, and SQL Server.',
                'Experience with RESTful services, design patterns, and Agile delivery methodologies.',
                'Demonstrated ability to own features independently and collaborate across teams.',
            ],
            senior: [
                "Bachelor's degree in Computer Science or equivalent experience.",
                '5+ years of experience designing and building production systems with .NET technologies.',
                'Deep expertise in C#, ASP.NET Core, cloud-ready architecture, and database design.',
                'Proven track record leading projects, mentoring developers, and influencing technical direction.',
            ],
        };

        const dotnetNice = [
            'Experience with Microsoft Azure or cloud deployment pipelines.',
            'Exposure to CI/CD, Docker, or automated testing frameworks.',
            'Familiarity with front-end frameworks (Angular, React, or Blazor).',
            'Understanding of microservices, messaging, or event-driven architecture.',
        ];

        return {
            dotnet: {
                about(seniority, title, dept) {
                    const openers = {
                        intern: `We are seeking a motivated ${title} to join our ${dept} team. This internship offers hands-on experience building real applications with C#, ASP.NET Core, and modern Microsoft technologies alongside experienced engineers.`,
                        junior: `We are looking for a talented ${title} to join our growing ${dept} team. You will work alongside experienced developers to build, test, and maintain web applications using C#, ASP.NET Core, and the Microsoft stack — with strong mentorship and room to grow.`,
                        mid: `We are hiring an experienced ${title} to strengthen our ${dept} team. You will own meaningful product work across the full software lifecycle, from design and implementation through deployment and continuous improvement.`,
                        senior: `We are seeking a seasoned ${title} to provide technical leadership within our ${dept} organisation. You will shape architecture, guide delivery, and raise the bar for engineering quality across our .NET platform.`,
                    };
                    return openers[seniority] || openers.junior;
                },
                responsibilities: dotnetResp,
                requirements: dotnetReq,
                nice: dotnetNice,
            },
            flutter: {
                about(seniority, title, dept) {
                    return seniority === 'senior'
                        ? `We are looking for a ${title} to lead mobile product delivery in our ${dept} team, driving Flutter architecture, performance, and best practices across iOS and Android.`
                        : `We are looking for a ${title} to join our ${dept} team and help build polished cross-platform mobile experiences using Flutter and Dart.`;
                },
                responsibilities: {
                    junior: [
                        'Develop and maintain Flutter applications for iOS and Android under guidance from senior mobile engineers.',
                        'Implement UI screens, state management, and API integrations based on product specifications.',
                        'Write clean Dart code, fix bugs, and contribute to code reviews and team discussions.',
                        'Collaborate with designers, backend engineers, and QA to ship reliable mobile releases.',
                    ],
                    mid: [
                        'Own feature delivery across the Flutter codebase — UI, business logic, and third-party integrations.',
                        'Improve app performance, maintainability, and test coverage across platforms.',
                        'Work with REST/GraphQL APIs and mobile release processes (build, signing, store submission support).',
                    ],
                    senior: [
                        'Define mobile architecture, patterns, and standards for Flutter applications at scale.',
                        'Lead complex feature development and mentor mobile engineers on best practices.',
                    ],
                },
                requirements: {
                    junior: [
                        "Bachelor's degree in Computer Science or related field (or equivalent experience).",
                        'Experience building mobile apps with Flutter and Dart.',
                        'Understanding of REST APIs, Git, and mobile UI/UX principles.',
                        'Strong problem-solving skills and collaborative mindset.',
                    ],
                },
                nice: ['Firebase experience', 'Native iOS/Android knowledge', 'Automated testing for Flutter'],
            },
            general: {
                about(seniority, title, dept) {
                    return `We are hiring a ${title} to join our ${dept} team. In this role, you will contribute to the design, development, and delivery of high-quality software solutions that support our business goals and customer experience.`;
                },
                responsibilities: {
                    junior: [
                        'Support the design, development, testing, and maintenance of software features and fixes.',
                        'Write clean, maintainable code and participate in code reviews with the engineering team.',
                        'Collaborate with product, design, and QA to understand requirements and deliver on schedule.',
                        'Document technical work, troubleshoot issues, and contribute to continuous improvement.',
                    ],
                    mid: [
                        'Own end-to-end delivery of features from requirements through production support.',
                        'Build scalable, reliable solutions and improve existing systems and processes.',
                        'Partner with cross-functional stakeholders to prioritise and ship high-impact work.',
                    ],
                    senior: [
                        'Provide technical leadership across projects, architecture, and engineering standards.',
                        'Drive complex initiatives, mentor team members, and influence product and platform direction.',
                    ],
                },
                requirements: {
                    junior: [
                        "Bachelor's degree in a relevant field or equivalent practical experience.",
                        'Foundational experience in software development and modern engineering practices.',
                        'Strong analytical, communication, and teamwork skills.',
                    ],
                },
                nice: ['Experience in Agile teams', 'Exposure to CI/CD and automated testing'],
            },
        };
    }

    function pickList(map, seniority, fallbackSeniority) {
        if (!map) return [];
        return map[seniority] || map[fallbackSeniority] || map.junior || map.mid || Object.values(map)[0] || [];
    }

    function generateJdFromCriteria(opts) {
        const title = String(opts.title || 'Open Position').trim();
        const dept = String(opts.department || 'Engineering').trim();
        const loc = String(opts.location || 'Remote').trim();
        const emp = String(opts.employment_type || 'Full-time').trim();
        const criteria = parseBulletLines(opts.criteria);
        const nice = parseBulletLines(opts.nice);

        const seniority = detectSeniority(title);
        const family = detectRoleFamily(title);
        const templates = roleTemplates();
        const tpl = templates[family] || templates.general;

        const about =
            typeof tpl.about === 'function' ? tpl.about(seniority, title, dept) : tpl.about;

        const responsibilities = pickList(tpl.responsibilities, seniority, 'junior');
        const defaultReq = pickList(tpl.requirements, seniority, 'junior');
        const requirements = criteria.length ? criteria : defaultReq;
        const defaultNice = Array.isArray(tpl.nice)
            ? tpl.nice
            : (Array.isArray(templates.general.nice) ? templates.general.nice : []);
        const niceList = nice.length ? nice : defaultNice;

        const expLine = {
            intern: 'Internship / graduate opportunity',
            junior: '0–2 years of relevant experience',
            mid: '2–5 years of relevant experience',
            senior: '5+ years of relevant experience',
        }[seniority];

        return (
            `${title}\n` +
            `${dept} | ${emp} | ${loc}\n\n` +
            `About the Role\n` +
            `${about} You will work in a collaborative environment where quality, ownership, and continuous learning are valued.\n\n` +
            `What You'll Do\n` +
            `${toBullets(responsibilities)}\n\n` +
            `What We're Looking For\n` +
            `${toBullets(requirements)}\n\n` +
            `Nice to Have\n` +
            `${toBullets(niceList)}\n\n` +
            `Qualifications\n` +
            `${toBullets([
                expLine,
                'Ability to work independently and collaboratively in a professional team environment',
                'Strong problem-solving skills and attention to detail',
            ])}\n\n` +
            `What We Offer\n` +
            `${toBullets([
                'Competitive compensation aligned with experience and market standards',
                'Collaborative culture with mentorship, code review, and structured growth opportunities',
                'Exposure to modern tooling, Agile delivery, and industry best practices',
                loc.toLowerCase().includes('remote')
                    ? 'Flexible remote-friendly working arrangements'
                    : 'A supportive on-site team environment',
            ])}\n\n` +
            `How to Apply\n` +
            `Ready to join us? Submit your CV through our careers portal. Shortlisted candidates will be invited to complete a structured technical assessment — the next step in our hiring process.\n\n` +
            `We are an equal opportunity employer and welcome applications from qualified candidates regardless of background.`
        );
    }

    async function loadWebhookConfig() {
        if (!deps?.sb) return '';
        const { data } = await deps.sb.from('app_config').select('value').eq('key', 'cv_ingest_webhook').maybeSingle();
        const url = normalizeWebhookUrl(data?.value || localStorage.getItem(WEBHOOK_STORAGE) || '');
        const inp = document.getElementById('admWebhook');
        if (inp && url) inp.value = url;
        return url;
    }

    async function loadJdWebhookConfig() {
        const url = await resolveJdWebhookUrl();
        const inp = document.getElementById('admJdWebhook');
        if (inp && url && !inp.value.trim()) inp.value = url;
        return url;
    }

    async function saveWebhookConfig() {
        if (deps.auth && !deps.auth.can('save_webhooks')) {
            deps.banner('Only super admins can change integration settings.', 'err');
            return;
        }
        const cvUrl = normalizeWebhookUrl(document.getElementById('admWebhook')?.value || '');
        const jdUrl = normalizeWebhookUrl(document.getElementById('admJdWebhook')?.value || '');
        if (!cvUrl) {
            deps.banner('Enter a valid n8n CV ingest webhook URL.', 'err');
            return;
        }
        localStorage.setItem(WEBHOOK_STORAGE, cvUrl);
        if (jdUrl) localStorage.setItem(JD_WEBHOOK_STORAGE, jdUrl);
        if (deps.sb) {
            const rows = [
                { key: 'cv_ingest_webhook', value: cvUrl, updated_at: new Date().toISOString() },
            ];
            if (jdUrl) {
                rows.push({ key: 'jd_generate_webhook', value: jdUrl, updated_at: new Date().toISOString() });
            }
            await deps.sb.from('app_config').upsert(rows, { onConflict: 'key' });
        }
        if (deps.auth) await deps.auth.logAudit('save_webhooks', 'app_config', 'webhooks', { cv: !!cvUrl, jd: !!jdUrl });
        deps.banner('Webhook URLs saved.', 'ok');
    }

    async function loadJobs() {
        if (!deps?.sb) return;
        const { data, error } = await deps.sb.from('jobs').select('*').order('updated_at', { ascending: false });
        if (error) {
            deps.banner('Jobs load failed: ' + error.message, 'err');
            return;
        }
        JOBS = data || [];
        renderJobs();
        populateJobSelects();
    }

    function populateJobSelects() {
        const selects = ['scrJob', 'onsJob', 'jobEditId'];
        selects.forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (id === 'jobEditId') {
                el.innerHTML = '<option value="">New job</option>' +
                    JOBS.map((j) => `<option value="${j.id}">${deps.esc(j.title)} (${j.status})</option>`).join('');
                return;
            }
            const openJobs = JOBS.filter((j) => j.status === 'open');
            el.innerHTML = '<option value="">Select job…</option>' +
                openJobs.map((j) =>
                    `<option value="${deps.esc(j.job_id)}" data-job-id="${deps.esc(j.id)}">${deps.esc(j.title)}</option>`
                ).join('');
        });
    }

    function applyPageUrl(jobId) {
        const slug = String(jobId || '').trim();
        if (!slug) return 'apply.html';
        return 'apply.html?job=' + encodeURIComponent(slug);
    }

    function renderLiveJobsPreview() {
        const el = document.getElementById('liveJobsPreview');
        if (!el) return;
        const open = JOBS.filter((j) => j.status === 'open');
        if (!open.length) {
            el.innerHTML =
                '<p class="empty" style="padding:16px 0">No open roles on the careers page. Set a job status to <strong>open</strong> to publish.</p>';
            return;
        }
        el.innerHTML =
            '<div style="display:flex;flex-direction:column;gap:10px">' +
            open
                .map(
                    (j) =>
                        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2)">' +
                        '<div><strong>' +
                        deps.esc(j.title) +
                        '</strong><div class="c-role">' +
                        deps.esc(j.location || 'Remote') +
                        ' · ' +
                        deps.esc(j.job_id) +
                        '</div></div>' +
                        '<a href="' +
                        applyPageUrl(j.job_id) +
                        '" target="_blank" rel="noopener" class="btn-sm" style="text-decoration:none;white-space:nowrap">View apply page ↗</a>' +
                        '</div>'
                )
                .join('') +
            '</div>';
    }

    function renderJobs() {
        const tb = document.getElementById('jobsBody');
        if (!tb) return;
        renderLiveJobsPreview();
        if (!JOBS.length) {
            tb.innerHTML = '<tr><td class="empty" colspan="7">No jobs yet — create one in the form.</td></tr>';
            return;
        }
        const canDel = !deps.auth || deps.auth.can('delete_job');
        const canEdit = !deps.auth || deps.auth.can('edit_jobs');
        tb.innerHTML = JOBS.map((j) =>
            `<tr data-job="${j.id}">
                <td><strong>${deps.esc(j.title)}</strong><div class="c-role">${deps.esc(j.job_id)}</div></td>
                <td>${deps.esc(j.location || '—')}</td>
                <td><span class="pill ${j.status === 'open' ? 'p-pass' : j.status === 'draft' ? 'p-pending' : 'p-reject'}">${deps.esc(j.status)}</span></td>
                <td class="c-role">${deps.fmtDate(j.updated_at)}</td>
                <td>${j.status === 'open' ? `<a href="${applyPageUrl(j.job_id)}" target="_blank" rel="noopener" class="btn-sm" style="text-decoration:none">View live</a>` : '<span class="c-role">—</span>'}</td>
                <td>${canEdit ? `<button type="button" class="btn-sm" data-edit-job="${j.id}">Edit</button>` : '<span class="c-role">—</span>'}</td>
                <td>${canDel ? `<button type="button" class="btn-sm btn-danger" data-del-job="${j.id}">Delete</button>` : '<span class="c-role">—</span>'}</td>
            </tr>`
        ).join('');

        tb.querySelectorAll('[data-edit-job]').forEach((btn) => {
            btn.addEventListener('click', () => fillJobForm(btn.getAttribute('data-edit-job')));
        });
        tb.querySelectorAll('[data-del-job]').forEach((btn) => {
            btn.addEventListener('click', () => deleteJob(btn.getAttribute('data-del-job')));
        });
    }

    function setSelectValue(id, value, fallback) {
        const el = document.getElementById(id);
        if (!el) return;
        const v = String(value || fallback || '').trim();
        if (v && ![...el.options].some((o) => o.value === v)) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            el.appendChild(opt);
        }
        el.value = v || fallback || el.options[0]?.value || '';
    }

    function fillJobForm(id) {
        const j = JOBS.find((x) => x.id === id);
        if (!j) return;
        document.getElementById('jobEditId').value = j.id;
        document.getElementById('jobTitleIn').value = j.title || '';
        document.getElementById('jobDeptIn').value = j.department || '';
        setSelectValue('jobLocIn', j.location, 'Remote');
        setSelectValue('jobTypeIn', j.employment_type, 'Full-time');
        document.getElementById('jobIntIn').value = j.interviewer_email || '';
        document.getElementById('jobStatusIn').value = j.status || 'draft';
        document.getElementById('jobCriteriaIn').value = '';
        document.getElementById('jobJdIn').value = j.jd_text || '';
        deps.setView('jobs');
    }

    async function saveJob() {
        if (deps.auth && !deps.auth.can('edit_jobs')) {
            deps.banner('You do not have permission to edit jobs.', 'err');
            return;
        }
        const id = document.getElementById('jobEditId').value;
        const title = document.getElementById('jobTitleIn').value.trim();
        const jd_text = document.getElementById('jobJdIn').value.trim();
        const interviewer_email = document.getElementById('jobIntIn').value.trim().toLowerCase();
        if (!title || !jd_text) {
            deps.banner('Job title and description are required.', 'err');
            return;
        }
        if (!interviewer_email) {
            deps.banner('Interviewer email is required.', 'err');
            return;
        }
        const row = {
            title,
            jd_text,
            job_id: slugFromTitle(title),
            department: document.getElementById('jobDeptIn').value.trim() || null,
            location: document.getElementById('jobLocIn').value || 'Remote',
            employment_type: document.getElementById('jobTypeIn').value || 'Full-time',
            interviewer_email,
            status: document.getElementById('jobStatusIn').value || 'draft',
            updated_at: new Date().toISOString(),
        };
        let error;
        if (id) {
            ({ error } = await deps.sb.from('jobs').update(row).eq('id', id));
        } else {
            ({ error } = await deps.sb.from('jobs').insert(row));
        }
        if (error) {
            deps.banner('Save job failed: ' + error.message, 'err');
            return;
        }
        if (deps.auth) await deps.auth.logAudit('save_job', 'job', row.job_id, { title: row.title, status: row.status });
        deps.banner('Job saved.', 'ok');
        document.getElementById('jobForm').reset();
        document.getElementById('jobEditId').value = '';
        await loadJobs();
    }

    async function deleteJob(id) {
        if (deps.auth && !deps.auth.can('delete_job')) {
            deps.banner('Only super admins can delete jobs.', 'err');
            return;
        }
        if (!confirm('Delete this job posting?')) return;
        const { error } = await deps.sb.from('jobs').delete().eq('id', id);
        if (error) {
            deps.banner('Delete job failed: ' + error.message + ' — run supabase_admin_panel.sql', 'err');
            return;
        }
        if (deps.auth) await deps.auth.logAudit('delete_job', 'job', id, {});
        deps.banner('Job deleted.', 'ok');
        await loadJobs();
    }

    async function onJobCriteriaGenerate() {
        const title = document.getElementById('jobTitleIn').value.trim();
        if (!title) {
            deps.banner('Enter a job title first.', 'err');
            return;
        }

        const payload = {
            title,
            department: document.getElementById('jobDeptIn').value.trim(),
            location: document.getElementById('jobLocIn').value,
            employment_type: document.getElementById('jobTypeIn').value,
            criteria: document.getElementById('jobCriteriaIn').value,
            nice_to_have: document.getElementById('jobNiceIn').value,
        };

        const btn = document.getElementById('jobGenBtn');
        const webhook = await resolveJdWebhookUrl();

        if (webhook) {
            const jdInp = document.getElementById('admJdWebhook');
            if (jdInp && !jdInp.value.trim()) jdInp.value = webhook;
            const prevLabel = btn?.textContent || 'Generate with AI';
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'AI generating…';
            }
            try {
                const res = await fetch(webhook, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'ngrok-skip-browser-warning': '1',
                    },
                    body: JSON.stringify(payload),
                });
                const rawText = await res.text();
                let data = {};
                try { data = rawText ? JSON.parse(rawText) : {}; } catch (_) { data = { jd_text: rawText }; }
                const jd = String(data.jd_text || data.output || data.text || '').trim();
                if (res.ok && jd) {
                    document.getElementById('jobJdIn').value = jd;
                    deps.banner('AI generated professional JD — review before saving.', 'ok');
                    return;
                }
                const errMsg = data.error || data.message ||
                    (!rawText.trim() ? 'Empty response — activate JD Generate workflow in n8n' : ('HTTP ' + res.status));
                deps.banner('AI generation failed: ' + errMsg + ' — using template fallback.', 'err');
            } catch (e) {
                deps.banner('AI generation failed — using template fallback.', 'err');
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = prevLabel;
                }
            }
        } else {
            deps.banner('JD webhook not set — using template. Add URL in Settings.', 'err');
        }

        const jd = generateJdFromCriteria({
            title: payload.title,
            department: payload.department,
            location: payload.location,
            employment_type: payload.employment_type,
            criteria: payload.criteria,
            nice: payload.nice_to_have,
        });
        document.getElementById('jobJdIn').value = jd;
        deps.banner('Template JD generated — review and tailor before publishing.', 'ok');
    }

    function onScreenJobPick() {
        const sel = document.getElementById('scrJob');
        const opt = sel?.selectedOptions?.[0];
        const job = JOBS.find((j) => j.id === opt?.dataset?.jobId);
        if (!job) return;
        document.getElementById('scrTitle').value = job.title || '';
        document.getElementById('scrJd').value = job.jd_text || '';
        document.getElementById('scrInt').value = job.interviewer_email || '';
    }

    function guessEmailFromFilename(name) {
        const base = String(name || '').replace(/\.pdf$/i, '');
        const m = base.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        return m ? m[0].toLowerCase() : '';
    }

    function collectEmailsFromText(...chunks) {
        const uniq = [];
        const addFrom = (source) => {
            const normalized = String(source || '')
                .replace(/\s*@\s*/g, '@')
                .replace(/([a-z0-9._%+-])\s+\.\s+([a-z])/gi, '$1.$2');
            const compact = normalized.replace(/\s+/g, '');
            for (const blob of [source, normalized, compact]) {
                const found = String(blob).match(EMAIL_RE) || [];
                for (const e of found) {
                    const email = e.toLowerCase().trim().replace(/\.+$/g, '');
                    if (!email || uniq.includes(email)) continue;
                    const local = email.split('@')[0];
                    if (BLOCKED_LOCAL.test(local)) continue;
                    if (BLOCKED_DOMAIN.test(email)) continue;
                    if (/\.(png|jpg|jpeg|pdf)$/i.test(email)) continue;
                    uniq.push(email);
                }
            }
        };
        chunks.forEach(addFrom);
        return uniq;
    }

    function pickBestEmail(...chunks) {
        const fallbackName = chunks[chunks.length - 1];
        const sources = chunks.slice(0, -1);
        const raw = sources.join('\n');
        const uniq = collectEmailsFromText(...sources);
        if (!uniq.length) return guessEmailFromFilename(fallbackName);
        const scored = uniq.map((email) => {
            let score = 0;
            const pos = raw.toLowerCase().indexOf(email);
            if (pos >= 0 && pos < 800) score += 30;
            if (pos >= 0 && pos < 200) score += 20;
            if (/\.(com|net|org|pk|co\.uk)$/i.test(email)) score += 5;
            if (/gmail|outlook|hotmail|yahoo|icloud|live\./i.test(email)) score += 8;
            return { email, score };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored[0].email;
    }

    function emailFromAnnotationUrl(url) {
        const u = String(url || '').trim();
        if (!u) return '';
        if (/^mailto:/i.test(u)) return u.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
        const m = u.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        return m ? m[0].toLowerCase() : '';
    }

    async function extractTextFromPdf(file, maxPages) {
        if (!window.pdfjsLib) throw new Error('PDF reader not loaded');
        const buf = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        const pages = Math.min(pdf.numPages, maxPages || 2);
        let text = '';
        let compact = '';
        const linkEmails = [];
        for (let p = 1; p <= pages; p++) {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            const parts = content.items.map((it) => String(it.str || '').trim()).filter(Boolean);
            text += parts.join(' ') + '\n';
            compact += parts.join('');
            try {
                const annots = await page.getAnnotations();
                for (const a of annots || []) {
                    const fromUrl = emailFromAnnotationUrl(a.url || a.unsafeUrl);
                    if (fromUrl) linkEmails.push(fromUrl);
                }
            } catch (_) { /* optional */ }
        }
        return { text, compact, linkEmails };
    }

    async function extractEmailFromPdf(file) {
        const fromName = guessEmailFromFilename(file.name);
        try {
            const { text, compact, linkEmails } = await extractTextFromPdf(file, 2);
            const linkBlob = linkEmails.join(' ');
            return pickBestEmail(text, compact, linkBlob, file.name) || fromName;
        } catch (err) {
            console.warn('PDF email extract failed', file.name, err);
            return fromName;
        }
    }

    function setScreenMode(mode) {
        screenMode = mode === 'batch' ? 'batch' : 'single';
        document.querySelectorAll('[data-screen-mode]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.screenMode === screenMode);
        });
        const fileInput = document.getElementById('scrCvFile');
        const emailGroup = document.getElementById('scrEmailGroup');
        const textGroup = document.getElementById('scrCvTextGroup');
        const fileLabel = document.getElementById('scrFileLabel');
        const fileHint = document.getElementById('scrFileHint');
        if (fileInput) {
            fileInput.multiple = screenMode === 'batch';
            fileInput.value = '';
        }
        document.getElementById('scrBatchList').innerHTML = '';
        if (emailGroup) emailGroup.style.display = screenMode === 'single' ? '' : 'none';
        if (textGroup) textGroup.style.display = screenMode === 'single' ? '' : 'none';
        if (fileLabel) fileLabel.textContent = screenMode === 'batch' ? 'Upload PDFs (multiple)' : 'Upload PDF';
        if (fileHint) {
            fileHint.textContent = screenMode === 'batch'
                ? 'Select multiple PDFs — emails auto-detected from each CV (first 2 pages). Edit any row if needed.'
                : 'PDF only · email auto-detected from CV';
        }
    }

    async function renderBatchList() {
        const list = document.getElementById('scrBatchList');
        const fileInput = document.getElementById('scrCvFile');
        const files = Array.from(fileInput?.files || []);
        if (screenMode !== 'batch' || !files.length) {
            if (list) list.innerHTML = '';
            return;
        }
        list.innerHTML = files.map((file, i) =>
            '<div class="batch-row">' +
            '<span class="fname" title="' + deps.esc(file.name) + '">' + deps.esc(file.name) + '</span>' +
            '<input type="email" required placeholder="Reading CV…" data-batch-email="' + i + '" class="extracting" disabled />' +
            '</div>'
        ).join('');
        const gen = ++batchExtractGen;
        for (let i = 0; i < files.length; i++) {
            if (gen !== batchExtractGen) return;
            const input = document.querySelector('[data-batch-email="' + i + '"]');
            if (!input) continue;
            const email = await extractEmailFromPdf(files[i]);
            if (gen !== batchExtractGen) return;
            input.disabled = false;
            input.classList.remove('extracting');
            if (email) {
                input.value = email;
                input.classList.add('extracted');
            } else {
                input.classList.add('missing');
                input.placeholder = 'Not found — type email';
            }
        }
    }

    async function onScreenFileChange() {
        const fileInput = document.getElementById('scrCvFile');
        if (screenMode === 'batch') {
            await renderBatchList();
            return;
        }
        const file = fileInput?.files?.[0];
        if (!file) return;
        const emailInput = document.getElementById('scrEmail');
        if (!emailInput) return;
        emailInput.placeholder = 'Reading email from CV…';
        const email = await extractEmailFromPdf(file);
        if (email) {
            emailInput.value = email;
            emailInput.placeholder = 'candidate@email.com';
        } else {
            emailInput.placeholder = 'Email not found — enter manually';
        }
    }

    async function screenOneCandidate(webhook, { email, title, requirements, interviewer, file, cvText }) {
        const fd = new FormData();
        fd.append('candidate_email', email);
        fd.append('requisition_title', title);
        fd.append('requisition_requirements', requirements);
        fd.append('requisition_id', slugFromTitle(title));
        fd.append('source', 'admin_cv_screen');
        if (interviewer) fd.append('interviewer_email', interviewer);
        if (file) fd.append('cv_file', file, file.name);
        else if (cvText) fd.append('cv_text', cvText);
        const res = await fetch(webhook, { method: 'POST', body: fd, headers: { 'ngrok-skip-browser-warning': '1' } });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error('HTTP ' + res.status + (errText ? ': ' + errText.slice(0, 120) : ''));
        }
    }

    async function submitManualScreen(e) {
        e.preventDefault();
        if (deps.auth && !deps.auth.can('screen_cv')) {
            deps.banner('You do not have permission to run CV screening.', 'err');
            return;
        }
        const webhook = normalizeWebhookUrl(document.getElementById('admWebhook')?.value || localStorage.getItem(WEBHOOK_STORAGE));
        if (!webhook) {
            deps.banner('Set CV ingest webhook in Settings first.', 'err');
            deps.setView('settings');
            return;
        }
        const title = document.getElementById('scrTitle').value.trim();
        const requirements = document.getElementById('scrJd').value.trim();
        const interviewer = document.getElementById('scrInt').value.trim().toLowerCase();
        if (!title || !requirements) {
            deps.banner('Job title and JD are required.', 'err');
            return;
        }
        if (!interviewer || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(interviewer)) {
            deps.banner('Valid interviewer email is required.', 'err');
            return;
        }

        const btn = document.getElementById('scrSubmit');
        const progress = document.getElementById('scrProgress');
        const progressFill = document.getElementById('scrProgressFill');
        btn.disabled = true;
        btn.textContent = 'Screening…';
        progress?.classList.remove('show');
        if (progressFill) progressFill.style.width = '0';

        try {
            if (screenMode === 'batch') {
                const files = Array.from(document.getElementById('scrCvFile')?.files || []);
                if (!files.length) {
                    deps.banner('Select at least one PDF.', 'err');
                    return;
                }
                const jobs = [];
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    const input = document.querySelector('[data-batch-email="' + i + '"]');
                    let email = (input?.value || '').trim().toLowerCase();
                    if (!email) email = await extractEmailFromPdf(file);
                    if (!email) {
                        deps.banner('Could not find email in: ' + file.name + '. Enter it manually.', 'err');
                        return;
                    }
                    jobs.push({ file, email });
                }
                progress?.classList.add('show');
                let ok = 0;
                let fail = 0;
                for (let i = 0; i < jobs.length; i++) {
                    const job = jobs[i];
                    if (progressFill) progressFill.style.width = Math.round(((i + 0.5) / jobs.length) * 100) + '%';
                    deps.banner('Screening ' + (i + 1) + ' of ' + jobs.length + ': ' + job.file.name + '…', 'ok');
                    try {
                        await screenOneCandidate(webhook, { email: job.email, title, requirements, interviewer, file: job.file });
                        ok++;
                    } catch (err) {
                        fail++;
                        console.error(err);
                    }
                }
                if (progressFill) progressFill.style.width = '100%';
                deps.banner('Batch done — ' + ok + ' submitted' + (fail ? ', ' + fail + ' failed' : '') + '. Check Candidates in ~30s.', fail ? 'err' : 'ok');
                document.getElementById('screenForm').reset();
                setScreenMode('batch');
                setTimeout(() => { deps.loadData(); deps.setView('candidates'); }, 1500);
            } else {
                const email = document.getElementById('scrEmail').value.trim().toLowerCase();
                const cvText = document.getElementById('scrCvText').value.trim();
                const file = document.getElementById('scrCvFile').files?.[0];
                if (!email) {
                    deps.banner('Candidate email is required.', 'err');
                    return;
                }
                if (!cvText && !file) {
                    deps.banner('Paste CV text or upload a PDF.', 'err');
                    return;
                }
                await screenOneCandidate(webhook, { email, title, requirements, interviewer, file, cvText });
                deps.banner('CV sent for AI screening — check Candidates in ~30s.', 'ok');
                document.getElementById('screenForm').reset();
                setScreenMode('single');
                setTimeout(() => { deps.loadData(); deps.setView('candidates'); }, 1500);
            }
        } catch (err) {
            deps.banner('Screening failed: ' + (err.message || err), 'err');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Run AI screening';
            setTimeout(() => progress?.classList.remove('show'), 800);
        }
    }

    async function loadOnsite() {
        if (!deps?.sb) return;
        const { data, error } = await deps.sb.from('onsite_interviews').select('*').order('interview_date', { ascending: false }).limit(500);
        if (error) {
            deps.banner('Onsite records: ' + error.message + ' — run supabase_admin_panel.sql', 'err');
            return;
        }
        ONSITE = data || [];
        renderOnsite();
    }

    function renderOnsite() {
        const tb = document.getElementById('onsiteBody');
        if (!tb) return;
        if (!ONSITE.length) {
            tb.innerHTML = '<tr><td class="empty" colspan="6">No onsite interview records yet.</td></tr>';
            return;
        }
        tb.innerHTML = ONSITE.map((r) =>
            `<tr>
                <td><strong>${deps.esc(r.candidate_email)}</strong>${r.candidate_name ? '<div class="c-role">' + deps.esc(r.candidate_name) + '</div>' : ''}</td>
                <td class="c-role">${deps.esc(r.job_title || r.job_id || '—')}</td>
                <td>${deps.fmtDateTime(r.interview_date)}</td>
                <td>${deps.esc(r.interview_type || 'onsite')}</td>
                <td><span class="pill p-pending">${deps.esc(r.outcome || 'pending')}</span></td>
                <td><button type="button" class="btn-sm btn-danger" data-del-onsite="${r.id}">Delete</button></td>
            </tr>`
        ).join('');
        tb.querySelectorAll('[data-del-onsite]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this onsite record?')) return;
                await deps.sb.from('onsite_interviews').delete().eq('id', btn.getAttribute('data-del-onsite'));
                await loadOnsite();
            });
        });
    }

    async function saveOnsite(e) {
        e.preventDefault();
        if (deps.auth && !deps.auth.can('onsite_write')) {
            deps.banner('You do not have permission to record onsite interviews.', 'err');
            return;
        }
        const row = {
            candidate_email: document.getElementById('onsEmail').value.trim().toLowerCase(),
            candidate_name: document.getElementById('onsName').value.trim() || null,
            job_id: document.getElementById('onsJob').value || null,
            job_title: (() => {
                const opt = document.getElementById('onsJob')?.selectedOptions?.[0];
                const job = JOBS.find((j) => j.id === opt?.dataset?.jobId);
                return job?.title || null;
            })(),
            interview_date: new Date(document.getElementById('onsDate').value).toISOString(),
            interview_type: document.getElementById('onsType').value,
            outcome: document.getElementById('onsOutcome').value || 'pending',
            interviewer_name: document.getElementById('onsInterviewer').value.trim() || null,
            location: document.getElementById('onsLocation').value.trim() || null,
            notes: document.getElementById('onsNotes').value.trim() || null,
            score: document.getElementById('onsScore').value ? Number(document.getElementById('onsScore').value) : null,
        };
        if (!row.candidate_email || !document.getElementById('onsDate').value) {
            deps.banner('Candidate email and interview date required.', 'err');
            return;
        }
        const { error } = await deps.sb.from('onsite_interviews').insert(row);
        if (error) {
            deps.banner('Save onsite failed: ' + error.message, 'err');
            return;
        }
        deps.banner('Onsite interview recorded.', 'ok');
        document.getElementById('onsiteForm').reset();
        await loadOnsite();
    }

    function roleOptionsHtml(selected, roles) {
        return (roles || []).map((r) =>
            '<option value="' + r + '"' + (selected === r ? ' selected' : '') + '>' +
            deps.esc(deps.auth.roleLabel(r)) + '</option>'
        ).join('');
    }

    function populateInviteRoleSelect() {
        const sel = document.getElementById('invRole');
        if (!sel || !deps.auth) return;
        const roles = deps.auth.assignableRoles();
        sel.innerHTML = roleOptionsHtml(roles[0], roles);
    }

    async function loadUsers() {
        if (!deps.auth?.canManageUsers()) return;
        populateInviteRoleSelect();
        const { data, error } = await deps.sb.from('profiles').select('*').order('created_at', { ascending: false });
        const tb = document.getElementById('usersBody');
        if (!tb) return;
        if (error) {
            tb.innerHTML = '<tr><td class="empty" colspan="5">' + deps.esc(error.message) + ' — run supabase_auth_profiles.sql</td></tr>';
            return;
        }
        const rows = data || [];
        if (!rows.length) {
            tb.innerHTML = '<tr><td class="empty" colspan="5">No users yet.</td></tr>';
            return;
        }
        const me = deps.auth.profile()?.id;
        tb.innerHTML = rows.map((u) => {
            const inactive = !u.is_active;
            const canEdit = deps.auth.canEditUserRole(u);
            const roleOpts = deps.auth.hasRole('super_admin')
                ? deps.auth.ALL_ROLES
                : deps.auth.assignableRoles();
            return `<tr data-user="${u.id}">
                <td><strong>${deps.esc(u.full_name || u.email)}</strong><div class="c-role">${deps.esc(u.email)}</div></td>
                <td>
                    <select class="filter" data-user-role="${u.id}" ${!canEdit || u.id === me ? 'disabled' : ''}>
                        ${roleOptionsHtml(u.role, canEdit ? roleOpts : [u.role])}
                    </select>
                </td>
                <td><span class="role-pill ${inactive ? 'inactive' : ''}">${inactive ? 'Inactive' : 'Active'}</span></td>
                <td class="c-role">${deps.fmtDate(u.created_at)}</td>
                <td>${u.id === me ? '<span class="c-role">You</span>' : `<button type="button" class="btn-sm" data-toggle-user="${u.id}">${inactive ? 'Activate' : 'Deactivate'}</button>`}</td>
            </tr>`;
        }).join('');
        tb.querySelectorAll('[data-user-role]').forEach((sel) => {
            sel.addEventListener('change', () => updateUserRole(sel.getAttribute('data-user-role'), sel.value));
        });
        tb.querySelectorAll('[data-toggle-user]').forEach((btn) => {
            btn.addEventListener('click', () => toggleUserActive(btn.getAttribute('data-toggle-user')));
        });
    }

    async function updateUserRole(userId, role) {
        if (!deps.auth?.canManageUsers()) return;
        if (!deps.auth.canAssignRole(role)) {
            deps.banner('You cannot assign the role: ' + deps.auth.roleLabel(role), 'err');
            await loadUsers();
            return;
        }
        const { error } = await deps.sb.from('profiles').update({ role, updated_at: new Date().toISOString() }).eq('id', userId);
        if (error) {
            deps.banner('Update role failed: ' + error.message, 'err');
            await loadUsers();
            return;
        }
        await deps.auth.logAudit('update_user_role', 'profile', userId, { role });
        deps.banner('User role updated.', 'ok');
    }

    async function toggleUserActive(userId) {
        if (!deps.auth?.canManageUsers()) return;
        const { data } = await deps.sb.from('profiles').select('is_active, email, role, id').eq('id', userId).maybeSingle();
        if (!data) return;
        if (!deps.auth.canEditUserRole(data)) {
            deps.banner('You cannot modify this user.', 'err');
            return;
        }
        const next = !data.is_active;
        if (!confirm((next ? 'Activate' : 'Deactivate') + ' ' + data.email + '?')) {
            await loadUsers();
            return;
        }
        const { error } = await deps.sb.from('profiles').update({ is_active: next, updated_at: new Date().toISOString() }).eq('id', userId);
        if (error) {
            deps.banner('Update failed: ' + error.message, 'err');
            return;
        }
        await deps.auth.logAudit(next ? 'activate_user' : 'deactivate_user', 'profile', userId, {});
        deps.banner('User updated.', 'ok');
        await loadUsers();
    }

    async function inviteUser(e) {
        e.preventDefault();
        if (!deps.auth?.canManageUsers()) {
            deps.banner('You do not have permission to invite users.', 'err');
            return;
        }
        const fullName = document.getElementById('invName').value.trim();
        const email = document.getElementById('invEmail').value.trim().toLowerCase();
        const password = document.getElementById('invPass').value;
        const role = document.getElementById('invRole').value;
        if (!deps.auth.canAssignRole(role)) {
            deps.banner('You cannot create users with role: ' + deps.auth.roleLabel(role), 'err');
            return;
        }
        const btn = document.getElementById('inviteUserBtn');
        btn.disabled = true;
        try {
            await deps.auth.inviteUser(email, password, {
                full_name: fullName,
                role,
                invited_by_admin: 'true',
            });
            await deps.auth.logAudit('invite_user', 'profile', email, { role });
            deps.banner('User created — share login credentials securely.', 'ok');
            document.getElementById('inviteUserForm').reset();
            await loadUsers();
        } catch (err) {
            let msg = err.message || String(err);
            if (/rate limit/i.test(msg)) {
                msg = 'Supabase email rate limit — create user in Supabase Auth dashboard, then set role here. Or disable Confirm email in Auth settings.';
            } else if (/not confirmed/i.test(msg)) {
                msg = 'User created but email not confirmed — run: UPDATE auth.users SET email_confirmed_at = now() WHERE email = \'...\';';
            }
            deps.banner('Invite failed: ' + msg, 'err');
        } finally {
            btn.disabled = false;
        }
    }

    async function loadAudit() {
        if (!deps.auth?.can('view_audit')) return;
        const tb = document.getElementById('auditBody');
        if (!tb) return;
        const { data: logs, error } = await deps.sb
            .from('audit_log')
            .select('id, action, entity_type, entity_id, meta, created_at, actor_id')
            .order('created_at', { ascending: false })
            .limit(250);
        if (error) {
            tb.innerHTML = '<tr><td class="empty" colspan="5">' + deps.esc(error.message) + '</td></tr>';
            return;
        }
        const actorIds = [...new Set((logs || []).map((l) => l.actor_id).filter(Boolean))];
        let actorMap = {};
        if (actorIds.length) {
            const { data: profs } = await deps.sb.from('profiles').select('id, email, full_name').in('id', actorIds);
            (profs || []).forEach((p) => { actorMap[p.id] = p.full_name || p.email; });
        }
        if (!logs?.length) {
            tb.innerHTML = '<tr><td class="empty" colspan="5">No audit events yet.</td></tr>';
            return;
        }
        tb.innerHTML = logs.map((l) =>
            `<tr>
                <td class="c-role">${deps.fmtDateTime(l.created_at)}</td>
                <td>${deps.esc(actorMap[l.actor_id] || '—')}</td>
                <td><strong>${deps.esc(l.action)}</strong></td>
                <td class="c-role">${deps.esc((l.entity_type || '') + (l.entity_id ? ' · ' + l.entity_id : ''))}</td>
                <td class="c-role">${deps.esc(l.meta ? JSON.stringify(l.meta).slice(0, 120) : '—')}</td>
            </tr>`
        ).join('');
    }

    function candidateJobSlugs(m) {
        const slugs = new Set();
        const r = String(m.role || '').toLowerCase().trim();
        if (r) {
            slugs.add(r);
            slugs.add(slugFromTitle(r));
        }
        const cfg = m.session?.config;
        const parsed = typeof cfg === 'object' && cfg ? cfg : {};
        if (parsed.requisition_id) slugs.add(String(parsed.requisition_id).toLowerCase());
        return [...slugs].filter(Boolean);
    }

    async function loadJobScope() {
        if (!deps.auth?.isJobScopedRole()) {
            SCOPED_JOB_SLUGS = null;
            return;
        }
        const email = String(deps.auth.profile()?.email || '').toLowerCase();
        const uid = deps.auth.profile()?.id;
        const slugs = new Set();
        if (email && deps.sb) {
            const { data: jobs } = await deps.sb.from('jobs').select('job_id, interviewer_email');
            (jobs || []).forEach((j) => {
                if (String(j.interviewer_email || '').toLowerCase() === email) {
                    slugs.add(String(j.job_id).toLowerCase());
                }
            });
        }
        if (uid && deps.sb) {
            const { data: rows } = await deps.sb.from('job_assignments').select('job_id').eq('user_id', uid);
            (rows || []).forEach((row) => slugs.add(String(row.job_id).toLowerCase()));
        }
        SCOPED_JOB_SLUGS = slugs;
    }

    function applyScopeFilter(merged) {
        if (!deps.auth?.isJobScopedRole()) return merged;
        if (!SCOPED_JOB_SLUGS || !SCOPED_JOB_SLUGS.size) return [];
        return (merged || []).filter((m) =>
            candidateJobSlugs(m).some((s) => SCOPED_JOB_SLUGS.has(s))
        );
    }

    function showScopeBanner() {
        const el = document.getElementById('scopeBanner');
        if (!el) return;
        if (!deps.auth?.isJobScopedRole()) {
            el.className = 'banner';
            el.textContent = '';
            return;
        }
        const n = SCOPED_JOB_SLUGS ? SCOPED_JOB_SLUGS.size : 0;
        const jobs = n ? [...SCOPED_JOB_SLUGS].join(', ') : 'none';
        el.className = 'banner show ok';
        el.textContent = n
            ? 'Hiring Manager view — showing candidates for your ' + n + ' assigned job(s): ' + jobs
            : 'No jobs assigned to you yet. Ask super admin to set interviewer email on jobs or assign jobs in Users tab.';
    }

    function noteTypeLabel(t) {
        const map = { feedback: 'Feedback', proceed: 'Proceed', reject: 'Reject', general: 'Note' };
        return map[t] || t;
    }

    function noteTypePill(t) {
        const cls = t === 'proceed' ? 'p-pass' : t === 'reject' ? 'p-reject' : 'p-pending';
        return '<span class="pill ' + cls + '">' + deps.esc(noteTypeLabel(t)) + '</span>';
    }

    async function loadDrawerNotes(m) {
        const list = document.getElementById('hmNotesList');
        if (!list || !deps.sb) return;
        const email = String(m.email || '').toLowerCase();
        const { data, error } = await deps.sb
            .from('candidate_notes')
            .select('*')
            .eq('candidate_email', email)
            .order('created_at', { ascending: false })
            .limit(40);
        if (error) {
            list.innerHTML = '<p class="c-role">' + deps.esc(error.message) + ' — run supabase_hiring_manager.sql</p>';
            return;
        }
        if (!data?.length) {
            list.innerHTML = '<p class="c-role">No notes yet — add feedback or a hiring decision below.</p>';
            return;
        }
        list.innerHTML = data.map((n) =>
            '<div class="qblock" style="margin-bottom:10px">' +
            '<div class="qphase">' + noteTypePill(n.note_type) +
            '<strong style="margin-left:8px">' + deps.esc(n.author_name || 'Team') + '</strong>' +
            '<span class="c-role" style="margin-left:8px">' + deps.fmtDateTime(n.created_at) + '</span></div>' +
            '<div class="qtext">' + deps.esc(n.body) + '</div></div>'
        ).join('');
    }

    function renderHmNotesPanelHtml() {
        if (!deps.auth?.can('add_candidate_notes')) return '';
        return '<div class="section" id="hmNotesSection">' +
            '<div class="section-h">Team notes &amp; decisions</div>' +
            '<div id="hmNotesList" class="c-role">Loading notes…</div>' +
            '<form id="hmNoteForm" style="margin-top:14px">' +
            '<div class="form-group"><label for="hmNoteType">Note type</label>' +
            '<select id="hmNoteType" class="filter" style="width:100%">' +
            '<option value="feedback">Feedback</option>' +
            '<option value="proceed">Proceed to interview</option>' +
            '<option value="reject">Do not proceed</option>' +
            '<option value="general">General note</option>' +
            '</select></div>' +
            '<div class="form-group"><label for="hmNoteBody">Comment</label>' +
            '<textarea id="hmNoteBody" required placeholder="Interview feedback, hiring decision, concerns…" style="width:100%;min-height:80px"></textarea></div>' +
            '<button type="submit" class="btn-sm btn-primary">Save note</button>' +
            '</form></div>';
    }

    async function saveCandidateNote(m, noteType, body) {
        if (!deps.auth?.can('add_candidate_notes')) return;
        const prof = deps.auth.profile();
        const row = {
            candidate_email: String(m.email || '').toLowerCase(),
            job_id: candidateJobSlugs(m)[0] || null,
            author_id: prof?.id,
            author_name: prof?.full_name || prof?.email,
            author_role: prof?.role,
            body: String(body || '').trim(),
            note_type: noteType || 'feedback',
        };
        if (!row.body) return;
        const { error } = await deps.sb.from('candidate_notes').insert(row);
        if (error) throw error;
        if (deps.auth) await deps.auth.logAudit('add_candidate_note', 'candidate', row.candidate_email, { note_type: row.note_type });
    }

    function bindDrawerNotes(m) {
        const form = document.getElementById('hmNoteForm');
        if (!form) return;
        loadDrawerNotes(m);
        form.onsubmit = async (e) => {
            e.preventDefault();
            try {
                await saveCandidateNote(
                    m,
                    document.getElementById('hmNoteType')?.value,
                    document.getElementById('hmNoteBody')?.value
                );
                document.getElementById('hmNoteBody').value = '';
                deps.banner('Note saved.', 'ok');
                await loadDrawerNotes(m);
            } catch (err) {
                deps.banner('Save note failed: ' + (err.message || err), 'err');
            }
        };
    }

    async function loadJobAssignmentsPanel() {
        const card = document.getElementById('jobAssignCard');
        const el = document.getElementById('jobAssignPanel');
        if (card) card.style.display = deps.auth?.can('manage_job_assignments') ? '' : 'none';
        if (!el || !deps.auth?.can('manage_job_assignments')) return;
        // Full-access mode: all roles see assignments panel if they have manage_job_assignments
        const [{ data: users }, { data: jobs }] = await Promise.all([
            deps.sb.from('profiles').select('id, email, full_name, role')
                .in('role', ['hiring_manager', 'hiring_manager_head', 'interviewer']).eq('is_active', true),
            deps.sb.from('jobs').select('job_id, title').order('title'),
        ]);
        const hmUsers = users || [];
        const jobList = jobs || [];
        if (!hmUsers.length) {
            el.innerHTML = '<p class="form-hint">No hiring managers — invite one with role Hiring Manager first.</p>';
            return;
        }
        el.innerHTML =
            '<form id="jobAssignForm" class="form-grid cols-1">' +
            '<div class="form-group"><label for="assignUser">Hiring manager</label>' +
            '<select id="assignUser" required>' +
            hmUsers.map((u) => '<option value="' + u.id + '">' + deps.esc(u.full_name || u.email) + '</option>').join('') +
            '</select></div>' +
            '<div class="form-group"><label for="assignJob">Job (slug)</label>' +
            '<select id="assignJob" required>' +
            '<option value="">Select job…</option>' +
            jobList.map((j) => '<option value="' + deps.esc(j.job_id) + '">' + deps.esc(j.title) + ' (' + deps.esc(j.job_id) + ')</option>').join('') +
            '</select></div>' +
            '<button type="submit" class="btn-secondary">Assign job</button></form>' +
            '<div id="assignList" class="form-hint" style="margin-top:12px">Loading assignments…</div>';
        document.getElementById('jobAssignForm')?.addEventListener('submit', saveJobAssignment);
        await renderAssignmentList();
    }

    async function renderAssignmentList() {
        const el = document.getElementById('assignList');
        if (!el) return;
        const { data, error } = await deps.sb
            .from('job_assignments')
            .select('id, job_id, user_id, profiles(full_name, email)')
            .order('created_at', { ascending: false })
            .limit(100);
        if (error) {
            el.textContent = error.message;
            return;
        }
        if (!data?.length) {
            el.innerHTML = 'No explicit assignments yet — HMs also see jobs where <code>interviewer_email</code> matches their login email.';
            return;
        }
        el.innerHTML = '<ul style="margin:0;padding-left:18px">' + data.map((a) => {
            const p = a.profiles || {};
            return '<li>' + deps.esc(p.full_name || p.email || a.user_id) + ' → <strong>' + deps.esc(a.job_id) + '</strong> ' +
                '<button type="button" class="btn-sm btn-danger" data-rm-assign="' + a.id + '">Remove</button></li>';
        }).join('') + '</ul>';
        el.querySelectorAll('[data-rm-assign]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                await deps.sb.from('job_assignments').delete().eq('id', btn.getAttribute('data-rm-assign'));
                await renderAssignmentList();
            });
        });
    }

    async function saveJobAssignment(e) {
        e.preventDefault();
        if (!deps.auth?.can('manage_job_assignments')) return;
        const user_id = document.getElementById('assignUser')?.value;
        const job_id = document.getElementById('assignJob')?.value;
        if (!user_id || !job_id) return;
        const { error } = await deps.sb.from('job_assignments').insert({
            user_id,
            job_id,
            assignment_role: 'hiring_manager',
        });
        if (error) {
            deps.banner('Assign failed: ' + error.message, 'err');
            return;
        }
        deps.banner('Job assigned to hiring manager.', 'ok');
        await renderAssignmentList();
    }

    async function deleteCandidateRecord(m) {
        if (deps.auth && !deps.auth.can('delete_candidate')) {
            deps.banner('Only super admins can delete candidates.', 'err');
            return;
        }
        if (!m || !confirm('Permanently delete all records for ' + m.email + '? This cannot be undone.')) return;
        const email = String(m.email || '').toLowerCase();
        const errs = [];

        if (m.session?.id) {
            const { error } = await deps.sb.from('assessment_sessions').delete().eq('id', m.session.id);
            if (error) errs.push('session: ' + error.message);
        } else {
            const { error } = await deps.sb.from('assessment_sessions').delete().eq('candidate_email', email);
            if (error) errs.push('session: ' + error.message);
        }
        if (m.candidateId) {
            const { error } = await deps.sb.from('candidates').delete().eq('id', m.candidateId);
            if (error) errs.push('candidate: ' + error.message);
        } else {
            const { error } = await deps.sb.from('candidates').delete().eq('candidate_email', email);
            if (error) errs.push('candidate: ' + error.message);
        }
        await deps.sb.from('onsite_interviews').delete().eq('candidate_email', email);

        if (errs.length) {
            deps.banner('Partial delete — run supabase_admin_panel.sql. ' + errs.join('; '), 'err');
        } else {
            if (deps.auth) await deps.auth.logAudit('delete_candidate', 'candidate', email, {});
            deps.banner('Candidate deleted.', 'ok');
        }
        deps.closeDrawer();
        await deps.loadData();
        await loadOnsite();
    }

    function bindEvents() {
        document.getElementById('jobForm')?.addEventListener('submit', (e) => { e.preventDefault(); saveJob(); });
        document.getElementById('jobGenBtn')?.addEventListener('click', onJobCriteriaGenerate);
        document.getElementById('jobResetBtn')?.addEventListener('click', () => {
            document.getElementById('jobForm').reset();
            document.getElementById('jobEditId').value = '';
        });
        document.getElementById('screenForm')?.addEventListener('submit', submitManualScreen);
        document.getElementById('scrJob')?.addEventListener('change', onScreenJobPick);
        document.getElementById('scrCvFile')?.addEventListener('change', onScreenFileChange);
        document.getElementById('scrViewResults')?.addEventListener('click', () => deps.setView('candidates'));
        document.querySelectorAll('[data-screen-mode]').forEach((btn) => {
            btn.addEventListener('click', () => setScreenMode(btn.dataset.screenMode));
        });
        document.getElementById('onsiteForm')?.addEventListener('submit', saveOnsite);
        document.getElementById('saveWebhookBtn')?.addEventListener('click', saveWebhookConfig);
        document.getElementById('drawerDeleteBtn')?.addEventListener('click', () => {
            if (deps.activeCandidate) deleteCandidateRecord(deps.activeCandidate);
        });
        document.getElementById('inviteUserForm')?.addEventListener('submit', inviteUser);
    }

    window.TAAdmin = {
        init(d) {
            deps = d;
            deps.activeCandidate = null;
            initPdfJs();
            bindEvents();
            setScreenMode('single');
            loadWebhookConfig();
            loadJdWebhookConfig();
            loadJobs();
            loadOnsite();
            const wh = new URLSearchParams(location.search).get('webhook');
            if (wh) {
                const decoded = decodeURIComponent(wh);
                const input = document.getElementById('admWebhook');
                if (input && !input.value) input.value = decoded;
                localStorage.setItem(WEBHOOK_STORAGE, decoded);
            }
        },
        onViewChange(view) {
            if (view === 'jobs') loadJobs();
            if (view === 'onsite') loadOnsite();
            if (view === 'settings') {
                loadWebhookConfig();
                loadJdWebhookConfig();
            }
            if (view === 'users') {
                loadUsers();
                loadJobAssignmentsPanel();
            }
            if (view === 'audit') loadAudit();
        },
        setActiveCandidate(m) {
            deps.activeCandidate = m;
            const btn = document.getElementById('drawerDeleteBtn');
            if (btn) btn.style.display = (m && deps.auth?.can('delete_candidate')) ? 'inline-flex' : 'none';
        },
        async loadJobScope() {
            await loadJobScope();
        },
        applyScopeFilter(merged) {
            return applyScopeFilter(merged);
        },
        showScopeBanner() {
            showScopeBanner();
        },
        renderHmNotesPanelHtml() {
            return renderHmNotesPanelHtml();
        },
        bindDrawerNotes(m) {
            bindDrawerNotes(m);
        },
        renderOnsiteForDrawer(email) {
            const rows = ONSITE.filter((r) => String(r.candidate_email).toLowerCase() === String(email).toLowerCase());
            if (!rows.length) return '';
            let html = '<div class="section"><div class="section-h">Onsite interviews</div>';
            rows.forEach((r) => {
                html += '<div class="qblock"><div class="qphase"><strong>' + deps.esc(deps.fmtDateTime(r.interview_date)) + '</strong>' +
                    '<span class="pill p-pending">' + deps.esc(r.outcome || 'pending') + '</span></div>';
                if (r.notes) html += '<div class="qtext ans">' + deps.esc(r.notes) + '</div>';
                html += '</div>';
            });
            return html + '</div>';
        },
    };
})();
