import type { CatalogEntry } from '../shared/contracts.ts';
import { updateCatalogRating } from './catalog.ts';
export interface VisitorClient { csrfToken():Promise<string> }
export function createVisitorClient():VisitorClient {
  let pending:Promise<string>|undefined;
  return {csrfToken(){return pending??=(async()=>{const response=await fetch('/api/visitor');if(!response.ok)throw new Error('Could not establish this browser session');return (await response.json()).csrfToken as string;})().catch(error=>{pending=undefined;throw error;});}};
}
/** A post-play, editable five-star vote. Later choices are serialized after an in-flight save. */
export function ratingControls(visitor:VisitorClient,onChanged:()=>void=()=>{}) {
  // A second play/return can remount this widget while a previous vote is saving.
  const writes=new Map<string,Promise<void>>();
  return (root:HTMLElement,entry:CatalogEntry)=>{
    root.classList.add('community-rating');
    const heading=document.createElement('h2');heading.textContent=`How was ${entry.map.metadata.title}?`;
    const stars=document.createElement('div');stars.className='community-rating-stars';stars.setAttribute('role','radiogroup');stars.setAttribute('aria-label','Your rating');
    const status=document.createElement('p');status.setAttribute('role','status');
    root.append(heading,stars,status);
    const endpoint=`/api/maps/${encodeURIComponent(entry.map.id)}/ratings`;
    let edited=false;let selected=0;let choice=0;
    const key=JSON.stringify([entry.map.id,entry.revision.id]);
    const buttons:HTMLButtonElement[]=[];
    const paint=()=>buttons.forEach((button,index)=>{
      button.setAttribute('aria-checked',String(selected===index+1));button.dataset.filled=String(selected>=index+1);
      button.tabIndex=(selected?selected===index+1:index===0)?0:-1;
    });
    const choose=(rating:number)=>{
      edited=true;selected=rating;paint();const version=++choice;status.textContent='Saving rating…';
      const operation=(writes.get(key)??Promise.resolve()).then(async()=>{
        try {
          const csrf=await visitor.csrfToken();
          const response=await fetch(endpoint,{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({revisionId:entry.revision.id,rating})});
          const data=await response.json();if(!response.ok)throw new Error(data.error??'Could not save rating');
          updateCatalogRating(root,entry,data.rating);
          if(choice===version)status.textContent=`Saved. ${data.rating.average.toFixed(1)} average from ${data.rating.count} ${data.rating.count===1?'rating':'ratings'}.`;
          onChanged();
        }catch(error){if(choice===version)status.textContent=`${error instanceof Error?error.message:'Could not save rating'}. Choose a star to retry.`;}
      });
      writes.set(key,operation);
      void operation.finally(()=>{if(writes.get(key)===operation)writes.delete(key);});
    };
    for(let value=1;value<=5;value++){
      const button=document.createElement('button');button.type='button';button.className='community-rating-star konkr-plain';button.setAttribute('role','radio');button.setAttribute('aria-label',`${value} ${value===1?'star':'stars'}`);
      const icon=document.createElement('span');icon.className='konkr-star';icon.setAttribute('aria-hidden','true');button.append(icon);
      button.onclick=()=>choose(value);
      button.onkeydown=event=>{
        const next=event.key==='ArrowRight'||event.key==='ArrowDown'?value%5+1:event.key==='ArrowLeft'||event.key==='ArrowUp'?(value+3)%5+1:event.key==='Home'?1:event.key==='End'?5:0;
        if(next){event.preventDefault();buttons[next-1].focus();choose(next);}
      };
      buttons.push(button);stars.append(button);
    }
    paint();
    void visitor.csrfToken().then(async()=>{await writes.get(key);return fetch(endpoint);}).then(async response=>{
      if(response.ok){const data=await response.json();if(!edited&&data.revisionId===entry.revision.id&&Number.isInteger(data.mine)&&data.mine>=1&&data.mine<=5){selected=data.mine;paint();}}
    }).catch(()=>{});
  };
}
