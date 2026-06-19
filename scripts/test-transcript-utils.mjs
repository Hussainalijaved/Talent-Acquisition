// Unit tests for relay/lib/transcript-utils.mjs
import {
  cleanUserAnswerText,
  displayUserTranscript,
  extractEnglishAnswer,
  isEnglishTranscript,
  isClosingMessage,
} from '../relay/lib/transcript-utils.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   - ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

console.log('=== extractEnglishAnswer ===');
check('keeps english', extractEnglishAnswer('I built an API with ASP.NET Core')?.includes('ASP.NET'));
check('strips non-latin script', !extractEnglishAnswer('I built an API مرحبا بالعربي')?.includes('مرحبا'));
check('keeps latin-script english', extractEnglishAnswer("okay we did the project close to pilot")?.includes('pilot'));
check('empty on noise', !extractEnglishAnswer('[noise]'));

console.log('\n=== cleanUserAnswerText ===');
check('english answer kept', cleanUserAnswerText('I am motivated by building real .NET backends')?.length > 10);
check('non-english flagged', /non-english/i.test(cleanUserAnswerText('مرحبا كيف حالك بالعربي فقط')));
check('noise flagged', /no spoken|noise/i.test(cleanUserAnswerText('[noise]') || cleanUserAnswerText('')));

console.log('\n=== displayUserTranscript (live captions) ===');
check('partial english shows', displayUserTranscript('okay we were close to the pilot I communicate')?.includes('pilot'));
check('does not blank mid-speech', displayUserTranscript('well actually I use').length > 5);

console.log('\n=== isEnglishTranscript ===');
check('english true', isEnglishTranscript('Hello this is my answer about EF Core'));
check('arabic false', !isEnglishTranscript('مرحبا'));

console.log('\n=== isClosingMessage ===');
check('thank you detected', isClosingMessage('Thank you for your time — that completes the voice interview.'));
check('question not closing', !isClosingMessage('What motivates you about this role?'));

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
