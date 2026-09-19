import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { runEnterpriseCommandV3, safeEnterpriseToolError, type EnterpriseCommandV3 } from './commands.js';
import { insist } from './manifest.js';
try {
  const args=process.argv.slice(2),command=args.shift() as EnterpriseCommandV3;
  const flags=new Map<string,string|true>();
  while(args.length) {
    const flag=args.shift()!;
    insist(['--manifest','--plan-out','--resume'].includes(flag) && !flags.has(flag),'enterprise_cli_arguments');
    if(flag==='--resume')flags.set(flag,true);
    else{const value=args.shift();insist(value && !value.startsWith('--'),'enterprise_cli_arguments');flags.set(flag,value);}
  }
  const manifest=flags.get('--manifest');insist(typeof manifest==='string' && isAbsolute(manifest),'enterprise_cli_absolute_manifest_required');
  const result=await runEnterpriseCommandV3(command,JSON.parse(readFileSync(manifest,'utf8')),
    {resume:flags.has('--resume'),...(flags.has('--plan-out')?{planOut:flags.get('--plan-out') as string}:{})});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(!result.ready && !['preflight','inspect'].includes(command))process.exitCode=1;
}catch(error){process.stderr.write(JSON.stringify({error:safeEnterpriseToolError(error)})+'\n');process.exitCode=1;}
