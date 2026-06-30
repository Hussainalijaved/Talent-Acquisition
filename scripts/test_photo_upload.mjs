// Quick probe for /api/upload-candidate-photo
const base = process.argv[2] || 'https://talent-acquisition-six.vercel.app';
const tinyJpeg =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA//2Q==';

async function probe(label, body) {
  const res = await fetch(`${base}/api/upload-candidate-photo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`\n--- ${label} ---`);
  console.log('status', res.status);
  console.log(text.slice(0, 500));
}

async function main() {
  const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  console.log('health', JSON.stringify(health));

  await probe('jpeg', {
    email: 'test@example.com',
    content_type: 'image/jpeg',
    image_base64: `data:image/jpeg;base64,${tinyJpeg}`,
  });

  await probe('jpg mime (common Windows bug)', {
    email: 'test@example.com',
    content_type: 'image/jpg',
    image_base64: `data:image/jpeg;base64,${tinyJpeg}`,
  });

  await probe('empty type', {
    email: 'test@example.com',
    content_type: '',
    image_base64: `data:image/jpeg;base64,${tinyJpeg}`,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
