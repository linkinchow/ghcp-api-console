import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {runEnterpriseCommandV4,safeEnterpriseToolError,type EnterpriseCommandV4} from './commands.js';
import {insist,parseEnterpriseManifestV4} from './manifest.js';
try{
  const args=process.argv.slice(2),command=args.shift() as EnterpriseCommandV4,flags=new Map<string,string|true>();
  while(args.length){const flag=args.shift()!;insist(['--manifest','--plan-out','--resume'].includes(flag)&&!flags.has(flag),'enterprise_cli_arguments');if(flag==='--resume')flags.set(flag,true);else{const value=args.shift();insist(value && !value.startsWith('--'),'enterprise_cli_arguments');flags.set(flag,value);}}
  const path=flags.get('--manifest');insist(typeof path==='string' && isAbsolute(path),'enterprise_cli_absolute_manifest_required');
  const manifest=parseEnterpriseManifestV4(JSON.parse(readFileSync(path,'utf8'))),env:NodeJS.ProcessEnv={};
  // Only explicitly named connection variables are read; never .env, MYSQL_URL or service runtime config.
  for(const service of manifest.services)if(service.driver==='mysql')for(const name of [service.location.connectionEnv,`${service.location.connectionEnv}_CA_FILE`])if(process.env[name]!==undefined)env[name]=process.env[name];
  const result=await runEnterpriseCommandV4(command,manifest,{env,resume:flags.has('--resume'),...(flags.has('--plan-out')?{planOut:flags.get('--plan-out') as string}:{})});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!result.ready&&!['preflight','inspect'].includes(command))process.exitCode=1;
}catch(error){process.stderr.write(JSON.stringify({error:safeEnterpriseToolError(error)})+'\n');process.exitCode=1;}
