// 把 pet-kit-local 登记进 desktop profile（按 profile-ops 的规矩：备份 → 脚本改 → 验）
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE = 'C:/Users/余/.dsh/profiles/desktop';
const SRC = 'C:/Users/余/Documents/deepseek-harness/pet-kit-local';
const NAME = 'pet-kit-local';
const p = join(PROFILE, 'package.json');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
copyFileSync(p, `${p}.bak-petkit-${stamp}`);
console.log('备份:', `${p}.bak-petkit-${stamp}`);

const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const json = JSON.parse(raw);
json.dependencies = json.dependencies || {};
json.dependencies[NAME] = 'file:' + SRC;
const bundles = (json.dsh && json.dsh.profile && json.dsh.profile.bundles) || [];
if (!bundles.includes(NAME)) bundles.push(NAME);
json.dsh.profile.bundles = bundles;
// 无 BOM 写入
writeFileSync(p, JSON.stringify(json, null, 2), 'utf8');
// 写回后立刻再解析一遍
const check = JSON.parse(readFileSync(p, 'utf8'));
console.log('已登记:', check.dependencies[NAME], '| bundles 含它:', check.dsh.profile.bundles.includes(NAME), '| 总数:', check.dsh.profile.bundles.length);
console.log('有 BOM?', readFileSync(p, 'utf8').charCodeAt(0) === 0xfeff);
