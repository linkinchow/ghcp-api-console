export const HARD_LIMIT_MS=600_000;

export function boundedInteger(value:unknown,min:number,max:number,name:string):number {
  const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`${name}_out_of_bounds`);return n;
}

export async function sleep(ms:number,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();
  await new Promise<void>((resolve,reject)=>{
    const cleanup=()=>signal?.removeEventListener('abort',abort);
    const timer=setTimeout(()=>{cleanup();resolve();},ms);
    const abort=()=>{clearTimeout(timer);cleanup();reject(new Error('fixture_deadline_exceeded'));};
    signal?.addEventListener('abort',abort,{once:true});
  });
}
