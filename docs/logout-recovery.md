# Sign-out recovery in the current tab

Sign-out clears the local account/workspace immediately. Before sending the request,
the browser attempts to store a small versioned intent in sessionStorage. The record
contains only a random intent identifier and an unconfirmed/confirmed phase; it does
not contain account details, cookies or credentials.

When this tab reloads, App restores the record before starting authenticated session
loads. An unconfirmed record keeps the Auth screen locked and offers **Retry sign-out**.
Nothing automatically retries the server request or refreshes the authenticated
session. A malformed, unsupported, oversized or unreadable record is unknown rather
than absent and keeps the same conservative gate. A confirmed-absent record preserves
ordinary sign-in and session loading. The coordinator also checks the gate before
publishing a loaded snapshot; its existing generation guard suppresses older results.
This does not cancel requests already in flight.

An explicit retry creates a new random intent. Completion may remove only the intent
it still owns; an older coordinator cannot clear a newer intent by resetting its local
generation. If an atomic replacement write fails, cleanup retains the observed
predecessor identity instead of claiming the unwritten replacement. A different/newer
stored intent is never removed or confirmed by the old completion. The older live
coordinator retains its server confirmation and offers local cleanup only; while a
newer intent remains, cleanup stays blocked until that owner recovers. Reload instead
restores the current persisted intent, not an older owner's private memory. This is
ownership within this tab, not a cross-tab storage protocol.

If the server confirms revocation but local cleanup fails, Auth reports that distinction
and offers **Retry local cleanup**. It makes one bounded storage recovery attempt and
sends no additional logout request. Confirmation is saved before removal, so a confirmed
record that survives reload keeps that local-only action. There are no background
retries or timers. When storage becomes readable/removable, the explicit action clears
the record and unlocks Auth without an automatic session refresh.

Storage can fail. A failed initial write still preserves immediate local clear and the
live coordinator's memory gate, but cannot promise protection after reload. If both
saving server confirmation and removing the marker fail, the live coordinator remembers
confirmation and retries only cleanup. That confirmation could not be made durable:
a later reload can see only the older unconfirmed record, and a subsequent explicit
user retry may repeat the earlier completed request. Similarly a lost response cannot
establish server confirmation. Neither case triggers an automatic retry. Clearing or
editing storage can remove this UI protection.

This is a same-tab UI mitigation, not session revocation or an authorization boundary.
A failed server request can leave a valid HttpOnly cookie and database session. Direct
API use, copied/stolen cookies, other tabs or profiles, a new context, unavailable or
cleared storage, and universal browser/device restarts are not secured by this marker.
A new tab can also inherit a copy of sessionStorage from its opener; no synchronization
or global logout guarantee is made. The server/API/cookie/schema policy is unchanged.

The accompanying unit fixtures use controlled schedules and injected storage faults.
The browser fixtures require real Chrome reloads against the local Worker with a real
synthetic signup/session; route-injected failures leave that cookie valid and test-owned
API reads distinguish this from page-owned authenticated reads. These fixtures do not
prove deployed browser/privacy settings, transport delivery, or server-failure recovery
in production. Runtime results and first-failure/cleanup limitations belong to the
separate validation receipt; source preparation is not a passing test report or security
clearance.

## Confirmed account deletion

The Account page delegates deletion to the same session coordinator. Before awaiting
DELETE, it captures the current coordinator generation and a deletion-attempt identity.
Only an acknowledged DELETE in that still-current context may clear the local session.
It does not issue a second logout request. The server account-deletion/cascade/cookie
contract is unchanged; local completion is not evidence about a newer login or another
browser context.

A refresh, sign-out, App unmount or later deletion attempt makes the older completion
obsolete. A newly stored intent is also left untouched, whether unconfirmed or confirmed.
The old completion neither navigates nor clears/promotes that owner's state. This is a
conservative context check, not cancellation: DELETE may have completed server-side even
when its local completion is ignored. An authentication change outside this coordinator,
including another context's cookie activity, is not detected or made safe by this check.

Rejected or ambiguous DELETE still reports an error on the Account page without claiming
confirmation, clearing the current session, adding logout intent or automatically retrying.
A pending DELETE stays pending; no new request timeout or server policy is introduced.
A lost response can therefore leave the old UI visible after actual server deletion.

For a current acknowledgement, the coordinator records a confirmed intent and performs
its existing owned local cleanup. Removal failure keeps a confirmed marker across reload
and offers Retry local cleanup without DELETE or logout. A failed confirmation write with
readable absence can finish cleanup directly. Unreadable storage after acknowledgement
keeps live local-only recovery and never treats unknown contents as absence or overwrites
them. If a different marker is later observed, cleanup waits for its owner; the old
confirmation cannot authorize clearing it. Without durable confirmation, reload cannot
recover that memory-only fact, and the general storage/information-loss limits above apply.

The additional unit fixtures control acknowledgement, newer generation/intent, invalidation,
failed or pending DELETE and storage faults. New browser fixtures exercise the actual
Account/App/coordinator path, real local signup/deletion, route-injected response failure,
held acknowledgement, and Chrome reload with confirmed sessionStorage. They do not prove
production transport, old/new cookie ordering, arbitrary external authentication changes,
all callback schedules, or browser-storage reliability. Test preparation is not execution;
original failures and fixed outcomes require a separately authorized validation receipt.
