import './_test-environment.mjs';import test from 'node:test';import assert from 'node:assert/strict';
import {validPosition,createWorkplaceMap} from '../workplace-map.js';import handler from '../api/workplace-map-config.js';
test('map coordinates reject missing, nonfinite and out-of-range positions',()=>{
 assert.equal(validPosition(43,-79),true);for(const p of [[NaN,1],[91,0],[0,-181],[undefined,1]])assert.equal(validPosition(...p),false);
});
test('free map configuration still requires manager authorization',async()=>{
 const r={setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;return this;}};await handler({method:'GET',headers:{}},r);assert.equal(r.code,401);
});
test('free map click and draggable pin fill coordinates; radius and clearing are synchronized',()=>{
 let map,marker,circle,tiles;const selected=[];
 const events=()=>({events:{},on(n,f){this.events[n]=f;return this;},addTo(){this.attached=true;return this;}});
 const leaflet={map:()=>map={...events(),setView(p){this.center=p;return this;},removeLayer(layer){layer.attached=false;}},tileLayer:(url,options)=>tiles={...events(),url,options},divIcon:x=>x,
 marker:()=>marker={...events(),setLatLng(p){this.position=p;},getLatLng(){return {wrap:()=>({lat:44,lng:-80})};}},circle:()=>circle={...events(),setLatLng(p){this.position=p;},setRadius(r){this.radius=r;}}};
 let radius=50;const picker=createWorkplaceMap({leaflet,config:{tileUrl:'https://tile.openstreetmap.org/{z}/{x}/{y}.png'},mapContainer:{},getRadius:()=>radius,onSelect:v=>selected.push(v),onError:e=>{throw new Error(e);}});
 map.events.click({latlng:{lat:43,wrap:()=>({lng:-79})}});assert.deepEqual(selected[0],{latitude:43,longitude:-79});assert.equal(circle.radius,50);assert.equal(marker.attached,true);
 marker.events.dragend();assert.deepEqual(selected[1],{latitude:44,longitude:-80});radius=100;picker.updateRadius();assert.equal(circle.radius,100);
 picker.clearSelection();assert.equal(marker.attached,false);assert.equal(circle.attached,false);assert.equal(picker.setPosition(91,0),false);
 assert.match(tiles.options.attribution,/OpenStreetMap/);assert.equal(tiles.options.referrerPolicy,'strict-origin-when-cross-origin');
});
