import './catalog.css';
import './admin.css';
import './results.css';
import type { CatalogEntry, CatalogQuery, CatalogReader, Difficulty, SupportedConfigurations } from '../shared/contracts.ts';
import { supports } from '../shared/contracts.ts';
import { installCustomMaps } from './custom-maps.ts';
import { createVisitorClient, ratingControls } from './ratings.ts';
import { LocalRunStore } from './local-runs.ts';
import { createResultsApi, createResultsController, mountResults } from './results.ts';
import { attachRunRecorder } from '../runtime/recording.ts';
import { waitForCommunityEngine, preservePlayerUrl } from '../runtime/menu-bridge.ts';
import { mountAdmin, mountCuratorAccess } from './admin.ts';
import { mountMapEditor } from './map-editor.ts';
import { publicationControls } from './publication.ts';

interface Config {
  flags:{customMaps:boolean;submissions:boolean;verifiedResults:boolean};
  engineHash:string;policy:SupportedConfigurations;runtime:{vendor:string;main:string};
}
function failure(error:unknown):void {
  const alert=document.querySelector<HTMLElement>('#community-alert')!;
  alert.textContent=error instanceof Error?error.message:'The community service is unavailable. Please retry.';alert.hidden=false;
}
async function json<T>(url:string):Promise<T>{const response=await fetch(url);const body=await response.json();if(!response.ok)throw new Error(body.error??'The catalogue is unavailable. Please retry.');return body as T;}
const reader:CatalogReader={
  list(query:CatalogQuery){const params=new URLSearchParams();for(const [key,value]of Object.entries(query)){if(value===undefined)continue;if(key==='tags'){for(const tag of value as string[])params.append('tag',tag);}else params.set(key,String(value));}return json('/api/maps?'+params);},
  async get(id){const response=await fetch('/api/maps/'+encodeURIComponent(id));if(response.status===404)return null;const body=await response.json();if(!response.ok)throw new Error(body.error??'Map details unavailable');return body;},
};
async function boot():Promise<void>{
  if(location.pathname==='/admin/maps'){
    document.body.classList.add('admin-page');document.getElementById('status')!.hidden=true;
    const root=document.getElementById('admin-root')!;root.hidden=false;
    mountAdmin(root,(client,session)=>{
      const header=document.createElement('header');const heading=document.createElement('h1');heading.textContent='Community map curation';
      const signOut=document.createElement('button');signOut.textContent='Sign out';signOut.onclick=()=>{void client.signOut().catch(failure);};header.append(heading,signOut);
      const editor=document.createElement('section');const access=document.createElement('section');root.replaceChildren(header,editor,access);
      mountMapEditor(editor,client,{renderPublication:publicationControls(client)});
      if(session.identity.role==='admin')mountCuratorAccess(access,client);
    });return;
  }
  const config=await json<Config>('/api/config');
  const loader=await waitForCommunityEngine();
  // This runs even when the catalog feature is temporarily switched off.
  preservePlayerUrl(loader);
  if(!config.flags.customMaps)return;
  const visitor=createVisitorClient();const store=new LocalRunStore(localStorage);
  let custom:Awaited<ReturnType<typeof installCustomMaps>>|undefined;
  const results=createResultsController({api:createResultsApi(visitor),store,onError:failure,onVerified:()=>{void custom?.catalog.refresh();}});
  custom=await installCustomMaps({
    root:document.getElementById('catalog-root')!,reader,store,engineHash:config.engineHash,
    onError:failure,onStart:results.onStart,
    supportedDifficulties:(entry:CatalogEntry)=>(['normal','hard'] as Difficulty[]).filter(mode=>supports(config.policy,entry.revision.engineHash,mode,entry.revision.plugins)),
    verifiedResultsEnabled:config.flags.verifiedResults,
    async loadMap(entry){const response=await fetch(`/api/maps/${encodeURIComponent(entry.map.id)}/file?revision=${encodeURIComponent(entry.revision.id)}`);if(!response.ok)throw new Error('This map is no longer available. Refresh the catalogue to retry.');return response.text();},
    renderDetailActions:ratingControls(visitor),
    renderExtras:container=>mountResults(container,{controller:results,store,reader,resumeSaved:save=>custom!.resumeSaved(save)}),
  });
  if(config.flags.submissions)attachRunRecorder({loader,bridge:custom.bridge,onError:failure,onVictory:results.enqueue});
}
void boot().catch(failure);
