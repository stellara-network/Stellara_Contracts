import { execSync } from 'node:child_process';

let out;
try {
  out = execSync('npx eslint "{src,apps,libs,test}/**/*.ts" -f json 2>/dev/null', {
    maxBuffer: 1024 * 1024 * 50,
  }).toString();
} catch (err) {
  out = (err.stdout || '').toString();
}

const report = JSON.parse(out);
for (const f of report) {
  const rel = f.filePath.replace(/.*Backend\//, '');
  for (const m of f.messages) {
    if (m.severity === 2) {
      console.log(`${rel}:${m.line}:${m.column}  [${m.ruleId}]  ${m.message}`);
    }
  }
}
