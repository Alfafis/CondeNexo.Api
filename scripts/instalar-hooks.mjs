// `prepare` do npm: aponta o git para .githooks/ (ganchos versionados, sem husky). Nunca falha o install: na Cloudflare,
// no CI e em qualquer lugar sem .git ou sem git, apenas não faz nada.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

try {
  if (existsSync('.git') && existsSync('.githooks')) {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  }
} catch {
  /* sem git: segue */
}
