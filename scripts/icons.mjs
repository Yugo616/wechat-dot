import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile } from 'node:fs/promises';
for (const [name, width] of [['icon', 1024], ['tray', 20]]) {
  const source = await readFile(`assets/${name}.svg`, 'utf8');
  await writeFile(`assets/${name}.png`, new Resvg(source, { fitTo: { mode: 'width', value: width } }).render().asPng());
}
const source = await readFile('assets/tray.svg', 'utf8');
await writeFile('assets/tray@2x.png', new Resvg(source, { fitTo: { mode: 'width', value: 40 } }).render().asPng());
