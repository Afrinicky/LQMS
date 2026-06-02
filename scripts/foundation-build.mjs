import fs from 'node:fs';
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', '<!doctype html><html><head><meta charset="UTF-8"><title>SECH_LIMS by Nickland</title></head><body><div id="root">Build placeholder: install dependencies in a network-enabled environment and run Vite for the full desktop bundle.</div></body></html>\n');
console.log('Foundation build artifacts written to dist/.');
