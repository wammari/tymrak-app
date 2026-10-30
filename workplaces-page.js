import {createAddressSearch} from './workplace-search.js';
import {loadSupabaseConfiguration} from './supabase-config.js';
import {loadLeaflet,createWorkplaceMap} from './workplace-map.js';
import {createClient} from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const $=id=>document.getElementById(id);let client,workplaces=[],employees=[],editing=null,mapPicker=null;
function message(text){$('message').textContent=text;}
async function request(url,method='GET',body){
 const {data:{session}}=await client.auth.getSession();if(!session)throw new Error('Sign in with your manager account first.');
 const response=await fetch(url,{method,headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();if(!response.ok)throw new Error(data.error||'Unable to complete request');return data;
}
let searchVersion=0;const searchAddress=createAddressSearch();
function clearSearch(){searchVersion++;$('addressResults').replaceChildren();$('searchStatus').textContent='';}
$('address').addEventListener('input',clearSearch);
function edit(w){clearSearch();editing=w?.id||null;$('title').textContent=w?'Edit workplace':'Add workplace';$('name').value=w?.name||'';$('address').value=w?.address||'';$('latitude').value=w?.latitude??'';$('longitude').value=w?.longitude??'';$('radius').value=w?.radius_metres??150;$('active').checked=w?.is_active??true;
 if(w)mapPicker?.setPosition(w.latitude,w.longitude);else mapPicker?.clearSelection();
 const assigned=new Set(w?.employee_ids||[]);$('employees').replaceChildren();
 for(const e of employees){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.value=e.id;box.checked=assigned.has(e.id);label.append(box,document.createTextNode(` ${e.first_name} ${e.last_name}${e.is_active?'':' (inactive)'}`));$('employees').append(label);}
}
function render(){const list=$('list');list.replaceChildren();if(!workplaces.length)list.textContent='No workplaces configured yet.';
 for(const w of workplaces){const row=document.createElement('p'),button=document.createElement('button');row.append(document.createTextNode(`${w.name} — ${w.is_active?'Active':'Inactive'} · ${w.radius_metres} m · ${w.employee_ids.length} assigned `));button.textContent='Edit';button.type='button';button.addEventListener('click',()=>edit(w));row.append(button);list.append(row);}
}
async function ensureMap(){
 if(mapPicker)return mapPicker;
 $('loadMap').disabled=true;$('mapStatus').textContent='Loading map…';
 try {const config=await request('/api/workplace-map-config');
  const leaflet=await loadLeaflet();$('workplaceMap').hidden=false;
  mapPicker=createWorkplaceMap({leaflet,config,mapContainer:$('workplaceMap'),getRadius:()=>Number($('radius').value)||150,
   onError:text=>$('mapStatus').textContent=text,onSelect:value=>{$('latitude').value=value.latitude;$('longitude').value=value.longitude;$('mapStatus').textContent='Workplace centre selected. Review the pin, radius and assignments, then save.';}});
  if($('latitude').value!==''&&$('longitude').value!=='')mapPicker.setPosition(Number($('latitude').value),Number($('longitude').value));
  $('mapStatus').textContent='Zoom to the workplace and click the building. Drag the pin to adjust the centre.';$('loadMap').hidden=true;return mapPicker;
 }catch(error){$('mapStatus').textContent=error.message;$('loadMap').disabled=false;throw error;}
}
$('loadMap').addEventListener('click',()=>{ensureMap().catch(()=>{});});
$('searchAddress').addEventListener('click',async()=>{
 const version=++searchVersion;$('searchAddress').disabled=true;$('addressResults').replaceChildren();$('searchStatus').textContent='Finding address…';
 try{const results=await searchAddress($('address').value);if(version!==searchVersion)return;
 $('searchStatus').textContent=results.length?'Choose the correct address, then review the pin.':'No matching address found. Include the city and country, or choose the location on the map.';
 for(const result of results){const button=document.createElement('button');button.type='button';button.textContent=result.label;button.addEventListener('click',async()=>{
 if(version!==searchVersion)return;button.disabled=true;try{const picker=await ensureMap();if(version!==searchVersion)return;
 $('latitude').value=result.latitude;$('longitude').value=result.longitude;$('address').value=result.label.slice(0,300);picker.setPosition(result.latitude,result.longitude);clearSearch();$('searchStatus').textContent='Address located. Verify the building, radius and employees, then save.';
 }catch{$('searchStatus').textContent='The map could not load. Try again; your saved workplace has not changed.';}finally{button.disabled=false;}});$('addressResults').append(button);}
 }catch(error){if(version===searchVersion)$('searchStatus').textContent=error.message;}finally{$('searchAddress').disabled=false;}
});
for(const id of ['latitude','longitude'])$(id).addEventListener('change',()=>{if($('latitude').value!==''&&$('longitude').value!=='')mapPicker?.setPosition(Number($('latitude').value),Number($('longitude').value));});
$('radius').addEventListener('input',()=>mapPicker?.updateRadius());
$('new').addEventListener('click',()=>edit(null));
$('form').addEventListener('submit',async event=>{event.preventDefault();$('save').disabled=true;message('Saving…');try{
 const body={id:editing,name:$('name').value,address:$('address').value,latitude:Number($('latitude').value),longitude:Number($('longitude').value),radiusMetres:Number($('radius').value),isActive:$('active').checked,employeeIds:[...$('employees').querySelectorAll('input:checked')].map(e=>e.value)};
 workplaces=(await request('/api/manager-workplaces','POST',body)).workplaces;render();edit(workplaces.find(w=>w.id===editing)||null);message('Workplace and assignments saved.');
 }catch(error){message(error.message);}finally{$('save').disabled=false;}});
try{const config=await loadSupabaseConfiguration();client=createClient(config.supabaseUrl,config.supabasePublishableKey);await request('/api/manager-session');const [w,e]=await Promise.all([request('/api/manager-workplaces'),request('/api/employees')]);workplaces=w.workplaces;employees=e.employees;render();edit(null);$('app').hidden=false;message('Configure workplaces before enabling the geofenced release.');}catch(error){message(error.message);}
