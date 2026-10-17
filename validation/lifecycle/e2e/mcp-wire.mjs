import {spawn} from 'node:child_process';import fs from 'node:fs';
const [logFile,fixture]=process.argv.slice(2);
function log(direction,data){fs.appendFileSync(logFile,JSON.stringify({at:Date.now(),direction,data:String(data)})+'\n');}
const c=spawn(process.execPath,[fixture],{stdio:['pipe','pipe','pipe']});
process.stdin.on('data',d=>{log('host-to-mcp',d);c.stdin.write(d)});process.stdin.on('end',()=>c.stdin.end());
c.stdout.on('data',d=>{log('mcp-to-host',d);process.stdout.write(d)});c.stderr.on('data',d=>process.stderr.write(d));c.on('exit',code=>process.exit(code||0));
