import {fileURLToPath} from 'node:url';
import {AgentServer,ServerOptions,initializeLogger} from '@livekit/agents';
for(const key of ['LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','OPENFON_API_URL','OPENFON_AGENT_SERVICE_TOKEN','KATALEPTIC_API_KEY'])if(!process.env[key])throw new Error('Missing operator setting: '+key);
if(process.env.LK_OPENAI_DEBUG&&process.env.LK_OPENAI_DEBUG!=='0')throw new Error('Wire logging must remain disabled');
initializeLogger({pretty:false,level:'error'});
const server=new AgentServer(new ServerOptions({agent:fileURLToPath(new URL('./worker.js',import.meta.url)),agentName:'openfon-released-web',logLevel:'error',production:true,wsURL:process.env.LIVEKIT_URL,apiKey:process.env.LIVEKIT_API_KEY,apiSecret:process.env.LIVEKIT_API_SECRET}));
let closing=false;async function close(){if(closing)return;closing=true;await server.close();}
process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
await server.run();
