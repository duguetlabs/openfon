/** Test-only observation, never included in the application entry point.
 * Count mutation statement attempts before preparation/execution, including
 * rejected statements, rather than inferring zero attempts from row snapshots. */
export function observeAsteriskRateWrites(db) {
  let attempts=0;
  const DB=new Proxy(db,{get(target,key){
    if(key==='prepare' || key==='exec')return sql=>{
      if(/\brate_counters\b/i.test(sql) && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))attempts++;
      return target[key](sql);
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  return {DB,get attempts(){return attempts;}};
}
