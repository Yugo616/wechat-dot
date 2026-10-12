import { rename } from 'node:fs/promises';
import { join } from 'node:path';
// Each Mac build has its own feed so parallel jobs cannot overwrite the other architecture.
if (process.platform === 'darwin') await rename(join('release', 'latest-mac.yml'), join('release', `latest-${process.arch}-mac.yml`));
