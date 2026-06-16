/**
 * Talent Acquisition — Admin panel extensions
 * Loaded by dashboard.html after core bootstrap.
 */
(function () {
    'use strict';

    const WEBHOOK_STORAGE = 'ta_cv_ingest_webhook';
    const JD_WEBHOOK_STORAGE = 'ta_jd_generate_webhook';
    const MANUAL_SHORTLIST_WEBHOOK_STORAGE = 'ta_manual_shortlist_webhook';
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

    const TAPagination = {
        PAGE_SIZE: 12,
        pages: {},
        get(key) {
            if (!this.pages[key]) this.pages[key] = 1;
            return this.pages[key];
        },
        set(key, page) {
            this.pages[key] = Math.max(1, Number(page) || 1);
        },
        reset(key) {
            this.pages[key] = 1;
        },
        slice(key, items) {
            const list = Array.isArray(items) ? items : [];
            const total = list.length;
            const totalPages = Math.max(1, Math.ceil(total / this.PAGE_SIZE));
            let page = this.get(key);
            if (page > totalPages) {
                page = totalPages;
                this.pages[key] = page;
            }
            const start = (page - 1) * this.PAGE_SIZE;
            return {
                items: list.slice(start, start + this.PAGE_SIZE),
                page,
                totalPages,
                total,
                from: total ? start + 1 : 0,
                to: Math.min(start + this.PAGE_SIZE, total),
            };
        },
        renderBar(containerId, key, meta, onChange) {
            const el = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
            if (!el) return;
            if (!meta || !meta.total) {
                el.hidden = true;
                el.innerHTML = '';
                return;
            }
            el.hidden = false;
            const prevDisabled = meta.page <= 1;
            const nextDisabled = meta.page >= meta.totalPages;
            el.innerHTML =
                '<p class="pagination-info">Showing ' + meta.from + '–' + meta.to + ' of ' + meta.total + '</p>' +
                '<div class="pagination-actions">' +
                '<button type="button" class="pagination-btn" data-page-action="first" ' + (prevDisabled ? 'disabled' : '') + '>First</button>' +
                '<button type="button" class="pagination-btn" data-page-action="prev" ' + (prevDisabled ? 'disabled' : '') + '>Previous</button>' +
                '<span class="pagination-page">' + meta.page + ' / ' + meta.totalPages + '</span>' +
                '<button type="button" class="pagination-btn" data-page-action="next" ' + (nextDisabled ? 'disabled' : '') + '>Next</button>' +
                '<button type="button" class="pagination-btn" data-page-action="last" ' + (nextDisabled ? 'disabled' : '') + '>Last</button>' +
                '</div>';
            el.querySelectorAll('[data-page-action]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const action = btn.getAttribute('data-page-action');
                    let next = meta.page;
                    if (action === 'first') next = 1;
                    else if (action === 'prev') next = meta.page - 1;
                    else if (action === 'next') next = meta.page + 1;
                    else if (action === 'last') next = meta.totalPages;
                    this.set(key, next);
                    if (typeof onChange === 'function') onChange();
                });
            });
        },
    };

    let AUDIT_LOGS = [];

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

    function uniqueJobSlug(title, excludeId) {
        const base = slugFromTitle(title);
        let slug = base;
        let n = 2;
        while (JOBS.some((j) => j.job_id === slug && j.id !== excludeId)) {
            slug = (base.slice(0, 44) + '-' + n).replace(/-+$/, '');
            n += 1;
        }
        return slug;
    }

    const JOB_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    function clearJobFieldErrors() {
        document.querySelectorAll('#jobForm .form-group.field-error').forEach((g) => {
            g.classList.remove('field-error');
            g.querySelector('.field-error-msg')?.remove();
        });
    }

    let jobCreatePanelRo = null;

    function syncJobCreatePanelHeight() {
        const view = document.getElementById('view-jobs-create');
        const left = view?.querySelector('.job-create-left');
        const panel = view?.querySelector('.job-jd-panel');
        if (!view?.classList.contains('active') || !left || !panel) return;

        if (window.innerWidth <= 1100) {
            panel.style.height = '';
            panel.style.maxHeight = '';
            return;
        }

        const h = left.offsetHeight;
        if (h > 0) {
            panel.style.height = h + 'px';
            panel.style.maxHeight = h + 'px';
        }
    }

    function bindJobCreatePanelSync() {
        const left = document.querySelector('#view-jobs-create .job-create-left');
        if (!left) return;

        if (jobCreatePanelRo) jobCreatePanelRo.disconnect();
        if (typeof ResizeObserver !== 'undefined') {
            jobCreatePanelRo = new ResizeObserver(() => {
                requestAnimationFrame(syncJobCreatePanelHeight);
            });
            jobCreatePanelRo.observe(left);
        }

        window.addEventListener('resize', syncJobCreatePanelHeight);
    }

    function setJobFieldError(fieldId, message) {
        const el = document.getElementById(fieldId);
        if (!el) return false;
        const group = el.closest('.form-group');
        if (!group) return false;
        group.classList.add('field-error');
        let msg = group.querySelector('.field-error-msg');
        if (!msg) {
            msg = document.createElement('div');
            msg.className = 'field-error-msg';
            group.appendChild(msg);
        }
        msg.textContent = message;
        return true;
    }

    function bindJobFieldValidation() {
        const ids = ['jobTitleIn', 'jobIntIn', 'jobJdIn', 'jobDeptIn', 'jobExpIn', 'jobStackIn', 'jobSalaryIn'];
        ids.forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            const ev = el.tagName === 'SELECT' ? 'change' : 'input';
            el.addEventListener(ev, () => {
                const group = el.closest('.form-group');
                if (group?.classList.contains('field-error')) {
                    group.classList.remove('field-error');
                    group.querySelector('.field-error-msg')?.remove();
                }
            });
        });
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

    function deriveManualShortlistWebhookFromCv(cvUrl) {
        const u = normalizeWebhookUrl(cvUrl);
        if (!u) return '';
        if (/\/talent\/cv-ingest$/i.test(u)) {
            return u.replace(/\/talent\/cv-ingest$/i, '/talent/manual-shortlist-mail');
        }
        if (/\/webhook\//i.test(u)) return u.replace(/\/[^/]+$/, '/talent/manual-shortlist-mail');
        return u + '/webhook/talent/manual-shortlist-mail';
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

        const expLine = String(opts.experience || '').trim() || {
            intern: 'Internship / graduate opportunity',
            junior: '0–2 years of relevant experience',
            mid: '2–5 years of relevant experience',
            senior: '5+ years of relevant experience',
        }[seniority];
        const stackLine = String(opts.tech_stack || '').trim();
        const salaryLine = String(opts.salary_range || '').trim();

        const metaBits = [dept, emp, loc];
        if (stackLine) metaBits.push('Stack: ' + stackLine);
        if (salaryLine) metaBits.push('Compensation: ' + salaryLine);

        return (
            `${title}\n` +
            `${metaBits.join(' | ')}\n\n` +
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

    async function loadManualShortlistWebhookConfig() {
        const fromInput = normalizeWebhookUrl(document.getElementById('admManualShortlistWebhook')?.value || '');
        if (fromInput) return fromInput;

        const fromStorage = normalizeWebhookUrl(localStorage.getItem(MANUAL_SHORTLIST_WEBHOOK_STORAGE) || '');
        if (fromStorage) return fromStorage;

        if (deps?.sb) {
            const { data } = await deps.sb
                .from('app_config')
                .select('value')
                .eq('key', 'manual_shortlist_webhook')
                .maybeSingle();
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
            const derived = deriveManualShortlistWebhookFromCv(data?.value || '');
            if (derived) return derived;
        }
        if (cvUrl) {
            const derived = deriveManualShortlistWebhookFromCv(cvUrl);
            if (derived) return derived;
        }

        return isLocalHost() ? 'http://localhost:5678/webhook/talent/manual-shortlist-mail' : N8N_WEBHOOK_BASE + '/talent/manual-shortlist-mail';
    }

    async function populateManualShortlistWebhookConfig() {
        const url = await loadManualShortlistWebhookConfig();
        const inp = document.getElementById('admManualShortlistWebhook');
        if (inp && url && !inp.value.trim()) inp.value = url;
        return url;
    }

    async function triggerManualShortlistMailWebhook(payload) {
        const webhook = await loadManualShortlistWebhookConfig();
        if (!webhook) return { ok: false, error: 'Manual shortlist webhook URL not set — add it in Settings.' };
        if (/\/webhook-test\//i.test(webhook)) {
            return { ok: false, error: 'Use n8n Production URL (/webhook/), not Test URL (/webhook-test/).' };
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
            if (res.ok) return { ok: true };
            const errText = String(await res.text()).slice(0, 200);
            return { ok: false, error: errText || 'HTTP ' + res.status };
        } catch (err) {
            return { ok: false, error: String(err?.message || err).slice(0, 200) };
        }
    }

    async function saveWebhookConfig() {
        if (deps.auth && !deps.auth.can('save_webhooks')) {
            deps.banner('Only super admins can change integration settings.', 'err');
            return;
        }
        const cvUrl = normalizeWebhookUrl(document.getElementById('admWebhook')?.value || '');
        const jdUrl = normalizeWebhookUrl(document.getElementById('admJdWebhook')?.value || '');
        const manualShortlistUrl = normalizeWebhookUrl(
            document.getElementById('admManualShortlistWebhook')?.value ||
            deriveManualShortlistWebhookFromCv(cvUrl)
        );
        if (!cvUrl) {
            deps.banner('Enter a valid n8n CV ingest webhook URL.', 'err');
            return;
        }
        localStorage.setItem(WEBHOOK_STORAGE, cvUrl);
        if (jdUrl) localStorage.setItem(JD_WEBHOOK_STORAGE, jdUrl);
        if (manualShortlistUrl) localStorage.setItem(MANUAL_SHORTLIST_WEBHOOK_STORAGE, manualShortlistUrl);
        if (deps.sb) {
            const rows = [
                { key: 'cv_ingest_webhook', value: cvUrl, updated_at: new Date().toISOString() },
            ];
            if (jdUrl) {
                rows.push({ key: 'jd_generate_webhook', value: jdUrl, updated_at: new Date().toISOString() });
            }
            if (manualShortlistUrl) {
                rows.push({
                    key: 'manual_shortlist_webhook',
                    value: manualShortlistUrl,
                    updated_at: new Date().toISOString(),
                });
            }
            await deps.sb.from('app_config').upsert(rows, { onConflict: 'key' });
        }
        if (deps.auth) {
            await deps.auth.logAudit('save_webhooks', 'app_config', 'webhooks', {
                cv: !!cvUrl,
                jd: !!jdUrl,
                manual_shortlist: !!manualShortlistUrl,
            });
        }
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

    function renderJobs() {
        const tb = document.getElementById('jobsBody');
        if (!tb) return;
        if (!JOBS.length) {
            TAPagination.renderBar('jobsPagination', 'jobs', { total: 0 }, renderJobs);
            tb.innerHTML = '<tr><td class="empty" colspan="7">No jobs yet — <button type="button" class="btn-sm" data-go-view="jobs-create">Create your first job</button></td></tr>';
            tb.querySelector('[data-go-view]')?.addEventListener('click', () => deps.setView('jobs-create'));
            return;
        }
        const pageMeta = TAPagination.slice('jobs', JOBS);
        TAPagination.renderBar('jobsPagination', 'jobs', pageMeta, renderJobs);
        const canDel = !deps.auth || deps.auth.can('delete_job');
        const canEdit = !deps.auth || deps.auth.can('edit_jobs');
        tb.innerHTML = pageMeta.items.map((j) =>
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

    function populateJobDisplayStyleSelect() {
        const el = document.getElementById('jobDisplayStyleIn');
        if (!el || !window.TAJobStyles) return;
        el.innerHTML = window.TAJobStyles.buildSelectOptions(el.value || 'hiring-top');
    }

    function updateJobDisplayStyleHint() {
        const el = document.getElementById('jobDisplayStyleIn');
        const hint = document.getElementById('jobDisplayStyleHint');
        if (!el || !hint || !window.TAJobStyles) return;
        const opt = window.TAJobStyles.OPTIONS.find((o) => o.id === el.value);
        hint.textContent = opt?.hint || 'How this role looks on the public apply page.';
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
        document.getElementById('jobNiceIn').value = '';
        document.getElementById('jobExpIn').value = j.experience || '';
        document.getElementById('jobStackIn').value = j.tech_stack || '';
        document.getElementById('jobSalaryIn').value = j.salary_range || '';
        document.getElementById('jobJdIn').value = j.jd_text || '';
        setSelectValue('jobDisplayStyleIn', window.TAJobStyles?.normalize(j.display_style) || 'hiring-top', 'hiring-top');
        updateJobDisplayStyleHint();
        clearJobFieldErrors();
        resetJobTemplateUi();
        deps.setView('jobs-create');
    }

    async function saveJob() {
        if (deps.auth && !deps.auth.can('edit_jobs')) {
            deps.banner('You do not have permission to edit jobs.', 'err');
            return;
        }
        clearJobFieldErrors();

        const id = document.getElementById('jobEditId').value;
        const existing = id ? JOBS.find((x) => x.id === id) : null;
        const title = document.getElementById('jobTitleIn').value.trim();
        const jd_text = document.getElementById('jobJdIn').value.trim();
        const interviewer_email = document.getElementById('jobIntIn').value.trim().toLowerCase();

        let hasError = false;
        let firstErrorId = null;
        const fail = (fieldId, message) => {
            setJobFieldError(fieldId, message);
            if (!firstErrorId) firstErrorId = fieldId;
            hasError = true;
        };

        if (!title) fail('jobTitleIn', 'Job title is required — enter a role name.');
        if (!jd_text) fail('jobJdIn', 'Job description is required — upload a template or generate with AI.');
        if (!interviewer_email) {
            fail('jobIntIn', 'Interviewer email is required.');
        } else if (!JOB_EMAIL_RE.test(interviewer_email)) {
            fail('jobIntIn', 'Enter a valid email address (e.g. interviewer@company.com).');
        }

        if (hasError) {
            document.getElementById(firstErrorId)?.focus();
            deps.banner('Please fill in the highlighted fields before saving.', 'err');
            return;
        }

        const experience = document.getElementById('jobExpIn')?.value.trim() || null;
        const tech_stack = document.getElementById('jobStackIn')?.value.trim() || null;
        const salary_range = document.getElementById('jobSalaryIn')?.value.trim() || null;
        const display_style = window.TAJobStyles?.normalize(
            document.getElementById('jobDisplayStyleIn')?.value || 'hiring-top'
        ) || 'hiring-top';

        const row = {
            title,
            jd_text,
            job_id: existing ? existing.job_id : uniqueJobSlug(title),
            department: document.getElementById('jobDeptIn').value.trim() || null,
            location: document.getElementById('jobLocIn').value || 'Remote',
            employment_type: document.getElementById('jobTypeIn').value || 'Full-time',
            interviewer_email,
            status: document.getElementById('jobStatusIn').value || 'draft',
            experience,
            tech_stack,
            salary_range,
            display_style,
            updated_at: new Date().toISOString(),
        };

        async function trySave(payload) {
            if (id) return deps.sb.from('jobs').update(payload).eq('id', id);
            return deps.sb.from('jobs').insert(payload);
        }

        let { error } = await trySave(row);
        let usedFallback = false;
        if (error && /column|schema|does not exist/i.test(error.message || '')) {
            const fallback = { ...row };
            delete fallback.experience;
            delete fallback.tech_stack;
            delete fallback.salary_range;
            delete fallback.display_style;
            const extras = [
                experience ? 'Experience: ' + experience : '',
                tech_stack ? 'Tech stack: ' + tech_stack : '',
                salary_range ? 'Compensation: ' + salary_range : '',
            ].filter(Boolean);
            if (extras.length) {
                fallback.jd_text = extras.join('\n') + '\n\n' + jd_text;
            }
            ({ error } = await trySave(fallback));
            usedFallback = !error;
        }
        if (error) {
            const msg = String(error.message || error);
            if (/duplicate key|unique constraint|jobs_job_id/i.test(msg)) {
                if (id) {
                    deps.banner('Save failed: job link ID conflict. Refresh the page and try again.', 'err');
                } else {
                    setJobFieldError('jobTitleIn', 'A job with a similar title already exists — change the title slightly.');
                    deps.banner('This job title already exists. Use a different title.', 'err');
                }
            } else {
                deps.banner('Save job failed: ' + msg, 'err');
            }
            return;
        }
        deps.banner(
            usedFallback
                ? 'Job saved (run supabase_jobs_expand.sql to store experience/stack/salary separately).'
                : 'Job saved.',
            'ok'
        );
        if (deps.auth) await deps.auth.logAudit('save_job', 'job', row.job_id, { title: row.title, status: row.status });
        document.getElementById('jobForm').reset();
        document.getElementById('jobEditId').value = '';
        resetJobTemplateUi();
        await loadJobs();
        deps.setView('jobs');
    }

    /* ---------- LinkedIn / social post image ---------- */
    let socialPostFormat = 'linkedin';
    let lastSocialData = null;
    const SOCIAL_FORMATS = {
        linkedin: { w: 1200, h: 627, label: 'linkedin' },
        square: { w: 1080, h: 1080, label: 'square' },
    };
    const SOCIAL_FONT = 'Inter, system-ui, -apple-system, sans-serif';

    function roundRect(ctx, x, y, w, h, r) {
        const rr = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    }

    function wrapCanvasText(ctx, text, maxWidth) {
        const words = String(text || '').split(/\s+/).filter(Boolean);
        if (!words.length) return [];
        const lines = [];
        let line = words[0];
        for (let i = 1; i < words.length; i++) {
            const test = line + ' ' + words[i];
            if (ctx.measureText(test).width > maxWidth && line) {
                lines.push(line);
                line = words[i];
            } else {
                line = test;
            }
        }
        if (line) lines.push(line);
        return lines;
    }

    function truncateCanvasText(ctx, text, maxWidth) {
        let t = String(text || '');
        if (ctx.measureText(t).width <= maxWidth) return t;
        while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
        return t + '…';
    }

    async function ensureSocialFonts() {
        if (!document.fonts?.load) return;
        await Promise.all([
            document.fonts.load('800 36px ' + SOCIAL_FONT),
            document.fonts.load('700 42px ' + SOCIAL_FONT),
            document.fonts.load('600 18px ' + SOCIAL_FONT),
            document.fonts.load('500 16px ' + SOCIAL_FONT),
        ]);
    }

    function paintSocialBackground(ctx, w, h) {
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#0f172a');
        g.addColorStop(0.5, '#1e3a8a');
        g.addColorStop(1, '#2563eb');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.beginPath();
        ctx.arc(w * 0.88, h * 0.12, Math.min(w, h) * 0.14, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(w * 0.08, h * 0.88, Math.min(w, h) * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(w * 0.55, h * 0.05, Math.min(w, h) * 0.08, 0, Math.PI * 2);
        ctx.fill();
    }

    function drawSocialChip(ctx, x, y, text) {
        const padX = 14;
        const padY = 8;
        ctx.font = '600 15px ' + SOCIAL_FONT;
        const tw = ctx.measureText(text).width;
        const cw = tw + padX * 2;
        const ch = 30;
        roundRect(ctx, x, y, cw, ch, 15);
        ctx.fillStyle = '#eff6ff';
        ctx.fill();
        ctx.strokeStyle = '#bfdbfe';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#1d4ed8';
        ctx.fillText(text, x + padX, y + 20);
        return cw + 10;
    }

    function drawSocialMetaRow(ctx, x, y, label, value, maxWidth) {
        if (!value) return y;
        ctx.font = '700 15px ' + SOCIAL_FONT;
        ctx.fillStyle = '#64748b';
        ctx.fillText(label, x, y);
        ctx.font = '600 17px ' + SOCIAL_FONT;
        ctx.fillStyle = '#0f172a';
        const lines = wrapCanvasText(ctx, value, maxWidth - 130);
        lines.forEach((line, i) => ctx.fillText(line, x + 120, y + i * 24));
        return y + lines.length * 24 + 14;
    }

    function collectJobSocialData() {
        const id = document.getElementById('jobEditId')?.value || '';
        const existing = id ? JOBS.find((x) => x.id === id) : null;
        const title = document.getElementById('jobTitleIn')?.value.trim() || '';
        const slug = existing?.job_id || (title ? uniqueJobSlug(title) : '');
        const apply_url = new URL(applyPageUrl(slug), location.href).href;
        const careers_url = new URL('careers.html', location.href).href;
        return {
            title,
            department: document.getElementById('jobDeptIn')?.value.trim() || '',
            location: document.getElementById('jobLocIn')?.value || 'Remote',
            employment_type: document.getElementById('jobTypeIn')?.value || 'Full-time',
            experience: document.getElementById('jobExpIn')?.value.trim() || '',
            tech_stack: document.getElementById('jobStackIn')?.value.trim() || '',
            salary_range: document.getElementById('jobSalaryIn')?.value.trim() || '',
            criteria: parseBulletLines(document.getElementById('jobCriteriaIn')?.value).slice(0, 4),
            job_slug: slug,
            is_saved: !!existing,
            is_live: existing?.status === 'open',
            apply_url,
            careers_url,
        };
    }

    function buildLinkedInCaption(data) {
        const lines = [];
        lines.push('🚀 We\'re hiring: ' + data.title);
        lines.push('');
        const meta = [data.location, data.employment_type, data.department].filter(Boolean);
        if (meta.length) lines.push(meta.join(' · '));
        if (data.experience) lines.push('Experience: ' + data.experience);
        if (data.tech_stack) lines.push('Tech stack: ' + data.tech_stack);
        if (data.salary_range) lines.push('Compensation: ' + data.salary_range);
        if (data.criteria.length) {
            lines.push('');
            lines.push('What we\'re looking for:');
            data.criteria.forEach((c) => lines.push('• ' + c));
        }
        lines.push('');
        if (data.is_live) {
            lines.push('Apply now: ' + data.apply_url);
        } else if (data.is_saved) {
            lines.push('Careers portal: ' + data.careers_url);
            lines.push('Tip: set status to Open and save for a direct apply link.');
        } else {
            lines.push('Save this job and set status to Open for a live apply link.');
            lines.push('Careers portal: ' + data.careers_url);
        }
        lines.push('');
        lines.push('#hiring #jobs #careers #CONVO');
        return lines.join('\n');
    }

    function drawSocialCardContent(ctx, data, cardX, cardY, cardW, cardH, isSquare) {
        const pad = isSquare ? 48 : 40;
        const innerW = cardW - pad * 2;
        let y = cardY + pad + (isSquare ? 8 : 4);

        ctx.font = '800 ' + (isSquare ? '52' : '44') + 'px ' + SOCIAL_FONT;
        ctx.fillStyle = '#0f172a';
        const titleLines = wrapCanvasText(ctx, data.title || 'Open Position', innerW);
        const titleSize = isSquare ? 52 : 44;
        const titleLineH = isSquare ? 58 : 50;
        titleLines.slice(0, isSquare ? 3 : 2).forEach((line) => {
            ctx.fillText(line, cardX + pad, y);
            y += titleLineH;
        });
        y += 12;

        let chipX = cardX + pad;
        let chipRowY = y;
        const chips = [data.location, data.employment_type, data.department].filter(Boolean);
        chips.forEach((chip) => {
            ctx.font = '600 15px ' + SOCIAL_FONT;
            const cw = ctx.measureText(chip).width + 28;
            if (chipX + cw > cardX + cardW - pad) {
                chipX = cardX + pad;
                chipRowY += 40;
            }
            drawSocialChip(ctx, chipX, chipRowY, chip);
            chipX += cw + 10;
        });
        y = chips.length ? chipRowY + 44 : y + 8;

        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cardX + pad, y);
        ctx.lineTo(cardX + cardW - pad, y);
        ctx.stroke();
        y += 28;

        y = drawSocialMetaRow(ctx, cardX + pad, y, 'Experience', data.experience, innerW);
        y = drawSocialMetaRow(ctx, cardX + pad, y, 'Tech stack', data.tech_stack, innerW);
        y = drawSocialMetaRow(ctx, cardX + pad, y, 'Salary', data.salary_range, innerW);

        const bulletStart = y;
        const maxBulletY = cardY + cardH - (isSquare ? 100 : 88);
        if (data.criteria.length && y < maxBulletY - 30) {
            ctx.font = '700 15px ' + SOCIAL_FONT;
            ctx.fillStyle = '#64748b';
            ctx.fillText('Key requirements', cardX + pad, y);
            y += 26;
            ctx.font = '600 17px ' + SOCIAL_FONT;
            ctx.fillStyle = '#334155';
            for (const item of data.criteria) {
                if (y > maxBulletY) break;
                const lines = wrapCanvasText(ctx, item, innerW - 28);
                lines.forEach((line, i) => {
                    if (y > maxBulletY) return;
                    if (i === 0) {
                        ctx.fillStyle = '#2563eb';
                        ctx.fillText('•', cardX + pad, y);
                    }
                    ctx.fillStyle = '#334155';
                    ctx.fillText(line, cardX + pad + 22, y);
                    y += 24;
                });
                y += 4;
            }
        }
        if (y === bulletStart && !data.experience && !data.tech_stack && !data.salary_range) {
            ctx.font = '600 17px ' + SOCIAL_FONT;
            ctx.fillStyle = '#64748b';
            ctx.fillText('Join our team — details in the job post.', cardX + pad, y);
        }
    }

    function drawSocialFooter(ctx, cardX, cardY, cardW, cardH, data) {
        const footH = 64;
        const fy = cardY + cardH - footH;
        const r = 22;
        ctx.beginPath();
        ctx.moveTo(cardX, fy);
        ctx.lineTo(cardX + cardW, fy);
        ctx.lineTo(cardX + cardW, cardY + cardH - r);
        ctx.arcTo(cardX + cardW, cardY + cardH, cardX + cardW - r, cardY + cardH, r);
        ctx.arcTo(cardX, cardY + cardH, cardX, cardY + cardH - r, r);
        ctx.lineTo(cardX, fy);
        ctx.closePath();
        ctx.fillStyle = '#2563eb';
        ctx.fill();
        ctx.font = '800 22px ' + SOCIAL_FONT;
        ctx.fillStyle = '#ffffff';
        ctx.fillText('Apply now →', cardX + 36, fy + 40);
        ctx.font = '600 15px ' + SOCIAL_FONT;
        const link = data.is_live ? data.apply_url : data.careers_url;
        const linkText = truncateCanvasText(ctx, link.replace(/^https?:\/\//, ''), cardW - 220);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillText(linkText, cardX + 200, fy + 40);
    }

    async function renderSocialPostCanvas(canvas, data, format) {
        const spec = SOCIAL_FORMATS[format] || SOCIAL_FORMATS.linkedin;
        const { w, h } = spec;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = '100%';
        canvas.style.maxWidth = w + 'px';
        canvas.style.aspectRatio = w + ' / ' + h;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        paintSocialBackground(ctx, w, h);

        const isSquare = format === 'square';
        const margin = isSquare ? 56 : 48;
        const cardX = margin;
        const cardY = isSquare ? 120 : 96;
        const cardW = w - margin * 2;
        const cardH = h - cardY - margin;

        ctx.font = '800 ' + (isSquare ? '40' : '34') + 'px ' + SOCIAL_FONT;
        ctx.fillStyle = '#ffffff';
        ctx.fillText('CONVO', cardX, isSquare ? 72 : 58);

        const badge = "WE'RE HIRING";
        ctx.font = '800 14px ' + SOCIAL_FONT;
        const bw = ctx.measureText(badge).width + 28;
        const bx = w - margin - bw;
        const by = isSquare ? 48 : 36;
        roundRect(ctx, bx, by, bw, 34, 17);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.fillStyle = '#1d4ed8';
        ctx.fillText(badge, bx + 14, by + 22);

        ctx.shadowColor = 'rgba(15, 23, 42, 0.18)';
        ctx.shadowBlur = 28;
        ctx.shadowOffsetY = 10;
        roundRect(ctx, cardX, cardY, cardW, cardH, 22);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;

        drawSocialCardContent(ctx, data, cardX, cardY, cardW, cardH, isSquare);
        drawSocialFooter(ctx, cardX, cardY, cardW, cardH, data);
    }

    async function refreshSocialPostPreview() {
        if (!lastSocialData) return;
        const canvas = document.getElementById('socialPostCanvas');
        if (!canvas) return;
        await ensureSocialFonts();
        await renderSocialPostCanvas(canvas, lastSocialData, socialPostFormat);
    }

    function setSocialPostFormat(format) {
        socialPostFormat = SOCIAL_FORMATS[format] ? format : 'linkedin';
        document.querySelectorAll('[data-social-format]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.socialFormat === socialPostFormat);
        });
        refreshSocialPostPreview();
    }

    function updateSocialPostHint(data) {
        const hint = document.getElementById('socialPostHint');
        if (!hint) return;
        if (data.is_live) {
            hint.textContent = 'Live apply link is included in the image and caption.';
        } else if (data.is_saved) {
            hint.textContent = 'Job is saved as draft/closed — set status to Open for a direct apply link.';
        } else {
            hint.textContent = 'Save the job and set status to Open for a live apply link in posts.';
        }
    }

    async function openSocialPostModal() {
        const title = document.getElementById('jobTitleIn')?.value.trim();
        if (!title) {
            setJobFieldError('jobTitleIn', 'Enter a job title before creating a social post.');
            deps.banner('Add a job title first, then generate the LinkedIn post.', 'err');
            document.getElementById('jobTitleIn')?.focus();
            return;
        }
        lastSocialData = collectJobSocialData();
        const modal = document.getElementById('socialPostModal');
        const caption = document.getElementById('socialPostCaption');
        if (caption) caption.value = buildLinkedInCaption(lastSocialData);
        updateSocialPostHint(lastSocialData);
        if (modal) {
            modal.classList.add('show');
            modal.setAttribute('aria-hidden', 'false');
        }
        await refreshSocialPostPreview();
    }

    function closeSocialPostModal() {
        const modal = document.getElementById('socialPostModal');
        if (modal) {
            modal.classList.remove('show');
            modal.setAttribute('aria-hidden', 'true');
        }
    }

    async function downloadSocialPostImage() {
        const canvas = document.getElementById('socialPostCanvas');
        if (!canvas || !lastSocialData) return;
        await refreshSocialPostPreview();
        const slug = lastSocialData.job_slug || 'job';
        const link = document.createElement('a');
        link.download = 'convo-hiring-' + slug + '-' + socialPostFormat + '.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
        deps.banner('Image downloaded — ready to post on LinkedIn.', 'ok');
    }

    async function copySocialPostCaption() {
        const caption = document.getElementById('socialPostCaption');
        const text = caption?.value || (lastSocialData ? buildLinkedInCaption(lastSocialData) : '');
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            deps.banner('Caption copied to clipboard.', 'ok');
        } catch (_) {
            caption?.select();
            document.execCommand('copy');
            deps.banner('Caption copied.', 'ok');
        }
    }

    function bindSocialPostEvents() {
        document.getElementById('jobSocialBtn')?.addEventListener('click', openSocialPostModal);
        document.getElementById('socialPostModalClose')?.addEventListener('click', closeSocialPostModal);
        document.getElementById('socialPostModalBackdrop')?.addEventListener('click', closeSocialPostModal);
        document.getElementById('socialDownloadBtn')?.addEventListener('click', downloadSocialPostImage);
        document.getElementById('socialCopyCaptionBtn')?.addEventListener('click', copySocialPostCaption);
        document.querySelectorAll('[data-social-format]').forEach((btn) => {
            btn.addEventListener('click', () => setSocialPostFormat(btn.dataset.socialFormat));
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.getElementById('socialPostModal')?.classList.contains('show')) {
                closeSocialPostModal();
            }
        });
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
            experience: document.getElementById('jobExpIn')?.value.trim() || '',
            tech_stack: document.getElementById('jobStackIn')?.value.trim() || '',
            salary_range: document.getElementById('jobSalaryIn')?.value.trim() || '',
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
            experience: payload.experience,
            tech_stack: payload.tech_stack,
            salary_range: payload.salary_range,
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

    function fileExt(name) {
        const m = String(name || '').match(/\.([^.]+)$/);
        return m ? m[1].toLowerCase() : '';
    }

    function stripHtmlToText(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return (doc.body.innerText || doc.body.textContent || '').trim();
    }

    function stripRtfBasic(rtf) {
        return String(rtf || '')
            .replace(/\\par[d]?\s?/gi, '\n')
            .replace(/\\[a-z]+-?\d*\s?/gi, '')
            .replace(/[{}]/g, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    async function extractTextFromDocx(file) {
        if (!window.mammoth) throw new Error('Word reader not loaded');
        const buf = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer: buf });
        if (result.messages?.length) console.warn('DOCX extract:', result.messages);
        return (result.value || '').trim();
    }

    async function extractFullPdfText(file) {
        if (!window.pdfjsLib) throw new Error('PDF reader not loaded');
        const buf = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        const maxPages = Math.min(pdf.numPages, 40);
        let text = '';
        for (let p = 1; p <= maxPages; p++) {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            const items = content.items
                .map((it) => ({
                    str: String(it.str || ''),
                    y: Math.round(it.transform[5]),
                }))
                .filter((it) => it.str.trim());
            items.sort((a, b) => b.y - a.y);
            let lastY = null;
            const parts = [];
            for (const it of items) {
                if (lastY !== null && Math.abs(it.y - lastY) > 4) parts.push('\n');
                parts.push(it.str);
                lastY = it.y;
            }
            text += parts.join('').replace(/\s+\n/g, '\n').trim() + '\n\n';
        }
        return text.trim();
    }

    async function extractTextFromJobTemplate(file) {
        const ext = fileExt(file.name);
        const type = String(file.type || '').toLowerCase();

        if (ext === 'pdf' || type === 'application/pdf') return extractFullPdfText(file);
        if (ext === 'docx' || type.includes('wordprocessingml')) return extractTextFromDocx(file);
        if (ext === 'doc') {
            throw new Error('Legacy .doc files are not supported — save as .docx or PDF and upload again.');
        }
        if (['txt', 'md', 'csv'].includes(ext) || type.startsWith('text/')) return (await file.text()).trim();
        if (['html', 'htm'].includes(ext) || type.includes('html')) return stripHtmlToText(await file.text());
        if (ext === 'rtf' || type.includes('rtf')) {
            const asText = stripRtfBasic(await file.text());
            if (asText.length > 40) return asText;
            throw new Error('Could not read RTF — try saving as .docx or PDF.');
        }
        try {
            const guess = (await file.text()).trim();
            if (guess.length > 80 && /[a-zA-Z]{4,}/.test(guess)) return guess;
        } catch (_) { /* binary */ }
        throw new Error('Unsupported file type — use PDF, Word (.docx), TXT, or HTML.');
    }

    function extractFieldFromJd(text, patterns) {
        const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
            for (const re of patterns) {
                const m = line.match(re);
                if (m) return (m[1] || m[0] || '').replace(/^[\s:–—-]+/, '').trim();
            }
        }
        return '';
    }

    function tryFillFieldsFromJdText(text) {
        const jd = String(text || '').trim();
        if (!jd) return;

        const titleIn = document.getElementById('jobTitleIn');
        if (titleIn && !titleIn.value.trim()) {
            const firstLine = jd.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 3 && l.length < 120);
            if (firstLine && !/^(about|job description|overview|responsibilities)/i.test(firstLine)) {
                titleIn.value = firstLine.replace(/\s*[|–—-]\s*.+$/, '').trim();
            }
        }

        const expIn = document.getElementById('jobExpIn');
        if (expIn && !expIn.value.trim()) {
            const exp = extractFieldFromJd(jd, [
                /(?:experience|years of experience|yoe)\s*[:\-–—]?\s*(.+)/i,
                /(\d+\s*[–—-]\s*\d+\+?\s*years?)/i,
                /(\d+\+?\s*years?(?:\s+of)?\s+(?:relevant\s+)?experience)/i,
            ]);
            if (exp) expIn.value = exp;
        }

        const stackIn = document.getElementById('jobStackIn');
        if (stackIn && !stackIn.value.trim()) {
            const stack = extractFieldFromJd(jd, [
                /(?:tech(?:nical)?\s*stack|technologies|skills|stack)\s*[:\-–—]?\s*(.+)/i,
            ]);
            if (stack) stackIn.value = stack;
        }

        const salaryIn = document.getElementById('jobSalaryIn');
        if (salaryIn && !salaryIn.value.trim()) {
            const salary = extractFieldFromJd(jd, [
                /(?:salary|compensation|pay(?:\s*range)?|package)\s*[:\-–—]?\s*(.+)/i,
                /(PKR\s*[\d,.]+[kK]?\s*[–—-]\s*[\d,.]+[kK]?)/i,
                /(\$[\d,.]+[kK]?\s*[–—-]\s*\$?[\d,.]+[kK]?)/i,
            ]);
            if (salary) salaryIn.value = salary;
        }
    }

    function resetJobTemplateUi() {
        const input = document.getElementById('jobTemplateFile');
        const name = document.getElementById('jobTemplateName');
        const btn = document.getElementById('jobTemplateBtn');
        const hint = document.getElementById('jobTemplateHint');
        if (input) input.value = '';
        if (name) name.textContent = '';
        if (btn) {
            btn.classList.remove('has-file');
            btn.textContent = 'Upload template';
        }
        if (hint) hint.textContent = 'Used for careers page, CV screening, and assessment.';
    }

    async function onJobTemplateFileChange(file) {
        if (!file) return;
        const btn = document.getElementById('jobTemplateBtn');
        const nameEl = document.getElementById('jobTemplateName');
        const hint = document.getElementById('jobTemplateHint');
        const jdIn = document.getElementById('jobJdIn');

        if (btn) {
            btn.classList.add('has-file');
            btn.textContent = 'Change template';
        }
        if (nameEl) nameEl.textContent = file.name;
        if (hint) hint.textContent = 'Reading template…';

        try {
            const text = await extractTextFromJobTemplate(file);
            if (!text) throw new Error('No text found in file.');
            if (jdIn) jdIn.value = text;
            tryFillFieldsFromJdText(text);
            if (hint) hint.textContent = 'Template loaded — review and edit before saving.';
            deps.banner('JD loaded from template: ' + file.name, 'ok');
        } catch (err) {
            if (btn) {
                btn.classList.remove('has-file');
                btn.textContent = 'Upload template';
            }
            if (nameEl) nameEl.textContent = '';
            if (hint) hint.textContent = 'Used for careers page, CV screening, and assessment.';
            deps.banner('Template upload failed: ' + (err.message || err), 'err');
        }
    }

    function bindJobTemplateUpload() {
        const input = document.getElementById('jobTemplateFile');
        const btn = document.getElementById('jobTemplateBtn');
        if (!input) return;

        btn?.addEventListener('click', () => input.click());
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (file) onJobTemplateFileChange(file);
        });
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
            TAPagination.renderBar('onsitePagination', 'onsite', { total: 0 }, renderOnsite);
            tb.innerHTML = '<tr><td class="empty" colspan="6">No onsite interview records yet.</td></tr>';
            return;
        }
        const pageMeta = TAPagination.slice('onsite', ONSITE);
        TAPagination.renderBar('onsitePagination', 'onsite', pageMeta, renderOnsite);
        tb.innerHTML = pageMeta.items.map((r) =>
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

    function roleOptionsGroupedHtml(selected, groups) {
        return (groups || []).map((g) => {
            const opts = (g.roles || []).map((r) =>
                '<option value="' + r + '"' + (selected === r ? ' selected' : '') + '>' +
                deps.esc(deps.auth.roleLabel(r)) + '</option>'
            ).join('');
            return '<optgroup label="' + deps.esc(g.label) + '">' + opts + '</optgroup>';
        }).join('');
    }

    function buildRoleSelectHtml(selected, useGrouped) {
        if (!deps.auth) return '';
        const groups = deps.auth.roleGroupsForInvite();
        if (useGrouped && groups.length) {
            return roleOptionsGroupedHtml(selected, groups);
        }
        const roles = deps.auth.assignableRoles();
        return roleOptionsHtml(selected || roles[0], roles);
    }

    function updateInviteRoleHint(role) {
        const hint = document.getElementById('inviteRoleHint');
        if (!hint || !deps.auth) return;
        const desc = role ? deps.auth.roleDescription(role) : '';
        if (desc) {
            hint.textContent = desc;
            return;
        }
        if (deps.auth.hasRole('super_admin')) {
            hint.textContent = 'Platform Admin can create any role, including HR Lead and Hiring Lead.';
        } else if (deps.auth.hasRole('hr_head')) {
            hint.textContent = 'Invite recruiters, interviewers, or read-only users to your HR team.';
        } else if (deps.auth.hasRole('hiring_manager_head')) {
            hint.textContent = 'Invite hiring managers or interviewers to your team.';
        }
    }

    function populateInviteRoleSelect() {
        const sel = document.getElementById('invRole');
        if (!sel || !deps.auth) return;
        if (!deps.auth.canManageUsers()) return;
        const roles = deps.auth.assignableRoles();
        if (!roles.length) {
            sel.innerHTML = '<option value="">No roles available</option>';
            return;
        }
        const useGrouped = deps.auth.roleGroupsForInvite().length > 0;
        const defaultRole = deps.auth.hasRole('super_admin')
            ? 'hr_head'
            : (deps.auth.hasRole('hiring_manager_head') ? 'hiring_manager' : 'recruiter');
        sel.innerHTML = buildRoleSelectHtml(
            roles.includes(defaultRole) ? defaultRole : roles[0],
            useGrouped
        );
        updateInviteRoleHint(sel.value);
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
        const rows = (data || []).filter((u) => deps.auth.canSeeUser(u));
        renderUsersTable(rows);
    }

    function renderUsersTable(rows) {
        const tb = document.getElementById('usersBody');
        if (!tb) return;
        if (!rows.length) {
            TAPagination.renderBar('usersPagination', 'users', { total: 0 }, () => loadUsers());
            tb.innerHTML = '<tr><td class="empty" colspan="5">No team members yet — use Invite user to add someone.</td></tr>';
            return;
        }
        const pageMeta = TAPagination.slice('users', rows);
        TAPagination.renderBar('usersPagination', 'users', pageMeta, () => renderUsersTable(rows));
        const me = deps.auth.profile()?.id;
        tb.innerHTML = pageMeta.items.map((u) => {
            const inactive = !u.is_active;
            const canEdit = deps.auth.canEditUserRole(u);
            const roleSelectHtml = canEdit
                ? buildRoleSelectHtml(u.role, deps.auth.hasRole('super_admin'))
                : roleOptionsHtml(u.role, [u.role]);
            return `<tr data-user="${u.id}">
                <td><strong>${deps.esc(u.full_name || u.email)}</strong><div class="c-role">${deps.esc(u.email)}</div></td>
                <td>
                    <select class="filter" data-user-role="${u.id}" ${!canEdit || u.id === me ? 'disabled' : ''}>
                        ${roleSelectHtml}
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
            deps.setView('users');
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
            TAPagination.renderBar('auditPagination', 'audit', { total: 0 }, renderAuditTable);
            tb.innerHTML = '<tr><td class="empty" colspan="5">' + deps.esc(error.message) + '</td></tr>';
            return;
        }
        const actorIds = [...new Set((logs || []).map((l) => l.actor_id).filter(Boolean))];
        let actorMap = {};
        if (actorIds.length) {
            const { data: profs } = await deps.sb.from('profiles').select('id, email, full_name').in('id', actorIds);
            (profs || []).forEach((p) => { actorMap[p.id] = p.full_name || p.email; });
        }
        AUDIT_LOGS = (logs || []).map((l) => ({ ...l, actorLabel: actorMap[l.actor_id] || '—' }));
        renderAuditTable();
    }

    function renderAuditTable() {
        const tb = document.getElementById('auditBody');
        if (!tb) return;
        if (!AUDIT_LOGS.length) {
            TAPagination.renderBar('auditPagination', 'audit', { total: 0 }, renderAuditTable);
            tb.innerHTML = '<tr><td class="empty" colspan="5">No audit events yet.</td></tr>';
            return;
        }
        const pageMeta = TAPagination.slice('audit', AUDIT_LOGS);
        TAPagination.renderBar('auditPagination', 'audit', pageMeta, renderAuditTable);
        tb.innerHTML = pageMeta.items.map((l) =>
            `<tr>
                <td class="c-role">${deps.fmtDateTime(l.created_at)}</td>
                <td>${deps.esc(l.actorLabel || '—')}</td>
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

    async function approveReviewCandidate(m) {
        if (deps.auth && !deps.auth.can('approve_review')) {
            deps.banner('You do not have permission to shortlist review candidates.', 'err');
            return;
        }
        if (!m?.candidateId) {
            deps.banner('Missing candidate record id.', 'err');
            return;
        }
        if (m.stage !== 'ReviewQueue') {
            deps.banner('Only Review queue candidates can be manually shortlisted.', 'err');
            return;
        }
        if (m.session?.id) {
            deps.banner('This candidate already has an assessment session.', 'err');
            return;
        }
        if (!confirm('Shortlist ' + m.email + ' for ' + (m.role || 'this role') + ' and create an assessment session?')) {
            return;
        }

        const btn = document.getElementById('drawerApproveBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Creating session…';
        }

        try {
            const session = await deps.auth?.getSession?.();
            if (!session?.access_token) {
                throw new Error('Not signed in — refresh and try again.');
            }

            const res = await fetch('/api/manual-shortlist', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer ' + session.access_token,
                },
                body: JSON.stringify({ candidate_id: m.candidateId }),
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                throw new Error(data.message || data.error || 'Shortlist request failed');
            }

            if (data.assessment_link && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(data.assessment_link);
            }

            let emailSent = !!data.email_sent;
            let emailError = data.email_error || '';

            if (!emailSent) {
                if (btn) btn.textContent = 'Sending invite email…';
                const mailResult = await triggerManualShortlistMailWebhook({
                    candidate_email: data.candidate_email || m.email,
                    session_id: data.session_id,
                    requisition_id: data.requisition_id,
                    requisition_title: m.role,
                    score: m.cvScore,
                    max_questions: 5,
                    organization_name: 'CONVO',
                    portal_base_url: 'https://talent-acquisition-six.vercel.app',
                    assessment_link: data.assessment_link,
                    manual_shortlist: true,
                    approved_by: deps.auth?.profile?.email || '',
                });
                if (mailResult.ok) {
                    emailSent = true;
                } else if (!emailError) {
                    emailError = mailResult.error || 'Browser webhook call failed';
                }
            }

            if (emailSent) {
                deps.banner(
                    'Shortlisted — assessment session created and invite email sent to ' + m.email + '.',
                    'ok'
                );
            } else if (!data.webhook_configured && !emailError) {
                deps.banner(
                    'Shortlisted — session created. Email not sent: set manual shortlist webhook in Settings (use ngrok /webhook/ URL, not localhost).',
                    'err'
                );
            } else if (emailError) {
                deps.banner(
                    'Shortlisted — session created but email failed: ' + emailError + '. Check n8n workflow is Active and URL uses /webhook/ not /webhook-test/.',
                    'err'
                );
            } else if (data.assessment_link && navigator.clipboard?.writeText) {
                deps.banner('Shortlisted — session created. Link copied to clipboard.', 'ok');
            } else {
                deps.banner('Shortlisted — session ' + (data.session_id || 'created'), 'ok');
            }

            if (emailError) {
                console.warn('Manual shortlist mail error:', emailError);
            }

            if (deps.auth) {
                await deps.auth.logAudit('approve_review', 'candidate', m.email, {
                    session_id: data.session_id,
                    requisition_id: data.requisition_id,
                });
            }

            deps.closeDrawer();
            await deps.loadData();
        } catch (err) {
            deps.banner('Shortlist failed: ' + (err.message || err), 'err');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Shortlist & send assessment';
            }
        }
    }

    function syncDrawerActionButtons(m) {
        const approveBtn = document.getElementById('drawerApproveBtn');
        const deleteBtn = document.getElementById('drawerDeleteBtn');
        const canApprove =
            m &&
            m.stage === 'ReviewQueue' &&
            !m.session?.id &&
            (!deps.auth || deps.auth.can('approve_review'));
        if (approveBtn) approveBtn.style.display = canApprove ? 'inline-flex' : 'none';
        if (deleteBtn) {
            deleteBtn.style.display = m && deps.auth?.can('delete_candidate') ? 'inline-flex' : 'none';
        }
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

    function renderRoleAccessMatrix() {
        const el = document.getElementById('roleAccessMatrix');
        if (!el || !deps.auth) return;
        if (!deps.auth.canManageRolePermissions()) {
            el.innerHTML = '<p class="empty">Only Platform Admin can configure role access.</p>';
            return;
        }
        const snapshot = deps.auth.getRoleAccessSnapshot();
        const viewLabels = deps.auth.VIEW_LABELS || {};
        const permLabels = deps.auth.PERM_LABELS || {};
        const views = deps.auth.ALL_VIEWS.filter((v) => v !== 'role-permissions');
        const perms = deps.auth.ALL_PERMS || [];

        el.innerHTML = deps.auth.EDITABLE_ROLES.map((role) => {
            const access = snapshot[role] || { views: [], perms: [] };
            const viewChecks = views.map((v) => {
                const on = access.views.includes(v);
                return '<label class="perm-check">' +
                    '<input type="checkbox" data-role="' + role + '" data-kind="view" data-key="' + v + '"' + (on ? ' checked' : '') + ' />' +
                    '<span>' + deps.esc(viewLabels[v] || v) + '</span></label>';
            }).join('');
            const permChecks = perms.map((p) => {
                const on = access.perms.includes(p);
                return '<label class="perm-check">' +
                    '<input type="checkbox" data-role="' + role + '" data-kind="perm" data-key="' + p + '"' + (on ? ' checked' : '') + ' />' +
                    '<span>' + deps.esc(permLabels[p] || p) + '</span></label>';
            }).join('');
            return '<div class="perm-role-card" data-perm-role="' + role + '">' +
                '<div class="perm-role-head">' +
                '<div><div class="perm-role-title">' + deps.esc(deps.auth.roleLabel(role)) + '</div>' +
                '<div class="perm-role-desc">' + deps.esc(deps.auth.roleDescription(role)) + '</div></div>' +
                '</div>' +
                '<div class="perm-section"><div class="perm-section-label">Pages they can open</div>' +
                '<div class="perm-check-grid">' + viewChecks + '</div></div>' +
                '<div class="perm-section"><div class="perm-section-label">Actions they can perform</div>' +
                '<div class="perm-check-grid">' + permChecks + '</div></div>' +
                '</div>';
        }).join('');
    }

    function collectRoleAccessFromForm() {
        const config = {};
        (deps.auth?.EDITABLE_ROLES || []).forEach((role) => {
            config[role] = { views: [], perms: [] };
        });
        document.querySelectorAll('#roleAccessMatrix input[type="checkbox"]').forEach((cb) => {
            const role = cb.getAttribute('data-role');
            const kind = cb.getAttribute('data-kind');
            const key = cb.getAttribute('data-key');
            if (!role || !kind || !key || !cb.checked || !config[role]) return;
            if (kind === 'view') config[role].views.push(key);
            if (kind === 'perm') config[role].perms.push(key);
        });
        return config;
    }

    async function saveRoleAccessConfig() {
        if (!deps.auth?.canManageRolePermissions()) {
            deps.banner('Only Platform Admin can save role access.', 'err');
            return;
        }
        const btn = document.getElementById('saveRoleAccessBtn');
        if (btn) btn.disabled = true;
        try {
            await deps.auth.saveRolePermissions(collectRoleAccessFromForm());
            deps.auth.applyRoleNav();
            deps.banner('Role access saved. Team members may need to refresh.', 'ok');
            renderRoleAccessMatrix();
        } catch (e) {
            deps.banner('Save failed: ' + (e.message || e), 'err');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function resetRoleAccessConfig() {
        if (!deps.auth?.canManageRolePermissions()) return;
        if (!confirm('Reset all role access to built-in defaults? Custom settings will be removed.')) return;
        try {
            await deps.auth.resetRolePermissions();
            deps.auth.applyRoleNav();
            deps.banner('Role access reset to defaults.', 'ok');
            renderRoleAccessMatrix();
        } catch (e) {
            deps.banner('Reset failed: ' + (e.message || e), 'err');
        }
    }

    function bindEvents() {
        document.getElementById('jobForm')?.addEventListener('submit', (e) => { e.preventDefault(); saveJob(); });
        document.getElementById('jobGenBtn')?.addEventListener('click', onJobCriteriaGenerate);
        document.getElementById('jobResetBtn')?.addEventListener('click', () => {
            document.getElementById('jobForm').reset();
            document.getElementById('jobEditId').value = '';
            setSelectValue('jobDisplayStyleIn', 'hiring-top', 'hiring-top');
            updateJobDisplayStyleHint();
            clearJobFieldErrors();
            resetJobTemplateUi();
        });
        document.getElementById('jobEditId')?.addEventListener('change', (e) => {
            const val = e.target.value;
            if (val) {
                fillJobForm(val);
                return;
            }
            document.getElementById('jobForm')?.reset();
            setSelectValue('jobDisplayStyleIn', 'hiring-top', 'hiring-top');
            updateJobDisplayStyleHint();
            clearJobFieldErrors();
            resetJobTemplateUi();
        });
        bindJobTemplateUpload();
        bindJobFieldValidation();
        bindJobCreatePanelSync();
        bindSocialPostEvents();
        populateJobDisplayStyleSelect();
        document.getElementById('jobDisplayStyleIn')?.addEventListener('change', updateJobDisplayStyleHint);
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
        document.getElementById('drawerApproveBtn')?.addEventListener('click', () => {
            if (deps.activeCandidate) approveReviewCandidate(deps.activeCandidate);
        });
        document.getElementById('inviteUserForm')?.addEventListener('submit', inviteUser);
        document.getElementById('invRole')?.addEventListener('change', (e) => {
            updateInviteRoleHint(e.target.value);
        });
        document.getElementById('saveRoleAccessBtn')?.addEventListener('click', saveRoleAccessConfig);
        document.getElementById('resetRoleAccessBtn')?.addEventListener('click', resetRoleAccessConfig);
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
            populateManualShortlistWebhookConfig();
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
            if (view === 'jobs' || view === 'jobs-create') loadJobs();
            if (view === 'jobs-create') {
                requestAnimationFrame(() => {
                    syncJobCreatePanelHeight();
                    setTimeout(syncJobCreatePanelHeight, 50);
                });
            }
            if (view === 'onsite') loadOnsite();
            if (view === 'settings') {
                loadWebhookConfig();
                loadJdWebhookConfig();
                populateManualShortlistWebhookConfig();
            }
            if (view === 'users' || view === 'users-invite') {
                if (!deps.auth?.canManageUsers()) {
                    deps.setView('overview');
                    return;
                }
                if (view === 'users') loadUsers();
                if (view === 'users-invite') populateInviteRoleSelect();
            }
            if (view === 'audit') loadAudit();
            if (view === 'role-permissions') renderRoleAccessMatrix();
        },
        setActiveCandidate(m) {
            deps.activeCandidate = m;
            syncDrawerActionButtons(m);
        },
        syncDrawerActionButtons(m) {
            syncDrawerActionButtons(m);
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
        pagination: TAPagination,
    };
    window.TAPagination = TAPagination;
})();
