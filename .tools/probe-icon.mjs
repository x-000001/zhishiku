import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
function decode(buf){let o=8,w=0,h=0;const id=[];while(o<buf.length){const len=buf.readUInt32BE(o);const type=buf.toString('ascii',o+4,o+8);const d=buf.subarray(o+8,o+8+len);if(type==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);}else if(type==='IDAT'){id.push(d);} else if(type==='IEND'){break;} o+=12+len;}
const raw=zlib.inflateSync(Buffer.concat(id));const stride=w*4;const px=new Uint8Array(stride*h);let src=0;let prev=new Uint8Array(stride);
for(let y=0;y<h;y++){const f=raw[src++];const line=raw.subarray(src,src+stride);src+=stride;const out=px.subarray(y*stride,(y+1)*stride);for(let x=0;x<stride;x++){const left=x>=4?out[x-4]:0;const up=prev[x];const ul=x>=4?prev[x-4]:0;const v=line[x];out[x]=f===0?v:f===1?v+left:f===2?v+up:f===3?v+((left+up)>>1):v; }prev=out;}return {w,h,px};}
const p=decode(fs.readFileSync('resources/icon.png'));
const at=(x,y)=>[p.px[(y*p.w+x)*4],p.px[(y*p.w+x)*4+1],p.px[(y*p.w+x)*4+2],p.px[(y*p.w+x)*4+3]];
for(let y=28;y<=40;y++) console.log(y, JSON.stringify(at(256,y)));
const ico=fs.readFileSync('resources/icon.ico');const count=ico.readUInt16LE(4);
for(let i=0;i<count;i++){const e=6+i*16;if(ico[e]===16){const size=ico.readUInt32LE(e+8);const off=ico.readUInt32LE(e+12);const s=decode(ico.subarray(off,off+size));const a=(x,y)=>[s.px[(y*s.w+x)*4],s.px[(y*s.w+x)*4+1],s.px[(y*s.w+x)*4+2],s.px[(y*s.w+x)*4+3]];console.log('--- 16px rows');for(let y=5;y<=11;y++){let row='';for(let x=4;x<=12;x++)row+=' '+JSON.stringify(a(x,y));console.log(y,row);}}}
