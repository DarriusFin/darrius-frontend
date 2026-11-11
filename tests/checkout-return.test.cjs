const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(require('path').join(__dirname,'../js/checkout.return.js'),'utf8');
function route(url){let result=null;vm.runInNewContext(source,{URL,window:{location:{href:url,replace:x=>result=x}}});return result;}
assert.equal(route('https://darrius.ai/?checkout=cancel'),'https://darrius.ai/account.html?checkout=cancel');
assert.equal(route('https://darrius.ai/?checkout=canceled&lang=zh&redirect=https://evil.example/'),'https://darrius.ai/account.html?checkout=cancel&lang=zh');
assert.equal(route('https://darrius.ai/?checkout=success'),null);
assert.equal(route('https://darrius.ai/?ref=abc'),null);
console.log('PASS legacy cancel routing; fixed same-origin destination; unrelated navigation unchanged');
