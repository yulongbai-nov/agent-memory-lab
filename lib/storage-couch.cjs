'use strict';
const {digest, canonical} = require('./storage.cjs');
function client({url, authorization, fetchImpl = fetch}) {
  const target = new URL(url);
  if (target.username || target.password) throw new Error('CouchDB URL must not contain credentials');
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost','127.0.0.1','::1','[::1]'].includes(target.hostname))) throw new Error('CouchDB requires HTTPS except on loopback');
  if (target.search || target.hash || target.pathname === '/') throw new Error('CouchDB URL must identify a database');
  if (authorization !== undefined && (typeof authorization !== 'string' || /[\r\n]/.test(authorization))) throw new Error('Invalid authorization');
  const base = target.href.replace(/\/$/, '');
  async function request(endpoint, options = {}) {
    const headers = {...(options.headers || {})};
    if (authorization) headers.authorization = authorization;
    const response = await fetchImpl(`${base}${endpoint}`, {...options, headers, redirect:'manual'});
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error('CouchDB redirect rejected');
    return response;
  }
  return {request};
}
async function pushImmutable({url, documents, authorization, fetchImpl}) {
  const {request} = client({url,authorization,fetchImpl}); let pushed = 0;
  for (const payload of documents) {
    const id = `immutable:${digest(payload)}`, endpoint = `/${encodeURIComponent(id)}`;
    const response = await request(endpoint,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({_id:id,type:'immutable',payload})});
    if (response.status === 409 || response.status === 412) {
      const existing = await request(endpoint);
      if (!existing.ok) throw new Error(`Unable to verify CouchDB conflict (${existing.status})`);
      const value = await existing.json();
      if (value._id !== id || value.type !== 'immutable' || canonical(value.payload) !== canonical(payload)) throw new Error('CouchDB immutable document conflict');
    } else if (!response.ok) throw new Error(`CouchDB write failed (${response.status})`);
    else pushed++;
  }
  return {pushed,verified:documents.length-pushed};
}
async function pullImmutable({url,authorization,fetchImpl,validate}) {
  const {request} = client({url,authorization,fetchImpl}); const documents = []; let cursor;
  for (;;) {
    const params = new URLSearchParams({include_docs:'true',limit:'101',startkey:JSON.stringify(cursor || 'immutable:'),endkey:JSON.stringify('immutable:\ufff0')});
    if (cursor) params.set('skip','1');
    const response = await request(`/_all_docs?${params}`);
    if (!response.ok) throw new Error(`CouchDB read failed (${response.status})`);
    const body = await response.json();
    if (!Array.isArray(body.rows) || body.rows.length > 101) throw new Error('Invalid CouchDB page');
    for (const row of body.rows) {
      const doc = row.doc;
      if (!doc || typeof row.id !== 'string' || doc._id !== row.id || doc.type !== 'immutable' || row.id !== `immutable:${digest(doc.payload)}` || doc._deleted) throw new Error('Invalid immutable document');
      validate(doc.payload); documents.push(doc.payload);
    }
    if (body.rows.length < 101) break;
    const next = body.rows.at(-1).id;
    if (cursor && next <= cursor) throw new Error('Invalid CouchDB pagination');
    cursor = next;
  }
  return documents;
}
const validateDocUpdate = `function(newDoc, oldDoc, userCtx) {
  if (oldDoc || newDoc._deleted) throw({forbidden:'immutable documents cannot be changed or deleted'});
  if (userCtx.roles.indexOf('archive_writer') === -1 && !(userCtx.roles.indexOf('archive_annotator') !== -1 && newDoc.payload && newDoc.payload.kind === 'annotation')) throw({forbidden:'role does not permit this document'});
  if (newDoc.type !== 'immutable' || !newDoc.payload || newDoc._id.indexOf('immutable:') !== 0) throw({forbidden:'invalid immutable document'});
}`;
// Explicit administrative operation; caller supplies credentials at runtime.
async function provision({url,authorization,fetchImpl}) {
  if (!authorization) throw new Error('Administrator authorization required');
  const {request} = client({url,authorization,fetchImpl});
  const write = async (endpoint,body) => {
    const response = await request(endpoint,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if (!response.ok) throw new Error(`CouchDB provisioning failed (${response.status})`);
  };
  // Existing security or design documents must not be silently overwritten.
  const existing = await request('/_design/archive');
  if (existing.status !== 404) throw new Error('Archive design already exists or cannot be checked');
  const security = await request('/_security');
  if (!security.ok) throw new Error('Cannot inspect CouchDB security');
  const current = await security.json();
  if ((current.admins?.names || []).length || (current.admins?.roles || []).filter(r => r !== '_admin').length || (current.members?.names || []).length || (current.members?.roles || []).filter(r => r !== '_admin').length) throw new Error('Database security is already configured');
  await write('/_design/archive',{_id:'_design/archive',validate_doc_update:validateDocUpdate});
  await write('/_security',{admins:{names:[],roles:['_admin']},members:{names:[],roles:['archive_reader','archive_annotator','archive_writer']}});
  return {configured:true};
}
module.exports = {pushImmutable,pullImmutable,validateDocUpdate,provision};
