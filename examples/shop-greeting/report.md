# Proofline report: run 20261117-202538

**Proven: 8 of 8 criteria** · branch `proofline/20261117-202538` in api off `main@a5d19df`, web off `main@6262c38` · 39s

> Add a greeting feature: the API serves GET /greeting returning { message: 'Hello, <name>!' } for the query name, or a 400 with an error when the name is missing. The web client gets greetingRequest(base, name) and readGreeting(body) for it. Both repositories get tests.

This delivery spans 2 repositories (api, web). They were verified together, each with all of its work merged.

## Contract → result

| | Criterion | Proof | Before the work | Built by | Commits |
|---|---|---|---|---|---|
| ✅ | **C1** In api, handle('GET','/greeting',{name:'Ada'}) returns { status: 200, body: { message: 'Hello, Ada!' } }. | command `cd api && node -e "import('./src/routes.js').then(m=>{const r=m.handle('GET','/greeting',{name:'Ada'});require('node:assert/strict').deepEqual(r,{status:200,body:{message:'Hello, Ada!'}})}).catch(e=>{console.error(e);process.exit(1)})"` | failed, as expected | T1 | `7c8fd31` |
| ✅ | **C2** In api, handle('GET','/greeting',{}) and handle('GET','/greeting',{name:''}) both return status 400 with a body containing a non-empty string 'error' field and no 'message' field. | command `cd api && node -e "import('./src/routes.js').then(m=>{const a=require('node:assert/strict');for(const q of [{},{name:''}]){const r=m.handle('GET','/greeting',q);a.equal(r.status,400);a.equal(typeof r.body.error,'string');a.ok(r.body.error.length>0);a.ok(!('message' in r.body))}}).catch(e=>{console.error(e);process.exit(1)})"` | failed, as expected | T1 | `7c8fd31` |
| ✅ | **C3** The new file api/test/greeting.test.js exists, covers both the success case and the missing-name 400 case, and passes. | command `cd api && node --test test/greeting.test.js` | failed, as expected | T1 | `7c8fd31` |
| ✅ | **C4** In web, greetingRequest('http://x','Ada') returns { method: 'GET', url: 'http://x/greeting?name=Ada' }, and a name with special characters is URL-encoded (greetingRequest('http://x','A b&c').url is 'http://x/greeting?name=A%20b%26c'). | command `cd web && node -e "import('./src/client.js').then(m=>{const a=require('node:assert/strict');a.deepEqual(m.greetingRequest('http://x','Ada'),{method:'GET',url:'http://x/greeting?name=Ada'});a.equal(m.greetingRequest('http://x','A b&c').url,'http://x/greeting?name=A%20b%26c')}).catch(e=>{console.error(e);process.exit(1)})"` | failed, as expected | T2 | `6631e1e` |
| ✅ | **C5** In web, readGreeting({ message: 'Hello, Ada!' }) returns the string 'Hello, Ada!'. | command `cd web && node -e "import('./src/client.js').then(m=>{require('node:assert/strict').equal(m.readGreeting({message:'Hello, Ada!'}),'Hello, Ada!')}).catch(e=>{console.error(e);process.exit(1)})"` | failed, as expected | T2 | `6631e1e` |
| ✅ | **C6** The new file web/test/greeting.test.js exists, covers greetingRequest and readGreeting, and passes. | command `cd web && node --test test/greeting.test.js` | failed, as expected | T2 | `6631e1e` |
| ✅ | **C7** The existing health tests still pass in both repositories. | command `cd api && node --test test/health.test.js && cd ../web && node --test test/health.test.js` | already passed (guard) | T1 | `7c8fd31` |
| ✅ | **C8** Seam: the request greetingRequest builds (method GET, path /greeting, query parameter named exactly 'name') is the request the API route accepts (method GET, path /greeting, reads query.name), and the field readGreeting reads ('message') is the field the API returns on success ('message'). Check each name and the method/path field by field across both repositories. | independent review | n/a | T2 | `6631e1e` |

## Evidence

**C1** ✅ In api, handle('GET','/greeting',{name:'Ada'}) returns { status: 200, body: { message: 'Hello, Ada!' } }.

```
exit 0 in 0.0s
```

**C2** ✅ In api, handle('GET','/greeting',{}) and handle('GET','/greeting',{name:''}) both return status 400 with a body containing a non-empty string 'error' field and no 'message' field.

```
exit 0 in 0.0s
```

**C3** ✅ The new file api/test/greeting.test.js exists, covers both the success case and the missing-name 400 case, and passes.

```
exit 0 in 0.3s
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 187.220451
```

**C4** ✅ In web, greetingRequest('http://x','Ada') returns { method: 'GET', url: 'http://x/greeting?name=Ada' }, and a name with special characters is URL-encoded (greetingRequest('http://x','A b&c').url is 'http://x/greeting?name=A%20b%26c').

```
exit 0 in 0.0s
```

**C5** ✅ In web, readGreeting({ message: 'Hello, Ada!' }) returns the string 'Hello, Ada!'.

```
exit 0 in 0.0s
```

**C6** ✅ The new file web/test/greeting.test.js exists, covers greetingRequest and readGreeting, and passes.

```
exit 0 in 0.2s
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 103.790268
```

**C7** ✅ The existing health tests still pass in both repositories.

```
exit 0 in 0.3s
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 103.820388
```

**C8** ✅ Seam: the request greetingRequest builds (method GET, path /greeting, query parameter named exactly 'name') is the request the API route accepts (method GET, path /greeting, reads query.name), and the field readGreeting reads ('message') is the field the API returns on success ('message'). Check each name and the method/path field by field across both repositories.

```
web/src/client.js:11 builds `{ method: 'GET', url: `${base}/greeting?name=${encodeURIComponent(name)}` }`, matching the API route's method GET and path '/greeting' at api/src/routes.js:5-6, with the query parameter named exactly `name`. The API's handler reads it via destructuring `({ name })` at api/src/routes.js:7, which is the same as reading query.name. web/src/client.js:15 `readGreeting` returns `body.message`, and api/src/routes.js:9 returns `{ status: 200, body: { message: ... } }` on success, so the field names match.
```

## Tasks

| Task | Status | Attempts | Commits | Builder's summary (not proof) |
|---|---|---|---|---|
| **T1** [api] API greeting route and tests | merged | 1 | 1 | Added a GET /greeting entry to the `routes` table in api/src/routes.js. A non-empty string `query.name` returns 200 with `{message:'Hello, <name>!'}`. A missing or empty name returns 400 with `{error:'name is required'}`. Added api/test/greeting.test.js, which covers the success case and the 400 case for `{}` and `{name:''}`. Both api tests pass and the C1 proof passes. I didn't run C2 or the web half of C7, and C7 depends on web's health test passing. |
| **T2** [web] Web greeting client helpers and tests (after T1) | merged | 1 | 1 | Added greetingRequest(base, name) and readGreeting(body) to web/src/client.js, leaving the health helpers unchanged. Added web/test/greeting.test.js with three tests: a plain name, a special-character name, and readGreeting. The greeting and health tests pass, the C4 proof passes, and the work is committed. |

## Agent usage

| Role | Runs | Turns | Agent time | List-price equivalent |
|---|---|---|---|---|
| planner | 2 | 14 | 29s | $0.10 |
| builder | 2 | 11 | 27s | $0.18 |
| verifier | 1 | 4 | 5s | $0.00 |

_Command proofs were run by the harness. Review proofs came from a read-only agent that never saw the builders' output._
