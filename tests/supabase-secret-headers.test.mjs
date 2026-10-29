import test from "node:test";
import assert from "node:assert/strict";
import { databaseHeaders } from "../api/_employee-management.js";

test("new Supabase secret key uses apikey and never Bearer secret",()=>{
 const key="sb_secret_fixture_only";
 const headers=databaseHeaders(key);
 assert.equal(headers.apikey,key);
 assert.equal("Authorization" in headers,false);
});
test("legacy service-role JWT remains supported",()=>{
 const key="legacy.jwt.fixture";
 const headers=databaseHeaders(key);
 assert.equal(headers.apikey,key);
 assert.equal(headers.Authorization,"Bearer "+key);
});
