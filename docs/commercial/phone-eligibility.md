# Business location and phone eligibility

Business country is an explicit ISO country selection in setup and My business. Existing businesses remain unset until the customer chooses; timezone, language, IP address and a requested telephone country never supply it implicitly. The field is included in account exports and normal business ownership checks. Changing business facts preserves assistants, calls, links, credentials and existing phone orders.

Requested number country is separate. The customer menu is supplied by the configured operator market (`TELNYX_PURCHASE_COUNTRY`), not a fixed list of advertised countries. A business outside that country can qualify if its actual regulatory review permits it. Available inventory alone never establishes eligibility.

## Operator review records

New quotes need both the existing global commercial/carrier controls and a current `commercial_phone_approvals` record for the owned business, requested country, number type and area. The approval must have status `approved`, a review time, future expiry, and exact current business name, address and country. An empty address or unset business country cannot qualify. Pending review, rejection, revocation, expiration or changed business identity blocks new quotes and orders.

Only an operator can write these records; there is no customer approval endpoint or document-upload facility. Store private KYC evidence in the operator's authorized carrier workflow, not in application notes. Verify the carrier's current requirements, end-user identity, allowed number type/area and expiry before approving anything. This implementation contains no pre-approved businesses and does not claim a completed regulatory review.

Use a parameterized database operation with independently verified values. Bind the intended business ID, snapshot, country, type, area, review date and expiry explicitly. A new record should start `pending`; after review, update that exact record to `approved` only while its snapshot still matches. Use `NULL` for `area_code` only when the review explicitly authorizes country-wide scope; otherwise store the approved numeric area (one to six digits).

```sql
INSERT INTO commercial_phone_approvals
  (id, business_id, country, number_type, area_code, status,
   business_name, business_address, business_country, reviewed_at, expires_at)
VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, ?);

UPDATE commercial_phone_approvals
SET status = 'approved', reviewed_at = ?, expires_at = ?
WHERE id = ? AND business_id = ? AND status = 'pending'
  AND business_name = ? AND business_address = ? AND business_country = ?
  AND EXISTS (
    SELECT 1 FROM businesses b WHERE b.id = commercial_phone_approvals.business_id
      AND b.name = commercial_phone_approvals.business_name
      AND b.address = commercial_phone_approvals.business_address
      AND b.country = commercial_phone_approvals.business_country
  );
```

Require one changed row and read the result back. Material edits automatically increment `revision` to invalidate old quotes. **Do not set `revision` manually**, including in an update that changes status or scope. To revoke an approval, update that actual row to `revoked`; inserting a separate rejected record does not revoke an older approved record. Review all overlapping active scopes when withdrawing authority.

## Quote and order boundaries

Quotes pin the exact approval ID/revision, area and business identity after inventory returns. Explicit carrier country/type contradictions are rejected. Telnyx does not return a destination-code field: for any area-filtered request, the application requires a matching country in `region_information` and the documented `best_effort: false` response asserting an exact match to the submitted search criteria. Missing, true or malformed match flags cannot authorize an area quote. This relies on the carrier’s exact-match assertion, not independent numbering-plan parsing. The application does not send the US/Canada-only best-effort query option for other markets. A changed approval or identity during the inventory request produces a conflict rather than an executable stale quote.

Ordering checks the same pins on initial read, reservation and immediately before the provider request. Existing price, expiry, subscription coverage, assistant, account deletion, cancellation and spending controls remain. The last database admission is the boundary: an operator change after the provider request has already been dispatched cannot retract it. This is not a distributed cancellation guarantee.

An existing order remains readable, reconcilable and idempotent without a new approval. Existing numbers can still be assigned or disabled. Old quotes with no approval pins cannot create new orders.

## Migrations and validation

`0028_business_country.sql` adds a nullable business field; `0029_phone_eligibility.sql` adds the approval table, revision triggers and nullable quote pins. Apply both before deploying this source. They do not rewrite old businesses, quotes or orders, or modify the historical `0024` migration. Take a restricted backup and rehearse preservation on the exact environment before a separately authorized remote migration. Current production migration status is in [production preflight](../launch/production-preflight.md).

Local tests cover country validation/omission/clearing/export/isolation, review states and identity changes, foreign-business and foreign-number distinctions, inventory mismatch, approval revision races and order admission boundaries. These are synthetic carrier tests. No actual approval, KYC submission, purchase, rental, PSTN call or charge is established by them. Carrier and billing flags remain disabled until their independent acceptance gates close.

Local validation of this candidate passed an initial 246 focused API tests and a later 32-test country/eligibility run including the added preservation case, both application typechecks, and the five selected browser cases. The first browser run retained three passes and two locator failures; only the affected two cases were rerun after selectors were corrected to include the labels’ help text. Actual local workerd D1 applied 0028/0029 over a synthetic 0027 database and preserved existing business, quote and order values, with empty foreign-key checks and monotonic revoke/reapprove revisions. Its unsupported `PRAGMA integrity_check` returned `SQLITE_AUTH` and remains an original harness failure; a read-only check of the local SQLite database independently returned `ok`. No migrations were repeated to obtain that result.
