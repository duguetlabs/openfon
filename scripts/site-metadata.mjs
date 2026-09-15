import { readFile, writeFile } from 'node:fs/promises';

// A deployment supplies its own origin. Do not bake one operator's domain into
// the self-hostable source or invent canonical URLs for local previews.
const supplied = process.env.OPENFON_PUBLIC_URL;
if (supplied) {
  const url = new URL(supplied);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('OPENFON_PUBLIC_URL must be an HTTPS origin, without a path, credentials, query, or fragment.');
  }
  const origin = url.origin;
  const htmlPath = new URL('../dist/client/index.html', import.meta.url);
  let html = await readFile(htmlPath, 'utf8');
  html = html.replace('content="/social-card.png"', `content="${origin}/social-card.png"`);
  html = html.replace('</head>', `  <link rel="canonical" href="${origin}/" />\n    <meta property="og:url" content="${origin}/" />\n  </head>`);
  await writeFile(htmlPath, html);
  await writeFile(new URL('../dist/client/sitemap.xml', import.meta.url), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>\n`);
  const robotsPath = new URL('../dist/client/robots.txt', import.meta.url);
  await writeFile(robotsPath, `${await readFile(robotsPath, 'utf8')}\nSitemap: ${origin}/sitemap.xml\n`);
  console.log(`Public metadata configured for ${origin}`);
} else {
  console.log('Public hostname not configured; canonical URL and sitemap omitted. Set OPENFON_PUBLIC_URL for a public release.');
}
