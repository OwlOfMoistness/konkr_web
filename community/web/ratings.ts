import type { CatalogEntry } from '../shared/contracts.ts';
import { updateCatalogRating } from './catalog.ts';
export interface VisitorClient { csrfToken():Promise<string> }
export function createVisitorClient():VisitorClient {
  let pending:Promise<string>|undefined;
  return {csrfToken(){return pending??=(async()=>{const response=await fetch('/api/visitor');if(!response.ok)throw new Error('Could not establish this browser session');return (await response.json()).csrfToken as string;})().catch(error=>{pending=undefined;throw error;});}};
}
export function ratingControls(visitor:VisitorClient,onChanged:()=>void=()=>{}) {
  return (root:HTMLElement,entry:CatalogEntry)=>{
    const form=document.createElement('form');const label=document.createElement('label');label.textContent='Your rating';
    const select=document.createElement('select');select.required=true;
    let edited=false;select.addEventListener('input',()=>{edited=true;});select.addEventListener('change',()=>{edited=true;});
    for(const [value,text] of [['','Choose a rating'],['1','1 star'],['2','2 stars'],['3','3 stars'],['4','4 stars'],['5','5 stars']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}label.append(select);
    const button=document.createElement('button');button.textContent='Save rating';
    const status=document.createElement('p');status.setAttribute('role','status');
    const note=document.createElement('p');note.textContent='One editable rating per browser for this revision. No account needed.';
    form.append(label,button);root.append(form,status,note);
    const endpoint=`/api/maps/${encodeURIComponent(entry.map.id)}/ratings`;
    void visitor.csrfToken().then(()=>fetch(endpoint)).then(async response=>{if(response.ok){const data=await response.json();if(!edited&&data.revisionId===entry.revision.id&&data.mine)select.value=String(data.mine);}}).catch(()=>{});
    form.onsubmit=event=>{event.preventDefault();const rating=Number(select.value);edited=true;button.disabled=true;
      void visitor.csrfToken().then(csrf=>fetch(endpoint,{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({revisionId:entry.revision.id,rating})})).then(async response=>{
        const data=await response.json();if(!response.ok)throw new Error(data.error??'Could not save rating');updateCatalogRating(root,entry,data.rating);status.textContent=`Saved. ${data.rating.average.toFixed(1)} average from ${data.rating.count} ${data.rating.count===1?'rating':'ratings'}.`;onChanged();
      }).catch(error=>{status.textContent=error.message;}).finally(()=>{button.disabled=false;});
    };
  };
}
