#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', '.cache']);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && full.endsWith('.js')) files.push(full);
  }
}

for (const name of ['serve.js', 'config.js', 'config.local.example.js']) {
  files.push(path.join(root, name));
}
for (const name of ['api', 'data', 'scripts', 'tools']) walk(path.join(root, name));
const failures = [];
for (const file of files) {
  try {
    // 只解析，不执行。这样 CommonJS 服务端文件和浏览器脚本都能检查，
    // 也不会在检查过程中读取密钥、连接数据库或调用外部 API。
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
  } catch (error) {
    failures.push({ file: path.relative(root, file), output: error.message });
  }
}

if (failures.length) {
  console.error(`JavaScript syntax check failed (${failures.length} file(s))`);
  for (const failure of failures) console.error(`\n${failure.file}\n${failure.output}`);
  process.exitCode = 1;
} else {
  console.log(`JavaScript syntax check passed (${files.length} file(s))`);
  require(path.join(__dirname, '..', 'tools', 'check-data.js'));
}
