// 단일 HTML(index.html)로 번들: node build.js
const fs = require('fs');
const path = require('path');
const r = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
let html = r('src/template.html');
const parts = {
  __VENDOR_CFB__: r('vendor/cfb.js'),
  __VENDOR_FFLATE__: r('vendor/fflate.min.js'),
  __CORE__: r('src/core.js'),
  __APP__: r('src/app.js'),
};
for (const [k, v] of Object.entries(parts)) html = html.replace('/*' + k + '*/', () => safe(v));
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('index.html', Math.round(html.length / 1024) + ' KB');
