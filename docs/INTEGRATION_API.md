# Sending leads to the MSP CRM (for our other software)

Base URL: `https://<msp-crm-backend>/api/v1/integrations`
Auth: header `X-API-Key: <key>` — one key per software, created in **MSP CRM → Settings → Integrations** (Admin).

**Call this API from your server only.** Keep the key in an environment variable (`MSP_CRM_API_KEY`); never put it in browser code.

## Send a lead

`POST /leads`

```json
{
  "externalRef": "1234",
  "companyName": "Acme Pvt Ltd",
  "contactPerson": "Ravi Kumar",
  "phone": "+91 98765 43210",
  "email": "ravi@acme.com",
  "requirement": "Needs 2 firewalls for the new branch",
  "classification": "HARDWARE",
  "subcategories": ["Firewall"],
  "notes": "Referred by existing ILL customer",
  "customerGstin": "27AAACA4321P1Z3",
  "customerState": "27",
  "billingAddress": "Pune",
  "submittedBy": { "name": "Sam User", "email": "sam@example.com" }
}
```

- **Required:** `externalRef` (your own lead id, unique in your software), `companyName`, `contactPerson`, `phone`, `email`.
- **Optional:** everything else.
- `classification` (`HARDWARE` / `SOFTWARE`) + `subcategories` together mean the lead arrives categorized, ready for MSP TL to assign. Without both, MSP TL categorizes it.
- `submittedBy` is shown as the **Lead owner** in the MSP CRM; the assigned Sales person is shown separately.
- `customerState` may be a GST code (`"27"`) or a name (`"Maharashtra"`). A GSTIN or state that can't be used doesn't reject the lead: it's left blank and kept in the lead's notes.
- `201` = created · `200` = this `externalRef` was already received (same lead returned, **safe to retry**).
- `400` = validation problem: `message` says which field. Don't retry without fixing it.

Response `data` is the status object below. Save `leadId` if you want it.

## Status object

```json
{
  "leadId": "uuid",
  "externalRef": "1234",
  "companyName": "Acme Pvt Ltd",
  "status": "ASSIGNED",
  "statusLabel": "Assigned to Sales",
  "orderNo": 1,
  "assignedTo": "Neha Gupta",
  "dropReason": null,
  "createdAt": "2026-10-30T06:00:00.000Z",
  "updatedAt": "2026-10-30T07:00:00.000Z"
}
```

| `status` | Meaning |
|---|---|
| `RECEIVED` | Received, MSP TL hasn't assigned it yet |
| `ASSIGNED` | Assigned to a Sales person |
| `IN_DISCUSSION` | Meeting booked / held |
| `QUOTATION_IN_PROGRESS` | Quotation being prepared |
| `QUOTATION_SENT` | Quotation sent to the customer |
| `ORDER_IN_PROGRESS` | Customer accepted, order being processed |
| `INVOICED` | Customer invoiced |
| `CLOSED_WON` | Fully paid, deal closed |
| `DROPPED` | Lead dropped (`dropReason` says why) |
| `REMOVED` | Deleted in the MSP CRM |

Treat unknown values as "show `statusLabel`": new statuses may be added.

**Repeat orders:** when a closed customer orders again, `status` goes back to `ASSIGNED` and `orderNo` increases. That's normal, not an error.

## Keep statuses up to date (every 5 minutes)

`GET /leads?updatedSince=<ISO time>&page=1&limit=100`

```json
{
  "items": [ /* status objects, oldest change first */ ],
  "total": 12, "page": 1, "limit": 100, "totalPages": 1,
  "removed": [ { "externalRef": "1200", "removedAt": "…" } ],
  "serverTime": "2026-10-30T07:05:00.000Z"
}
```

1. Read your saved `updatedSince` (none on the first run: you get everything).
2. Fetch page 1; **remember its `serverTime`**. Fetch the remaining pages up to `totalPages`.
3. Update your leads by `externalRef`; mark those in `removed` as removed (`removed` is only on page 1).
4. Only after every page succeeded, save that `serverTime` as the next `updatedSince`.

Always use `serverTime`, never your own clock. A lead may appear twice across runs; updating it again is harmless.

One lead: `GET /leads/:externalRef` (`404` = not found; deleted leads return `status: "REMOVED"`).

## Errors and limits

| Code | Meaning | What to do |
|---|---|---|
| `400` | Invalid data | Fix it; don't retry |
| `401` | Missing/wrong key | Check `MSP_CRM_API_KEY` |
| `403` | Key disabled | Ask the MSP CRM admin |
| `404` | No such lead for this key | — |
| `429` | Over 120 requests a minute | Wait a minute and retry |
| `5xx` / network | Temporary | Retry later with the same `externalRef` |

Errors look like `{ "success": false, "message": "…" }`. Successes look like `{ "success": true, "data": … }`.

## Example (Node.js)

```js
const BASE = process.env.MSP_CRM_API_URL; // https://<backend>/api/v1/integrations
const headers = { 'Content-Type': 'application/json', 'X-API-Key': process.env.MSP_CRM_API_KEY };

async function sendLead(lead) {
  const res = await fetch(`${BASE}/leads`, { method: 'POST', headers, body: JSON.stringify(lead) });
  const body = await res.json();
  if (res.status === 400) throw new Error(body.message); // don't retry
  if (!res.ok) throw Object.assign(new Error(body.message), { retry: true });
  return body.data;
}

async function syncStatuses(updatedSince) {
  let page = 1, serverTime, totalPages = 1;
  do {
    const qs = new URLSearchParams({ page, limit: 100, ...(updatedSince ? { updatedSince } : {}) });
    const res = await fetch(`${BASE}/leads?${qs}`, { headers });
    if (!res.ok) throw new Error(`Status sync failed: ${res.status}`);
    const { data } = await res.json();
    if (page === 1) serverTime = data.serverTime;
    totalPages = data.totalPages;
    for (const l of data.items) await saveStatus(l.externalRef, l); // your DB update
    for (const r of data.removed) await markRemoved(r.externalRef);
    page++;
  } while (page <= totalPages);
  return serverTime; // save as the next updatedSince
}
```
