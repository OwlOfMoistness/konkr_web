import './theme.css';
import './catalog.css';
import './admin.css';
import './results.css';
import type { CatalogEntry, CatalogQuery, CatalogReader, Difficulty, SupportedConfigurations } from '../shared/contracts.ts';
import { supportsPlayback } from '../shared/native-playback.ts';
import type { NativePlaybackPolicy } from '../shared/native-playback.ts';
import { installCustomMaps } from './custom-maps.ts';
import { createVisitorClient, ratingControls } from './ratings.ts';
import { LocalRunStore } from './local-runs.ts';
import { createResultsApi, createResultsController } from './results.ts';
import { attachRunRecorder } from '../runtime/recording.ts';
import { waitForCommunityEngine, preservePlayerUrl } from '../runtime/menu-bridge.ts';
import { mountAdmin, mountCuratorAccess } from './admin.ts';
import { mountMapEditor } from './map-editor.ts';
import { publicationControls } from './publication.ts';
import { initializeNativeAssets } from './native-controls.ts';
import { createLivePreviewPool } from './live-preview.ts';

interface Config {
  flags:{customMaps:boolean;submissions:boolean;verifiedResults:boolean};
  engineHash:string;policy:SupportedConfigurations;nativePlayback?:NativePlaybackPolicy;runtime:{vendor:string;main:string};
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
  await initializeNativeAssets(document);
  const previews=createLivePreviewPool({layer:location.pathname==='/admin/maps'?1:21});
  const mapCache=new Map<string,Promise<string>>();
  const loadMap=(url:string,hash:string)=>{
    const key=JSON.stringify([url,hash]);let result=mapCache.get(key);
    if(!result){result=(async()=>{
      const response=await fetch(url);if(!response.ok)throw new Error('The map file is unavailable. Reload the map to retry.');
      const encoded=await response.text();
      const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(encoded)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      if(digest!==hash)throw new Error('The map changed while loading. Select it again to refresh the preview.');
      return encoded;
    })().catch(error=>{mapCache.delete(key);throw error;});mapCache.set(key,result);if(mapCache.size>32)mapCache.delete(mapCache.keys().next().value!);}
    return result;
  };
  if(location.pathname==='/admin/maps'){
    document.body.classList.add('admin-page');document.getElementById('status')!.hidden=true;
    const root=document.getElementById('admin-root')!;root.hidden=false;
    mountAdmin(root,(client,session)=>{
      const nav=document.createElement('nav');nav.className='admin-navigation';nav.setAttribute('aria-label','Curator navigation');
      const home=document.createElement('a');home.href='/';home.className='konkr-button';home.textContent='← Game';
      const maps=document.createElement('button');maps.textContent='Curated maps';maps.setAttribute('aria-pressed','true');
      const signOut=document.createElement('button');signOut.textContent='Sign out';signOut.onclick=()=>{void client.signOut().then(()=>mapEditor.destroy()).catch(failure);};
      nav.append(home,maps,signOut);
      const heading=document.createElement('h1');heading.className='admin-title';heading.textContent='Map workshop';
      const editor=document.createElement('section');editor.className='admin-panel';
      const access=document.createElement('section');access.className='admin-panel admin-access';access.hidden=true;
      root.replaceChildren(nav,heading,editor,access);
      const mapEditor=mountMapEditor(editor,client,{renderPublication:publicationControls(client,{mountPreview(container,detail){
        const revision=detail.revisions.find((item:any)=>item.id===detail.map.current_revision_id);
        return previews.mount(container,{key:revision.id+':'+revision.content_hash,title:detail.map.title,loadMap:()=>loadMap(`/api/admin/maps/${encodeURIComponent(detail.map.id)}/file`,revision.content_hash)});
      }})});
      let accessButton:HTMLButtonElement|undefined;
      maps.onclick=()=>{editor.hidden=false;access.hidden=true;maps.setAttribute('aria-pressed','true');accessButton?.setAttribute('aria-pressed','false');void mapEditor.showList().catch(failure);};
      if(session.identity.role==='admin'){
        accessButton=document.createElement('button');accessButton.textContent='Access settings';accessButton.setAttribute('aria-pressed','false');nav.append(accessButton);
        let mounted=false;
        accessButton.onclick=()=>{editor.hidden=true;access.hidden=false;maps.setAttribute('aria-pressed','false');accessButton!.setAttribute('aria-pressed','true');if(!mounted){mountCuratorAccess(access,client);mounted=true;}};
      }
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
    supportedDifficulties:(entry:CatalogEntry)=>(['normal','hard'] as Difficulty[]).filter(mode=>supportsPlayback(config.policy,entry.revision.engineHash,mode,entry.revision.plugins,config.nativePlayback)),
    verifiedResultsEnabled:config.flags.verifiedResults,
    async loadMap(entry){const response=await fetch(`/api/maps/${encodeURIComponent(entry.map.id)}/file?revision=${encodeURIComponent(entry.revision.id)}`);if(!response.ok)throw new Error('This map is no longer available. Refresh the catalogue to retry.');return response.text();},
    renderPostPlay:ratingControls(visitor),
    renderPreview:(container,entry,thumbnail)=>previews.mount(container,{key:entry.revision.id+':'+entry.revision.contentHash,title:entry.map.metadata.title,thumbnail,loadMap:()=>loadMap(`/api/maps/${encodeURIComponent(entry.map.id)}/file?revision=${encodeURIComponent(entry.revision.id)}`,entry.revision.contentHash)}),
  });
  if(config.flags.submissions)attachRunRecorder({loader,bridge:custom.bridge,onError:failure,onVictory:results.enqueue});
}
void boot().catch(failure);
