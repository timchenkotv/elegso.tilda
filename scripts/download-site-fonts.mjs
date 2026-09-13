#!/usr/bin/env node
// One-time vendoring of unmodified, openly licensed fonts. No browser requests
// to Google are involved after these files are served from our own host.
import fs from 'node:fs/promises';
import path from 'node:path';
const destination = path.resolve('www/assets/fonts');
await fs.mkdir(destination, { recursive: true });
const ubuntu = ['Ubuntu-Light.ttf', 'Ubuntu-Regular.ttf', 'Ubuntu-Medium.ttf', 'Ubuntu-Bold.ttf', 'Ubuntu-LightItalic.ttf', 'Ubuntu-Italic.ttf', 'Ubuntu-MediumItalic.ttf', 'Ubuntu-BoldItalic.ttf'];
const sources = [...ubuntu.map(name => ({ name, url: `https://raw.githubusercontent.com/google/fonts/main/ufl/ubuntu/${name}` })),
  { name: 'Ubuntu-LICENCE.txt', url: 'https://raw.githubusercontent.com/google/fonts/main/ufl/ubuntu/LICENCE.txt' },
  { name: 'Prata-Regular.ttf', url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/prata/Prata-Regular.ttf' },
  { name: 'Prata-OFL.txt', url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/prata/OFL.txt' }];
for (const source of sources) {
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (source.name.endsWith('.ttf') && !bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]))) throw new Error(`Unexpected font format: ${source.name}`);
  await fs.writeFile(path.join(destination, source.name), bytes);
  console.log(`${source.name}: ${bytes.length} bytes`);
}
