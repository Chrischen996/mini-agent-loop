#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const CURRENT_VERSION = '0.2.2';
const ONLINE_VERSION = '0.2.2';
const SKIP_FILE = '.version-skip';

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  console.log(`[版本检测] 当前版本: ${CURRENT_VERSION}`);
  console.log(`[版本检测] 线上版本: ${ONLINE_VERSION}`);

  if (CURRENT_VERSION === ONLINE_VERSION) {
    console.log('已是最新版本。');
    return;
  }

  console.log(`\n⚠ 发现新版本可升级: ${CURRENT_VERSION} → ${ONLINE_VERSION}`);
  console.log('请选择:');
  console.log('  1. 立即升级');
  console.log('  2. 下次再说');

  const choice = await prompt('请输入选项 (1/2): ');

  if (choice === '1') {
    console.log('执行立即升级...');
    console.log(`已升级至 ${ONLINE_VERSION}`);
    // 实际升级：可替换为 npm install / 替换源码等
  } else {
    console.log('已跳过，标记为下次再说。');
    writeFileSync(SKIP_FILE, new Date().toISOString());
  }
}

main();
