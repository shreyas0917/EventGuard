# 0007: JWT bearer tokens with two roles; demo login stands in for an identity provider

**Status:** accepted

## Context

Every endpoint was open: anyone could create a `PAYMENT_SUCCESS` event (minting money), replay the DLQ, or read any wallet. The checkout verify call also took the beneficiary's `userId` from the request body.

## Decision

- HS256 JWTs with `sub` = user id and `role` ∈ {`user`, `admin`}. Verification pins the algorithm and checks issuer, audience and expiry.
- The whole access policy is declared in one place, `app.ts`. Admin covers events, retries, outbox, DLQ, webhook history and reconciliation. Users act only on their own wallet, orders and payment verification. Webhooks stay public but HMAC-verified over the raw body.
- Payment verification credits the **token's** user, and only if the Razorpay order was created for that user (`order.notes.userId`).
- `POST /api/auth/demo-login` issues tokens without a user store, for the dashboard and demos. An admin token additionally requires `ADMIN_API_KEY`, compared in constant time. The endpoint is rate-limited and refused at startup in production, as are known placeholder secrets.

## Consequences

- Swapping in a real identity provider means replacing demo login and the token verifier. Authorization rules do not change.
- Tokens cannot be revoked before expiry (`JWT_TTL_SECONDS`, default 1 h). Acceptable for this scope; a production system would add short-lived access tokens with refresh, or a denylist.
- 130 in-process security tests cover the policy, including forged, expired, `alg: none` and tampered tokens.
