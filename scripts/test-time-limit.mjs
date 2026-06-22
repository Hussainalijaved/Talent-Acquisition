// Unit tests for relay/lib/time-limit.mjs
import {
  deriveTimeLimitSeconds,
  inferTierFromQuestion,
  tierTimeRange,
} from '../relay/lib/time-limit.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   - ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

console.log('=== inferTierFromQuestion ===');
check('short question → A', inferTierFromQuestion('What motivates you?') === 'A');
check('long heavy → D', inferTierFromQuestion(
  'Describe in detail how you would design a scalable distributed architecture for multi-tenant concurrency, and also explain trade-offs in caching, indexing, and migration — then how would you optimize throughput?'
) === 'D');

console.log('\n=== deriveTimeLimitSeconds ===');
const short = deriveTimeLimitSeconds(null, null, 'Why this role?', {});
check('short gets tier A band', tierTimeRange(short.tier)[0] <= short.seconds && short.seconds <= tierTimeRange(short.tier)[1]);

const withAi = deriveTimeLimitSeconds(180, 'B', 'Tell me about a time you handled conflict with a teammate.', {});
check('AI 180 + tier B in band', withAi.seconds >= 150 && withAi.seconds <= 240);

const longQ = deriveTimeLimitSeconds(null, null, 'Walk me through how you would architect a secure multi-tenant pipeline with caching, indexing, and migration trade-offs across distributed services.', {});
check('long technical → higher tier', ['C', 'D'].includes(longQ.tier));

const q1 = deriveTimeLimitSeconds(null, null, 'What motivates you?', {});
const q2 = deriveTimeLimitSeconds(null, null, 'Describe how you would design a scalable distributed architecture with caching, indexing, and migration trade-offs across multi-tenant services.', {});
check('different questions → different times', q1.seconds !== q2.seconds);

console.log(failures ? `\n${failures} failure(s)` : '\nAll passed');
process.exit(failures ? 1 : 0);
