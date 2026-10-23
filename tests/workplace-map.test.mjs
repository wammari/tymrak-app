import './_test-environment.mjs';import test from 'node:test';import assert from 'node:assert/strict';
import {placeValues,createWorkplaceMap} from '../workplace-map.js';import handler from '../api/workplace-map-config.js';
test('place selection extracts coordinates, address and name and rejects missing geometry',()=>{
 assert.deepEqual(placeValues({location:{lat:()=>43,lng:()=>-79},formattedAddress:'Office address',displayName:'Office'}),{latitude:43,longitude:-79,address:'Office address',name:'Office'});
 assert.throws(()=>placeValues({}),/no usable map position/);assert.throws(()=>placeValues({location:{lat:()=>NaN,lng:()=>1}}));
});
test('map configuration requires manager authorization',async()=>{
 const r={setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;return this;}};await handler({method:'GET',headers:{}},r);assert.equal(r.code,401);
});
test('search auto-fills from selected result, map clicks adjust centre, radius updates',async()=>{
 let autocomplete,map,circle;const selected=[];
 class Map {constructor(){map=this;this.events={};}getCenter(){return {lat:0,lng:0};}setCenter(p){this.center=p;}setZoom(){}addListener(n,f){this.events[n]=f;}}
 class Circle {constructor(){circle=this;}setCenter(p){this.center=p;}setRadius(n){this.radius=n;}}
 class PlaceAutocompleteElement {constructor(){autocomplete=this;this.events={};}setAttribute(){}addEventListener(n,f){this.events[n]=f;}}
 const picker=await createWorkplaceMap({maps:{importLibrary:async()=>({Map,Circle,PlaceAutocompleteElement,AdvancedMarkerElement:class{}})},config:{mapId:'test'},searchContainer:{append(){}},mapContainer:{},getRadius:()=>50,onSelect:v=>selected.push(v),onError:e=>{throw new Error(e);}});
 await autocomplete.events['gmp-select']({placePrediction:{toPlace:()=>({fetchFields:async({fields})=>assert.deepEqual(fields,['displayName','formattedAddress','location']),location:{lat:()=>43,lng:()=>-79},formattedAddress:'Address',displayName:'Office'})}});
 assert.equal(selected[0].name,'Office');assert.equal(map.center.lat,43);assert.equal(circle.radius,50);
 map.events.click({latLng:{lat:()=>44,lng:()=>-80}});assert.deepEqual(selected[1],{latitude:44,longitude:-80});picker.updateRadius();assert.equal(circle.radius,50);
});
