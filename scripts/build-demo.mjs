// Build the static demo: the real UI bundle plus one recorded run, in a single HTML file.
//   npm run build && node scripts/build-demo.mjs demo/run.json
// Writes demo/index.html (opens anywhere, even from disk) and demo/embed.html (the same page
// without <html>/<head>, for hosts that wrap the page themselves).
import { readFileSync, writeFileSync } from 'node:fs';

const [dataFile = 'demo/run.json'] = process.argv.slice(2);
const css = readFileSync('dist/ui/assets/app.css', 'utf8');
const js = readFileSync('dist/ui/assets/app.js', 'utf8');
const data = readFileSync(dataFile, 'utf8');

// Inline scripts must not contain a closing script tag or an HTML comment opener.
const safe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const fonts =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">';

const body = `<title>Proofline Control Room</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts}
<style>
${css}
</style>
<div id="root"></div>
<script>window.__PROOFLINE__ = { demo: ${safe(data)} };</script>
<script type="module">
${safe(js)}
</script>
`;

writeFileSync('demo/embed.html', body);
writeFileSync(
  'demo/index.html',
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
${body}</body>
</html>
`,
);
console.log(`demo/index.html and demo/embed.html written (${(body.length / 1024).toFixed(0)} KB each)`);
