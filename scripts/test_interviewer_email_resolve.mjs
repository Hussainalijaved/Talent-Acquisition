import {
  firstNonEmptyEmail,
  interviewerFromRow,
  resolveInterviewerEmail,
} from '../lib/resolve-interviewer-email.mjs';

let failures = 0;
function fail(name, detail) {
  failures += 1;
  console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`);
}
function ok(name) {
  console.log(`  ok   - ${name}`);
}

console.log('=== resolve interviewer email ===');

{
  const email = firstNonEmptyEmail('', 'hm@company.com', 'cfg@example.com');
  if (email !== 'hm@company.com') fail('priority order', email);
  else ok('priority order');
}

if (
  interviewerFromRow({
    config: { interviewer_email: 'lead@company.com' },
  }) !== 'lead@company.com'
) {
  fail('interviewerFromRow nested config');
} else ok('interviewerFromRow nested config');

(async () => {
  const fromSession = await resolveInterviewerEmail({
    sessionRow: { config: { interviewer_email: 'session-hm@company.com' } },
    base: { config: { interviewer_email: 'cfg@example.com' } },
    ctx: {},
    workflowCfgEmail: 'cfg@example.com',
  });
  if (fromSession !== 'session-hm@company.com') {
    fail('resolve prefers session.config', fromSession);
  } else ok('resolve prefers session.config');

  const fromNode = await resolveInterviewerEmail({
    sessionRow: { config: {} },
    base: {},
    ctx: {},
    nodeRows: [{ interviewer_email: 'frontend-hm@company.com' }],
    workflowCfgEmail: 'cfg@example.com',
  });
  if (fromNode !== 'frontend-hm@company.com') {
    fail('resolve uses frontend node row', fromNode);
  } else ok('resolve uses frontend node row');

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
